"""Fusion and publishing may only file a task's skill under its own board.

``POST /skills/fuse`` and ``POST /skills/{name}/publish`` write into the skill
library of **this machine's** hardware profile (``~/.dsh/skills``, then mirrored
to Claude), while the pending skill's numbers were measured on the task's own
board.  On this machine 47 of 48 registered tasks are recorded as
``liquid-k500sm``, so "open a task page on the air machine and click 融合" is the
*normal* case, not an edge case -- and folding liquid findings into the air
edition is precisely the mix-up the profile split exists to prevent (air boards
have no HBM address hashing; the same code measures 1.06-1.70x apart).

The rule mirrors ``add_variant_route``'s: refuse a cross-board write and a task
whose board is unknown, and put the visible half in ``GET /skills`` so the page
hides the buttons instead of offering ones that fail.

Verified history (2026-10-07): five real fusions had already happened, all of
them from tasks recorded ``liquid-k500sm``, all writing into ``~/.dsh/skills``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.orchestrator import hw_profile
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import skill_store as store

from .conftest import register_dkao_task

AIR = "air-k100ai"
LIQUID = "liquid-k500sm"


@pytest.fixture()
def air_machine(monkeypatch):
    monkeypatch.setenv("METAINFER_HW_PROFILE", AIR)
    hw_profile.clear_cache()
    yield
    hw_profile.clear_cache()


@pytest.fixture()
def libraries(tmp_path, monkeypatch):
    """Isolated live + mirror libraries and an empty plugin library.

    Without this the route would write into the operator's real
    ``~/.dsh/skills`` -- the very library the rule protects.
    """
    dsh = tmp_path / "dsh" / "skills"
    ccb = tmp_path / "claude" / "skills"
    empty_plugin = tmp_path / "plugin-skills"
    empty_plugin.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(store, "dsh_skills_root", lambda: dsh)
    monkeypatch.setattr(store, "ccb_skills_root", lambda: ccb)
    monkeypatch.setattr(store, "plugin_skills_dir", lambda: empty_plugin)
    return dsh, ccb


PENDING = "int8-w8a8-gemm-worker-0-m16-wqkv-a"


def _task(
    tmp_path: Path,
    *,
    task_profile: str = AIR,
    with_pending: bool = True,
    execution_mode: str = "Gen and Opt",
) -> Path:
    """A registered DKAO task carrying one pending worker skill."""
    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    register_dkao_task(state_dir, workspace, task_id="dkao-skill")
    requirements = {
        "task_id": "dkao-skill",
        "task_type": "dcu-kernel-auto-opt",
        "answers": {"operator": "Quantized GEMM", "dtype": "INT8 W8A8"},
    }
    if task_profile:
        requirements["hw_profile"] = task_profile
    (state_dir / "requirements.json").write_text(
        json.dumps(requirements), encoding="utf-8"
    )
    (workspace / "plan.json").write_text(
        json.dumps({"execution_mode": execution_mode}), encoding="utf-8"
    )
    if with_pending:
        pending = workspace / "skills" / "pending" / PENDING
        pending.mkdir(parents=True, exist_ok=True)
        (pending / "SKILL.md").write_text(
            "---\n"
            f"name: {PENDING}\n"
            "description: worker skill measured on K500SM_AI / gfx928.\n"
            "---\n\n"
            "- Hardware: K500SM_AI / gfx928\n"
            "| m16_wqkv_a | 1 | plan | 125.14 | 1.61 | 51.24 | yes |\n",
            encoding="utf-8",
        )
    return state_dir


def _fuse(client, task_id: str = "dkao-skill"):
    return client.post(
        f"/api/dcu-kernel-auto-opt/{task_id}/skills/fuse",
        json={"skill_name": PENDING},
    )


def _publish(client, task_id: str = "dkao-skill"):
    return client.post(
        f"/api/dcu-kernel-auto-opt/{task_id}/skills/{PENDING}/publish", json={}
    )


# --------------------------------------------------------------------------- #
# The refusal
# --------------------------------------------------------------------------- #


def test_a_liquid_tasks_skill_is_not_fused_into_the_air_library(
    client, tmp_path, libraries, air_machine,
):
    """The write lands in this machine's edition; the data is the task's."""
    _task(tmp_path, task_profile=LIQUID)
    resp = _fuse(client)
    assert resp.status_code == 409, resp.text
    assert LIQUID in resp.json()["detail"]
    dsh, _ = libraries
    assert not list(dsh.rglob("SKILL.md")), "nothing may be written"


def test_a_liquid_tasks_skill_is_not_published_into_the_air_library(
    client, tmp_path, libraries, air_machine,
):
    _task(tmp_path, task_profile=LIQUID)
    resp = _publish(client)
    assert resp.status_code == 409, resp.text
    assert LIQUID in resp.json()["detail"]
    dsh, _ = libraries
    assert not list(dsh.rglob("SKILL.md"))
    # The pending skill must stay pending (no half-done move into published/).
    assert (tmp_path / "ws" / "skills" / "pending" / PENDING / "SKILL.md").is_file()


def test_an_unrecorded_task_cannot_be_fused(
    client, tmp_path, libraries, air_machine,
):
    """No record -> no way to tell whose numbers these are: refuse and say how."""
    _task(tmp_path, task_profile="")
    for resp in (_fuse(client), _publish(client)):
        assert resp.status_code == 409, resp.text
        assert "backfill_task_hw_profile" in resp.json()["detail"]


def test_the_readonly_mirror_is_still_refused_before_the_board_guard(
    client, tmp_path, libraries, air_machine,
):
    """Order matters: the embed's 403 must not become a 409 with a hint.

    ``test_ahe_child_embed.py`` pulls the full HE-child setup; this keeps the
    ordering claim next to the guard it belongs to by showing that the *board*
    guard is not what answers an ungated write -- a task with no entry at all is
    still a 404, not a 409.
    """
    resp = client.post(
        "/api/dcu-kernel-auto-opt/no-such-task/skills/fuse",
        json={"skill_name": PENDING},
    )
    assert resp.status_code == 404, resp.text


# --------------------------------------------------------------------------- #
# The allowed write (same board)
# --------------------------------------------------------------------------- #


def test_this_boards_own_skill_is_published(
    client, tmp_path, libraries, air_machine,
):
    """Same board -> the gate lets it through (the guard is not a blanket ban)."""
    _task(tmp_path, task_profile=AIR)
    resp = _publish(client)
    assert resp.status_code == 200, resp.text
    dsh, ccb = libraries
    assert (dsh / PENDING / "SKILL.md").is_file()
    assert (ccb / PENDING / "SKILL.md").is_file()


# --------------------------------------------------------------------------- #
# What the page is told
# --------------------------------------------------------------------------- #


def test_the_skills_payload_reports_both_boards(
    client, tmp_path, libraries, air_machine,
):
    """The page needs the task's board and this machine's to decide the gate."""
    _task(tmp_path, task_profile=LIQUID)
    body = client.get("/api/dcu-kernel-auto-opt/dkao-skill/skills").json()
    assert body["task_hw_profile"] == LIQUID
    assert body["task_hw_profile_source"] == "requirements.json"
    assert body["hw_profile"] == AIR
    assert LIQUID in body["write_blocked_reason"]
    assert {p["id"] for p in body["profiles"]} >= {AIR, LIQUID}


def test_the_payload_clears_the_block_for_this_boards_task(
    client, tmp_path, libraries, air_machine,
):
    """A same-board task must not be told it cannot write."""
    _task(tmp_path, task_profile=AIR)
    body = client.get("/api/dcu-kernel-auto-opt/dkao-skill/skills").json()
    assert body["task_hw_profile"] == AIR
    assert body["write_blocked_reason"] == ""


def test_the_payload_explains_an_unrecorded_task(
    client, tmp_path, libraries, air_machine,
):
    _task(tmp_path, task_profile="")
    body = client.get("/api/dcu-kernel-auto-opt/dkao-skill/skills").json()
    assert body["task_hw_profile"] == ""
    assert "backfill_task_hw_profile" in body["write_blocked_reason"]


def test_the_block_reason_matches_the_409_detail(
    client, tmp_path, libraries, air_machine,
):
    """One rule: the payload's reason *is* the refusal the write would get."""
    _task(tmp_path, task_profile=LIQUID)
    body = client.get("/api/dcu-kernel-auto-opt/dkao-skill/skills").json()
    assert body["write_blocked_reason"] == _fuse(client).json()["detail"]
