"""A run that leaves the fixed protocol has to say so.

``FLOW.md`` describes the only protocol a new HE task may use: variant rounds, a
frozen generalization paper, the two gates, rounds sized in waves of 4. Two older
paths still exist — suite mode (no measured pool file) and an explicit
``round_questions: legacy`` — and both skip all of that.

The operator's decision (2026-09-22) was **not** to delete them but to make
leaving the protocol impossible to miss: a WARNING in the orchestrator log, an
event on the task timeline, ``protocol.json`` for the task page, and a banner in
the detail view. That is what these tests pin.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from metainfer.server import tasks as _tasks
from metainfer.server.tasks import TaskEntry
from metainfer.tasks.harness_evolve.orchestrator import pipeline as P
from metainfer.tasks.harness_evolve.orchestrator.config import (
    load_experiment_config,
)
from metainfer.tasks.harness_evolve.orchestrator.pipeline import run_experiment


def _requirements(tmp_path: Path, answers: dict) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps({"task_id": "he-legacy", "answers": answers},
                              ensure_ascii=False), encoding="utf-8")
    return req


def _cfg(tmp_path: Path, answers: dict):
    return load_experiment_config(_requirements(tmp_path, answers),
                                 tmp_path / "state", tmp_path / "ws")


def _events(cfg) -> list:
    path = Path(cfg.state_dir) / "timeline.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _pool(tmp_path: Path, operators: int = 8) -> Path:
    path = tmp_path / "pool.yaml"
    path.write_text(yaml.safe_dump({
        "schema_version": 1,
        "instances": [
            {"id": f"op{i:02d}", "family": f"decode__fam{i}",
             "contract": {"M": 16}, "baseline_us": 100.0 + i,
             "best_known_us": 40.0 + 4 * i, "history": []}
            for i in range(operators)
        ],
    }, sort_keys=False), encoding="utf-8")
    return path


# ------------------------------------------------------------------- the reason

def test_the_reason_names_the_actual_cause(tmp_path):
    explicit = _cfg(tmp_path / "a", {"execution_mode": "dry-run",
                                     "round_questions": "legacy"})
    assert "round_questions" in P._legacy_protocol_reason(explicit)

    suite = _cfg(tmp_path / "b", {"execution_mode": "dry-run"})
    assert "no question pool" in P._legacy_protocol_reason(suite)

    builtin = _cfg(tmp_path / "c", {"execution_mode": "dry-run",
                                    "pool_source": "builtin"})
    assert "demo pool" in P._legacy_protocol_reason(builtin)

    missing = _cfg(tmp_path / "d", {"execution_mode": "dry-run",
                                    "pool_source": str(tmp_path / "nope.yaml")})
    assert "does not exist" in P._legacy_protocol_reason(missing)


# ------------------------------------------------- what the run leaves behind

def test_a_suite_run_says_it_left_the_protocol(tmp_path, capsys):
    cfg = _cfg(tmp_path, {"execution_mode": "dry-run", "max_iterations": 1})

    run_experiment(cfg)

    announced = [row for row in _events(cfg)
                 if row["type"] == "legacy_protocol_selected"]
    assert announced, "leaving the protocol must be on the record"
    payload = announced[0]["payload"]
    assert payload["mode"] == "legacy"
    assert "no question pool" in payload["reason"]
    assert "FLOW.md" in payload["policy"]

    # ... in a file the task page reads, so it can warn instead of looking idle
    written = json.loads((cfg.exp_dir / "protocol.json").read_text())
    assert written["mode"] == "legacy" and written["reason"] == payload["reason"]

    # ... and in the log, where somebody watching the process will see it
    assert "WARNING" in capsys.readouterr().err


def test_a_variant_run_says_nothing(tmp_path):
    """The default protocol must not raise the banner (no false positives)."""
    pool = _pool(tmp_path)
    cfg = _cfg(tmp_path, {"execution_mode": "dry-run", "max_iterations": 1,
                          "pool_source": str(pool), "question_pool": str(pool),
                          "per_round_budget": "4"})

    run_experiment(cfg)

    assert not [row for row in _events(cfg)
                if row["type"] == "legacy_protocol_selected"]
    assert not (cfg.exp_dir / "protocol.json").exists()


# --------------------------------------------------------------- on the page

def _register(state_dir: Path, workspace_dir: Path, task_id: str):
    state_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)
    _tasks.add_task(TaskEntry(id=task_id, type="harness-evolve", label="he",
                              state_dir=str(state_dir),
                              workspace_dir=str(workspace_dir),
                              created_at=0.0))


def test_the_task_page_can_warn_about_a_legacy_run(client, isolated_env,
                                                   tmp_path):
    home = isolated_env["home"]
    state = home / "tasks" / "he-legacy-view"
    ws = home / "workspaces" / "he-legacy-view"
    _register(state, ws, "he-legacy-view")
    (ws / "protocol.json").write_text(json.dumps({
        "mode": "legacy", "protocol": "legacy",
        "reason": "no question pool is configured",
    }), encoding="utf-8")

    body = client.get("/api/harness-evolve/he-legacy-view/summary").json()

    assert body["protocol"]["mode"] == "legacy"
    assert "no question pool" in body["protocol"]["reason"]


def test_a_variant_task_reports_the_fixed_protocol(client, isolated_env):
    home = isolated_env["home"]
    state = home / "tasks" / "he-variant-view"
    ws = home / "workspaces" / "he-variant-view"
    _register(state, ws, "he-variant-view")

    body = client.get("/api/harness-evolve/he-variant-view/summary").json()

    assert body["protocol"]["mode"] == "variant"
    assert "FLOW.md" in body["protocol"]["reason"]


def test_the_detail_view_renders_the_banner_only_for_legacy():
    """The page must read ``summary.protocol`` and stay quiet otherwise."""
    src = (Path(__file__).resolve().parents[1] / "static"
           / "he-detail.js").read_text(encoding="utf-8")
    assert "ProtocolBanner" in src
    assert 'mode !== "legacy"' in src, "the banner is legacy-only"
    assert "summary && summary.protocol" in src, "it reads the summary payload"
