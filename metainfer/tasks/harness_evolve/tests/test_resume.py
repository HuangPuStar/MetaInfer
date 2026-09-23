"""Resume-the-next-iteration support for harness_evolve."""

from __future__ import annotations

import json
import time
from pathlib import Path

from metainfer.tasks.harness_evolve.orchestrator.cli import resume_command
from metainfer.tasks.harness_evolve.orchestrator.config import (
    load_experiment_config,
)
from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
    completed_iterations, run_experiment,
)
from metainfer.tasks.harness_evolve.orchestrator.state import (
    read_target_iterations, write_target_iterations,
)
from metainfer.tasks.harness_evolve.server.routes import (
    _launch_resume, _resume_running,
)


def _write_req(tmp_path: Path) -> Path:
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": "resume-task",
        "task_type": "harness-evolve",
        "execution_mode": "dry-run",
        "max_iterations": 1,
        "evolve_mode": "dry-run",
        "per_round_budget": 2,
        "pool_source": "",
    }), encoding="utf-8")
    return req


def _cfg(tmp_path: Path):
    return load_experiment_config(
        _write_req(tmp_path), tmp_path / "state", tmp_path / "ws")


def test_resume_runs_next_iteration_with_champion_from_disk(tmp_path):
    cfg = _variant_cfg(tmp_path, rounds=2)      # two rounds: baseline + one pass
    write_target_iterations(cfg.exp_dir, 1)     # this call may run round 1 only
    run_experiment(cfg)
    exp = cfg.exp_dir
    assert completed_iterations(exp) == 1
    assert (exp / "runs" / "iteration_001" / "input" / "decision.json").is_file()

    write_target_iterations(cfg.exp_dir, 2)     # ... and now it may run round 2
    run_experiment(cfg, start_iteration=2, iterations_to_run=1)

    assert completed_iterations(exp) == 2
    it2 = exp / "runs" / "iteration_002" / "input"
    assert (it2 / "benchmark" / "results.json").is_file()
    assert (it2 / "decision.json").is_file()
    # champion/prev state must come from the resumed experiment
    decision = json.loads((it2 / "decision.json").read_text(encoding="utf-8"))
    assert decision["iteration"] == 2
    scores = (exp / "iteration_scores.jsonl").read_text(
        encoding="utf-8").strip().splitlines()
    assert len(scores) == 2
    assert json.loads(scores[-1])["iteration"] == 2


def test_cli_resume_starts_round_one_when_nothing_ran(tmp_path):
    """No completed round and nobody running: resume bootstraps round 1."""
    state = tmp_path / "state"
    state.mkdir(parents=True)
    _write_req(state if False else tmp_path)  # requirements at tmp_path
    (state / "requirements.json").write_text(
        (tmp_path / "requirements.json").read_text(encoding="utf-8"),
        encoding="utf-8")
    import argparse
    args = argparse.Namespace(
        state_dir=state, workspace_dir=tmp_path / "ws",
        requirements=None, iterations=1)
    assert resume_command(args) == 0          # not a refusal any more
    assert (tmp_path / "ws" / "runs" / "iteration_001").is_dir()


def test_cli_resume_defers_to_an_already_running_task(tmp_path, monkeypatch):
    """If the task is already running (started by the server), resume exits."""
    state = tmp_path / "state"
    state.mkdir(parents=True)
    _write_req(tmp_path)
    (state / "requirements.json").write_text(
        (tmp_path / "requirements.json").read_text(encoding="utf-8"),
        encoding="utf-8")
    import argparse
    from metainfer.tasks.harness_evolve.orchestrator import supervisor as sup
    monkeypatch.setattr(sup, "task_process_alive", lambda _state: 4242)
    args = argparse.Namespace(
        state_dir=state, workspace_dir=tmp_path / "ws",
        requirements=None, iterations=1)
    assert resume_command(args) == 0
    assert not (tmp_path / "ws" / "runs" / "iteration_001").is_dir()


def test_resume_running_detects_live_pid(tmp_path):
    """Only a live harness_evolve process counts (zombies/pids are rejected)."""
    import os
    import subprocess
    import sys

    state = tmp_path / "state"
    state.mkdir(parents=True)
    assert _resume_running(state) is None

    # our own pid is alive but is not a harness run
    (state / "resume.pid").write_text(str(os.getpid()), encoding="utf-8")
    assert _resume_running(state) is None

    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)", "harness_evolve"])
    try:
        (state / "resume.pid").write_text(str(proc.pid), encoding="utf-8")
        assert _resume_running(state) == proc.pid
    finally:
        proc.kill()
        proc.wait()

    (state / "resume.pid").write_text("999999", encoding="utf-8")
    assert _resume_running(state) is None


def test_launch_resume_end_to_end_dry(tmp_path):
    """The resume CLI really runs the next round (dry-run fixture)."""
    cfg = _cfg(tmp_path)
    run_experiment(cfg)
    state_dir = cfg.state_dir
    (state_dir / "requirements.json").write_text(
        (tmp_path / "requirements.json").read_text(encoding="utf-8"),
        encoding="utf-8")

    # The form's Iterations answer is the run's round target; raise it so the
    # resumed run is allowed to spend another round (a performance pass costs
    # 1.0, the retake 0.5, the baseline round is free).
    write_target_iterations(cfg.exp_dir, 3)
    out = _launch_resume(state_dir, cfg.exp_dir, 1)
    assert out["ok"] is True and out["pid"] > 0

    deadline = time.time() + 180
    while time.time() < deadline:
        if completed_iterations(cfg.exp_dir) >= 2:
            break
        time.sleep(1)
    assert completed_iterations(cfg.exp_dir) >= 2, (state_dir / "resume.log").read_text(
        encoding="utf-8", errors="replace")[-1500:]


def test_target_iterations_override_fallback_rounds(tmp_path):
    """The target (a round count) decides, not the caller's batch size."""
    cfg = _variant_cfg(tmp_path)
    write_target_iterations(cfg.exp_dir, 3)
    assert read_target_iterations(cfg.exp_dir) == 3
    run_experiment(cfg, iterations_to_run=1)          # the caller asks for 1
    assert completed_iterations(cfg.exp_dir) == 3     # the target wins


def test_lowered_target_stops_the_loop_immediately(tmp_path):
    """Lowering the target below the next round stops without a new round."""
    cfg = _cfg(tmp_path)
    run_experiment(cfg)                               # iteration 1 done
    write_target_iterations(cfg.exp_dir, 1)           # target already met
    run_experiment(cfg, start_iteration=2, iterations_to_run=5)
    assert completed_iterations(cfg.exp_dir) == 1
    assert not (cfg.exp_dir / "runs" / "iteration_002").exists()


def test_target_can_be_cleared_for_fixed_rounds(tmp_path):
    cfg = _cfg(tmp_path)
    write_target_iterations(cfg.exp_dir, 5)
    from metainfer.tasks.harness_evolve.orchestrator.state import (
        clear_target_iterations,
    )
    clear_target_iterations(cfg.exp_dir)
    assert read_target_iterations(cfg.exp_dir) is None


def test_champion_iteration_pins_the_comparison_baseline(tmp_path):
    """Resume can compare the new round against a chosen finished iteration."""
    cfg = _variant_cfg(tmp_path, rounds=3)      # three rounds of headroom
    # one iteration per call, so the test controls exactly which rounds exist
    write_target_iterations(cfg.exp_dir, 1)
    run_experiment(cfg)                                            # iteration 1
    write_target_iterations(cfg.exp_dir, 2)
    run_experiment(cfg, start_iteration=2, iterations_to_run=1)     # iteration 2
    write_target_iterations(cfg.exp_dir, 3)
    run_experiment(cfg, start_iteration=3, iterations_to_run=1,
                   champion_iteration=2)                            # iteration 3

    exp = cfg.exp_dir
    best = json.loads((exp / "best_ever.json").read_text(encoding="utf-8"))
    assert best["iteration"] == 2
    assert best["verdict"] == "MANUAL_BASELINE"
    assert (exp / "champion_override.json").is_file()

    it2 = json.loads((exp / "runs" / "iteration_002" / "input" / "benchmark"
                      / "results.json").read_text(encoding="utf-8"))["results"]
    decision = json.loads((exp / "runs" / "iteration_003" / "input"
                           / "decision.json").read_text(encoding="utf-8"))
    per = decision["performance_gate"]["comparison"]["per_instance"]
    assert per, "paired comparison must exist"
    # The pin is what this test is about: the run's comparison baseline is
    # iteration 2, so that iteration's results are what a resumed round reads
    # back (the gate then compares the candidate against the variant table, as
    # every round does).
    assert json.loads((exp / "champion_override.json").read_text()
                      )["champion_iteration"] == 2
    assert json.loads((exp / "best_ever.json").read_text())["iteration"] == 2
    assert set(it2) == set(per), (
        "the pinned round and the resumed round must pair the same operators")


def test_resume_clears_a_previous_stop_signal(tmp_path):
    """A gate-stopped run must be resumable: the stale stop signal is dropped.

    ``stop_requested.json`` is checked after every evaluate, so leaving it in
    place would make the very next resume stop again without doing any work.
    """
    cfg = _cfg(tmp_path)
    run_experiment(cfg)
    stop = cfg.exp_dir / "stop_requested.json"
    stop.write_text(json.dumps({"reason": "gpu_gate_blocked", "checks": 48}),
                    encoding="utf-8")

    from metainfer.tasks.harness_evolve.orchestrator.cli import clear_stop_request
    assert clear_stop_request(cfg.exp_dir, state_dir=cfg.state_dir) == [
        "stop_requested.json"]
    assert not stop.exists()
    events = [json.loads(l)["type"] for l in
              (cfg.state_dir / "timeline.jsonl").read_text(
                  encoding="utf-8").splitlines() if l.strip()]
    assert "stop_request_cleared" in events
    # idempotent: without a signal there is nothing to clear
    assert clear_stop_request(cfg.exp_dir, state_dir=cfg.state_dir) == []


def test_completed_iterations_counts_a_judged_round_without_results_json(tmp_path):
    """A variant-protocol stage is "done" through its decision artifacts.

    Only a *failing* pass writes ``input/benchmark/results.json``; a round that
    passed its gate leaves ``decision.json`` + the gate files instead. Reading
    only ``results.json`` reported 0 completed rounds for a run that had just
    finished three, and ``resume`` then refused to continue.
    """
    exp = tmp_path / "exp"
    for n, artifact in ((1, "baseline_round.json"),
                        (2, "performance_gate.json"),
                        (3, "generalization_gate.json")):
        d = exp / "runs" / f"iteration_{n:03d}" / "input"
        d.mkdir(parents=True)
        (d / "decision.json").write_text("{}", encoding="utf-8")
        (d / artifact).write_text("{}", encoding="utf-8")
    # an empty directory is not a completed round
    (exp / "runs" / "iteration_004" / "input").mkdir(parents=True)

    assert completed_iterations(exp) == 3

    # the classic evidence (a stage that stopped early) still counts
    (exp / "runs" / "iteration_005" / "input" / "benchmark").mkdir(parents=True)
    (exp / "runs" / "iteration_005" / "input" / "benchmark"
     / "results.json").write_text("{}", encoding="utf-8")
    assert completed_iterations(exp) == 5


# ------------------------------------------------- rounds as durable state

def _variant_cfg(tmp_path: Path, **answers):
    """A config in the variant-round protocol: it needs a real pool file."""
    import yaml

    ops = {f"op{i:02d}": {"baseline_us": 100.0 + i, "best_known_us": 40.0 + 4 * i}
           for i in range(8)}
    pool = tmp_path / "pool.yaml"
    pool.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [
            {"id": iid, "family": f"decode__fam{i}", "contract": {"M": 16},
             "baseline_us": v["baseline_us"], "best_known_us": v["best_known_us"],
             "history": []}
            for i, (iid, v) in enumerate(sorted(ops.items()))
        ],
    }, sort_keys=False), encoding="utf-8")
    tmp_path.mkdir(parents=True, exist_ok=True)
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({
        "task_id": "rounds-task",
        "task_type": "harness-evolve",
        "execution_mode": "dry-run",
        "evolve_mode": "dry-run",
        "pool_source": str(pool),
        "question_pool": str(pool),
        "round_questions": "variant",
        "per_round_budget": "4",
        "max_iterations": 1,
        **answers,
    }), encoding="utf-8")
    return load_experiment_config(req, tmp_path / "state", tmp_path / "ws")


def test_rounds_used_survives_a_resume(tmp_path):
    """The budget must not reset when the process is restarted.

    ``rounds_used`` used to live only in memory, so a resumed run came back with
    a full budget and could keep spending rounds the operator never asked for.
    """
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _rounds_used_on_disk,
    )

    cfg = _variant_cfg(tmp_path, rounds=3)
    run_experiment(cfg, iterations_to_run=2)          # baseline + one judgment
    spent = _rounds_used_on_disk(cfg.exp_dir)
    assert spent >= 1.0, "a judged pass must leave its cost on disk"
    assert json.loads((cfg.state_dir / "run.json").read_text())["rounds_used"] == spent
    # a second process (no memory of the first) sees the same number
    assert _rounds_used_on_disk(cfg.exp_dir) == spent


def test_rounds_used_is_derived_when_run_json_predates_it(tmp_path):
    """Old experiments report their spent rounds instead of a fresh budget."""
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _rounds_used_on_disk,
    )

    exp = tmp_path / "exp"
    for n, cost in ((1, 0.0), (2, 1.0), (3, 0.5)):
        d = exp / "runs" / f"iteration_{n:03d}" / "input"
        d.mkdir(parents=True)
        (d / "stage.json").write_text(json.dumps({"round_cost": cost}),
                                      encoding="utf-8")
    assert _rounds_used_on_disk(exp) == 1.5


def test_a_round_is_an_iteration(tmp_path):
    """`Rounds: 2` means the run may reach iteration 2 and no further.

    Round 1 is the baseline round; round 2 is a performance pass (plus, when it
    wins, the generalization retake inside that same iteration — a retake never
    consumes a round of its own).
    """
    cfg = _variant_cfg(tmp_path, rounds=2)
    write_target_iterations(cfg.exp_dir, 2)
    run_experiment(cfg, iterations_to_run=5)          # ask for five; rounds say two

    stages = [json.loads(p.read_text())["stage"]
              for p in sorted((cfg.exp_dir / "runs").glob("iteration_*/input/stage.json"))]
    assert stages == ["baseline", "performance"]
    assert completed_iterations(cfg.exp_dir) == 2
    run = json.loads((cfg.state_dir / "run.json").read_text())
    assert run["finished"] is True
    # the reported cost is bookkeeping: one judged pass
    assert run["rounds_used"] == 1.0
