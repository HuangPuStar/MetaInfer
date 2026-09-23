"""Losing the champion bookkeeping must be loud, and must not lose the champion.

``best_ever.json`` + the generation log decide what later rounds compare
against. When that write failed it used to be swallowed into a timeline row
(``champion_record_failed``) and nothing else — 26 of them in one run on
2026-09-11, all ``AttributeError`` — so the run carried on against a champion
chain nobody could vouch for.

Now a failure is visible (stderr, i.e. the orchestrator log), keeps its
traceback, and is followed by a rebuild of the champion from the generations
already on disk.
"""

from __future__ import annotations

import json
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator import pipeline as P
from metainfer.tasks.harness_evolve.orchestrator.champion_selection import (
    Generation, record_generation,
)
from metainfer.tasks.harness_evolve.orchestrator.config import ExperimentConfig


def _cfg(tmp_path: Path) -> ExperimentConfig:
    cfg = ExperimentConfig(
        task_id="he-champion", state_dir=tmp_path / "state",
        workspace_dir=tmp_path / "exp", suite=[], answers={},
        execution_mode="dry-run", per_round_budget=4, max_iterations=1,
    )
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    cfg.exp_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def _generation(exp: Path, iteration: int, median_us: float) -> Generation:
    """A generation on disk, the way the loop leaves one behind.

    ``load_generations`` reads each generation's measurements back from
    ``runs/iteration_NNN/input/benchmark/results.json``, so a usable champion
    needs both files — that is what the rebuild fallback replays.
    """
    generation = Generation(
        iteration=iteration,
        verdict="PROMOTE",
        results={"op00": {"median_us": median_us, "passed": True}},
        snapshot_dir=f"/tmp/snap-{iteration}",
        workspace_revision=f"rev-{iteration}",
        pass_count=1,
    )
    record_generation(exp, generation)
    results_path = (exp / "runs" / f"iteration_{iteration:03d}" / "input"
                    / "benchmark" / "results.json")
    results_path.parent.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(
        {"iteration": iteration, "results": generation.results}),
        encoding="utf-8")
    return generation


def _events(cfg: ExperimentConfig) -> list:
    path = Path(cfg.state_dir) / "timeline.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line)["type"]
            for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_a_healthy_record_writes_the_champion(tmp_path):
    cfg = _cfg(tmp_path)
    _generation(cfg.exp_dir, 1, median_us=11.0)

    outcome = P._record_champion_generation(
        cfg, cfg.exp_dir, iteration=1, decision={"verdict": "PROMOTE"},
        decision_rate=1.0, snapshot=Path("/tmp/snap-1"),
        live_workspace=cfg.workspace_dir, results={"op00": {"passed": True}},
        current={})

    assert outcome["recorded"] is True and outcome["recovered"] is False
    best = json.loads((cfg.exp_dir / "best_ever.json").read_text())
    assert best["iteration"] == 1
    assert "champion_best_measured" in _events(cfg)


def test_a_failed_record_is_loud_and_rebuilds_the_champion(tmp_path, monkeypatch,
                                                           capsys):
    cfg = _cfg(tmp_path)
    # a previous, good generation is already on disk
    _generation(cfg.exp_dir, 1, median_us=11.0)

    def boom(_exp, _generation):
        raise AttributeError("'NoneType' object has no attribute 'get'")

    monkeypatch.setattr(P, "record_generation", boom)

    outcome = P._record_champion_generation(
        cfg, cfg.exp_dir, iteration=2, decision={"verdict": "PROMOTE"},
        decision_rate=0.5, snapshot=Path("/tmp/snap-2"),
        live_workspace=cfg.workspace_dir, results={"op00": {"passed": True}},
        current={})

    # never raises, and the error is on the record with its traceback
    assert outcome["recorded"] is False and outcome["error"]
    rows = [json.loads(line) for line in
            (Path(cfg.state_dir) / "timeline.jsonl").read_text(
                encoding="utf-8").splitlines() if line.strip()]
    failed = [row for row in rows if row["type"] == "champion_record_failed"]
    assert failed and "AttributeError" in failed[0]["payload"]["error"]
    assert "NoneType" in failed[0]["payload"]["traceback"]
    # ... and it is visible in the orchestrator log, not only in a JSONL row
    assert "champion bookkeeping failed" in capsys.readouterr().err
    # the champion chain survives: rebuilt from the generation on disk
    assert outcome["recovered"] is True
    best = json.loads((cfg.exp_dir / "best_ever.json").read_text())
    assert best["iteration"] == 1 and best["verdict"] == "REBUILT_AFTER_ERROR"
    assert "champion_rebuilt" in _events(cfg)


def test_a_failure_with_nothing_to_rebuild_from_still_returns(tmp_path,
                                                              monkeypatch):
    """No usable generation on disk: report, keep the old champion, carry on."""
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(P, "record_generation",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full")))
    previous = {"iteration": 7, "verdict": "BEST_MEASURED"}

    outcome = P._record_champion_generation(
        cfg, cfg.exp_dir, iteration=8, decision={"verdict": "REJECT"},
        decision_rate=0.0, snapshot=Path("/tmp/snap-8"),
        live_workspace=cfg.workspace_dir, results={}, current=previous)

    assert outcome["recorded"] is False and outcome["recovered"] is False
    assert outcome["best_ever"] == previous
    assert "champion_record_failed" in _events(cfg)
