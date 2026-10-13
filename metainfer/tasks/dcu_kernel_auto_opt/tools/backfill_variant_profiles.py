"""Stamp every variant leaf with the hardware profile that produced it.

Why: variants are stored per profile, but the profile only lived in the *path*
(``variant/<profile>/…``), and staging flattens that level when the tree is
copied into an agent workspace (``references/<family>/…``).  So an agent reading
a staged variant could not tell whether the numbers came from the air board (no
HBM address hashing; read-heavy operators 40-87% slower) or the liquid one --
and the body comment "for Hygon K500SM_AI / gfx928" is generator boilerplate
that appears in air-measured files too.

Rule (evidence first, no guessing):

1. a header that already carries ``hw_profile=`` is left alone;
2. the profile comes from the leaf's own directory (``variant/<profile>/…``),
   which is what ``variant_store`` writes;
3. ``machine`` comes from that profile's entry in the resolver registry
   (``hw_profile.PROFILES[...].hostnames``): ``air-k100ai`` -> ``kme6``,
   ``liquid-k500sm`` -> ``j20r1n08``.  For the 53 pre-split vari: the operator
   statement (2026-09-29) plus the artifacts' ``device_name=K500SM_AI`` both
   say they were measured on the liquid machine;
4. ``measured_on`` is the header's own ``added=`` date, i.e. when the kernel was
   accepted -- never "today".

Only one line is inserted (right before ``// @@end``, matching what
``add_variant`` writes) and the rest of the file is left byte-identical.

Usage::

    python -m metainfer.tasks.dcu_kernel_auto_opt.tools.backfill_variant_profiles
    python -m metainfer.tasks.dcu_kernel_auto_opt.tools.backfill_variant_profiles --apply
"""

from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from metainfer.orchestrator import hw_profile

from ..orchestrator import variant_store

TAG = "hw_profile"


def machine_for(profile_id: str) -> str:
    """Host registered for this profile, or 'unknown'."""
    profile = hw_profile.PROFILES.get(profile_id)
    if profile is None or not profile.hostnames:
        return "unknown"
    return sorted(profile.hostnames)[0]


def _profile_from_path(rel_parts: Tuple[str, ...]) -> Optional[str]:
    if rel_parts and rel_parts[0] in hw_profile.PROFILES:
        return rel_parts[0]
    return None


def _date_from_header(text: str) -> str:
    for line in text.splitlines():
        if line.startswith("// @@variant") and "added=" in line:
            tail = line.split("added=", 1)[1].strip()
            date = tail.split()[0].strip()
            if date:
                return date
    return "unknown"


def _has_profile(text: str) -> bool:
    return f"{TAG}=" in text.split("// @@end", 1)[0]


def stamp(text: str, profile_id: str, machine: str) -> str:
    """Return *text* with one provenance line added to the header block.

    Raises ValueError when the header block is missing.
    """
    if "// @@end" not in text or "// @@variant" not in text:
        raise ValueError("no @@variant header block")
    measured_on = _date_from_header(text)
    line = f"//   {TAG}={profile_id} machine={machine} measured_on={measured_on}"
    lines = text.splitlines(keepends=True)

    # The header block is the ``// @@variant`` line plus the *contiguous run* of
    # "//   " lines right after it (exactly what add_variant writes).
    #
    # Do NOT scan for the last such line before "// @@end": kernel bodies are
    # full of "//   " indented comments, and that mistake put a provenance line
    # 349 lines into a 400-line kernel (caught 2026-09-29, tree restored from
    # backup and re-stamped).
    start = None
    for index, raw in enumerate(lines):
        if raw.startswith("// @@variant"):
            start = index
            break
    if start is None:
        raise ValueError("no @@variant header line")
    insert_at = start
    for index in range(start + 1, len(lines)):
        if not lines[index].startswith("//   "):
            break
        insert_at = index
    lines.insert(insert_at + 1, line + "\n")
    return "".join(lines)


def plan(root: Optional[Path] = None) -> List[Dict[str, Any]]:
    """What would change: one row per variant leaf."""
    root = root or variant_store.variant_root()
    rows: List[Dict[str, Any]] = []
    for path in sorted(root.rglob("*.hip")):
        if path.name.startswith("w8a8_gemm_variants"):
            continue
        rel = path.relative_to(root).parts
        text = path.read_text(encoding="utf-8", errors="replace")
        rows.append({
            "path": str(path.relative_to(root)),
            "profile": _profile_from_path(rel),
            "has_profile": _has_profile(text),
            "action": "skip" if _has_profile(text) else "stamp",
        })
    return rows


def apply(root: Optional[Path] = None, *, backup_root: Optional[Path] = None) -> Dict[str, Any]:
    root = root or variant_store.variant_root()
    if backup_root is not None:
        stamp_dir = backup_root / time.strftime("%Y%m%d-%H%M%S")
        shutil.copytree(root, stamp_dir)
    changed: List[str] = []
    skipped: List[str] = []
    for row in plan(root):
        path = root / row["path"]
        if row["action"] == "skip":
            skipped.append(row["path"])
            continue
        profile_id = row["profile"]
        if profile_id is None:
            profile_id = variant_store.UNMIGRATED_PROFILE
        before = path.read_text(encoding="utf-8", errors="replace")
        after = stamp(before, profile_id, machine_for(profile_id))
        # The only difference must be the inserted line: everything else stays
        # byte-identical, so kernel hashes and review history remain valid.
        assert after.replace(
            f"//   {TAG}={profile_id} machine={machine_for(profile_id)} "
            f"measured_on={_date_from_header(before)}\n", "", 1
        ) == before, f"unexpected edit in {path}"
        path.write_text(after, encoding="utf-8")
        changed.append(row["path"])
    variant_store.invalidate_variant_index()
    return {"changed": changed, "skipped": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-root", default="",
                        help="copy the whole tree here before writing")
    args = parser.parse_args()

    if args.apply:
        report = apply(backup_root=Path(args.backup_root) if args.backup_root else None)
        print(f"stamped {len(report['changed'])}, skipped {len(report['skipped'])}")
        for path in report["changed"][:10]:
            print("  +", path)
        if len(report["changed"]) > 10:
            print(f"  … {len(report['changed']) - 10} more")
    else:
        rows = plan()
        todo = [r for r in rows if r["action"] == "stamp"]
        print(f"DRY RUN: {len(rows)} leaves, {len(todo)} to stamp, "
              f"{len(rows) - len(todo)} already carry {TAG}=")
        for row in todo[:10]:
            print(f"  {row['path']}  -> {row['profile']} "
                  f"machine={machine_for(row['profile'] or '')}")
        if len(todo) > 10:
            print(f"  … {len(todo) - 10} more")
        print("\nre-run with --apply to write")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
