"""Packed-weight layout gate for the final merge of a W8A8 GEMM task.

Why this file exists
--------------------
``prepare_weight`` is frozen at ``(raw_weight, weight_scale)``: it has **no M**,
because in the real model one weight is packed once and every M of that weight
reuses the image.  The dispatch therefore cannot give the M=8 and the M=4096 GEMM
different weight bytes, while the worker contract explicitly lets each shape
bring its own packed layout ("may change only its HIP implementation **and the
matching GEMM interpretation** to test packed layouts").

When the members of one ``(N, K)`` family disagree, the merged artifact packs
with one member and interprets with another, and every element of the output is
wrong.  That failure mode has landed twice:

* ``hy3-tp8-m8-16-4096-2-9dcfce15`` -- m8/m16 shared a layout, m4096 changed it;
  the three pack sources were byte-identical, so nothing static could see it.
* ``minimax-tp8-m8-16-4096-df6fb501`` -- m8 emitted a k32-blocked image without
  the K-octet swizzle, m4096 emitted the swizzled one; 99.9% of the m4096 output
  was wrong while its latency stayed exactly the worker's number (the cheap
  kernel ran and produced garbage).

Both were found only by the *full* serial validation, i.e. after a task had
already spent hours optimizing: the merge is the first place the two layouts
meet, and it had no check of any kind.

What the gate measures
----------------------
For each ``(N, K)`` family it runs **each member's own pack kernel**, in a child
process, on the family's **real weight shape** filled with a byte-counter image,
and hashes the packed bytes:

    fingerprint = SHA256(pack_member(counter_image_of_this_weight))

Two facts make this the right measurement:

* It is **behavioural**: the hy3 pack sources were byte-identical yet disagreed,
  so comparing source or symbol names would have missed that incident entirely.
* It must run at the **real (N, K)**: probed at a small canonical shape the two
  df6fb501 packers agree (both wrote the same 32 KB block), while at the real
  ``(1280, 6144)`` they differ -- the swizzle only engages on the full k32 grid.
  Measured: 0.9 ms per 7.9 MB image, 8.3 ms for a 235 MB one, and never inside a
  timed region.

Interpretation: **equal fingerprints means byte-identical images**, so those
members are mutually interchangeable and may share one pack route.  Different
fingerprints are treated as *incompatible*: the gate cannot prove they are
readable by each other, and the observed failure was exactly a reader that
accepted only its own image.  That makes the verdict conservative -- a family
only pays an extra batch when its members really emit different bytes.

The plan
--------
A batch is a set of shapes merged into one extension.  Inside a batch every
``(N, K)`` family has exactly one pack route, taken from the family's smallest
M, so a batch is sound exactly when all members it contains emit the same image
(:func:`family_groups`).  Members that cannot share an image are grouped so that
each group is self-consistent, and the groups are packed into the fewest batches
(:func:`pack_batches`); the merged pipeline then validates one batch at a time, each
with its own dispatch and prebuilt set.

If the probe cannot run (no objects on disk, no GPU, a crashed child) the gate
reports no conflict -- but it must not pretend the family agreed either.  With
nothing measured, agreement is **unproven**, so every unmeasured multi-member
family is split by member (:func:`unproven_groups`, applied per family by
:func:`agreed_groups`): a blind gate then costs an extra batch instead of merging
two layouts into one pack route.  A probe failure still never fails a task.

The probe child is spawned through
:func:`metainfer.orchestrator.interpreter.python_executable`, never
``sys.executable``: inside a WebUI-launched orchestrator ``sys.executable`` is
``''``, and ``subprocess.run([''])`` raises
``PermissionError: [Errno 13] Permission denied: ''`` -- which the gate used to
absorb as "no conflict".  See ``wiki-metainfer/gotchas/
layout-gate-probe-blind-under-webui.md``.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from metainfer.orchestrator.interpreter import python_executable

__all__ = [
    "FamilyProbe",
    "LayoutCheck",
    "MemberProbe",
    "UNRESOLVED",
    "agreed_groups",
    "check",
    "family_groups",
    "pack_batches",
    "plan",
    "unproven_groups",
]

#: Sentinel for "this member's pack could not be measured".
UNRESOLVED = "unresolved"


def _counter_image(k: int, n: int) -> bytes:
    """The probe weight: a byte counter.

    A counter -- not zeros, not a constant -- is what makes the image sensitive
    to any in-image permutation (the k32 blocks, the K-octet swizzle, a row
    stride): two layouts can only compare equal if they place every byte
    identically.
    """
    return bytes(i & 0xFF for i in range(k * n))


_CHILD_CODE = r"""
import ctypes, hashlib, json, sys
from pathlib import Path

import torch

import metainfer.tasks.dcu_kernel_auto_opt.orchestrator.final_layout_gate as gate

spec_path, out_path = sys.argv[1], sys.argv[2]
spec = json.loads(Path(spec_path).read_text())

# One GPU context for every family: a child per family would spend ~16 s each
# just initialising torch/HIP, against ~1 ms of actual packing.
torch.cuda.init()
stream = ctypes.c_void_p(torch.cuda.current_stream().cuda_stream)

report = {"families": {}, "errors": {}}
for key, family in spec["families"].items():
    n, k = family["N"], family["K"]
    raw = gate._materialize(gate._counter_image(k, n))
    zero = torch.zeros(n, dtype=torch.float32, device="cuda")
    entry = {"fingerprints": {}, "errors": {}}
    for shape_id, item in family["members"].items():
        try:
            library = gate._load_probe_library(
                Path(item["object"]), item["pack_symbol"]
            )
            packed = torch.zeros(k * n, dtype=torch.int8, device="cuda")
            packed_scale = torch.zeros(n, dtype=torch.float32, device="cuda")
            gate._pack_fn(library, item["pack_symbol"])(
                ctypes.c_void_p(raw.data_ptr()),
                ctypes.c_void_p(zero.data_ptr()),
                ctypes.c_void_p(packed.data_ptr()),
                ctypes.c_void_p(packed_scale.data_ptr()),
                k, n, stream,
            )
            torch.cuda.synchronize()
            entry["fingerprints"][shape_id] = hashlib.sha256(
                packed.cpu().view(torch.uint8).numpy().tobytes()
            ).hexdigest()
        except Exception as exc:  # noqa: BLE001 - one member must not kill it
            entry["errors"][shape_id] = f"{type(exc).__name__}: {exc}"[:200]
    report["families"][key] = entry

Path(out_path).write_text(json.dumps(report))
"""


def _materialize(blob: bytes, device: str = "cuda"):
    """Wrap raw bytes as a device tensor (int8 bit pattern preserved)."""
    import torch  # noqa: PLC0415 - probe only

    return torch.frombuffer(bytearray(blob), dtype=torch.int8).to(device)


def _load_probe_library(object_path: Path, symbol: str):
    """Link one namespaced prebuilt object into a loadable library."""
    import ctypes  # noqa: PLC0415 - probe only

    scratch = Path(tempfile.mkdtemp(prefix="w8a8-layout-probe-"))
    library_path = scratch / f"{symbol}.so"
    result = subprocess.run(
        [
            "gcc", "-shared", "-fPIC", "-o", str(library_path),
            str(object_path), "-L/opt/dtk/lib", "-lamdhip64",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "probe link failed: "
            + (result.stderr or result.stdout or "").strip()[-500:]
        )
    library = ctypes.CDLL(str(library_path))
    # Keep the scratch dir referenced so the .so outlives this call.
    library._dsh_probe_scratch = str(scratch)
    return library


def _pack_fn(library, symbol: str):
    """The trusted pack ABI: ``(raw, scale, packed, packed_scale, k, n, stream)``."""
    import ctypes  # noqa: PLC0415 - probe only

    function = getattr(library, symbol)
    function.restype = None
    function.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
    ]
    return function


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #


@dataclass
class MemberProbe:
    """One member's packed image for the family's weight."""

    shape_id: str
    pack_symbol: str
    fingerprint: str = UNRESOLVED
    error: str = ""


@dataclass
class FamilyProbe:
    """One ``(N, K)`` family, probed."""

    n: int
    k: int
    members: List[MemberProbe] = field(default_factory=list)
    #: ``shape_id -> M``: a family's pack route is its **smallest M**.
    m_of: Dict[str, int] = field(default_factory=dict)

    def member(self, shape_id: str) -> MemberProbe:
        for item in self.members:
            if item.shape_id == shape_id:
                return item
        raise KeyError(shape_id)

    @property
    def resolved(self) -> bool:
        return any(item.fingerprint != UNRESOLVED for item in self.members)

    @property
    def images(self) -> Dict[str, List[str]]:
        """``fingerprint -> [shape_id, ...]``; unmeasured members kept together."""
        grouped: Dict[str, List[str]] = {}
        for item in self.members:
            grouped.setdefault(item.fingerprint, []).append(item.shape_id)
        return {key: sorted(value) for key, value in sorted(grouped.items())}

    def as_json(self) -> Dict[str, Any]:
        return {
            "n": self.n,
            "k": self.k,
            "resolved": self.resolved,
            "distinct_images": len(self.images),
            "images": self.images,
            "members": {
                item.shape_id: {
                    "pack_symbol": item.pack_symbol,
                    "fingerprint": item.fingerprint,
                    "error": item.error,
                }
                for item in self.members
            },
        }


@dataclass
class LayoutCheck:
    """Probe result: one :class:`FamilyProbe` per ``(N, K)``."""

    families: List[FamilyProbe] = field(default_factory=list)
    probed: bool = False
    probe_error: Optional[str] = None

    def family(self, n: int, k: int) -> Optional[FamilyProbe]:
        for item in self.families:
            if (item.n, item.k) == (n, k):
                return item
        return None

    @property
    def conflicts(self) -> List[FamilyProbe]:
        """Families whose members emit more than one distinct image."""
        return [
            family for family in self.families
            if family.resolved and len(family.images) > 1
        ]

    @property
    def ok(self) -> bool:
        return not self.conflicts

    @property
    def unproven(self) -> List[FamilyProbe]:
        """Families whose packed image was never measured at all.

        Non-empty while :attr:`probed` can still be true: one family's members can
        all fail to probe (a link error, say) while another family measures fine.
        Those families must still be split by member -- the global ``probed`` flag
        is not enough to decide per family.
        """
        return [family for family in self.families if not family.resolved]

    def as_json(self) -> Dict[str, Any]:
        return {
            "probed": self.probed,
            "probe_error": self.probe_error,
            "conflicts": [
                {**item.as_json(), "groups": family_groups(item)}
                for item in self.conflicts
            ],
            "families": [item.as_json() for item in self.families],
        }


# --------------------------------------------------------------------------- #
# Probe driver
# --------------------------------------------------------------------------- #


def _probe_families(
    families: Sequence[FamilyProbe],
    artifacts: Sequence[Dict[str, Any]],
    source_dir: Path,
) -> Dict[str, Any]:
    """Fingerprint every family's members in one child process; never raises.

    Returns ``{"fingerprints": {shape_id: sha256}, "errors": {...},
    "probe_error": str}``.  Unmeasured members are simply absent from
    ``fingerprints``.
    """
    by_shape = {
        str(artifact["shape_id"]): artifact for artifact in artifacts
    }
    spec_families: Dict[str, Any] = {}
    for family in families:
        members: Dict[str, Dict[str, str]] = {}
        for member in family.members:
            artifact = by_shape.get(member.shape_id)
            if artifact is None:
                continue
            object_path = source_dir / str(artifact.get("final_object") or "")
            if not object_path.is_file():
                continue
            members[member.shape_id] = {
                "object": str(object_path),
                "pack_symbol": member.pack_symbol,
            }
        if members:
            spec_families[f"{family.n}x{family.k}"] = {
                "N": family.n,
                "K": family.k,
                "members": members,
            }
    missing = {
        member.shape_id: (
            "pack object missing: "
            + str(source_dir / str(
                (by_shape.get(member.shape_id) or {}).get("final_object") or ""
            ))
        )
        for family in families
        for member in family.members
        if member.shape_id not in {
            shape_id
            for entry in spec_families.values()
            for shape_id in entry["members"]
        }
    }
    if not spec_families:
        return {"fingerprints": {}, "errors": missing,
                "probe_error": "no pack object is available to probe"}

    scratch = Path(tempfile.mkdtemp(prefix="w8a8-family-probe-"))
    spec_path = scratch / "spec.json"
    out_path = scratch / "report.json"
    spec_path.write_text(
        json.dumps({"families": spec_families}), encoding="utf-8"
    )
    env = dict(os.environ)
    repo_root = str(Path(__file__).resolve().parents[3])
    env["PYTHONPATH"] = os.pathsep.join(
        [repo_root, env.get("PYTHONPATH", "")]
    ).strip(os.pathsep)
    failure = ""
    report: Dict[str, Any] = {}
    interpreter = python_executable()
    try:
        result = subprocess.run(
            [interpreter, "-c", _CHILD_CODE, str(spec_path), str(out_path)],
            capture_output=True,
            text=True,
            timeout=1800,
            env=env,
        )
        if result.returncode != 0 or not out_path.is_file():
            failure = (result.stderr or result.stdout or "").strip()[-300:]
        else:
            report = json.loads(out_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        # Name the interpreter: ``PermissionError: [Errno 13] Permission
        # denied: ''`` (an empty sys.executable) says nothing on its own.
        failure = f"{type(exc).__name__}: {exc} (interpreter={interpreter!r})"[:300]
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    fingerprints: Dict[str, str] = {}
    errors: Dict[str, str] = dict(missing)
    for entry in (report.get("families") or {}).values():
        fingerprints.update(entry.get("fingerprints") or {})
        errors.update(entry.get("errors") or {})
    if failure:
        for family in families:
            for member in family.members:
                errors.setdefault(member.shape_id, failure)
    return {
        "fingerprints": fingerprints,
        "errors": errors,
        "probe_error": failure,
    }


def check(
    artifacts: Sequence[Dict[str, Any]],
    source_dir: Path,
    *,
    probe: bool = True,
    probe_families: Optional[Callable[..., Dict[str, Any]]] = None,
) -> LayoutCheck:
    """Probe every ``(N, K)`` family of one merge.

    ``probe_families`` is injectable so the gate can be exercised without a GPU.
    """
    grouped: Dict[Tuple[int, int], List[Dict[str, Any]]] = {}
    for artifact in artifacts:
        shape = artifact.get("shape") or {}
        grouped.setdefault((int(shape["N"]), int(shape["K"])), []).append(
            artifact
        )
    result = LayoutCheck()
    if not grouped:
        return result

    families: List[FamilyProbe] = []
    for key, members in sorted(grouped.items()):
        ordered = sorted(members, key=lambda item: str(item["shape_id"]))
        families.append(FamilyProbe(
            n=key[0],
            k=key[1],
            members=[
                MemberProbe(
                    shape_id=str(item["shape_id"]),
                    pack_symbol=str(item.get("pack_symbol") or ""),
                    error="" if probe else "probe disabled",
                )
                for item in ordered
            ],
            m_of={
                str(item["shape_id"]): int(
                    (item.get("shape") or {}).get("M") or 0
                )
                for item in ordered
            },
        ))
    result.families = families
    if not probe:
        return result

    runner = probe_families or _probe_families
    payload = runner(
        [family for family in families],
        artifacts,
        source_dir,
    )
    fingerprints = payload.get("fingerprints") or {}
    errors = payload.get("errors") or {}
    for family in families:
        for member in family.members:
            digest = fingerprints.get(member.shape_id)
            member.fingerprint = str(digest) if digest else UNRESOLVED
            member.error = str(errors.get(member.shape_id) or "")
    result.probed = any(family.resolved for family in families)
    if not result.probed:
        error = payload.get("probe_error") or "no family could be probed"
        result.probe_error = str(error)
    return result


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #


def family_groups(family: FamilyProbe) -> List[List[str]]:
    """The groups of members that can share one pack route.

    Grouping is by packed image: members that emit byte-identical images are
    interchangeable, and members that emit different images get their own group
    (a different image is not proof of incompatibility, but it is the shape of
    the incident, and the merge cannot prove the reader accepts it).

    Groups come out smallest-M first: that is the order the dispatcher's pack
    route follows, so the leading group is the one it will actually serve.
    """
    def by_m(shape_id: str):
        return (family.m_of.get(shape_id, 0), shape_id)

    return sorted(
        (sorted(members) for members in family.images.values()),
        key=lambda group: by_m(group[0]),
    )


def unproven_groups(family: FamilyProbe) -> List[List[str]]:
    """The groups to use when this family's images were never measured.

    A blind probe proves nothing, so every member of a multi-member family gets
    its own group: the merge then gives each M its own pack route, which is the
    layout the shape's own kernel was tuned and validated against.  Single-member
    families are unaffected, so a task whose shapes never shared a weight pays
    nothing.

    Same ordering contract as :func:`family_groups` (smallest M first), so batch
    packing stays deterministic and batch 0 still leads with the decode shapes.
    """
    if len(family.members) <= 1:
        return [[member.shape_id for member in family.members]]

    def by_m(member: MemberProbe):
        return (family.m_of.get(member.shape_id, 0), member.shape_id)

    return [[member.shape_id] for member in sorted(family.members, key=by_m)]


def agreed_groups(family: FamilyProbe) -> List[List[str]]:
    """The grouping rule :func:`plan` uses once at least one family is blind.

    Per family: measured families keep the fingerprint rule, unmeasured ones fall
    back to :func:`unproven_groups`.  This is why the decision cannot be made from
    the single global ``probed`` flag -- a probe run can measure every family but
    one, and that one family would otherwise still share a pack route.
    """
    if family.resolved:
        return family_groups(family)
    return unproven_groups(family)


def pack_batches(
    artifacts: Sequence[Dict[str, Any]],
    families: Sequence[FamilyProbe],
    *,
    groups: Callable[[FamilyProbe], List[List[str]]] = family_groups,
) -> List[List[Dict[str, Any]]]:
    """Pack the groups into the fewest batches.

    A batch may hold any number of families but at most one group per family, so
    within a batch every ``(N, K)`` has a single, self-consistent pack route.
    Groups are placed largest-first into the earliest batch that still lacks
    their family: minimal batch count, deterministic result, and the published
    batch 0 leads with the decode shapes.

    ``groups`` is the grouping rule: :func:`family_groups` when the probe
    measured the images, :func:`unproven_groups` when it could not.
    """
    by_shape = {
        str(artifact["shape_id"]): artifact for artifact in artifacts
    }
    rows: List[Tuple[Tuple[int, int], List[str], int]] = []
    for family in families:
        for group in groups(family):
            first_m = min(
                (family.m_of.get(shape_id, 0) for shape_id in group),
                default=0,
            )
            rows.append(((family.n, family.k), group, first_m))
    if not rows:
        return [list(artifacts)]
    rows.sort(key=lambda item: (-len(item[1]), item[0], item[2], item[1][0]))

    batches: List[List[str]] = []
    seen: List[set] = []
    for key, group, _first_m in rows:
        target = next(
            (
                index for index, families_seen in enumerate(seen)
                if key not in families_seen
            ),
            None,
        )
        if target is None:
            batches.append([])
            seen.append(set())
            target = len(batches) - 1
        batches[target].extend(group)
        seen[target].add(key)

    return [
        [by_shape[shape_id] for shape_id in sorted(batch) if shape_id in by_shape]
        for batch in batches
    ]


def plan(
    artifacts: Sequence[Dict[str, Any]],
    source_dir: Path,
    *,
    probe: bool = True,
) -> Tuple[LayoutCheck, List[List[Dict[str, Any]]]]:
    """Probe the families and return the batches the merge should validate.

    Three outcomes:

    * members of a family emit **different** images (:attr:`LayoutCheck.conflicts`)
      -- one batch per self-consistent group;
    * the probe **measured nothing** (``probed`` is false: no objects, no GPU, a
      crashed child, or ``probe=False``) -- every multi-member family is split by
      member, because agreement is unproven and a shared pack route would be a
      guess.  Unlike a measured conflict this is *not* reported as one
      (:attr:`LayoutCheck.ok` stays true), so a broken probe still cannot fail a
      task: it can only cost an extra batch;
    * every family agrees on one image -- the single historical batch.

    A probe run can also leave *some* families blind while others measure fine
    (:attr:`LayoutCheck.unproven`); those families get the same conservative
    treatment through :func:`agreed_groups`.
    """
    result = check(artifacts, source_dir, probe=probe)
    if result.conflicts:
        return result, pack_batches(artifacts, result.families)
    if result.unproven:
        return result, pack_batches(
            artifacts, result.families, groups=agreed_groups
        )
    return result, [list(artifacts)]
