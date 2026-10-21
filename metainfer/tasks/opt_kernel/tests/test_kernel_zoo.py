"""Tests for the kernel zoo (#7, KDA kernel-zoo integration).

Covers the pure ``kernel_zoo`` module: read (filtered), prompt-block render,
promote (best-iter selection + source inlining + cap), and the advisory
never-raises posture. Reuses the real ``<node>/.metainfer/tasks/<id>`` layout
so the ``node_metainfer_dir`` path validation in ``lessons`` (which
``kernel_zoo.zoo_path`` relies on) succeeds.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from metainfer.tasks.opt_kernel.orchestrator import kernel_zoo


# --------------------------------------------------------------------------- #
# layout + fakes
# --------------------------------------------------------------------------- #

def _node_layout(tmp_path: Path, task_id: str = "t1"):
    state_dir = tmp_path / ".metainfer" / "tasks" / task_id
    state_dir.mkdir(parents=True)
    ws_root = tmp_path / "workspaces" / task_id / "iterations"
    ws_root.mkdir(parents=True)
    return state_dir, ws_root


@dataclass
class _FakeRec:
    iteration: int
    perf: Dict[str, float] = field(default_factory=dict)


class _FakeStore:
    """Plain-dict contract mirroring ``StateStore.load_iteration``."""

    def __init__(self, records: List[_FakeRec]):
        self._records = {r.iteration: r for r in records}

    def load_iteration(self, i: int) -> Optional[Dict[str, Any]]:
        r = self._records.get(i)
        return None if r is None else {"iteration": r.iteration, "perf": r.perf}


class _FakeWorkspace:
    """Workspace stub: ``latest_complete_number`` + ``iter_dir`` pointing at
    real dirs we populate with a kernel file for the chosen iteration."""

    def __init__(self, last: int, root: Path):
        self._last = last
        self._root = root

    def latest_complete_number(self) -> int:
        return self._last

    def iter_dir(self, n: int) -> Path:
        d = self._root / f"{n:03d}"
        d.mkdir(parents=True, exist_ok=True)
        return d


def _write_kernel(iter_dir: Path, name: str, src: str) -> None:
    (iter_dir / name).write_text(src, encoding="utf-8")


def _entry(task_id="t1", task_type="opt-kernel", operator="W8A8 GEMM",
           hardware="MI300", language="Triton", ms=1.8, src="// kernel\n",
           ts=1.0):
    return {
        "ts": ts, "source_task_id": task_id, "task_type": task_type,
        "tags": {"operator": operator, "hardware": hardware,
                 "language": language, "shapes": ""},
        "perf": {"ms_per_op": ms},
        "primary": {"metric": "ms_per_op", "value": ms, "direction": "decrease"},
        "kernel_file": "kernel.py", "kernel_src": src,
        "note": f"promoted from {task_id}",
    }


# --------------------------------------------------------------------------- #
# read_zoo
# --------------------------------------------------------------------------- #

def test_read_zoo_empty_when_missing(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    assert kernel_zoo.read_zoo(state_dir, "opt-kernel") == []


def test_read_zoo_filters_by_task_type_and_tags(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    wp = kernel_zoo.zoo_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    wp.write_text(
        "\n".join(json.dumps(_entry(task_id="a", operator="W8A8 GEMM",
                                    hardware="MI300", language="Triton", ts=1)) for _ in [0])
        + "\n"
        + json.dumps(_entry(task_id="b", operator="Attention",
                            hardware="H100", language="CUDA C++", ts=2))
        + "\n"
        + json.dumps(_entry(task_id="c", task_type="other", operator="W8A8 GEMM",
                            hardware="MI300", language="Triton", ts=3))
        + "\n",
        encoding="utf-8",
    )
    # task_type filter
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel")
    assert [e["source_task_id"] for e in got] == ["b", "a"]  # newest first
    # operator filter
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel", operator="W8A8 GEMM")
    assert [e["source_task_id"] for e in got] == ["a"]
    # hardware + language filter
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel", hardware="H100",
                              language="CUDA C++")
    assert [e["source_task_id"] for e in got] == ["b"]


def test_read_zoo_never_raises_on_bad_layout(tmp_path):
    # A state_dir whose parent.parent is NOT a .metainfer dir → ValueError
    # inside, but read_zoo returns [] (advisory).
    bad = tmp_path / "tasks" / "x"
    bad.mkdir(parents=True)
    assert kernel_zoo.read_zoo(bad, "opt-kernel") == []


def test_read_zoo_skips_malformed_lines(tmp_path):
    state_dir, _ = _node_layout(tmp_path)
    wp = kernel_zoo.zoo_path(state_dir)
    wp.parent.mkdir(parents=True, exist_ok=True)
    wp.write_text("not json\n{}\n" + json.dumps(_entry(task_id="a")) + "\n",
                  encoding="utf-8")
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel")
    assert [e["source_task_id"] for e in got] == ["a"]


# --------------------------------------------------------------------------- #
# zoo_prompt_block
# --------------------------------------------------------------------------- #

def test_zoo_prompt_block_none_when_empty():
    assert kernel_zoo.zoo_prompt_block([]) is None


def test_zoo_prompt_block_renders_scaffold_with_source():
    block = kernel_zoo.zoo_prompt_block([_entry(operator="W8A8 GEMM",
                                                language="Triton", src="def k(): pass")])
    assert "Kernel zoo" in block
    assert "W8A8 GEMM" in block
    assert "STARTING POINT" in block
    assert "def k(): pass" in block
    assert "ms_per_op" in block


# --------------------------------------------------------------------------- #
# _pick_kernel_file
# --------------------------------------------------------------------------- #

def test_pick_kernel_file_chooses_largest_source(tmp_path):
    d = tmp_path / "001"
    d.mkdir()
    (d / "test.sh").write_text("# tiny")  # not a kernel ext
    (d / "small.py").write_text("x = 1")
    (d / "kernel.py").write_text("y = " + "1" * 500)  # largest
    picked = kernel_zoo._pick_kernel_file(d)
    assert picked is not None and picked.name == "kernel.py"


def test_pick_kernel_file_skips_build_dirs(tmp_path):
    d = tmp_path / "001"
    d.mkdir()
    (d / "__pycache__").mkdir()
    (d / "__pycache__" / "huge.py").write_text("z = " + "1" * 5000)
    (d / "k.py").write_text("a = 1")
    picked = kernel_zoo._pick_kernel_file(d)
    assert picked is not None and picked.name == "k.py"


def test_pick_kernel_file_none_when_no_source(tmp_path):
    d = tmp_path / "001"
    d.mkdir()
    (d / "README.md").write_text("hi")
    assert kernel_zoo._pick_kernel_file(d) is None


# --------------------------------------------------------------------------- #
# promote_best
# --------------------------------------------------------------------------- #

def test_promote_best_picks_best_iter_and_inlines_source(tmp_path):
    state_dir, ws_root = _node_layout(tmp_path, "t1")
    # iter1 ms=2.0 (worse), iter2 ms=1.5 (best). iter2 has the kernel.
    store = _FakeStore([_FakeRec(1, {"ms_per_op": 2.0}),
                        _FakeRec(2, {"ms_per_op": 1.5})])
    ws = _FakeWorkspace(2, ws_root)
    _write_kernel(ws.iter_dir(1), "old.py", "old = 1")
    _write_kernel(ws.iter_dir(2), "kernel.py", "def kernel(): pass  # best")
    entry = kernel_zoo.promote_best(
        state_dir, ws, store, "t1", "opt-kernel",
        {"operator": "W8A8 GEMM", "target_hardware": "MI300",
         "kernel_language": "Triton", "input_shapes": "M=4096"})
    assert entry is not None
    assert entry["primary"]["value"] == 1.5
    assert entry["tags"] == {"operator": "W8A8 GEMM", "hardware": "MI300",
                             "language": "Triton", "shapes": "M=4096"}
    assert "def kernel(): pass  # best" in entry["kernel_src"]
    # zoo file written + readable back
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel")
    assert len(got) == 1 and got[0]["primary"]["value"] == 1.5


def test_promote_best_returns_none_when_no_perf(tmp_path):
    state_dir, ws_root = _node_layout(tmp_path, "t1")
    store = _FakeStore([_FakeRec(1, {})])  # no usable perf
    ws = _FakeWorkspace(1, ws_root)
    _write_kernel(ws.iter_dir(1), "k.py", "x=1")
    assert kernel_zoo.promote_best(state_dir, ws, store, "t1", "opt-kernel", {}) is None


def test_promote_best_returns_none_when_no_kernel_file(tmp_path):
    state_dir, ws_root = _node_layout(tmp_path, "t1")
    store = _FakeStore([_FakeRec(1, {"ms_per_op": 1.5})])
    ws = _FakeWorkspace(1, ws_root)
    # iter dir exists but has no kernel-ext file
    ws.iter_dir(1)
    assert kernel_zoo.promote_best(state_dir, ws, store, "t1", "opt-kernel", {}) is None


def test_promote_best_caps_zoo_dropping_oldest(tmp_path):
    state_dir, ws_root = _node_layout(tmp_path, "t1")
    store = _FakeStore([_FakeRec(1, {"ms_per_op": 1.0})])
    ws = _FakeWorkspace(1, ws_root)
    _write_kernel(ws.iter_dir(1), "kernel.py", "k")
    req = {"operator": "W8A8 GEMM", "target_hardware": "MI300",
           "kernel_language": "Triton", "input_shapes": ""}
    # Promote more than MAX_ZOO_ENTRIES times with distinct task_ids/timestamps.
    n = kernel_zoo.MAX_ZOO_ENTRIES + 5
    for i in range(n):
        kernel_zoo.promote_best(state_dir, ws, store, f"t{i}", "opt-kernel",
                                req, now=float(i))
    got = kernel_zoo.read_zoo(state_dir, "opt-kernel", limit=0)
    assert len(got) == kernel_zoo.MAX_ZOO_ENTRIES
    # Oldest (t0..t4) dropped; newest kept. newest-first ordering:
    assert got[0]["source_task_id"] == f"t{n-1}"
    assert got[-1]["source_task_id"] == f"t{5}"


def test_promote_best_truncates_large_source(tmp_path):
    state_dir, ws_root = _node_layout(tmp_path, "t1")
    store = _FakeStore([_FakeRec(1, {"ms_per_op": 1.0})])
    ws = _FakeWorkspace(1, ws_root)
    big = "# line\n" * (kernel_zoo.MAX_SRC_INLINE // 4)  # well over the cap
    _write_kernel(ws.iter_dir(1), "kernel.py", big)
    entry = kernel_zoo.promote_best(state_dir, ws, store, "t1", "opt-kernel", {})
    assert entry is not None
    assert len(entry["kernel_src"]) <= kernel_zoo.MAX_SRC_INLINE + 200  # +marker
    assert "truncated" in entry["kernel_src"]


def test_promote_best_never_raises_on_bad_layout(tmp_path):
    bad = tmp_path / "tasks" / "x"
    bad.mkdir(parents=True)
    # Should swallow the ValueError and return None, not raise.
    assert kernel_zoo.promote_best(bad, _FakeWorkspace(0, tmp_path),
                                   _FakeStore([]), "t", "opt-kernel", {}) is None

# --------------------------------------------------------------------------- #
# Wiring: finish path (_promote_kernel_to_zoo) + plan path (_do_plan reads zoo)
# --------------------------------------------------------------------------- #

from unittest.mock import MagicMock

from metainfer.orchestrator.state import StateStore
from metainfer.tasks.opt_kernel.orchestrator.pipeline import (
    IterationContext,
    Orchestrator,
    OrchestratorConfig,
)


def _make_orchestrator(tmp_path, task_id="t1", req_extra=None):
    state_dir, iters_root = _node_layout(tmp_path, task_id)
    cfg = OrchestratorConfig(
        workdir=state_dir, repo_root=tmp_path, notebooks_dir=tmp_path,
        iterations_root=iters_root, state_dir=state_dir, logs_root=tmp_path / "logs",
    )
    req = {"task_id": task_id, "task_type": "opt-kernel",
           "operator": "W8A8 GEMM", "target_hardware": "MI300",
           "kernel_language": "Triton"}
    if req_extra:
        req.update(req_extra)
    return Orchestrator(req=req, store=StateStore(state_dir), cfg=cfg,
                       manager=MagicMock())


def _timeline_events(orch):
    p = orch.store.timeline_path
    return ([json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()
             if l.strip()] if p.is_file() else [])


def test_finish_promotes_best_kernel_and_records_timeline(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    fake = {"source_task_id": "t1", "task_type": "opt-kernel",
            "primary": {"metric": "ms_per_op", "value": 1.5, "direction": "decrease"},
            "note": "promoted from t1 (iter 2)"}
    monkeypatch.setattr(kernel_zoo, "promote_best",
                        lambda *a, **k: fake)
    orch._promote_kernel_to_zoo("success")
    events = _timeline_events(orch)
    assert any(e["type"] == "kernel_zoo_promote"
               and e["payload"]["primary"]["value"] == 1.5
               for e in events)


def test_finish_promote_advisory_when_no_entry(tmp_path, monkeypatch):
    """promote_best returns None → no timeline event, no crash."""
    orch = _make_orchestrator(tmp_path)
    monkeypatch.setattr(kernel_zoo, "promote_best", lambda *a, **k: None)
    orch._promote_kernel_to_zoo("success")
    assert not any(e["type"] == "kernel_zoo_promote" for e in _timeline_events(orch))


def test_finish_promote_advisory_catches_errors(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    monkeypatch.setattr(kernel_zoo, "promote_best",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    orch._promote_kernel_to_zoo("success")
    assert any(e["type"] == "kernel_zoo_promote_error"
               and "boom" in e["payload"]["error"] for e in _timeline_events(orch))


def test_do_plan_injects_kernel_zoo_block(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    fake_entries = [_entry(operator="W8A8 GEMM", language="Triton",
                           src="def reused(): pass")]
    monkeypatch.setattr(kernel_zoo, "read_zoo", lambda *a, **k: fake_entries)
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    spec = orch.manager.launch.call_args_list[-1].args[0]
    prompt = spec.prompt_file.read_text(encoding="utf-8")
    assert "Kernel zoo" in prompt
    assert "def reused(): pass" in prompt
    assert any(e["type"] == "kernel_zoo_read" and e["payload"]["n_entries"] == 1
               for e in _timeline_events(orch))


def test_do_plan_omits_zoo_when_empty(tmp_path, monkeypatch):
    orch = _make_orchestrator(tmp_path)
    monkeypatch.setattr(kernel_zoo, "read_zoo", lambda *a, **k: [])
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    spec = orch.manager.launch.call_args_list[-1].args[0]
    prompt = spec.prompt_file.read_text(encoding="utf-8")
    assert "Kernel zoo" not in prompt
    assert not any(e["type"] == "kernel_zoo_read" for e in _timeline_events(orch))


def test_do_plan_records_flow_in_search_mode_event(tmp_path, monkeypatch):
    """The search_mode timeline event must carry the resolved ``flow`` so the
    UI / audit can tell flame_chase from ralph_loop / rlar runs."""
    orch = _make_orchestrator(tmp_path, req_extra={"flow": "ralph_loop"})
    monkeypatch.setattr(kernel_zoo, "read_zoo", lambda *a, **k: [])
    iter_dir = orch.workspace.open_iteration(1)
    orch._do_plan(1, iter_dir, IterationContext())
    sm = [e for e in _timeline_events(orch) if e["type"] == "search_mode"]
    assert sm and sm[-1]["payload"]["flow"] == "ralph_loop"
    assert sm[-1]["payload"]["mode"] == "fine_tune"  # ralph_loop never rewrites
