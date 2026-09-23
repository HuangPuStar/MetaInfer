"""The HE flow is a fixed contract: `FLOW.md` states it, the code obeys it.

Three things are pinned here, all of them from the operator's own wording:

1. **The document exists and still says the protocol** — question counts are
   multiples of 4, round 1 draws the frozen generalization paper from a random
   set that spans decode *and* prefill, the two gates are 75% / 50% with an 80%
   floor, and a failed performance gate goes back to analyze→evolve instead of
   being promoted.
2. **The multiple of 4 is enforced, not suggested** — the form offers only
   multiples of 4, and a count that arrives from the CLI is rounded up at the
   single point where it enters the run (``config._normalized_budget``).
3. **HE only launches DKAO tasks** — no device reads, no waiting on cards, no
   freezing a child for a device. Every one of those existed at some point and
   was removed; this test is what keeps them out.
"""

from __future__ import annotations

from pathlib import Path

import pytest

HE_PKG = Path(__file__).resolve().parents[1]
ORCH = HE_PKG / "orchestrator"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _code_only(path: Path) -> str:
    """Source with comments and string literals removed.

    A contract test has to judge *code*: the comments in ``eval.py`` explaining
    that the device verdict belongs to DKAO are exactly what we want to keep,
    and they would otherwise read as "HE mentions the measurement gate".
    """
    import io
    import tokenize

    tokens = []
    with path.open("rb") as fh:
        for tok in tokenize.tokenize(fh.readline):
            if tok.type in (tokenize.COMMENT, tokenize.STRING, tokenize.NL,
                            tokenize.NEWLINE, tokenize.INDENT,
                            tokenize.DEDENT):
                continue
            tokens.append(tok.string)
    return " ".join(tokens)


# --------------------------------------------------------------- 1. the document

def test_the_flow_document_exists_and_is_called_out_by_the_readme():
    flow = HE_PKG / "FLOW.md"
    assert flow.is_file(), "the fixed protocol document is missing"
    assert "FLOW.md" in _read(HE_PKG / "README.md"), (
        "README must point at FLOW.md instead of restating the protocol")


def test_the_flow_document_states_every_rule_the_operator_fixed():
    doc = _read(HE_PKG / "FLOW.md")
    required = [
        "4 的倍数",              # question count is a multiple of 4
        "decode", "prefill",     # round 1 spans both regimes
        "M ≤ 32",                # decode definition
        "A1", "A_i",             # round-1 paper vs later draws
        "75%", "50%", "80%",     # the two gates and the floor
        "仅在性能门通过后开",     # generalization only after performance
        "固化考卷",               # the paper never moves
        "只发起 DKAO 任务",       # the boundary, in one line
        "不租卡", "不读卡状态", "不 `SIGSTOP`",   # what HE must not do
        "analyze", "evolve",     # the failure path
        "awaiting_approval",     # promotion waits for a human
    ]
    missing = [token for token in required if token not in doc]
    assert not missing, f"FLOW.md no longer states: {missing}"


# ------------------------------------------------- 2. the multiple-of-4 rule

def test_the_machine_and_the_wave_are_both_four():
    from metainfer.tasks.harness_evolve.orchestrator.rounds import (
        GPU_COUNT, OPERATORS_PER_GATE, normalized_per_gate,
    )

    assert GPU_COUNT == 4 and OPERATORS_PER_GATE == 4
    assert normalized_per_gate(4) == 4
    assert normalized_per_gate(8) == 8
    assert normalized_per_gate(5) == 8      # up, never down
    assert normalized_per_gate(3) == 4
    assert normalized_per_gate(None) == 4


def test_the_form_only_offers_multiples_of_four():
    import metainfer.tasks  # noqa: F401 - registers the plugins
    from metainfer.server.forms import load_form_schema

    schema = load_form_schema("harness-evolve")
    field = next(f for f in schema["fields"] if f["key"] == "per_round_budget")

    assert field["type"] == "select", (
        "a free number field lets the operator ask for 3 or 5 questions, which "
        "leaves devices idle in the wave")
    counts = [int(option["label"]) for option in field["options"]]
    assert counts and all(count % 4 == 0 for count in counts), counts
    assert int(field["default"]) % 4 == 0


def test_a_count_from_the_cli_is_rounded_up_where_it_enters_the_run():
    from metainfer.tasks.harness_evolve.orchestrator.config import (
        _normalized_budget,
    )

    assert _normalized_budget(3) == 4
    assert _normalized_budget(5) == 8
    assert _normalized_budget(12) == 12
    assert _normalized_budget(0) == 0, (
        "0 keeps the legacy meaning 'no cap / whole pool'")
    assert _normalized_budget("bad") == 0


def test_the_round_is_drawn_from_the_pool_in_whole_waves():
    """The selection itself honours the count it is given (no silent shrink)."""
    import random

    from metainfer.tasks.harness_evolve.orchestrator.rounds import (
        select_round_questions,
    )

    instances = {}
    for idx in range(8):
        m = 16 if idx % 2 == 0 else 4096
        regime = "decode" if m <= 32 else "prefill"
        iid = f"op{idx:02d}"
        instances[iid] = {
            "baseline_us": 100.0 * (idx + 1),
            "best_known_us": 40.0 * (idx + 1),        # an existing variant
            "family": f"{regime}__fam{idx}",
            "contract": {"M": m, "N": 64, "K": 32},
        }
    table = {"operators": {}, "groups": {}, "harness_version": None}

    picked = select_round_questions(iteration=1, table=table,
                                    instances=instances, state={}, count=8,
                                    rng=random.Random(7))

    assert len(picked["performance_ids"]) == 8
    assert picked["generalization_ids"] == picked["performance_ids"], (
        "round 1's draw *is* the frozen paper")
    assert picked["defines_paper"] is True


# ------------------------------------------- 3. HE does not manage environment

def test_the_supervisor_never_reads_the_cards():
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import Supervisor

    code = _code_only(ORCH / "supervisor.py")
    for forbidden in ("gpu_preflight", "preflight_gpus", "free_gb",
                      "sample_gpu_state", "foreign_kfd_pids", "GpuBroker"):
        assert forbidden not in code, (
            f"HE must not consult {forbidden}: a device verdict is DKAO's "
            "(FLOW.md §0)")
    assert not hasattr(Supervisor, "free_gb")


def test_nothing_freezes_a_child_for_a_device_any_more():
    src = _code_only(ORCH / "process_control.py")
    for forbidden in ("signal.SIGSTOP", "signal.SIGCONT", "def freeze",
                      "def resume("):
        assert forbidden not in src, forbidden
    # terminate is what remains, and it must still work as a group signal
    assert "def terminate" in src and "killpg" in src
    assert "def freeze" not in src


def test_classify_incident_is_driven_by_the_runs_own_evidence():
    from metainfer.tasks.harness_evolve.orchestrator.supervisor import (
        CATEGORY_AGENT, CATEGORY_CODE, CATEGORY_RESOURCE, CATEGORY_UNKNOWN,
        classify_incident,
    )

    assert classify_incident(exit_code=137)[0] == CATEGORY_RESOURCE
    assert classify_incident(log_tail="std::bad_alloc")[0] == CATEGORY_RESOURCE
    assert classify_incident(log_tail="TransportClosedError")[0] == CATEGORY_AGENT
    assert classify_incident(
        log_tail="Traceback (most recent call last):")[0] == CATEGORY_CODE
    assert classify_incident(log_tail="nothing to see")[0] == CATEGORY_UNKNOWN
    with pytest.raises(TypeError):
        classify_incident(log_tail="x", free_gb=1.0)      # the knob is gone


def test_the_evaluator_only_decides_the_device_layout():
    src = _code_only(ORCH / "adapters" / "eval.py")
    assert "device_for_index" in src, (
        "the device is a pure layout decision (index % 4)")
    for forbidden in ("ensure_measurement_gate", "MEASUREMENT_GATE_VRAM_PERCENT",
                      "measurement_suspect", "contention", "gpu_preflight",
                      "preflight_gpus"):
        assert forbidden not in src, (
            "environment verdicts live in DKAO, not in HE")


def test_the_gate_numbers_are_the_protocol_numbers():
    from metainfer.tasks.harness_evolve.orchestrator.decision_engine import (
        GENERALIZATION_GATE_FLOOR_PERCENT, GENERALIZATION_GATE_WIN_RATIO,
        PERFORMANCE_GATE_FLOOR_PERCENT, PERFORMANCE_GATE_WIN_RATIO,
    )
    from metainfer.tasks.harness_evolve.orchestrator.rounds import (
        GENERALIZATION_ROUND_COST, PERFORMANCE_ROUND_COST,
    )

    assert PERFORMANCE_GATE_WIN_RATIO == 0.75
    assert GENERALIZATION_GATE_WIN_RATIO == 0.50
    assert PERFORMANCE_GATE_FLOOR_PERCENT == 0.80
    assert GENERALIZATION_GATE_FLOOR_PERCENT == 0.80
    assert PERFORMANCE_ROUND_COST == 1.0
    assert GENERALIZATION_ROUND_COST == 0.5
