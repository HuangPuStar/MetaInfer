"""Generate, inspect, and explicitly publish optimization skills."""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any, Dict, Iterable

from .config import OptimizerConfig, WorkerAssignment, resolve_claude_bin


def _slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value[:63] or "kernel-optimization"


def _frontmatter(name: str, description: str) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        "---\n\n"
    )


def _write_candidate(
    pending_root: Path,
    *,
    name: str,
    kind: str,
    source: str,
    content: str,
) -> Dict[str, Any]:
    """Write one pending skill, stamped with this board.

    A worker/merged skill is **operator knowledge** -- its numbers were measured
    on this machine -- so it carries the edition marker from the moment it is
    written.  That makes its provenance visible in the UI, and it means the
    marker survives publication into the live library even if nothing else
    stamps it.
    """
    target = pending_root / name
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(
        stamp_edition(content, active_profile_id()), encoding="utf-8"
    )
    manifest = {
        "name": name,
        "kind": kind,
        "source": source,
        "status": "pending",
        "created_at": time.time(),
    }
    (target / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def _read_experiments(worker_root: Path) -> list[Dict[str, Any]]:
    experiments: list[Dict[str, Any]] = []
    for path in sorted((worker_root / "runs").glob("*/experiments.jsonl")):
        for line in path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict):
                experiments.append(item)
    return experiments


def generate_worker_skill(
    *,
    config: OptimizerConfig,
    assignment: WorkerAssignment,
    workspace_dir: Path,
    agent_draft: str | None = None,
) -> Dict[str, Any]:
    """Write one skill after a worker has finished all assigned shapes."""
    worker_root = workspace_dir / "workers" / assignment.worker_id
    experiments = _read_experiments(worker_root)
    shape_label = "-".join(assignment.shape_ids)
    name = _slug(
        f"{config.dtype}-{config.operator}-{assignment.worker_id}-{shape_label}"
    )
    description = (
        f"Optimize {config.dtype} {config.operator} on {config.hardware} for "
        f"the shape group {', '.join(assignment.shape_ids)}. Use when tuning "
        "a matching kernel shape or transferring measured worker findings."
    )
    if agent_draft and agent_draft.strip():
        content = _frontmatter(name, description) + agent_draft.strip() + "\n"
        return _write_candidate(
            workspace_dir / "skills" / "pending",
            name=name,
            kind="worker",
            source=assignment.worker_id,
            content=content,
        )

    lines = [
        _frontmatter(name, description),
        f"# {config.dtype} {config.operator}: {assignment.worker_id}",
        "",
        "## Scope",
        "",
        f"- Hardware: {config.hardware}",
        f"- Stack: {config.kernel_language}",
        f"- GPU worker: {assignment.worker_id} / physical GPU {assignment.gpu}",
        f"- Shapes: {', '.join(assignment.shape_ids)}",
        "",
        "## Measured results",
        "",
        "| Shape | Round | Plan | Median (us) | INT8 TOPS | Algorithmic BW (GB/s) | Accepted |",
        "|---|---:|---|---:|---:|---:|---|",
    ]
    for item in experiments:
        metrics = item.get("metrics") or {}
        plan = str(item.get("hypothesis") or "").replace("|", "/")
        lines.append(
            f"| {item.get('shape_id', '—')} | {item.get('iteration', '—')} | "
            f"{plan} | {metrics.get('median_us', '—')} | "
            f"{metrics.get('logical_tops', metrics.get('tflops', '—'))} | "
            f"{metrics.get('algorithmic_bandwidth_gb_s', metrics.get('bandwidth_gb_s', '—'))} | "
            f"{'yes' if item.get('accepted') else 'no'} |"
        )
    manual = [
        str(item["manual_guidance"])
        for item in experiments if item.get("manual_guidance")
    ]
    lines.extend([
        "",
        "## Optimization procedure",
        "",
        "1. Match the incoming dimensions to the measured shape group.",
        "2. Start from the best accepted candidate and preserve the trusted reference.",
        "3. Change one optimization variable per round and record the hypothesis.",
        "4. Reject correctness failures and unstable median or P90 regressions.",
        "5. Re-run the winner in serial validation before integration.",
    ])
    if manual:
        lines.extend([
            "",
            "## Human guidance applied",
            "",
            *[f"- {text}" for text in dict.fromkeys(manual)],
        ])
    lines.extend([
        "",
        "Treat these results as shape-specific evidence; remeasure before "
        "applying them outside the listed dimensions.",
        "",
    ])
    return _write_candidate(
        workspace_dir / "skills" / "pending",
        name=name,
        kind="worker",
        source=assignment.worker_id,
        content="\n".join(lines),
    )


def generate_merged_skill(
    *,
    config: OptimizerConfig,
    assignments: Iterable[WorkerAssignment],
    workspace_dir: Path,
    agent_draft: str | None = None,
    failed_workers: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Create the main-agent synthesis after every worker skill exists."""
    assignments = list(assignments)
    name = _slug(f"{config.dtype}-{config.operator}-optimization")
    description = (
        f"Optimize {config.dtype} {config.operator} across multiple shape "
        f"regimes on {config.hardware}. Use when selecting, tuning, validating, "
        "or integrating a kernel covered by the measured shape families."
    )
    if agent_draft and agent_draft.strip():
        content = _frontmatter(name, description) + agent_draft.strip() + "\n"
        return _write_candidate(
            workspace_dir / "skills" / "pending",
            name=name,
            kind="merged",
            source="main_agent",
            content=content,
        )

    lines = [
        _frontmatter(name, description),
        f"# {config.dtype} {config.operator} optimization",
        "",
        "## Shape routing",
        "",
        "| Worker evidence | Physical GPU | Shapes |",
        "|---|---:|---|",
    ]
    for assignment in assignments:
        lines.append(
            f"| {assignment.worker_id} | {assignment.gpu} | "
            f"{', '.join(assignment.shape_ids)} |"
        )
    if failed_workers:
        lines.extend([
            "",
            "## Unavailable worker evidence",
            "",
            *[
                f"- `{worker_id}`: {failure.get('error', 'worker failed')}"
                for worker_id, failure in sorted(failed_workers.items())
            ],
        ])
    lines.extend([
        "",
        "## Workflow",
        "",
        "1. Route the target shape to the closest measured shape family.",
        "2. Read that worker skill before choosing the first candidate.",
        "3. Preserve quantization, scale, reference, build, and call contracts.",
        "4. Compare stable median, P90, TFLOPS, and bandwidth every round.",
        "5. Feed human guidance only to the selected worker's next round.",
        "6. Validate winners serially and keep per-shape fallbacks.",
        "",
        "## Evidence files",
        "",
    ])
    for assignment in assignments:
        worker_name = _slug(
            f"{config.dtype}-{config.operator}-{assignment.worker_id}-"
            f"{'-'.join(assignment.shape_ids)}"
        )
        lines.append(f"- `{worker_name}/SKILL.md`")
    lines.extend([
        "",
        "Do not infer an unmeasured shape rule solely from a nearby result. "
        "Benchmark the new shape and append evidence before generalizing.",
        "",
    ])
    return _write_candidate(
        workspace_dir / "skills" / "pending",
        name=name,
        kind="merged",
        source="main_agent",
        content="\n".join(lines),
    )


def dsh_skills_root() -> Path:
    """Authoritative skill library (DeepSeek Harness).

    dsh is the canonical library: the fusion agent scans it, and new/updated
    skills land here first. ``sync_skill_libraries()`` then mirrors them into
    the ccb (Claude Code) library so both agent frameworks share one set of
    skills.
    """
    for env in ("DSH_SKILLS_DIR", "METAINFER_SKILLS_DIR"):
        configured = os.environ.get(env)
        if configured:
            return Path(configured).expanduser()
    return Path.home() / ".dsh" / "skills"


def ccb_skills_root() -> Path:
    """Claude Code skill library — the mirror target for dsh skills."""
    configured = os.environ.get("METAINFER_CLAUDE_SKILLS_DIR")
    return (
        Path(configured).expanduser()
        if configured else Path.home() / ".claude" / "skills"
    )


def plugin_skills_dir() -> Path:
    """The plugin's vendored skill library, one directory per hardware profile.

    ``skills/<profile>/<name>/SKILL.md``.  Skills are knowledge, and knowledge
    here is hardware dependent (an air board's kernel numbers are 1.06-1.70x off
    the liquid board's, per operator), so each profile gets its own edition of
    the same skill names -- see ``wiki-metainfer/knowledge-packs.md``.
    """
    return Path(__file__).resolve().parents[1] / "skills"


def bundled_profile_dirs() -> Dict[str, Path]:
    """``{profile_id: dir}`` for every profile the plugin bundles."""
    root = plugin_skills_dir()
    found: Dict[str, Path] = {}
    if not root.is_dir():
        return found
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if (child / "SKILL.md").is_file():
            continue                    # itself a skill: this is the flat layout
        if any((skill / "SKILL.md").is_file() for skill in child.glob("*/")):
            found[child.name] = child
    return found


def active_profile_id() -> str:
    """This machine's hardware profile, or ``""`` when it cannot be resolved.

    Lazy import: ``skill_store`` must stay importable when the DKAO plugin is
    loaded somewhere the resolver is not available (tests, a bare checkout).
    """
    try:
        from metainfer.orchestrator import hw_profile

        return hw_profile.profile_id() or ""
    except Exception:  # noqa: BLE001 - an unknown machine is a normal state
        return ""


def _board_label() -> str:
    """Human-readable board label (``K100_AI / gfx928``), or ``""``.

    Used only for prompt/prose; the *id* is what decides ownership.
    """
    try:
        from metainfer.orchestrator import hw_profile

        return hw_profile.label(fallback="")
    except Exception:  # noqa: BLE001 - an unknown machine is a normal state
        return ""


def bundled_skills_root() -> Path:
    """Seed content for **this machine's** profile.

    Falls back to the root itself for a pre-split checkout (skills stored flat),
    so an unmigrated tree still seeds instead of silently seeding nothing.
    """
    root = plugin_skills_dir()
    profile = active_profile_id()
    if profile:
        candidate = root / profile
        if candidate.is_dir():
            return candidate
    return root


def skills_manifest_path() -> Path:
    """Which profile's edition is installed, and with what content.

    Lives next to the library (never inside it): the skill provider treats every
    direct child of the skills root as a skill, so bookkeeping files must stay
    out of that directory.
    """
    return dsh_skills_root().parent / ".metainfer-skills.json"


def skills_archive_root() -> Path:
    """Where the other profile's editions are parked, one directory per profile."""
    return dsh_skills_root().parent / ".metainfer-skill-libraries"


def read_skills_manifest() -> Dict[str, Any]:
    try:
        payload = json.loads(skills_manifest_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_skills_manifest(profile: str, skills: Dict[str, str]) -> None:
    path = skills_manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "hw_profile": profile,
        "skills": skills,          # name -> sha256(SKILL.md) as installed
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _skill_fingerprint(skill_dir: Path) -> str:
    import hashlib

    skill_md = skill_dir / "SKILL.md"
    try:
        return hashlib.sha256(skill_md.read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


#: Editions carry ``<!-- metainfer-edition: <profile> -->`` as the first body
#: line.  Ownership by marker (not by content hash) is what makes a swap safe:
#: an operator may edit or a round may publish into an edition, and it still
#: belongs to the board it was written for.
_EDITION_RE = re.compile(r"<!--\s*metainfer-edition:\s*([A-Za-z0-9._-]+)\s*-->")


def skill_edition(skill_dir: Path) -> str:
    """The profile an installed skill declares, or ``""`` when unmarked."""
    try:
        text = (skill_dir / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    match = _EDITION_RE.search(text)
    return match.group(1) if match else ""


def is_profile_owned(skill_dir: Path) -> bool:
    """True when a skill declares a board, i.e. it is somebody's *operator*
    knowledge.

    The marker is the split's only ownership signal and it means "operator
    findings measured on <board>".  A skill **without** one is shared knowledge
    -- the DSH-provided ``hygon-dcu-kernel`` / ``dumma-dcu`` and friends describe
    gfx928 itself, not this board's numbers -- so both boards may read it and no
    swap may move it.  That distinction is the whole point of the marker: only
    operator findings split per board.
    """
    return bool(skill_edition(skill_dir))


def _edition_marker(profile: str) -> str:
    return f"<!-- metainfer-edition: {profile} -->"


def stamp_edition(text: str, profile: str) -> str:
    """Return ``text`` carrying exactly one ``metainfer-edition`` marker.

    Written as the first body line (right after the YAML frontmatter), the layout
    the vendored editions use.  Any previous marker is dropped, so a merge can
    never leave the *other* board's declaration behind -- ownership is decided by
    this marker and nothing else.

    ``profile == ""`` returns the text unchanged: a machine whose board cannot be
    resolved must not claim one (``seed_bundled_skills`` refuses to seed in that
    state for the same reason).
    """
    if not profile:
        return text
    match = re.match(r"^(---\n.*?\n---\n)", text, flags=re.DOTALL)
    head = match.group(1) if match else ""
    body = _EDITION_RE.sub("", text[len(head):]).strip("\n")
    marker = _edition_marker(profile)
    if not head:
        return f"{marker}\n\n{body}\n" if body else f"{marker}\n"
    return f"{head}\n{marker}\n\n{body}\n" if body else f"{head}\n{marker}\n"


def _stamp_skill_file(skill_dir: Path, profile: str) -> bool:
    """Stamp ``<skill_dir>/SKILL.md`` in place; ``True`` when it changed."""
    skill_md = skill_dir / "SKILL.md"
    try:
        original = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    stamped = stamp_edition(original, profile)
    if stamped == original:
        return False
    skill_md.write_text(stamped, encoding="utf-8")
    return True


def _marked_skill_names(root: Path | None) -> set:
    """Names in ``root`` that declare a board (see ``is_profile_owned``)."""
    if root is None or not root.is_dir():
        return set()
    names = set()
    for skill in sorted(root.glob("*/")):
        if (skill / "SKILL.md").is_file() and is_profile_owned(skill):
            names.add(skill.name)
    return names


def _bundled_fingerprints() -> Dict[str, Dict[str, str]]:
    """``{profile: {skill_name: fingerprint}}`` over every bundled edition."""
    out: Dict[str, Dict[str, str]] = {}
    for profile, directory in bundled_profile_dirs().items():
        out[profile] = {
            skill.name: _skill_fingerprint(skill)
            for skill in sorted(directory.glob("*/"))
            if (skill / "SKILL.md").is_file()
        }
    return out


def _managed_skill_names(root: Path | None = None) -> set:
    """Skill names this plugin's split owns, in ``root`` too.

    Ownership: what the plugin vendors (any profile's edition), what the manifest
    records, and -- the part that makes fusion safe -- **anything that declares a
    board**, wherever it sits.  A fused or published operator skill is one of
    ours even though the plugin never vendored it, so it has to be swept by a
    profile swap like the vendored ones.  Shared knowledge (no marker) stays out
    of this set on purpose: both boards read it and nothing may move it.
    """
    names = set()
    for skills in _bundled_fingerprints().values():
        names.update(skills)
    names.update(read_skills_manifest().get("skills") or {})
    names.update(_marked_skill_names(dsh_skills_root()))
    names.update(_marked_skill_names(root))
    return names


def quarantine_foreign_skills(*, root: Path | None = None) -> Dict[str, Any]:
    """Move the *other* board's editions out of a live library.

    Requirement (operator, 2026-10-06): the air board must read air skills, and
    the two libraries stay separated.

    Scope (operator, 2026-10-07): **only operator knowledge splits.**  A skill
    that declares a board is this board's measured findings and is swapped like
    the vendored editions; a skill without a marker is shared knowledge
    (``hygon-dcu-kernel``, ``dumma-dcu``, ...) which both boards read and which
    is never moved.  That is what ``_managed_skill_names(root)`` encodes.

    Ownership is decided in this order:

    1. the ``<!-- metainfer-edition: <profile> -->`` marker inside the skill --
       authoritative, and stable even after the edition is edited or published
       into, so a swap never leaves the other board's knowledge behind;
    2. failing that, the content fingerprint: only a skill whose ``SKILL.md``
       matches another profile's bundled edition byte-for-byte is recognised as
       that board's (this is how the pre-marker libraries are classified).

    Anything else is the operator's/history's own business and is reported, not
    moved: the live library is authoritative once a human has touched it.

    Moved, never deleted: ``~/.dsh/.metainfer-skill-libraries/<profile>/<name>``.
    """
    root = root or dsh_skills_root()
    profile = active_profile_id()
    bundled = _bundled_fingerprints()
    moved: list = []
    foreign_kept: list = []
    local: list = []
    current: list = []
    if not root.is_dir():
        return {"quarantined": moved, "foreign_unmodified": foreign_kept,
                "local": local, "current": current, "profile": profile}
    for name in sorted(_managed_skill_names(root=root)):
        live = root / name
        if not (live / "SKILL.md").is_file():
            continue
        declared = skill_edition(live)
        if declared == profile and declared:
            current.append(name)                       # already this board's
            continue
        if declared:
            owner = declared                           # the marker is decisive
        else:
            fingerprint = _skill_fingerprint(live)
            if profile and fingerprint == (bundled.get(profile) or {}).get(name):
                current.append(name)
                continue                               # this profile's edition
            owner = next(
                (other for other, skills in bundled.items()
                 if other != profile and skills.get(name) == fingerprint),
                None,
            )
        if owner is None:
            local.append(name)                         # edited/published here
            continue
        archive = skills_archive_root() / owner / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        if archive.exists():
            shutil.rmtree(archive)
        shutil.move(str(live), str(archive))
        moved.append({"name": name, "from_profile": owner, "archived_at": str(archive)})
    return {"quarantined": moved, "foreign_unmodified": foreign_kept,
            "local": local, "current": current, "profile": profile}


def _restore_archived_owned_skills(root: Path, profile: str) -> list[str]:
    """Move **this board's own** operator skills back out of the archive.

    A swap parks the other board's editions; when the library comes back to this
    board, the operator skills this board wrote (fused or published, so *not*
    vendored) have to come back too -- otherwise an air -> liquid -> air round
    trip would silently drop merged knowledge out of the live library, and the
    agent would read a library that is missing its own findings.

    Vendored names are deliberately skipped: those are the plugin's to seed, and
    an older parked copy must not shadow a newer edition.  Shared knowledge (no
    marker) was never parked in the first place.
    """
    archive = skills_archive_root() / profile
    if not archive.is_dir():
        return []
    vendored: set = set()
    for skills in _bundled_fingerprints().values():
        vendored.update(skills)
    restored: list[str] = []
    for entry in sorted(archive.glob("*/")):
        if entry.name in vendored or not (entry / "SKILL.md").is_file():
            continue
        if (root / entry.name).exists():
            continue                       # a newer local copy wins
        shutil.move(str(entry), str(root / entry.name))
        restored.append(entry.name)
    return restored


def seed_bundled_skills() -> Dict[str, Any]:
    """Install this profile's edition, after parking the other board's.

    Order matters: the foreign edition has to leave the library **before** the
    seed step, or the (identical) skill name would be considered already
    installed and the agent would keep reading the other board's numbers.

    Within one profile the old behaviour is kept: an existing skill is never
    overwritten, so a published or hand-edited skill survives.
    """
    root = dsh_skills_root()
    profile = active_profile_id()
    source = bundled_skills_root()
    quarantine = quarantine_foreign_skills(root=root)
    if not profile:
        # An unidentifiable machine gets no hardware-dependent knowledge: both
        # editions are wrong somewhere.  Say so instead of guessing.
        return {"added": [], "root": str(root), "profile": "",
                "quarantined": quarantine["quarantined"],
                "reason": "hardware profile unresolved; refusing to seed "
                          "hardware-dependent skills"}
    if not source.exists():
        return {"added": [], "root": str(root), "profile": profile,
                "quarantined": quarantine["quarantined"]}
    root.mkdir(parents=True, exist_ok=True)
    restored = _restore_archived_owned_skills(root, profile)
    added: list[str] = []
    for src_dir in sorted(source.glob("*/")):
        if not (src_dir / "SKILL.md").is_file():
            continue
        name = src_dir.name
        dst = root / name
        if dst.exists():
            continue
        shutil.copytree(
            src_dir, dst, ignore=shutil.ignore_patterns("*.bak-*")
        )
        added.append(name)
    profile_dir = bundled_profile_dirs().get(profile)
    bundled_names = (
        {skill.name for skill in profile_dir.glob("*/")} if profile_dir else set()
    )
    installed = {
        skill.name: _skill_fingerprint(skill)
        for skill in sorted(root.glob("*/"))
        if (skill / "SKILL.md").is_file() and skill.name in bundled_names
    }
    _write_skills_manifest(profile, installed)
    return {"added": added, "root": str(root), "profile": profile,
            "restored": restored,
            "quarantined": quarantine["quarantined"],
            "local_edits_kept": quarantine["local"]}


def existing_skills_root() -> Path:
    """The library publish/fuse write into (dsh, the authoritative library)."""
    return dsh_skills_root()


def _skill_entries(root: Path, *, status: str) -> list[Dict[str, Any]]:
    entries = []
    if not root.exists():
        return entries
    for path in sorted(root.glob("*/SKILL.md")):
        manifest_path = path.parent / "manifest.json"
        manifest: Dict[str, Any] = {}
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        entries.append({
            "name": path.parent.name,
            "status": status,
            "kind": manifest.get("kind", "existing"),
            "source": manifest.get("source", "claude"),
            "path": str(path),
            "content": path.read_text(encoding="utf-8", errors="replace"),
        })
    return entries


def _frontmatter_description(content: str) -> str:
    """Pull the one-line description out of a SKILL.md frontmatter block."""
    match = re.match(r"^---\n(.*?)\n---\n", content, flags=re.DOTALL)
    if not match:
        return ""
    desc = re.search(r"(?m)^description:\s*(.+)$", match.group(1))
    if not desc:
        return ""
    return desc.group(1).strip().strip('"').strip("'")


def _copy_skill_dir(src: Path, dst: Path) -> None:
    """Copy one skill directory, skipping manifests and Windows Zone junk."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name == "manifest.json" or "Zone.Identifier" in item.name:
            continue
        if item.is_dir():
            shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dst / item.name)


def _backup_skill(skill_dir: Path) -> Path | None:
    """Snapshot SKILL.md as ``SKILL.md.bak-<ms>`` for rollback."""
    skill = skill_dir / "SKILL.md"
    if not skill.is_file():
        return None
    backup = skill_dir / f"SKILL.md.bak-{int(time.time() * 1000)}"
    shutil.copy2(skill, backup)
    return backup


def _skill_name_set(root: Path) -> set[str]:
    if not root.exists():
        return set()
    return {path.parent.name for path in root.glob("*/SKILL.md")}


# --------------------------------------------------------------------------- #
# dsh -> ccb one-way mirror
# --------------------------------------------------------------------------- #

def _sync_summary_path(workspace_dir: Path) -> Path:
    return workspace_dir / "skills" / "sync.json"


def read_sync_summary(workspace_dir: Path) -> Dict[str, Any]:
    try:
        return json.loads(_sync_summary_path(workspace_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_sync_summary(workspace_dir: Path, summary: Dict[str, Any]) -> None:
    _sync_summary_path(workspace_dir).parent.mkdir(parents=True, exist_ok=True)
    _sync_summary_path(workspace_dir).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sync_skill_libraries(*, workspace_dir: Path | None = None) -> Dict[str, Any]:
    """Seed this profile's skills, then mirror dsh into ccb (one-way).

    First installs any bundled plugin skills (metainfer/.../dcu_kernel_auto_opt/
    skills/<profile>) that are missing from the dsh library -- after parking the
    *other* profile's editions, so this machine never reads the other board's
    numbers (``quarantine_foreign_skills``) -- then copies skills that are new or
    changed in dsh into ccb; never deletes ccb-only skills. A ccb SKILL.md is
    backed up before being overwritten so a bad mirror can be rolled back.
    Idempotent and safe to call repeatedly.
    """
    seeded = seed_bundled_skills()
    source = dsh_skills_root()
    target = ccb_skills_root()
    added: list[str] = []
    updated: list[str] = []
    skipped: list[str] = []
    if source.exists():
        target.mkdir(parents=True, exist_ok=True)
        # The mirror must be profile-clean too, or a ccb agent would read the
        # other board's edition of a skill the dsh library no longer has.
        ccb_quarantine = quarantine_foreign_skills(root=target)
        for src_dir in sorted(source.glob("*/")):
            src_skill = src_dir / "SKILL.md"
            if not src_skill.is_file():
                continue
            name = src_dir.name
            dst = target / name
            dst_skill = dst / "SKILL.md"
            if not dst_skill.is_file():
                _copy_skill_dir(src_dir, dst)
                added.append(name)
            elif dst_skill.read_bytes() != src_skill.read_bytes():
                _backup_skill(dst)
                _copy_skill_dir(src_dir, dst)
                updated.append(name)
            else:
                skipped.append(name)
    else:
        ccb_quarantine = {"quarantined": []}
    summary = {
        "source": str(source),
        "target": str(target),
        "hw_profile": seeded.get("profile", ""),
        "quarantined": list(seeded.get("quarantined") or [])
                       + list(ccb_quarantine.get("quarantined") or []),
        "added": added,
        "updated": updated,
        "skipped": skipped,
        "seeded": sorted(seeded.get("added") or []),
        # This board's own operator skills that came back out of the archive
        # (a swap away and back must not lose fused findings).
        "restored": sorted(seeded.get("restored") or []),
        "ccb_only": sorted(_skill_name_set(target) - _skill_name_set(source)),
        "ts": time.time(),
    }
    if workspace_dir is not None:
        _write_sync_summary(workspace_dir, summary)
    return summary


def rollback_skill(name: str, *, workspace_dir: Path) -> Dict[str, Any]:
    """Restore the latest SKILL.md backup in the dsh library, then re-mirror.

    The restored body is re-stamped with this board: a backup taken before the
    edition markers existed (or before fusion stamped them) must not come back
    unmarked, or it would drop out of the profile split.
    """
    skill_dir = dsh_skills_root() / name
    if not skill_dir.is_dir():
        raise FileNotFoundError(f"skill not found in dsh library: {name}")
    backups = sorted(skill_dir.glob("SKILL.md.bak-*"))
    if not backups:
        raise FileNotFoundError(f"no backup available for skill {name}")
    latest = backups[-1]
    shutil.copy2(latest, skill_dir / "SKILL.md")
    latest.unlink()
    _stamp_skill_file(skill_dir, active_profile_id())
    sync = sync_skill_libraries(workspace_dir=workspace_dir)
    return {
        "name": name,
        "restored_from": str(latest),
        "synced_to_ccb": sync,
    }


# --------------------------------------------------------------------------- #
# Main-agent skill fusion (UI-triggered)
# --------------------------------------------------------------------------- #

def _fuse_status_path(workspace_dir: Path) -> Path:
    return workspace_dir / "skills" / "fuse" / "status.json"


def read_fuse_status(workspace_dir: Path) -> Dict[str, Any]:
    try:
        return json.loads(_fuse_status_path(workspace_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"status": "idle"}


def mark_fuse_running(workspace_dir: Path, skill_name: str) -> None:
    _fuse_status_path(workspace_dir).parent.mkdir(parents=True, exist_ok=True)
    _fuse_status_path(workspace_dir).write_text(
        json.dumps({
            "status": "running",
            "skill_name": skill_name,
            "ts": time.time(),
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _write_fuse_status(workspace_dir: Path, payload: Dict[str, Any]) -> None:
    _fuse_status_path(workspace_dir).parent.mkdir(parents=True, exist_ok=True)
    _fuse_status_path(workspace_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _build_fuse_prompt(
    existing: list[Dict[str, Any]],
    pending_content: str,
    decision_path: Path,
    *,
    profile: str = "",
    board_label: str = "",
) -> str:
    """The fusion agent's instructions.

    Two things the agent cannot infer and must be told, because getting them
    wrong files one board's measurements under the other:

    * **which board this is** -- the library holds that board's editions and the
      write lands there, so only findings measured here may be folded in;
    * **which existing skills are this board's operator knowledge** (marked) and
      which are shared knowledge both boards read (unmarked, never merged into).
    """
    board = f"{profile} ({board_label})" if board_label else (profile or "unknown")
    lines = [
        "You are the skill-fusion agent for DCU kernel optimization.",
        "",
        "Fold the task's newly written optimization skill into the existing",
        "DeepSeek Harness skill library so future agents reuse it. The library",
        "is mirrored to Claude Code automatically, so this one decision applies",
        "to both frameworks.",
        "",
        "## This machine's board",
        "",
        f"This machine is **{board}**, and the library holds that board's editions",
        "(``~/.dsh/skills``). Air boards lack HBM address hashing, so the same",
        "kernel measures 1.06-1.70x apart between boards -- a number measured on",
        "one board is wrong on the other. Fold in only material measured on this",
        "board; nothing else is offered to you.",
        "",
        "Each existing skill below is labelled with its ownership:",
        "",
        "* ``operator knowledge [<board>]`` -- board-specific measured findings,",
        "  i.e. the same kind of material as the new skill. Merging is allowed",
        "  here (and only here).",
        "* ``shared knowledge [no board]`` -- describes gfx928/DTK itself and is",
        "  read by **both** boards. Never merge board-specific numbers into one:",
        "  a refusal is raised server-side. If the new material is really generic",
        "  the operator will promote it separately.",
        "",
        "## Existing skills in the library (name, ownership, body excerpt)",
        "",
    ]
    if not existing:
        lines.append("(the library is empty — add a new skill)")
    for item in existing:
        declared = str(item.get("edition") or "")
        ownership = (
            f"operator knowledge [{declared}]" if declared
            else "shared knowledge [no board]"
        )
        lines.append(f"### {item.get('name')} — {ownership}")
        lines.append(f"description: {item.get('description') or ''}")
        body = item.get("content") or ""
        if body.count("---\n") >= 2:
            first = body.find("---\n")
            body = body[body.find("---\n", first + 1) + 4:]
        body = body.strip()
        if len(body) > 1200:
            body = body[:1200] + "\n... (truncated; read the full file with tools if needed)"
        lines.append(body)
        lines.append("")
    lines.extend([
        "## New skill to fuse",
        "",
        pending_content,
        "",
        "## Decision contract",
        "",
        "Decide whether the new skill should be ADDED as a brand-new skill file or",
        "MERGED into one of the existing skills above (only when the new material is",
        "a natural extension of an existing skill's scope).",
        "",
        f"Write ONE JSON object to `{decision_path}`. No markdown fences, no prose",
        "around it. Schema:",
        '{"action": "new" | "merge", "name": "<skill-name>", "description": "<one-line>", "content": "<complete markdown body, no YAML frontmatter>"}',
        "",
        '- action "new": name must be a short kebab-case id (<=63 chars) that does',
        "  not collide with an existing skill; content is the complete body.",
        '- action "merge": name must be EXACTLY an existing skill\'s name **that is',
        "  labelled operator knowledge**; content is the complete UPDATED body after",
        "  folding the new material in.",
        "- A skill files the board automatically: write the body only, no",
        "  ``metainfer-edition`` marker (the server stamps the machine's board).",
        "- Preserve all existing working knowledge; add the new evidence/rules where",
        "  they fit.",
        "- The body must be concise, actionable Markdown for a kernel-optimization",
        "  agent that runs on DCU (gfx928).",
    ])
    return "\n".join(lines) + "\n"


def _parse_fuse_decision(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        decision = json.loads(cleaned)
    except ValueError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError(
                "skill fusion agent did not return a JSON decision"
            ) from None
        try:
            decision = json.loads(cleaned[start:end + 1])
        except ValueError as exc:
            raise ValueError(
                "skill fusion agent returned unparseable JSON"
            ) from exc
    if not isinstance(decision, dict):
        raise ValueError("skill fusion decision must be a JSON object")
    action = str(decision.get("action") or "").strip().lower()
    if action not in {"new", "merge"}:
        raise ValueError(
            f"skill fusion decision action must be new or merge, got {action!r}"
        )
    name = _slug(str(decision.get("name") or ""))
    if not name:
        raise ValueError("skill fusion decision missing name")
    content = str(decision.get("content") or "").strip()
    if not content:
        raise ValueError("skill fusion decision missing content")
    description = str(decision.get("description") or "").strip()
    return {
        "action": action,
        "name": name,
        "description": description,
        "content": content,
    }


def _apply_fuse_decision(
    decision: Dict[str, Any], *, profile: str
) -> Dict[str, Any]:
    """Apply a parsed fusion decision into the dsh library.

    Everything written here is **this board's operator knowledge**, so it is
    stamped with ``profile`` -- the marker is what makes a later profile swap
    move it (``quarantine_foreign_skills``) instead of leaving this board's
    numbers in the other board's library.

    A merge into shared knowledge is refused rather than stamped: ``hygon-dcu-
    kernel`` and friends carry no board and are read by both boards, so folding
    this board's measured numbers into one would either mislabel shared truth or
    silently un-share it.  Board-specific findings belong in a ``new`` skill.
    """
    root = dsh_skills_root()
    root.mkdir(parents=True, exist_ok=True)
    action = decision["action"]
    name = decision["name"]
    content = decision["content"]
    description = decision["description"]
    if not profile:
        raise RuntimeError(
            "hardware profile unresolved: refusing to file operator knowledge "
            "that cannot be attributed to a board"
        )

    if action == "new":
        target = root / name
        if target.exists():
            raise FileExistsError(
                f"skill {name} already exists in the dsh library; "
                "choose merge or a new name"
            )
        target.mkdir(parents=True, exist_ok=True)
        body = stamp_edition(
            _frontmatter(name, description or f"{name} optimization skill")
            + content + "\n",
            profile,
        )
        (target / "SKILL.md").write_text(body, encoding="utf-8")
        return {
            "action": "new", "name": name, "path": str(target / "SKILL.md"),
            "edition": profile,
        }

    target = root / name
    if not (target / "SKILL.md").is_file():
        raise FileNotFoundError(
            f"merge target skill {name} does not exist in the dsh library"
        )
    declared = skill_edition(target)
    if not declared:
        raise ValueError(
            f"refusing to merge {profile!r} findings into {name!r}: that skill "
            "is shared knowledge (no metainfer-edition marker), so both boards "
            "read it and this board's numbers must not be folded into it. Ask "
            "for a new skill instead."
        )
    if declared != profile:
        raise ValueError(
            f"refusing to merge into {name!r}: it is the {declared!r} edition "
            f"while this machine is {profile!r}; the library still holds the "
            "other board's knowledge -- run 「同步 Skill 库」 first"
        )
    previous = (target / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    backup = _backup_skill(target)
    # Keep the existing frontmatter (the dir name is the skill identity) and the
    # board; only the body is replaced.  Re-stamping also repairs an edition
    # whose marker the agent failed to reproduce.
    fm = re.match(r"^(---\n.*?\n---\n)", previous, flags=re.DOTALL)
    body = stamp_edition(
        (fm.group(1) if fm else _frontmatter(
            name, description or f"{name} optimization skill"
        )) + content + "\n",
        profile,
    )
    (target / "SKILL.md").write_text(body, encoding="utf-8")
    diff = "".join(difflib.unified_diff(
        previous.splitlines(keepends=True),
        body.splitlines(keepends=True),
        fromfile=f"{name}/SKILL.md (before)",
        tofile=f"{name}/SKILL.md (after)",
    ))
    return {
        "action": "merge",
        "name": name,
        "path": str(target / "SKILL.md"),
        "backup": str(backup) if backup else None,
        "diff": diff,
        "edition": profile,
    }


def fuse_skill(
    *,
    config: OptimizerConfig,
    workspace_dir: Path,
    state_dir: Path,
    skill_name: str,
) -> Dict[str, Any]:
    """Fuse one pending skill into the dsh library via the task's main agent.

    Runs the agent with the same framework/model as the task (ccb or dsh).
    The agent scans the existing dsh library, writes a JSON decision
    (new file vs merge into an existing skill), the decision is applied to
    the dsh library, and the result is mirrored to the ccb library.

    The result is **this board's** operator knowledge: it is stamped with the
    machine's edition so a later profile swap carries it along, and a machine
    whose board cannot be resolved refuses to fuse at all.
    """
    profile = active_profile_id()
    if not profile:
        raise RuntimeError(
            "hardware profile unresolved: refusing to fuse operator knowledge "
            "that cannot be attributed to a board"
        )
    pending = workspace_dir / "skills" / "pending" / skill_name
    if not (pending / "SKILL.md").is_file():
        raise FileNotFoundError(f"pending skill not found: {skill_name}")
    pending_content = (pending / "SKILL.md").read_text(
        encoding="utf-8", errors="replace"
    )

    library_root = dsh_skills_root()
    existing = [
        {
            "name": item["name"],
            "description": _frontmatter_description(item["content"]),
            "content": item["content"],
            # Ownership, so the agent knows which targets are this board's
            # operator knowledge and which are shared and untouchable.
            "edition": skill_edition(library_root / item["name"]),
        }
        for item in _skill_entries(library_root, status="existing")
    ]

    fuse_dir = workspace_dir / "skills" / "fuse"
    fuse_dir.mkdir(parents=True, exist_ok=True)
    decision_path = fuse_dir / "decision.json"
    decision_path.unlink(missing_ok=True)
    prompt_file = fuse_dir / "prompt.txt"
    prompt_file.write_text(
        _build_fuse_prompt(
            existing, pending_content, decision_path,
            profile=profile, board_label=_board_label(),
        ),
        encoding="utf-8",
    )

    from metainfer.orchestrator._bootstrap import make_subagent_manager
    from metainfer.orchestrator.subagent_manager import AgentSpec

    manager = make_subagent_manager(
        claude_bin=resolve_claude_bin(config.agent_framework),
        model=config.claude_model,
        permission_mode="bypassPermissions",
        effort="max",
        extra_add_dirs=[workspace_dir, dsh_skills_root()],
        snapshot_file=state_dir / "agents.json",
        max_concurrent=1,
    )
    try:
        manager.launch(AgentSpec(
            name="skill-fusion",
            role="dcu_skill_fusion",
            prompt_file=prompt_file,
            workdir=fuse_dir,
            log_dir=fuse_dir / "logs",
            timeout_s=600,
            stuck_timeout_s=300,
            max_retries=1,
        ))
        agent_result = manager.result("skill-fusion")
        if agent_result is None or not agent_result.success:
            raise RuntimeError(
                agent_result.error if agent_result and agent_result.error
                else "skill fusion agent failed"
            )
        if not decision_path.is_file():
            raise RuntimeError(
                "skill fusion agent did not write a decision file"
            )
        decision = _parse_fuse_decision(
            decision_path.read_text(encoding="utf-8", errors="replace")
        )
        applied = _apply_fuse_decision(decision, profile=profile)
        sync = sync_skill_libraries(workspace_dir=workspace_dir)
        outcome = {
            **applied,
            "synced_to_ccb": {
                "added": sync["added"],
                "updated": sync["updated"],
            },
        }
        _write_fuse_status(workspace_dir, {
            "status": "done", "ok": True, **outcome, "ts": time.time(),
        })
        return outcome
    except Exception as exc:  # noqa: BLE001 - surfaced via the status file
        _write_fuse_status(workspace_dir, {
            "status": "error", "ok": False,
            "error": str(exc), "ts": time.time(),
        })
        raise
    finally:
        manager.close()


def list_skill_library(workspace_dir: Path) -> Dict[str, Any]:
    pending_root = workspace_dir / "skills" / "pending"
    manifest = read_skills_manifest()
    return {
        "existing_root": str(dsh_skills_root()),
        "ccb_mirror_root": str(ccb_skills_root()),
        # Which board's editions this library holds (see ``seed_bundled_skills``).
        "hw_profile": active_profile_id(),
        "installed_profile": manifest.get("hw_profile", ""),
        "existing": _skill_entries(dsh_skills_root(), status="existing"),
        "pending": _skill_entries(pending_root, status="pending"),
        "fuse_status": read_fuse_status(workspace_dir),
        "sync": read_sync_summary(workspace_dir),
    }


def publish_skill(workspace_dir: Path, name: str) -> Dict[str, Any]:
    """Publish one exact pending directory into the dsh library, then mirror
    the result to the ccb library. Never overwrites an existing skill.

    The published skill is operator knowledge measured on this machine, so it is
    stamped with this board's edition: without the marker a profile swap would
    leave it in the other board's library (see ``_managed_skill_names``).
    """
    profile = active_profile_id()
    if not profile:
        raise ValueError(
            "hardware profile unresolved: refusing to publish operator "
            "knowledge that cannot be attributed to a board"
        )
    if _slug(name) != name:
        raise ValueError("invalid skill name")
    source = workspace_dir / "skills" / "pending" / name
    if not (source / "SKILL.md").is_file():
        raise FileNotFoundError(f"pending skill not found: {name}")
    root = dsh_skills_root()
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    if target.exists():
        raise FileExistsError(f"skill already exists: {name}")
    shutil.copytree(
        source, target, ignore=shutil.ignore_patterns("manifest.json")
    )
    _stamp_skill_file(target, profile)
    published = workspace_dir / "skills" / "published" / name
    published.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(published))
    sync = sync_skill_libraries(workspace_dir=workspace_dir)
    return {
        "name": name,
        "path": str(target),
        "status": "existing",
        "edition": profile,
        "synced_to_ccb": {"added": sync["added"], "updated": sync["updated"]},
    }
