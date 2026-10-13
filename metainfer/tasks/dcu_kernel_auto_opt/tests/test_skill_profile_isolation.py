"""Skills are knowledge, so they are stored per hardware profile.

Operator requirement (2026-10-06): "液冷和风冷隔离开，风冷就读风冷的 skill" -- the
air board reads the air edition, the liquid board the liquid one, and neither
library ever holds the other board's edition.

The mechanism, and why it is shaped this way:

* the plugin vendors one directory per profile
  (``skills/<profile>/<name>/SKILL.md``), because a skill's numbers are
  hardware dependent;
* the DSH skill provider discovers ``<root>/<name>/SKILL.md`` **one level deep
  only** -- nesting profiles *inside* ``~/.dsh/skills`` would hide every skill
  instead of isolating it -- so exactly one profile's edition may live in the
  live library at a time;
* therefore seeding first **parks** the other board's edition
  (``~/.dsh/.metainfer-skill-libraries/<profile>/<name>``), and only when its
  content is provably that board's bundled copy. A hand-edited or
  round-published skill is never moved.
"""

from __future__ import annotations

import pytest

from metainfer.orchestrator import hw_profile

from ..orchestrator import skill_store as store


AIR = "air-k100ai"
LIQUID = "liquid-k500sm"


def _skill(root, name: str, body: str):
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name}.\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return directory


@pytest.fixture()
def bundled(tmp_path, monkeypatch):
    """A two-profile plugin library, so no assertion touches the real one."""
    root = tmp_path / "plugin-skills"
    for profile in (AIR, LIQUID):
        for name in ("int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations"):
            _skill(root / profile, name, f"body of {name} for {profile}")
    monkeypatch.setattr(store, "plugin_skills_dir", lambda: root)
    return root


@pytest.fixture()
def libraries(tmp_path, monkeypatch):
    """Isolated live + mirror libraries."""
    dsh = tmp_path / "dsh" / "skills"
    ccb = tmp_path / "claude" / "skills"
    monkeypatch.setattr(store, "dsh_skills_root", lambda: dsh)
    monkeypatch.setattr(store, "ccb_skills_root", lambda: ccb)
    return dsh, ccb


def _pin(monkeypatch, profile: str):
    monkeypatch.setenv("METAINFER_HW_PROFILE", profile)
    hw_profile.clear_cache()


@pytest.fixture(autouse=True)
def _clear_cache():
    yield
    hw_profile.clear_cache()


def test_the_plugin_bundles_one_edition_per_profile(bundled):
    assert set(store.bundled_profile_dirs()) == {AIR, LIQUID}
    for profile_dir in store.bundled_profile_dirs().values():
        names = {p.name for p in profile_dir.glob("*/")}
        assert names == {"int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations"}


def test_the_bundled_root_follows_this_machines_profile(
    bundled, monkeypatch
):
    _pin(monkeypatch, AIR)
    assert store.bundled_skills_root() == bundled / AIR
    _pin(monkeypatch, LIQUID)
    assert store.bundled_skills_root() == bundled / LIQUID


def test_an_unmigrated_flat_library_still_seeds(tmp_path, monkeypatch,
                                                libraries):
    """A pre-split checkout (skills stored flat) must not silently seed nothing."""
    flat = tmp_path / "flat-skills"
    _skill(flat, "old-flat-skill", "flat body")
    monkeypatch.setattr(store, "plugin_skills_dir", lambda: flat)
    _pin(monkeypatch, AIR)
    assert store.bundled_profile_dirs() == {}
    assert store.bundled_skills_root() == flat
    seeded = store.seed_bundled_skills()
    assert seeded["added"] == ["old-flat-skill"]


def test_air_seeds_the_air_edition(bundled, libraries, monkeypatch):
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert seeded["profile"] == AIR
    assert sorted(seeded["added"]) == ["int8-w8a8-gemm-decode",
                                       "int8-w8a8-gemm-foundations"]
    text = (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    assert f"for {AIR}" in text
    manifest = store.read_skills_manifest()
    assert manifest["hw_profile"] == AIR
    assert set(manifest["skills"]) == {"int8-w8a8-gemm-decode",
                                       "int8-w8a8-gemm-foundations"}


def test_the_other_boards_pristine_edition_is_parked(bundled, libraries,
                                                     monkeypatch):
    """The regression: an air machine holding the liquid edition.

    This is what the live library looked like before the split -- the plugin's
    skills had been seeded once, from what is now the liquid tree -- so the air
    agent read the liquid numbers.  Seeding must move it out, not leave it.
    """
    dsh, _ = libraries
    _skill(dsh, "int8-w8a8-gemm-decode",
           f"body of int8-w8a8-gemm-decode for {LIQUID}")     # liquid content
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()

    assert [q["name"] for q in seeded["quarantined"]] == ["int8-w8a8-gemm-decode"]
    assert seeded["quarantined"][0]["from_profile"] == LIQUID
    # Gone from the live library, replaced by this board's edition...
    assert f"for {AIR}" in (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    # ...and parked, not deleted.
    archived = store.skills_archive_root() / LIQUID / "int8-w8a8-gemm-decode"
    assert f"for {LIQUID}" in (archived / "SKILL.md").read_text()


def test_a_hand_edited_skill_is_never_moved(bundled, libraries, monkeypatch):
    """The live library is authoritative once an operator has touched it."""
    dsh, _ = libraries
    _skill(dsh, "int8-w8a8-gemm-decode", "hand-tuned body, not a bundled copy")
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert seeded["quarantined"] == []
    assert seeded["local_edits_kept"] == ["int8-w8a8-gemm-decode"]
    assert "hand-tuned body" in (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()


def test_a_skill_that_is_not_ours_is_untouched(bundled, libraries, monkeypatch):
    dsh, _ = libraries
    _skill(dsh, "some-other-package-skill", "third party")
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    assert (dsh / "some-other-package-skill" / "SKILL.md").is_file()
    assert not store.skills_archive_root().exists()


def test_seeding_is_idempotent(bundled, libraries, monkeypatch):
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    first = store.seed_bundled_skills()
    second = store.seed_bundled_skills()
    assert sorted(first["added"]) == ["int8-w8a8-gemm-decode",
                                      "int8-w8a8-gemm-foundations"]
    assert second["added"] == []            # already this board's edition
    assert second["quarantined"] == []
    assert f"for {AIR}" in (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()


def test_switching_profile_swaps_the_edition(bundled, libraries, monkeypatch):
    """The same machine re-imaged (or a cache stale after a firmware change)."""
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    _pin(monkeypatch, LIQUID)
    seeded = store.seed_bundled_skills()
    assert {q["name"] for q in seeded["quarantined"]} == {
        "int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations",
    }
    assert f"for {LIQUID}" in (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    assert (store.skills_archive_root() / AIR
            / "int8-w8a8-gemm-decode" / "SKILL.md").is_file()


def test_an_unresolved_machine_seeds_no_hardware_knowledge(
    bundled, libraries, monkeypatch
):
    """Both editions are wrong somewhere: say so instead of guessing."""
    dsh, _ = libraries
    monkeypatch.setenv("METAINFER_HW_PROFILE_NO_PROBE", "1")
    monkeypatch.setattr(hw_profile, "_hostname", lambda: "ci-runner")
    hw_profile.clear_cache()
    seeded = store.seed_bundled_skills()
    assert seeded["profile"] == ""
    assert seeded["added"] == []
    assert "unresolved" in seeded["reason"]
    assert not dsh.exists() or not any(dsh.glob("*/SKILL.md"))


def test_the_ccb_mirror_is_profile_clean_too(bundled, libraries, monkeypatch):
    """A ccb agent must not keep the other board's edition after the swap."""
    dsh, ccb = libraries
    _pin(monkeypatch, LIQUID)
    store.seed_bundled_skills()
    store.sync_skill_libraries()
    assert f"for {LIQUID}" in (ccb / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()

    _pin(monkeypatch, AIR)                    # same libraries, other board
    summary = store.sync_skill_libraries()
    assert f"for {AIR}" in (ccb / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    assert f"for {AIR}" in (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    assert summary["hw_profile"] == AIR
    assert {q["name"] for q in summary["quarantined"]} >= {"int8-w8a8-gemm-decode"}


def test_the_library_reports_which_profile_is_installed(
    bundled, libraries, monkeypatch, tmp_path
):
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    listed = store.list_skill_library(tmp_path)
    assert listed["hw_profile"] == AIR
    assert listed["installed_profile"] == AIR
    assert {entry["name"] for entry in listed["existing"]} == {
        "int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations",
    }


# --------------------------------------------------------------------------- #
# The shipped library itself
# --------------------------------------------------------------------------- #


def test_every_bundled_edition_carries_its_own_provenance():
    """Read the real vendored tree: each edition names its board and warns."""
    root = store.plugin_skills_dir()
    profiles = store.bundled_profile_dirs()
    assert {AIR, LIQUID} <= set(profiles), profiles
    assert set(profiles[AIR].glob("*/")) and set(profiles[LIQUID].glob("*/"))
    names = {p.name for p in profiles[AIR].glob("*/")}
    assert names == {p.name for p in profiles[LIQUID].glob("*/")}

    for name in sorted(names):
        air_text = (profiles[AIR] / name / "SKILL.md").read_text(encoding="utf-8")
        liquid_text = (profiles[LIQUID] / name / "SKILL.md").read_text(encoding="utf-8")
        assert "K100_AI" in air_text, name
        assert "LIQUID board" in liquid_text, name
        # The air edition states the board gap, or points at this board's own
        # measurements -- it must never inherit the liquid board's numbers.
        assert (
            "1.06-1.70x" in air_text
            or "1.06-1.40x" in air_text
            or "air-measured-baselines" in air_text
        ), name
        assert "worker29" not in air_text, name


def test_a_marked_foreign_edition_is_parked_even_after_edits(
    bundled, libraries, monkeypatch,
):
    """Ownership follows the marker, not the bytes.

    The pre-marker live libraries (the real ones on this machine) cannot be
    classified by content once the editions evolve, so an edition declares its
    board in the file.  A later edit inside that edition does not change which
    board it belongs to.
    """
    dsh, _ = libraries
    _skill(dsh, "int8-w8a8-gemm-decode", "edited body, still the liquid edition")
    skill_md = dsh / "int8-w8a8-gemm-decode" / "SKILL.md"
    skill_md.write_text(
        "<!-- metainfer-edition: liquid-k500sm -->\n"
        + skill_md.read_text(encoding="utf-8"), encoding="utf-8",
    )
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert [q["name"] for q in seeded["quarantined"]] == ["int8-w8a8-gemm-decode"]
    assert f"for {AIR}" in skill_md.read_text(encoding="utf-8")
    assert "edited body" in (
        store.skills_archive_root() / LIQUID / "int8-w8a8-gemm-decode" / "SKILL.md"
    ).read_text(encoding="utf-8")


def test_a_marked_skill_of_this_board_is_left_alone(bundled, libraries,
                                                    monkeypatch):
    dsh, _ = libraries
    _skill(dsh, "int8-w8a8-gemm-decode", f"body of int8-w8a8-gemm-decode for {AIR}")
    skill_md = dsh / "int8-w8a8-gemm-decode" / "SKILL.md"
    skill_md.write_text("<!-- metainfer-edition: air-k100ai -->\n"
                        + skill_md.read_text(encoding="utf-8"), encoding="utf-8")
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert seeded["quarantined"] == []
    assert seeded["local_edits_kept"] == []
    assert seeded["added"] == ["int8-w8a8-gemm-foundations"]   # the other one


def test_every_shipped_edition_declares_its_board():
    """The marker is what the swap relies on: it must be in every SKILL.md."""
    for profile, directory in store.bundled_profile_dirs().items():
        for skill in sorted(directory.glob("*/")):
            assert store.skill_edition(skill) == profile, skill
