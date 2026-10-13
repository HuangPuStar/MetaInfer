"""The final-merge packed-weight gate.

``prepare_weight`` is frozen at ``(raw_weight, weight_scale)`` -- no ``M`` -- so
one weight is packed once and every M of that weight reuses the image.  The
worker contract nevertheless lets each shape bring its own packed layout, so two
members of one ``(N, K)`` family can disagree.  When they do, the merged artifact
packs with one and interprets with another and *every* element is wrong; that
happened twice in production (``hy3-tp8-m8-16-4096-2-9dcfce15`` and
``minimax-tp8-m8-16-4096-df6fb501``) and was only ever caught by the full serial
validation.

These tests pin the gate that catches it up front: the family probe, the group
rule that decides which members may share one batch, and the batch packing.

Two properties keep the gate honest about its own blind spots:

* the probe child is spawned through a *resolved* interpreter, never
  ``sys.executable`` -- inside a WebUI-launched orchestrator that is ``''``, and
  ``subprocess.run([''])`` raises ``PermissionError: [Errno 13] Permission
  denied: ''``, which the gate used to read as "no conflict";
* when nothing could be measured, agreement is unproven and multi-member
  families are split by member.  A broken probe still never fails a task, but it
  can no longer merge two layouts into one pack route.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

from ..orchestrator import final_layout_gate as gate
from ..orchestrator.gen_and_opt_pipeline import (
    _layout_batch_source,
    plan_layout_batches,
)

FP_A = "a" * 64
FP_B = "b" * 64


def _artifact(shape_id: str, m: int, n: int, k: int) -> Dict[str, Any]:
    return {
        "shape_id": shape_id,
        "worker_id": "worker_0",
        "shape": {"M": m, "N": n, "K": k, "tp_size": 8, "operator": "qkv_proj"},
        "final_object": f"prebuilt/{shape_id}.o",
        "pack_symbol": f"mi_{shape_id}_launch_pack_w8a8_weight",
        "launch_symbol": f"mi_{shape_id}_launch_w8a8_gemm",
    }


def _family(
    n: int,
    k: int,
    fingerprints: Dict[str, str],
    m_of: Dict[str, int],
) -> gate.FamilyProbe:
    """A probe result by hand: ``{shape_id: fingerprint}``."""
    return gate.FamilyProbe(
        n=n,
        k=k,
        m_of=dict(m_of),
        members=[
            gate.MemberProbe(
                shape_id=shape_id,
                pack_symbol=f"mi_{shape_id}_launch_pack_w8a8_weight",
                fingerprint=fingerprint,
            )
            for shape_id, fingerprint in sorted(fingerprints.items())
        ],
    )


# --------------------------------------------------------------------------- #
# Group rule
# --------------------------------------------------------------------------- #

def test_one_image_keeps_the_family_in_one_group():
    """Byte-identical images are interchangeable: one group, one pack route."""
    family = _family(
        1280, 6144,
        {"qkv_m8": FP_A, "qkv_m4096": FP_A},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )

    assert gate.family_groups(family) == [["qkv_m4096", "qkv_m8"]]


def test_different_images_get_their_own_groups():
    """The df6fb501 shape: m8's k32 image is not the m4096 swizzled one."""
    family = _family(
        1280, 6144,
        {"qkv_m8": FP_A, "qkv_m4096": FP_B},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )

    assert gate.family_groups(family) == [["qkv_m8"], ["qkv_m4096"]]


def test_three_way_split_groups_the_identical_pair_together():
    family = _family(
        1280, 4096,
        {"qkv_m8": FP_A, "qkv_m16": FP_A, "qkv_m4096": FP_B},
        {"qkv_m8": 8, "qkv_m16": 16, "qkv_m4096": 4096},
    )

    assert gate.family_groups(family) == [["qkv_m16", "qkv_m8"], ["qkv_m4096"]]


def test_unmeasured_family_keeps_the_historical_single_group():
    """Unmeasured members carry ``unresolved``, so the *group* rule keeps them
    together -- ``family_groups`` is about fingerprints we have.

    This is no longer what an unproven family is merged with: :func:`plan` swaps
    in :func:`gate.unproven_groups` when nothing was measured (see
    ``test_plan_splits_a_multi_member_family_when_nothing_is_probed``).  The group
    rule stays this way because a *partially* measured family must still treat its
    unmeasured members as one unknown block.
    """
    family = _family(
        1280, 6144,
        {"qkv_m8": gate.UNRESOLVED, "qkv_m4096": gate.UNRESOLVED},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )

    assert gate.family_groups(family) == [["qkv_m4096", "qkv_m8"]]


# --------------------------------------------------------------------------- #
# Unproven agreement
# --------------------------------------------------------------------------- #

def test_unproven_groups_split_every_member_smallest_m_first():
    family = _family(
        1280, 6144,
        {"qkv_m8": gate.UNRESOLVED, "qkv_m16": gate.UNRESOLVED,
         "qkv_m4096": gate.UNRESOLVED},
        {"qkv_m8": 8, "qkv_m16": 16, "qkv_m4096": 4096},
    )

    assert gate.unproven_groups(family) == [
        ["qkv_m8"], ["qkv_m16"], ["qkv_m4096"],
    ]


def test_unproven_groups_leave_a_single_member_family_alone():
    family = _family(
        1280, 6144, {"qkv_m8": gate.UNRESOLVED}, {"qkv_m8": 8}
    )

    assert gate.unproven_groups(family) == [["qkv_m8"]]


def test_agreed_groups_are_decided_per_family():
    """A probe run can measure every family but one.

    ``LayoutCheck.probed`` is a single global flag, so it cannot answer "did
    *this* family agree".  The measured family keeps the fingerprint rule; the
    blind one is split by member.
    """
    measured = _family(
        6144, 1024,
        {"o_m8": FP_A, "o_m4096": FP_A},
        {"o_m8": 8, "o_m4096": 4096},
    )
    blind = _family(
        1280, 6144,
        {"qkv_m8": gate.UNRESOLVED, "qkv_m4096": gate.UNRESOLVED},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )

    assert gate.agreed_groups(measured) == [["o_m4096", "o_m8"]]
    assert gate.agreed_groups(blind) == [["qkv_m8"], ["qkv_m4096"]]


def test_groups_lead_with_the_smallest_m():
    """The dispatcher packs from the family's smallest M, so group order follows."""
    family = _family(
        6144, 384,
        {"down_m4096": FP_B, "down_m8": FP_A},
        {"down_m8": 8, "down_m4096": 4096},
    )

    assert gate.family_groups(family) == [["down_m8"], ["down_m4096"]]


# --------------------------------------------------------------------------- #
# Batch packing
# --------------------------------------------------------------------------- #

def test_groups_of_different_families_share_a_batch():
    artifacts = [
        _artifact("qkv_m8", 8, 1280, 6144),
        _artifact("qkv_m4096", 4096, 1280, 6144),
        _artifact("o_m8", 8, 6144, 1024),
        _artifact("o_m4096", 4096, 6144, 1024),
    ]
    families = [
        _family(1280, 6144, {"qkv_m8": FP_A, "qkv_m4096": FP_B},
                {"qkv_m8": 8, "qkv_m4096": 4096}),
        _family(6144, 1024, {"o_m8": FP_A, "o_m4096": FP_A},
                {"o_m8": 8, "o_m4096": 4096}),
    ]

    batches = gate.pack_batches(artifacts, families)

    assert [sorted(item["shape_id"] for item in batch) for batch in batches] == [
        ["o_m4096", "o_m8", "qkv_m8"],
        ["qkv_m4096"],
    ]


def test_every_batch_is_a_union_of_whole_groups():
    artifacts = [
        _artifact(f"qkv_m{m}", m, 1280, 6144) for m in (8, 16, 4096)
    ] + [
        _artifact(f"o_m{m}", m, 6144, 1024) for m in (8, 4096)
    ]
    families = [
        _family(1280, 6144,
                {"qkv_m8": FP_A, "qkv_m16": FP_A, "qkv_m4096": FP_B},
                {"qkv_m8": 8, "qkv_m16": 16, "qkv_m4096": 4096}),
        _family(6144, 1024, {"o_m8": FP_A, "o_m4096": FP_B},
                {"o_m8": 8, "o_m4096": 4096}),
    ]

    batches = gate.pack_batches(artifacts, families)

    seen = [item["shape_id"] for batch in batches for item in batch]
    assert sorted(seen) == sorted(item["shape_id"] for item in artifacts)
    assert [sorted(item["shape_id"] for item in batch) for batch in batches] == [
        ["o_m8", "qkv_m16", "qkv_m8"],
        ["o_m4096", "qkv_m4096"],
    ]
    # A partial group would reintroduce exactly the bug that failed batch 0 of
    # df6fb501 a second time: two members sharing a batch while packing
    # different images.
    allowed = {
        (family.n, family.k): [
            frozenset(group) for group in gate.family_groups(family)
        ]
        for family in families
    }
    for batch in batches:
        by_family: Dict[tuple, set] = {}
        for item in batch:
            key = (item["shape"]["N"], item["shape"]["K"])
            by_family.setdefault(key, set()).add(item["shape_id"])
        for key, members in by_family.items():
            assert frozenset(members) in allowed[key]


# --------------------------------------------------------------------------- #
# Merge wiring
# --------------------------------------------------------------------------- #

def test_plan_splits_a_multi_member_family_when_nothing_is_probed(tmp_path):
    """A blind probe must never merge two M into one pack route.

    ``glm-tp8-m8-16-4096-2663a78f`` reached serial validation with 18 shapes in
    one batch because the probe child could not start and "no conflict" was read
    off a measurement that never happened; the merge then packed with m8 and
    interpreted with m4096, and 99.9% of that shape's output was wrong.
    """
    artifacts = [
        _artifact("qkv_m8", 8, 1280, 6144),
        _artifact("qkv_m4096", 4096, 1280, 6144),
    ]

    # No objects on disk -> nothing measurable -> agreement is unproven.
    check, batches = plan_layout_batches(artifacts, tmp_path)

    assert check.probed is False
    assert check.ok is True  # a failed probe is still not a conflict
    assert [sorted(item["shape_id"] for item in batch) for batch in batches] == [
        ["qkv_m8"],
        ["qkv_m4096"],
    ]


def test_plan_keeps_one_batch_when_a_blind_family_has_one_member(tmp_path):
    """Never sharing a weight means nothing to prove: no extra batch."""
    artifacts = [
        _artifact("o_m8", 8, 6144, 1024),
        _artifact("qkv_m8", 8, 1280, 6144),
    ]

    check, batches = plan_layout_batches(artifacts, tmp_path)

    assert check.probed is False
    assert len(batches) == 1
    assert sorted(item["shape_id"] for item in batches[0]) == ["o_m8", "qkv_m8"]


def test_plan_keeps_one_batch_when_the_probe_measures_one_image(
    tmp_path, monkeypatch
):
    """A working probe that finds agreement costs nothing."""
    artifacts = [
        _artifact("qkv_m8", 8, 1280, 6144),
        _artifact("qkv_m4096", 4096, 1280, 6144),
    ]
    family = _family(
        1280, 6144,
        {"qkv_m8": FP_A, "qkv_m4096": FP_A},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )
    monkeypatch.setattr(
        gate,
        "check",
        lambda *args, **kwargs: gate.LayoutCheck(
            families=[family], probed=True
        ),
    )

    check, batches = plan_layout_batches(artifacts, tmp_path)

    assert check.ok is True
    assert len(batches) == 1
    assert sorted(item["shape_id"] for item in batches[0]) == [
        "qkv_m4096",
        "qkv_m8",
    ]


def test_plan_splits_a_family_the_probe_measured_nothing_for(
    tmp_path, monkeypatch
):
    """``probed=True`` globally must not excuse a family nobody measured.

    One family's members can all fail to probe (a link error) while others measure
    fine.  Deciding from the global flag alone would leave that family sharing one
    pack route -- the silent-merge hole this test closes.
    """
    artifacts = [
        _artifact("o_m8", 8, 6144, 1024),
        _artifact("o_m4096", 4096, 6144, 1024),
        _artifact("qkv_m8", 8, 1280, 6144),
        _artifact("qkv_m4096", 4096, 1280, 6144),
    ]
    measured = _family(
        6144, 1024,
        {"o_m8": FP_A, "o_m4096": FP_A},
        {"o_m8": 8, "o_m4096": 4096},
    )
    blind = _family(
        1280, 6144,
        {"qkv_m8": gate.UNRESOLVED, "qkv_m4096": gate.UNRESOLVED},
        {"qkv_m8": 8, "qkv_m4096": 4096},
    )
    monkeypatch.setattr(
        gate,
        "check",
        lambda *args, **kwargs: gate.LayoutCheck(
            families=[measured, blind], probed=True
        ),
    )

    check, batches = plan_layout_batches(artifacts, tmp_path)

    assert check.probed is True
    assert check.ok is True  # unproven is not a conflict
    assert len(batches) == 2
    contents = [set(item["shape_id"] for item in batch) for batch in batches]
    # The blind family's two M must not share a batch ...
    assert all(not {"qkv_m8", "qkv_m4096"} <= group for group in contents)
    # ... while the measured family stays together in one batch (it agreed).
    assert sum({"o_m8", "o_m4096"} <= group for group in contents) == 1


def test_plan_splits_when_a_family_emits_two_images(tmp_path, monkeypatch):
    artifacts = [
        _artifact("qkv_m8", 8, 1280, 6144),
        _artifact("qkv_m4096", 4096, 1280, 6144),
    ]
    family = _family(1280, 6144, {"qkv_m8": FP_A, "qkv_m4096": FP_B},
                     {"qkv_m8": 8, "qkv_m4096": 4096})
    monkeypatch.setattr(
        gate,
        "check",
        lambda *args, **kwargs: gate.LayoutCheck(
            families=[family], probed=True
        ),
    )

    check, batches = plan_layout_batches(artifacts, tmp_path)

    assert check.ok is False
    assert [sorted(item["shape_id"] for item in batch) for batch in batches] == [
        ["qkv_m8"],
        ["qkv_m4096"],
    ]


def test_batch_zero_renders_into_the_published_tree(tmp_path):
    """Batch 0's dispatch must be in ``final/source`` *before* it compiles.

    Batching once handed every batch its own directory and only rewrote the
    published tree afterwards: the first benchmark then died with
    ``compile inputs are missing: .../final/source/csrc/w8a8_dispatch.cpp``.
    """
    source = tmp_path / "final" / "source"

    assert _layout_batch_source(source, tmp_path, 0, 1) == source
    assert _layout_batch_source(source, tmp_path, 0, 2) == source
    assert _layout_batch_source(source, tmp_path, 1, 2) == (
        tmp_path / "final" / "layout_batches" / "batch1"
    )


# --------------------------------------------------------------------------- #
# The probe image
# --------------------------------------------------------------------------- #

def test_counter_image_is_sensitive_to_a_k_octet_swizzle():
    """The probe image must be able to see a swizzled layout at all.

    A constant or all-zero image makes every permutation compare equal, which
    would silently turn the whole gate into a no-op.
    """
    n, k = 128, 256
    image = gate._counter_image(k, n)

    assert len(image) == n * k
    assert len(set(image)) > 1
    step = image[:2048]
    swizzled = bytearray(2048)
    for row64 in range(64):
        for kk in range(32):
            src = row64 * 32 + kk
            dst = (
                (row64 >> 4) * 512 + ((kk >> 3) << 7)
                + ((row64 & 15) << 3) + (kk & 7)
            )
            swizzled[dst] = step[src]
    assert bytes(swizzled) != step


def test_probe_reports_the_error_instead_of_a_fingerprint(tmp_path):
    """An unreadable pack shows up as an error, never as a fake fingerprint."""
    artifacts = [_artifact("qkv_m8", 8, 1280, 6144)]
    check = gate.check(artifacts, tmp_path)

    member = check.families[0].members[0]
    assert member.fingerprint == gate.UNRESOLVED
    assert "missing" in member.error
    assert check.ok is True  # a failed probe is not a conflict


def _measurable(tmp_path, *shape_ids: str) -> Dict[str, Any]:
    """Artifacts whose prebuilt objects exist, so the probe has work to do."""
    (tmp_path / "prebuilt").mkdir(exist_ok=True)
    artifacts = []
    for shape_id in shape_ids:
        (tmp_path / "prebuilt" / f"{shape_id}.o").write_bytes(b"\x7fELF")
        artifacts.append(_artifact(shape_id, 8, 1280, 6144))
    return artifacts


def test_probe_spawns_a_resolvable_interpreter_without_sys_executable(
    tmp_path, monkeypatch
):
    """The WebUI launcher leaves ``sys.executable`` empty; the probe must not.

    Reproduces the ``glm-tp8-m8-16-4096-2663a78f`` failure: with ``''`` the child
    died with ``PermissionError: [Errno 13] Permission denied: ''``, every member
    stayed ``unresolved``, and the merge fell back to one pack route.
    """
    artifacts = _measurable(tmp_path, "qkv_m8")
    seen: Dict[str, Any] = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        spec = json.loads(Path(cmd[3]).read_text(encoding="utf-8"))
        report = {
            "families": {
                key: {
                    "fingerprints": {item: FP_A for item in entry["members"]},
                    "errors": {},
                }
                for key, entry in spec["families"].items()
            }
        }
        Path(cmd[4]).write_text(json.dumps(report), encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.delenv("METAINFER_PYTHON", raising=False)
    monkeypatch.setattr(sys, "executable", "")
    monkeypatch.setattr(gate.subprocess, "run", fake_run)

    check = gate.check(artifacts, tmp_path)

    assert seen["cmd"][0] != ""
    assert os.path.isfile(seen["cmd"][0])
    assert check.probed is True
    assert check.families[0].members[0].fingerprint == FP_A


def test_probe_failure_names_the_interpreter(tmp_path, monkeypatch):
    """``Permission denied: ''`` alone says nothing; the message must say which."""
    artifacts = _measurable(tmp_path, "qkv_m8")

    def boom(*args, **kwargs):
        raise PermissionError(13, "Permission denied", "")

    monkeypatch.setattr(gate.subprocess, "run", boom)

    check = gate.check(artifacts, tmp_path)

    assert check.probed is False
    assert "interpreter=" in check.probe_error
    assert check.ok is True


def test_each_batch_validates_only_its_own_shapes():
    """A batch cannot validate a shape its extension does not contain.

    df6fb501's batch 0 carries 7 artifacts; validating the task's 10 shapes
    through it sent the other 3 to the last-resort route, which is not a
    statement about that batch (and failed for a reason unrelated to it).
    """
    import inspect

    from ..orchestrator import gen_and_opt_pipeline as gp

    source = inspect.getsource(gp.GenAndOptPipeline._validate_layout_batch)
    assert 'batch_shape_ids' in source
    assert 'if str(shape["id"]) in batch_shape_ids' in source


def test_each_batch_benchmarks_its_own_tree():
    """Batch N must be measured through batch N's dispatch, not batch 0's.

    Sharing one runner across batches left ``runner.source`` at ``final/source``
    forever, so later batches were validated against batch 0's extension:
    ``glm_tp8_fused_qkv_a_proj_m4096`` fell to batch 0's m16 route and measured
    2721 us (correct, but its own kernel does 1191 us), and the perf gate read
    that as a regression of an artifact that was never measured.
    """
    import inspect

    from ..orchestrator import gen_and_opt_pipeline as gp

    source = inspect.getsource(gp.GenAndOptPipeline._validate_layout_batch)
    assert "source=batch_source" in source
    # ... and the shared runner is gone from the merge path.
    merge = inspect.getsource(gp.GenAndOptPipeline._synthesize_final_candidate)
    assert "runner=runner," not in merge


def test_a_blind_gate_is_recorded_in_the_timeline():
    """'Measured nothing' must not look like 'found no conflict'.

    The probe error used to live only inside ``layout_groups``, where it is
    indistinguishable from a clean single-batch merge on the task page.
    """
    import inspect

    from ..orchestrator import gen_and_opt_pipeline as gp

    source = inspect.getsource(gp.GenAndOptPipeline._synthesize_final_candidate)
    assert "final_layout_probe_failed" in source
    assert "layout_check.probe_error" in source
