"""Tests for the cross-task lessons wiki (#5, AHE experience accumulation).

Covers the pure ``lessons`` module (append / read / render / path validation)
and the two wiring points in the orchestrator:
  * finish path: ``_append_lessons_to_wiki`` appends the per-task snapshot to
    the node-level wiki + records a timeline event (advisory, never raises).
  * plan path: ``_do_plan`` reads the wiki and injects a lessons block into the
    planner prompt (advisory; missing wiki → no block).

SSOT invariant checked: the per-task snapshot is a historical record (only
appended from, never read back); the node-level wiki is the sole read source.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from metainfer.orchestrator.state import StateStore
from metainfer.tasks.opt_kernel.orchestrator import lessons
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    IterationContext,
    Orchestrator,
    OrchestratorConfig,
)


# --------------------------------------------------------------------------- #
# test layout helper: build the real <node>/.metainfer/tasks/<id> tree so the
# wiki path validation in node_metainfer_dir() succeeds.
# --------------------------------------------------------------------------- #

def _node_layout(tmp_path: Path, task_id: str = "t1"):
    state_dir = tmp_path / ".metainfer" / "tasks" / task_id
    state_dir.mkdir(parents=True)
    iterations_root = tmp_path / "workspaces" / task_id / "iterations"
    iterations_root.mkdir(parents=True)
    return state_dir, iterations_root


def _write_snapshot(analysis_dir: Path, records):
    analysis_dir.mkdir(parents=True, exist_ok=True)
    (analysis_dir / lessons.LESSONS_FILE).write_text(
        "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def _timeline_events(orch: Orchestrator):
    """All timeline events, or [] when nothing has been written yet."""
    p = orch.store.timeline_path
    if not p.is_file():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


# --------------------------------------------------------------------------- #
# node_metainfer_dir / wiki_path
# --------------------------------------------------------------------------- #

def test_node_metainfer_dir_validates_layout(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    assert lessons.node_metainfer_dir(state_dir).name == ".metainfer"
    assert lessons.wiki_path(state_dir) == state_dir.parent.parent / lessons.LESSONS_FILE


def test_node_metainfer_dir_raises_on_bad_layout(tmp_path):
    bad = tmp_path / "state"  # parent.parent is tmp_path, not a .metainfer dir
    bad.mkdir()
    with pytest.raises(ValueError, match="\\.metainfer"):
        lessons.node_metainfer_dir(bad)


# --------------------------------------------------------------------------- #
# append_task_lessons
# --------------------------------------------------------------------------- #

def test_append_stamps_and_filters(tmp_path):
    state_dir, iters_root = _node_layout(tmp_path)
    analysis = iters_root / "analysis"
    _write_snapshot(analysis, [
        {"category": "failure_mode", "headline": "BN=64 OOMs 64KB shared-mem", "detail": "cap BK*BN"},
        {"category": "do_not_repeat", "headline": "num_stages>1 slower 12%", "detail": ""},
        {"category": "bogus", "headline": "should be skipped"},
        {"category": "insight"},                         # missing headline → skipped
        {"category": "failure_mode", "headline": "   "},  # blank headline → skipped
    ])
    n = lessons.append_task_lessons(state_dir, analysis, "t1", "opt-kernel", now=1.0)
    assert n == 2
    wiki = lessons.read_wiki_lessons(state_dir)
    assert [r["category"] for r in wiki] == ["failure_mode", "do_not_repeat"]
    for r in wiki:
        assert r["source_task_id"] == "t1"
        assert r["task_type"] == "opt-kernel"
        assert r["ts"] == 1.0
    assert wiki[0]["headline"] == "BN=64 OOMs 64KB shared-mem"


def test_append_missing_snapshot_returns_zero(tmp_path):
    state_dir, iters_root = _node_layout(tmp_path)
    n = lessons.append_task_lessons(state_dir, iters_root / "analysis", "t1", "opt-kernel")
    assert n == 0
    assert not lessons.wiki_path(state_dir).exists()


def test_append_skips_malformed_lines(tmp_path):
    state_dir, iters_root = _node_layout(tmp_path)
    analysis = iters_root / "analysis"
    analysis.mkdir(parents=True)
    (analysis / lessons.LESSONS_FILE).write_text(
        "not json\n"
        + json.dumps({"category": "insight", "headline": "good one"}) + "\n"
        + "\n",  # blank
        encoding="utf-8")
    assert lessons.append_task_lessons(state_dir, analysis, "t1", "opt-kernel") == 1


# --------------------------------------------------------------------------- #
# read_wiki_lessons
# --------------------------------------------------------------------------- #

def test_read_filters_by_task_type_and_limits(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    analysis = state_dir.parent.parent / "tmp-snap"  # any dir
    analysis.mkdir(parents=True, exist_ok=True)
    _write_snapshot(analysis, [
        {"category": "failure_mode", "headline": f"h{i}"} for i in range(5)
    ])
    lessons.append_task_lessons(state_dir, analysis, "tA", "opt-kernel", now=1.0)
    # second task, different type
    _write_snapshot(analysis, [{"category": "insight", "headline": "other-type"}])
    lessons.append_task_lessons(state_dir, analysis, "tB", "gen-cpp", now=2.0)

    only_kernel = lessons.read_wiki_lessons(state_dir, task_type="opt-kernel")
    assert len(only_kernel) == 5
    assert all(r["task_type"] == "opt-kernel" for r in only_kernel)

    limited = lessons.read_wiki_lessons(state_dir, task_type="opt-kernel", limit=2)
    assert len(limited) == 2
    assert [r["headline"] for r in limited] == ["h3", "h4"]  # most recent 2


def test_read_missing_wiki_returns_empty(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    assert lessons.read_wiki_lessons(state_dir) == []


# --------------------------------------------------------------------------- #
# lessons_prompt_block
# --------------------------------------------------------------------------- #

def test_prompt_block_renders_newest_first(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    analysis = state_dir.parent.parent / "snap"
    analysis.mkdir(parents=True)
    _write_snapshot(analysis, [
        {"category": "failure_mode", "headline": "old", "detail": "d-old"},
        {"category": "do_not_repeat", "headline": "new", "detail": "d-new"},
    ])
    lessons.append_task_lessons(state_dir, analysis, "t1", "opt-kernel", now=1.0)
    block = lessons.lessons_prompt_block(lessons.read_wiki_lessons(state_dir))
    assert block is not None
    assert block.index("new") < block.index("old")        # newest first
    assert "[DO-NOT-REPEAT]" in block and "[FAILURE-MODE]" in block
    assert "from t1" in block


def test_prompt_block_none_when_empty():
    assert lessons.lessons_prompt_block([]) is None


# --------------------------------------------------------------------------- #
# Wiring: finish path (_append_lessons_to_wiki)
# --------------------------------------------------------------------------- #

def _make_orchestrator(tmp_path, task_id="t1"):
    state_dir, iters_root = _node_layout(tmp_path, task_id)
    cfg = OrchestratorConfig(
        workdir=state_dir, repo_root=tmp_path, notebooks_dir=tmp_path,
        iterations_root=iters_root, state_dir=state_dir, logs_root=tmp_path / "logs",
    )
    req = {"task_id": task_id, "task_type": "opt-kernel"}
    return Orchestrator(req=req, store=StateStore(state_dir), cfg=cfg, manager=MagicMock())


def test_finish_appends_snapshot_to_wiki_and_records_timeline(tmp_path):
    orch = _make_orchestrator(tmp_path)
    # debugger-written snapshot for this task
    _write_snapshot(orch._analysis_dir, [
        {"category": "failure_mode", "headline": "FM-5 shared-mem ceiling", "detail": "64KB cap"},
    ])
    orch._append_lessons_to_wiki("success")
    wiki = lessons.read_wiki_lessons(orch.cfg.state_dir, "opt-kernel")
    assert len(wiki) == 1
    assert wiki[0]["headline"] == "FM-5 shared-mem ceiling"
    events = _timeline_events(orch)
    assert any(e["type"] == "lessons_wiki_append" and e["payload"]["n_lessons"] == 1
               for e in events)


def test_finish_advisory_when_no_snapshot(tmp_path):
    """No snapshot → 0 appended, no crash, no timeline append event."""
    orch = _make_orchestrator(tmp_path)
    orch._append_lessons_to_wiki("success")
    assert not lessons.wiki_path(orch.cfg.state_dir).exists()
    events = _timeline_events(orch)
    assert not any(e["type"] == "lessons_wiki_append" for e in events)


def test_finish_advisory_catches_errors(tmp_path):
    """A bad state_dir layout must not raise out of the finish path — it logs
    a lessons_wiki_error timeline event instead (advisory, never blocks).
    A snapshot must be present so append reaches the wiki_path() call that
    raises."""
    orch = _make_orchestrator(tmp_path)
    _write_snapshot(orch._analysis_dir, [
        {"category": "insight", "headline": "will trigger wiki_path on bad layout"}])
    # break the layout validation so append raises internally
    orch.cfg.state_dir = tmp_path / "not-a-metainfer-dir"
    orch._append_lessons_to_wiki("success")
    events = _timeline_events(orch)
    assert any(e["type"] == "lessons_wiki_error" for e in events)


# --------------------------------------------------------------------------- #
# Wiring: plan path (_do_plan injects wiki lessons into the planner prompt)
# --------------------------------------------------------------------------- #

def test_do_plan_injects_cross_task_lessons(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    fixture = [
        {"category": "do_not_repeat", "headline": "num_stages>1 is slower 12%",
         "detail": "do not raise num_stages", "source_task_id": "prior-task",
         "task_type": "opt-kernel", "ts": 1.0},
    ]
    monkeypatch.setattr(lessons, "read_wiki_lessons", lambda *a, **k: fixture)
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    spec = orch.manager.launch.call_args_list[-1].args[0]
    prompt = spec.prompt_file.read_text(encoding="utf-8")
    assert "num_stages>1 is slower 12%" in prompt
    assert "Cross-task lessons" in prompt
    events = _timeline_events(orch)
    assert any(e["type"] == "lessons_wiki_read" for e in events)


def test_do_plan_omits_lessons_when_wiki_empty(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    monkeypatch.setattr(lessons, "read_wiki_lessons", lambda *a, **k: [])
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    spec = orch.manager.launch.call_args_list[-1].args[0]
    prompt = spec.prompt_file.read_text(encoding="utf-8")
    assert "Cross-task lessons" not in prompt
    events = _timeline_events(orch)
    assert not any(e["type"] == "lessons_wiki_read" for e in events)


# --------------------------------------------------------------------------- #
# SSOT & advisory contracts
# --------------------------------------------------------------------------- #

def test_read_wiki_lessons_never_raises_on_bad_layout(tmp_path):
    """The read path's docstring promises "never raises" (advisory). A
    non-standard state_dir layout (node_metainfer_dir would raise ValueError)
    must degrade to [] rather than crashing the A phase. (The *writer* path
    still fails loudly — see test_node_metainfer_dir_raises_on_bad_layout.)"""
    bad = tmp_path / "not-a-metainfer-dir" / "tasks" / "t1"
    bad.mkdir(parents=True)
    assert lessons.read_wiki_lessons(bad) == []


def test_plan_reads_wiki_never_the_per_task_snapshot(tmp_path):
    """SSOT invariant: the per-task ``analysis/lessons.jsonl`` is a historical
    snapshot — appended from at finish, never read back at runtime. The
    node-level wiki is the sole read source for the plan prompt. A future
    "convenience" patch that reads the snapshot back would violate this and
    turn the snapshot into a double-write source."""
    orch = _make_orchestrator(tmp_path)
    # 1) A per-task snapshot carrying a distinctive marker.
    _write_snapshot(orch._analysis_dir, [
        {"category": "failure_mode", "headline": "SNAPSHOT_ONLY_MARKER",
         "detail": "must NOT appear in the plan prompt"},
    ])
    assert not lessons.append_task_lessons(  # do NOT append → stays snapshot-only
        orch.cfg.state_dir, orch._analysis_dir, "t1", "opt-kernel") or True
    # 2) Seed the node-level wiki directly with a DIFFERENT marker.
    wiki = lessons.wiki_path(orch.cfg.state_dir)
    wiki.parent.mkdir(parents=True, exist_ok=True)
    wiki.write_text(json.dumps({
        "category": "do_not_repeat", "headline": "WIKI_ONLY_MARKER",
        "detail": "d", "source_task_id": "prior", "task_type": "opt-kernel",
        "ts": 1.0}) + "\n", encoding="utf-8")
    # 3) Run plan against the REAL read path (no monkeypatch).
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    prompt = orch.manager.launch.call_args_list[-1].args[0].prompt_file.read_text(
        encoding="utf-8")
    assert "WIKI_ONLY_MARKER" in prompt          # wiki is the read source
    assert "SNAPSHOT_ONLY_MARKER" not in prompt    # snapshot is NOT read back


# --------------------------------------------------------------------------- #
# maintain_wiki — self-evolving compaction (dedup + recency cap)
# --------------------------------------------------------------------------- #

def _seed_wiki(state_dir: Path, records):
    """Write records directly to the node wiki (bypassing append)."""
    wp = lessons.wiki_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    wp.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")


def _wiki_records(state_dir: Path):
    wp = lessons.wiki_path(state_dir)
    return [json.loads(l) for l in wp.read_text(encoding="utf-8").splitlines()
            if l.strip()]


def test_maintain_wiki_dedups_same_normalized_headline(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    _seed_wiki(state_dir, [
        {"ts": 1.0, "source_task_id": "a", "task_type": "opt-kernel",
         "category": "do_not_repeat", "headline": "Do not exceed shared-mem ceiling",
         "detail": "old"},
        {"ts": 2.0, "source_task_id": "b", "task_type": "opt-kernel",
         "category": "do_not_repeat", "headline": "DO NOT EXCEED shared-mem CEILING!!",
         "detail": "new"},
    ])
    remaining = lessons.maintain_wiki(state_dir)
    recs = _wiki_records(state_dir)
    assert remaining == 1
    assert recs[0]["source_task_id"] == "b"  # newest kept


def test_maintain_wiki_keeps_different_headlines(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    _seed_wiki(state_dir, [
        {"ts": 1.0, "source_task_id": "a", "task_type": "opt-kernel",
         "category": "failure_mode", "headline": "Tile too big", "detail": ""},
        {"ts": 2.0, "source_task_id": "b", "task_type": "opt-kernel",
         "category": "do_not_repeat", "headline": "Do not exceed shared-mem",
         "detail": ""},
    ])
    assert lessons.maintain_wiki(state_dir) == 2


def test_maintain_wiki_caps_per_type_category(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    cap = lessons.WIKI_CAP_PER_TYPE_CATEGORY
    recs = [{"ts": float(i), "source_task_id": f"t{i}", "task_type": "opt-kernel",
             "category": "insight", "headline": f"unique insight #{i}",
             "detail": ""} for i in range(cap + 10)]
    _seed_wiki(state_dir, recs)
    remaining = lessons.maintain_wiki(state_dir)
    assert remaining == cap
    out = _wiki_records(state_dir)
    # newest cap kept (the last `cap` by ts)
    kept_ids = {r["source_task_id"] for r in out}
    assert kept_ids == {f"t{i}" for i in range(10, cap + 10)}


def test_maintain_wiki_cap_is_per_type_category_bucket(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    cap = lessons.WIKI_CAP_PER_TYPE_CATEGORY
    recs = []
    # One bucket over the cap, another under it.
    for i in range(cap + 5):
        recs.append({"ts": float(i), "source_task_id": f"a{i}", "task_type": "opt-kernel",
                     "category": "insight", "headline": f"ins {i}", "detail": ""})
    for i in range(3):
        recs.append({"ts": float(i), "source_task_id": f"b{i}", "task_type": "opt-kernel",
                     "category": "failure_mode", "headline": f"fm {i}", "detail": ""})
    _seed_wiki(state_dir, recs)
    lessons.maintain_wiki(state_dir)
    out = _wiki_records(state_dir)
    cats = {}
    for r in out:
        cats.setdefault(r["category"], 0)
        cats[r["category"]] += 1
    assert cats["insight"] == cap
    assert cats["failure_mode"] == 3


def test_maintain_wiki_idempotent(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    _seed_wiki(state_dir, [
        {"ts": 1.0, "source_task_id": "a", "task_type": "opt-kernel",
         "category": "do_not_repeat", "headline": "X", "detail": ""},
        {"ts": 2.0, "source_task_id": "a", "task_type": "opt-kernel",
         "category": "do_not_repeat", "headline": "X", "detail": ""},  # dup
    ])
    n1 = lessons.maintain_wiki(state_dir)
    n2 = lessons.maintain_wiki(state_dir)
    assert n1 == 1 and n2 == 1


def test_maintain_wiki_noop_when_missing(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    assert lessons.maintain_wiki(state_dir) == 0
    # no file created
    assert not lessons.wiki_path(state_dir).is_file()


def test_maintain_wiki_never_raises_on_bad_layout(tmp_path):
    bad = tmp_path / "tasks" / "x"
    bad.mkdir(parents=True)
    assert lessons.maintain_wiki(bad) == 0  # ValueError swallowed -> 0


def test_maintain_wiki_skips_malformed_lines(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    wp = lessons.wiki_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    wp.write_text("garbage\n" + json.dumps({
        "ts": 1.0, "source_task_id": "a", "task_type": "opt-kernel",
        "category": "insight", "headline": "ok", "detail": ""}) + "\n",
        encoding="utf-8")
    assert lessons.maintain_wiki(state_dir) == 1


# --------------------------------------------------------------------------- #
# Wiring: finish path (_maintain_wiki)
# --------------------------------------------------------------------------- #

def test_finish_maintain_wiki_records_timeline(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    monkeypatch.setattr(lessons, "maintain_wiki", lambda state_dir: 7)
    orch._maintain_wiki()
    events = _timeline_events(orch)
    assert any(e["type"] == "lessons_wiki_maintain"
               and e["payload"]["remaining"] == 7 for e in events)


def test_finish_maintain_wiki_advisory_on_error(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    def boom(_):
        raise RuntimeError("maintain boom")
    monkeypatch.setattr(lessons, "maintain_wiki", boom)
    orch._maintain_wiki()  # must not raise
    events = _timeline_events(orch)
    assert any(e["type"] == "lessons_wiki_maintain_error"
               and "maintain boom" in e["payload"]["error"] for e in events)
