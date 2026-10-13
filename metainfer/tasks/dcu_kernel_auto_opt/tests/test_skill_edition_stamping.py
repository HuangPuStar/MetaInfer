"""Operator knowledge splits per board; shared knowledge is shared.

Operator requirement (2026-10-07): *"我想要的是风冷的 skill 和液冷的 skill 分开。
让风冷的机器上，读取风冷的 skill，融合也自然是风冷的 skill"*, refined with
*"仅仅是[算子]产生的 skill [分档]，如果是通用的知识类 skill，则可以共享"*.

That makes the ``<!-- metainfer-edition: <profile> -->`` marker mean **"this is
operator knowledge measured on that board"**:

* every skill this plugin/agent writes into the live library (a worker finding,
  a fused skill, a published skill) is stamped with the machine's board, so a
  later profile swap carries it out of the other board's library;
* a skill **without** a marker is shared knowledge (``hygon-dcu-kernel``,
  ``dumma-dcu``: they describe gfx928/DTK, not this board's numbers) and no swap
  may touch it -- which is also why a fusion may not merge board-specific
  findings into one;
* a swap away and back must not lose this board's own fused skills.

Before this, the marker existed only on the vendored editions and nothing wrote
it: a published skill stayed in the live library through a profile swap, so an
air machine whose library had been switched kept reading air findings as liquid
knowledge (measured 2026-10-07).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.orchestrator import hw_profile

from ..orchestrator import skill_store as store

AIR = "air-k100ai"
LIQUID = "liquid-k500sm"


# --------------------------------------------------------------------------- #
# Fixtures (same shape as test_skill_profile_isolation.py)
# --------------------------------------------------------------------------- #


def _skill(root: Path, name: str, body: str, *, edition: str = "") -> Path:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    marker = f"<!-- metainfer-edition: {edition} -->\n\n" if edition else ""
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name}.\n---\n\n{marker}{body}\n",
        encoding="utf-8",
    )
    return directory


@pytest.fixture()
def bundled(tmp_path, monkeypatch):
    """A two-profile plugin library, so no assertion touches the real one."""
    root = tmp_path / "plugin-skills"
    for profile in (AIR, LIQUID):
        for name in ("int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations"):
            _skill(root / profile, name, f"body of {name} for {profile}",
                   edition=profile)
    monkeypatch.setattr(store, "plugin_skills_dir", lambda: root)
    return root


@pytest.fixture()
def libraries(tmp_path, monkeypatch):
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


def _pending(workspace: Path, name: str, body: str) -> Path:
    directory = workspace / "skills" / "pending" / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name}.\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return directory


# --------------------------------------------------------------------------- #
# The stamp itself
# --------------------------------------------------------------------------- #


def test_stamp_puts_the_marker_as_the_first_body_line():
    stamped = store.stamp_edition(
        "---\nname: s\ndescription: d.\n---\n\n# Body\ntext\n", AIR
    )
    assert stamped == (
        "---\nname: s\ndescription: d.\n---\n\n"
        "<!-- metainfer-edition: air-k100ai -->\n\n# Body\ntext\n"
    )


def test_stamp_replaces_a_foreign_marker_instead_of_keeping_it():
    """A merge must never leave the other board's declaration in the file."""
    stamped = store.stamp_edition(
        "---\nname: s\ndescription: d.\n---\n\n"
        "<!-- metainfer-edition: liquid-k500sm -->\n\n# Body\n",
        AIR,
    )
    assert "liquid-k500sm" not in stamped
    assert stamped.count("metainfer-edition") == 1
    assert "metainfer-edition: air-k100ai" in stamped


def test_stamp_is_idempotent():
    once = store.stamp_edition("---\nname: s\n---\n\n# Body\n", AIR)
    assert store.stamp_edition(once, AIR) == once


def test_an_unresolved_machine_stamps_nothing():
    """No board -> no claim.  An unknown machine must not brand a sign."""
    text = "---\nname: s\n---\n\n# Body\n"
    assert store.stamp_edition(text, "") == text


# --------------------------------------------------------------------------- #
# What the pipeline writes
# --------------------------------------------------------------------------- #


def test_a_worker_candidate_is_stamped_with_this_board(tmp_path, monkeypatch,
                                                       libraries):
    """The pending skill states its board from the moment it is written."""
    _pin(monkeypatch, AIR)
    store._write_candidate(tmp_path / "pending", name="w0-m16", kind="worker",
                           source="worker_0",
                           content="---\nname: w0-m16\n---\n\n# w0\n")
    text = (tmp_path / "pending" / "w0-m16" / "SKILL.md").read_text()
    assert store.skill_edition(tmp_path / "pending" / "w0-m16") == AIR
    assert "metainfer-edition: air-k100ai" in text


def test_a_published_skill_carries_this_boards_marker(tmp_path, monkeypatch,
                                                      libraries):
    _pin(monkeypatch, AIR)
    dsh, ccb = libraries
    _pending(tmp_path / "ws", "my-air-finding", "# measured on air\n")
    result = store.publish_skill(tmp_path / "ws", "my-air-finding")

    assert result["edition"] == AIR
    assert store.skill_edition(dsh / "my-air-finding") == AIR
    # ...and it is now something a swap must sweep.
    assert "my-air-finding" in store._managed_skill_names(root=dsh)
    assert (ccb / "my-air-finding" / "SKILL.md").is_file()


def test_a_fused_new_skill_carries_this_boards_marker(tmp_path, monkeypatch,
                                                      libraries):
    _pin(monkeypatch, AIR)
    dsh, _ = libraries
    applied = store._apply_fuse_decision(
        {"action": "new", "name": "air-only-lesson", "description": "d.",
         "content": "# lesson\n"},
        profile=AIR,
    )
    assert applied["edition"] == AIR
    assert store.skill_edition(dsh / "air-only-lesson") == AIR


def test_a_merge_keeps_the_board_even_if_the_agent_drops_the_marker(
    bundled, libraries, monkeypatch,
):
    """The agent is asked to write the body only; the server owns the marker."""
    _pin(monkeypatch, AIR)
    dsh, _ = libraries
    store.seed_bundled_skills()
    store._apply_fuse_decision(
        {"action": "merge", "name": "int8-w8a8-gemm-decode",
         "description": "d.", "content": "# merged body, no marker\n"},
        profile=AIR,
    )
    text = (dsh / "int8-w8a8-gemm-decode" / "SKILL.md").read_text()
    assert store.skill_edition(dsh / "int8-w8a8-gemm-decode") == AIR
    assert "# merged body, no marker" in text


def test_merging_into_shared_knowledge_is_refused(libraries, monkeypatch):
    """Generic skills are read by both boards: never fold board numbers in."""
    _pin(monkeypatch, AIR)
    dsh, _ = libraries
    _skill(dsh, "hygon-dcu-kernel", "generic gfx928 knowledge")   # no marker
    with pytest.raises(ValueError) as excinfo:
        store._apply_fuse_decision(
            {"action": "merge", "name": "hygon-dcu-kernel", "description": "d.",
             "content": "# air numbers\n"},
            profile=AIR,
        )
    assert "shared knowledge" in str(excinfo.value)
    assert "generic gfx928 knowledge" in (
        dsh / "hygon-dcu-kernel" / "SKILL.md"
    ).read_text(), "the shared skill must be untouched"


def test_merging_into_the_other_boards_edition_is_refused(libraries,
                                                          monkeypatch):
    """A stale library (still holding liquid) must not absorb air findings."""
    _pin(monkeypatch, AIR)
    dsh, _ = libraries
    _skill(dsh, "int8-w8a8-gemm-decode", "liquid body", edition=LIQUID)
    with pytest.raises(ValueError) as excinfo:
        store._apply_fuse_decision(
            {"action": "merge", "name": "int8-w8a8-gemm-decode",
             "description": "d.", "content": "# air\n"},
            profile=AIR,
        )
    assert LIQUID in str(excinfo.value)


def test_an_unresolved_machine_refuses_to_fuse(libraries, monkeypatch):
    with pytest.raises(RuntimeError):
        store._apply_fuse_decision(
            {"action": "new", "name": "x", "description": "d.", "content": "b"},
            profile="",
        )


# --------------------------------------------------------------------------- #
# The swap: what moves, what stays shared, and the round trip
# --------------------------------------------------------------------------- #


def test_a_foreign_published_skill_is_parked_by_a_swap(
    tmp_path, monkeypatch, bundled, libraries,
):
    """The measured regression: an air finding surviving into the liquid library."""
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    _pending(tmp_path / "ws", "my-air-finding", "# measured on air\n")
    store.publish_skill(tmp_path / "ws", "my-air-finding")
    assert (dsh / "my-air-finding" / "SKILL.md").is_file()

    _pin(monkeypatch, LIQUID)
    seeded = store.seed_bundled_skills()
    assert "my-air-finding" in {q["name"] for q in seeded["quarantined"]}, (
        "an unmarked published skill used to stay here -- the reported bug"
    )
    assert not (dsh / "my-air-finding").exists()
    assert "measured on air" in (
        store.skills_archive_root() / AIR / "my-air-finding" / "SKILL.md"
    ).read_text()
    # The library is clean: only the liquid editions remain.
    assert {store.skill_edition(d) for d in dsh.glob("*/")} == {LIQUID}


def test_shared_knowledge_is_never_moved_by_a_swap(bundled, libraries,
                                                   monkeypatch):
    """``hygon-dcu-kernel`` describes the chip, not this board's numbers."""
    dsh, _ = libraries
    _skill(dsh, "hygon-dcu-kernel", "generic gfx928 knowledge")
    _pin(monkeypatch, LIQUID)
    seeded = store.seed_bundled_skills()
    assert seeded["quarantined"] == []
    assert seeded["local_edits_kept"] == []
    assert (dsh / "hygon-dcu-kernel" / "SKILL.md").is_file()
    assert not store.skills_archive_root().exists()


def test_this_boards_own_findings_come_back_after_a_round_trip(
    tmp_path, monkeypatch, bundled, libraries,
):
    """air -> liquid -> air must not silently drop fused operator knowledge."""
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    _pending(tmp_path / "ws", "my-air-finding", "# measured on air\n")
    store.publish_skill(tmp_path / "ws", "my-air-finding")

    _pin(monkeypatch, LIQUID)
    store.seed_bundled_skills()
    assert not (dsh / "my-air-finding").exists()

    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert seeded["restored"] == ["my-air-finding"]
    assert (dsh / "my-air-finding" / "SKILL.md").is_file()
    assert store.skill_edition(dsh / "my-air-finding") == AIR
    # And the library is this board's, both vendored and written.
    assert {store.skill_edition(d) for d in dsh.glob("*/")} == {AIR}


def test_a_parked_vendored_edition_is_not_restored_over_the_seed(
    bundled, libraries, monkeypatch,
):
    """Only this board's *own* skills come back; the plugin owns its editions.

    A parked vendored copy must never be moved back: it could be an older edition
    than the one the plugin ships now.  Vendored names come back through the
    seed step (``added``), never through the restore step.
    """
    dsh, _ = libraries
    _pin(monkeypatch, AIR)
    store.seed_bundled_skills()
    _pin(monkeypatch, LIQUID)
    store.seed_bundled_skills()          # parks the air editions
    _pin(monkeypatch, AIR)
    seeded = store.seed_bundled_skills()
    assert seeded["restored"] == [], "a vendored edition came back via the archive"
    assert sorted(seeded["added"]) == [
        "int8-w8a8-gemm-decode", "int8-w8a8-gemm-foundations",
    ], "the air editions must come back from the plugin, not from the archive"
    assert "for air-k100ai" in (
        dsh / "int8-w8a8-gemm-decode" / "SKILL.md"
    ).read_text()
    # The parked copies are still parked (nothing moved them back out).
    assert (store.skills_archive_root() / AIR / "int8-w8a8-gemm-decode").is_dir()
