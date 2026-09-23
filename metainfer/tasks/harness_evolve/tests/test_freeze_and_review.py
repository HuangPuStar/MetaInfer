"""Scheme 1: frozen variants, best-known tracking, final promotion, review."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
    _finalize_promotion, _track_best_known, _variant_policy,
)


def _cfg(tmp_path: Path, **answers) -> SimpleNamespace:
    state = tmp_path / "st"
    state.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(state_dir=state, task_id="t",
                           answers={"promote_kernels": "true", **answers})


def test_variant_policy_defaults_to_freeze(tmp_path):
    assert _variant_policy(_cfg(tmp_path)) == "freeze"
    assert _variant_policy(_cfg(tmp_path, variant_policy="per_round")) == "per_round"
    assert _variant_policy(_cfg(tmp_path, variant_policy="immediate")) == "per_round"


def test_best_known_curve_and_regression_detection(tmp_path):
    cfg = _cfg(tmp_path)
    exp = tmp_path / "exp"
    exp.mkdir()

    _track_best_known(cfg, exp, 1, {"a": {"median_us": 40.0, "passed": True}})
    first = json.loads((exp / "best_known.json").read_text(encoding="utf-8"))
    assert first["a"]["best_median_us"] == 40.0
    assert first["a"]["best_iteration"] == 1

    out = _track_best_known(cfg, exp, 2, {"a": {"median_us": 60.0, "passed": True}})
    assert out["regressions"] and out["regressions"][0]["shape"] == "a"
    assert out["regressions"][0]["best_median_us"] == 40.0
    assert out["regressions"][0]["delta_percent"] == 50.0
    assert (exp / "regressions.jsonl").is_file()

    data = json.loads((exp / "best_known.json").read_text(encoding="utf-8"))
    assert data["a"]["best_median_us"] == 40.0        # 60us never becomes best
    assert data["a"]["best_iteration"] == 1
    assert [h["median_us"] for h in data["a"]["history"]] == [40.0, 60.0]

    # a better round updates the best
    _track_best_known(cfg, exp, 3, {"a": {"median_us": 25.0, "passed": True}})
    data = json.loads((exp / "best_known.json").read_text(encoding="utf-8"))
    assert data["a"]["best_median_us"] == 25.0 and data["a"]["best_iteration"] == 3


def test_finalize_promotion_promotes_the_best_candidate_not_the_newest(
        tmp_path, monkeypatch):
    """40us from round 1 must win over 60us from round 2."""
    cfg = _cfg(tmp_path)
    exp = tmp_path / "exp"
    good = exp / "children" / "iteration_001" / "shapeA" / "workspace"
    worse = exp / "children" / "iteration_002" / "shapeA" / "workspace"
    good.mkdir(parents=True)
    worse.mkdir(parents=True)
    rows = [
        {"iteration": 1, "shape": "shapeA", "workspace": str(good),
         "ahe_passed": True, "action": "would_update", "ahe_median_us": 40.0,
         "answers": {"model": "hy3"}, "source_task": "t/1"},
        {"iteration": 2, "shape": "shapeA", "workspace": str(worse),
         "ahe_passed": True, "action": "would_update", "ahe_median_us": 60.0,
         "answers": {"model": "hy3"}, "source_task": "t/2"},
        {"iteration": 2, "shape": "shapeB", "workspace": str(worse),
         "ahe_passed": False, "action": "would_add", "ahe_median_us": 5.0,
         "answers": {}},
    ]
    (exp / "promotion_candidates.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    calls = []
    import metainfer.tasks.dcu_kernel_auto_opt.orchestrator.variant_promote as vp
    monkeypatch.setattr(vp, "promote_variant",
                        lambda **kw: calls.append(kw) or {
                            "shape": kw["shape_id"], "action": "updated"})

    payload = _finalize_promotion(cfg, exp)
    assert payload["promoted"] == ["shapeA"]
    assert len(calls) == 1
    assert calls[0]["workspace_dir"] == good          # the 40us candidate
    assert Path(str(payload["results"][0]["shape"])) == Path("shapeA")
    assert (exp / "final_promotion.json").is_file()
    # a failing candidate is never promoted, however fast it looks
    assert "shapeB" not in payload["promoted"]


def test_finalize_promotion_respects_the_switch(tmp_path):
    cfg = _cfg(tmp_path, promote_kernels="false")
    exp = tmp_path / "exp"
    exp.mkdir()
    (exp / "promotion_candidates.jsonl").write_text("{}\n", encoding="utf-8")
    assert _finalize_promotion(cfg, exp) is None


def test_fail_streak_counts_failures_and_resets_on_progress():
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _next_fail_streak,
    )
    assert _next_fail_streak("REJECT", 0) == 1
    assert _next_fail_streak("REJECT_OVERFIT", 1) == 2
    # unmeasurable rounds count too: that is the runaway-loop signature
    assert _next_fail_streak("INCONCLUSIVE", 2) == 3
    assert _next_fail_streak("NO_SIGNAL", 3) == 0
    assert _next_fail_streak("PROMOTE", 3) == 0
    assert _next_fail_streak("PROMOTE_UNEXPLAINED", 3) == 0


def test_circuit_breaker_trips_after_three_failing_rounds():
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _next_fail_streak,
    )
    streak = 0
    tripped_at = None
    for round_no, verdict in enumerate(["REJECT", "INCONCLUSIVE", "REJECT"], 1):
        streak = _next_fail_streak(verdict, streak)
        if streak >= 3:
            tripped_at = round_no
            break
    assert tripped_at == 3
