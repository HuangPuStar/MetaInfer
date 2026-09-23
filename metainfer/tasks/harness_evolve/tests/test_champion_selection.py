"""Champion = best measured generation, not "last promoted generation"."""

from __future__ import annotations

from metainfer.tasks.harness_evolve.orchestrator.champion_selection import (
    Generation, best_generation, compare_generations, load_generations,
    record_generation, summarize,
)


def _gen(iteration, medians, *, verdict="PROMOTE", passed=None) -> Generation:
    results = {}
    for iid, median in medians.items():
        ok = True if passed is None else bool(passed.get(iid, True))
        results[iid] = {"median_us": median, "passed": ok,
                        "correctness_ok": True}
    return Generation(iteration=iteration, verdict=verdict, results=results,
                      pass_count=sum(1 for r in results.values()
                                     if r["passed"]))


def test_better_generation_keeps_the_champion_slot():
    """The reported scenario: gen1 40us (unpromoted), gen2 60us (promoted)."""
    gen1 = _gen(1, {"a": 40.0, "b": 40.0}, verdict="CONFIRM_REQUIRED")
    gen2 = _gen(2, {"a": 60.0, "b": 60.0}, verdict="PROMOTE")
    assert compare_generations(gen1, gen2) == "a"
    assert best_generation([gen1, gen2]).iteration == 1


def test_rejected_generation_is_disqualified():
    good = _gen(1, {"a": 40.0})
    bad = _gen(2, {"a": 20.0}, verdict="REJECT")      # fast but regressed
    assert best_generation([good, bad]).iteration == 1


def test_no_signal_generation_does_not_displace_a_better_one():
    keeper = _gen(1, {"a": 40.0}, verdict="PROMOTE")
    flat = _gen(2, {"a": 41.0}, verdict="NO_SIGNAL")
    assert best_generation([keeper, flat]).iteration == 1


def test_more_passing_questions_wins_before_raw_speed():
    fewer = _gen(1, {"a": 30.0, "b": 100.0}, passed={"a": True, "b": False})
    more = _gen(2, {"a": 32.0, "b": 60.0}, passed={"a": True, "b": True})
    assert best_generation([fewer, more]).iteration == 2


def test_earlier_generation_wins_a_tie():
    first = _gen(1, {"a": 50.0})
    second = _gen(2, {"a": 50.5})                     # within the noise band
    assert best_generation([first, second]).iteration == 1


def test_round_trip_persistence(tmp_path):
    exp = tmp_path / "exp"
    (exp / "runs" / "iteration_001" / "input" / "benchmark").mkdir(parents=True)
    (exp / "runs" / "iteration_001" / "input" / "benchmark"
     / "results.json").write_text('{"results": {"a": {"median_us": 40.0, "passed": true}}}',
                                  encoding="utf-8")
    record_generation(exp, _gen(1, {"a": 40.0}, verdict="CONFIRM_REQUIRED"))
    gens = load_generations(exp)
    assert len(gens) == 1
    assert gens[0].iteration == 1 and gens[0].pending is True
    assert gens[0].results["a"]["median_us"] == 40.0
    assert best_generation(gens).iteration == 1

    # recording the same iteration again replaces the row
    record_generation(exp, _gen(1, {"a": 35.0}, verdict="PROMOTE"))
    gens = load_generations(exp)
    assert len(gens) == 1 and gens[0].verdict == "PROMOTE"

    rows = summarize(gens)
    assert rows[0]["champion"] is True
    assert rows[0]["medians"] == {"a": 40.0}
