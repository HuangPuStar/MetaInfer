"""Running the DKAO tests must not touch the operator's live skill library.

Measured 2026-10-07 (``wiki-metainfer/gotchas/dkao-tests-toggle-live-skill-library.md``):
``GenAndOptPipeline._prepare_worktrees()`` calls ``sync_skill_libraries()`` for
real -- by design, it corrects a stale library before any worker is spawned --
and two tests in ``test_gen_pipeline.py`` call that method directly while pinning
``METAINFER_HW_PROFILE=liquid-k500sm`` for their baseline expectations.  The
suite therefore **physically swapped ``~/.dsh/skills`` (and ``~/.claude/skills``)
between the air and liquid editions**, moving files in and out of the archive,
and a run that failed halfway left the operator reading the other board's skills.

That is now impossible: the package's ``conftest`` redirects both roots into the
test's tmp dir for every test.  These tests are the guard on the guard -- they
assert the redirect is active *and* demonstrate that a raw ``sync_skill_libraries``
under either board leaves the real library byte-identical.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from metainfer.orchestrator import hw_profile

from ..orchestrator import skill_store

_REAL_HOME = Path.home() / ".dsh"
_REAL_DSH = _REAL_HOME / "skills"
_REAL_ARCHIVE = _REAL_HOME / ".metainfer-skill-libraries"
_REAL_MANIFEST = _REAL_HOME / ".metainfer-skills.json"

AIR = "air-k100ai"
LIQUID = "liquid-k500sm"


def _snapshot() -> dict:
    """Names + content hashes of the real library, archive and manifest."""
    out: dict = {}
    for label, root in (("dsh", _REAL_DSH), ("archive", _REAL_ARCHIVE)):
        entries = {}
        if root.is_dir():
            for path in sorted(root.rglob("SKILL.md")):
                entries[str(path.relative_to(root))] = hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()[:16]
            entries["__dirs__"] = sorted(
                str(p.relative_to(root)) for p in root.glob("*/*") if p.is_dir()
            )
        out[label] = entries
    if _REAL_MANIFEST.is_file():
        out["manifest"] = hashlib.sha256(_REAL_MANIFEST.read_bytes()).hexdigest()[:16]
    else:
        out["manifest"] = "-"
    return out


@pytest.fixture(autouse=True)
def _clear_cache():
    yield
    hw_profile.clear_cache()


def test_the_redirect_is_active():
    """Both roots must sit inside the test's tmp dir, not the operator's home."""
    for root in (skill_store.dsh_skills_root(), skill_store.ccb_skills_root()):
        assert _REAL_HOME not in root.parents, (
            f"{root} is the operator's live library: the autouse redirect in "
            "tests/conftest.py is not active"
        )


def test_the_derived_paths_follow_the_redirect():
    """The manifest and the archive are derived from the library root."""
    assert skill_store.skills_manifest_path() == (
        skill_store.dsh_skills_root().parent / ".metainfer-skills.json"
    )
    assert skill_store.skills_archive_root() == (
        skill_store.dsh_skills_root().parent / ".metainfer-skill-libraries"
    )


def test_syncing_as_the_other_board_does_not_touch_the_real_library(monkeypatch):
    """The exact call ``_prepare_worktrees`` makes, under a pinned foreign board.

    Before the guard this moved the real editions into the archive and seeded
    the other board's -- the regression this file exists for.
    """
    if not _REAL_DSH.is_dir():
        pytest.skip("no live library on this host")
    before = _snapshot()

    for profile in (LIQUID, AIR):
        monkeypatch.setenv("METAINFER_HW_PROFILE", profile)
        hw_profile.clear_cache()
        summary = skill_store.sync_skill_libraries()
        # It really did the work -- on the redirected library.
        assert summary["hw_profile"] == profile
        assert _REAL_HOME not in Path(summary["source"]).parents

    assert _snapshot() == before, (
        "the suite mutated the operator's live skill library"
    )


def test_publishing_and_fusing_in_a_test_land_in_the_tmp_library(tmp_path):
    """A write path must not reach the operator's library either."""
    if not _REAL_DSH.is_dir():
        pytest.skip("no live library on this host")
    before = _snapshot()

    pending = tmp_path / "ws" / "skills" / "pending" / "isolation-probe"
    pending.mkdir(parents=True)
    (pending / "SKILL.md").write_text(
        "---\nname: isolation-probe\ndescription: d.\n---\n\n# probe\n",
        encoding="utf-8",
    )
    published = skill_store.publish_skill(tmp_path / "ws", "isolation-probe")
    assert Path(published["path"]).parent == skill_store.dsh_skills_root()

    assert _snapshot() == before
