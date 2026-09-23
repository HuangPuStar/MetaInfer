"""HE hands DKAO its questions and reads the gate verdict back, read-only.

HE used to lease GPUs and police contention itself. That is gone: the device a
question runs on is a fixed layout decision, and the only gate verdict is the
one the child's own DKAO engine wrote into ``measurement_gate.jsonl``. These
tests pin both halves — the layout HE records, and the read-only audit the
detail page renders — plus the rule that a gate verdict is not retried away.
"""

from __future__ import annotations

import json

from metainfer.tasks.harness_evolve.orchestrator.adapters.eval import (
    GATE_EXIT_CODE, DkaoCliEvaluator,
)
from metainfer.tasks.harness_evolve.orchestrator.rounds import (
    GPU_COUNT, device_for_index,
)
from metainfer.tasks.harness_evolve.server.routes import (
    _child_gate_audit, _gpu_cards,
)


def _gate_row(ts: float, event: str, *, attempt: int = 1, site: str = "benchmark",
              gpu: int = 0, reasons=None, wait_seconds: float = 1800.0,
              candidates=None, passing=None, usable=None):
    row = {
        "ts": ts, "event": event, "site": site, "gpu": gpu, "attempt": attempt,
        "wait_seconds": wait_seconds, "max_waits": 48,
        "reasons": list(reasons or []),
    }
    if candidates is not None:
        row["candidates"] = list(candidates)
        row["passing"] = list(passing or [])
        row["usable"] = bool(passing) if usable is None else usable
    return row


def _write_gate(child_state_dir, rows):
    child_state_dir.mkdir(parents=True, exist_ok=True)
    (child_state_dir / "measurement_gate.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")


# --------------------------------------------------------------- the layout


def test_the_layout_is_a_fixed_rotation_and_says_he_manages_nothing():
    """N questions land as N / 4 waves with one question per device."""
    assert GPU_COUNT == 4
    assert [device_for_index(i) for i in range(8)] == [0, 1, 2, 3, 0, 1, 2, 3]

    class _Inst:
        def __init__(self, i):
            self.id = i

    class _Cfg:
        pass

    layout = DkaoCliEvaluator._device_layout(
        _Cfg(), 2, [_Inst(f"q{i}") for i in range(4)])
    assert layout["schema"] == "he-gpu-layout/1"
    assert layout["managed_by"] == "dcu_kernel_auto_opt"
    # HE holds no lease at all — the field exists so a reader can see that
    assert layout["leases"] == [] and layout["enabled"] is False
    assert layout["devices"] == {"q0": 0, "q1": 1, "q2": 2, "q3": 3}
    assert layout["assigned_devices"] == [0, 1, 2, 3]
    assert "measurement gate" in layout["reason"]


def test_the_layout_is_recorded_next_to_the_iteration_evidence(tmp_path):
    """Audit trail: same file the DKAO side reads, in the run's input dir."""
    (tmp_path / "exp").mkdir()
    cfg = type("Cfg", (), {"exp_dir": tmp_path / "exp"})()
    ev = DkaoCliEvaluator()
    ev._save_preflight(cfg, 3, {"schema": "he-gpu-layout/1", "leases": []})
    audit = (tmp_path / "exp" / "runs" / "iteration_003" / "input"
             / "benchmark" / "gpu_preflight.json")
    assert audit.is_file()
    body = json.loads(audit.read_text(encoding="utf-8"))
    assert body["schema"] == "he-gpu-layout/1" and body["leases"] == []


# ------------------------------------------------------- the gate audit read


def test_gate_audit_counts_checks_waits_and_the_last_verdict(tmp_path):
    _write_gate(tmp_path / "state", [
        _gate_row(1.0, "gate_ok", gpu=0, candidates=[0, 1, 2, 3], passing=[0]),
        _gate_row(2.0, "gate_blocked", reasons=["VRAM 96.0% > 90.0% limit"]),
        _gate_row(2.0, "gate_blocked", reasons=["VRAM 96.0% > 90.0% limit"]),
        _gate_row(3.0, "gate_blocked", attempt=2, site="worker", gpu=2,
                  reasons=["device busy: HCU 100.0% > 0.0%"]),
        _gate_row(4.0, "gate_ok", gpu=2, candidates=[0, 2], passing=[2]),
    ])
    audit = _child_gate_audit(tmp_path / "state")
    assert audit["checks"] == 4                # the duplicated channel row folds
    assert audit["blocked"] == 2
    assert audit["waited_seconds"] == 3600.0   # two 30-minute waits
    assert audit["last_event"] == "gate_ok"
    assert audit["last_site"] == "benchmark"
    assert audit["max_waits"] == 48
    assert audit["last_passing"] == [2] and audit["last_candidates"] == [0, 2]
    # the blocked rows are kept so the page can show *why* it waited
    reasons = [r["reasons"] for r in audit["blocked_reasons"]]
    assert ["VRAM 96.0% > 90.0% limit"] in reasons
    assert ["device busy: HCU 100.0% > 0.0%"] in reasons


def test_a_passing_row_never_reports_its_neighbours_as_this_device_reason(
        tmp_path):
    """Real DKAO shape: a passing row lists the *other* cards it rejected.

    ``ensure_any_measurement_gate`` puts the failed candidates' reasons on a
    ``gate_ok`` row while ``gpu`` is the card that passed. Reporting those
    reasons next to this device would show a block that never happened, so the
    audit must drop them for a passing verdict — and must still name the device
    it cleared.
    """
    _write_gate(tmp_path / "state", [
        _gate_row(10.0, "gate_ok", site="generate_probe", gpu=1,
                  candidates=[0, 1, 2, 3], passing=[1, 2, 3], usable=True,
                  reasons=["device busy: HCU 97.5% > 0.0%"]),
    ])
    audit = _child_gate_audit(tmp_path / "state")
    assert audit["last_event"] == "gate_ok" and audit["last_usable"] is True
    assert audit["last_reasons"] == []                 # not this device's block
    assert audit["blocked"] == 0 and audit["waited_seconds"] == 0
    assert audit["device"] == 1 and audit["device_from"] == "gate_pass"
    assert audit["last_passing"] == [1, 2, 3]


def test_a_blocked_row_keeps_its_reasons_and_the_device_it_blocked_on(
        tmp_path):
    _write_gate(tmp_path / "state", [
        _gate_row(10.0, "gate_blocked", site="benchmark", gpu=3, attempt=1,
                  candidates=[3], passing=[], usable=False,
                  reasons=["VRAM 94% > 90% limit",
                           "device busy: HCU 90.8% > 0.0%"]),
    ])
    audit = _child_gate_audit(tmp_path / "state")
    assert audit["last_event"] == "gate_blocked"
    assert audit["last_usable"] is False
    assert audit["last_reasons"] == ["VRAM 94% > 90% limit",
                                     "device busy: HCU 90.8% > 0.0%"]
    assert audit["device"] == 3 and audit["device_from"] == "gate_blocked"
    assert audit["waited_seconds"] == 1800.0


def test_gate_audit_of_a_child_that_never_gated_is_empty(tmp_path):
    audit = _child_gate_audit(tmp_path / "missing")
    assert audit["checks"] == 0 and audit["blocked"] == 0
    assert audit["last_event"] is None and audit["blocked_reasons"] == []
    assert audit["waited_seconds"] == 0
    assert audit["device"] is None and audit["device_from"] is None
    assert audit["last_reasons"] == []


def test_child_gate_audit_matches_the_dkao_route_verdict(tmp_path):
    """HE must read the child's rows the same way DKAO's own page does."""
    from metainfer.tasks.dcu_kernel_auto_opt.server.routes import _gate_status

    state = tmp_path / "state"
    _write_gate(state, [
        _gate_row(1.0, "gate_blocked", reasons=["device busy: HCU 100.0% > 0.0%"]),
        _gate_row(2.0, "gate_ok", gpu=1, candidates=[1], passing=[1]),
    ])
    dkao = _gate_status(state)
    he = _child_gate_audit(state)
    assert dkao["blocked"] == he["blocked"] == 1
    assert dkao["last_event"] == he["last_event"] == "gate_ok"


# ------------------------------------------------------------ the card view


def _seed_child(exp, num, qid, *, phase="parallel_explore", gate_rows=()):
    state = exp / "children" / f"iteration_{num:03d}" / qid / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "run.json").write_text(json.dumps({
        "task_id": qid, "task_type": "dcu-kernel-auto-opt",
        "current_phase": phase, "current_iteration": 1,
    }), encoding="utf-8")
    if gate_rows:
        _write_gate(state, gate_rows)
    return state


def test_gpu_cards_group_questions_by_their_own_device(tmp_path):
    """The card is the device the child's gate recorded, not the enumeration."""
    exp = tmp_path / "exp"
    # child A was cleared for device 3, child B for device 0: the cards must
    # follow the children's own records rather than alphabetical order
    _seed_child(exp, 2, "m16_a", gate_rows=[
        _gate_row(1.0, "gate_blocked", gpu=3,
                  reasons=["device busy: HCU 100.0% > 0.0%"]),
        _gate_row(2.0, "gate_ok", gpu=3, candidates=[3], passing=[3]),
    ])
    _seed_child(exp, 2, "m16_b", gate_rows=[
        _gate_row(3.0, "gate_ok", gpu=0, candidates=[0], passing=[0]),
    ])
    _seed_child(exp, 2, "m16_c")            # no gate record: layout prediction

    cards = _gpu_cards(exp, 2)
    by_gpu = {c["gpu"]: c for c in cards}
    assert sorted(by_gpu) == [0, 2, 3]
    assert [q["question"] for q in by_gpu[3]["questions"]] == ["m16_a"]
    assert [q["question"] for q in by_gpu[0]["questions"]] == ["m16_b"]
    # m16_c is the third child alphabetically -> index 2 -> predicted device 2
    assert [q["question"] for q in by_gpu[2]["questions"]] == ["m16_c"]
    assert by_gpu[3]["questions"][0]["gate_audit"]["blocked"] == 1
    assert by_gpu[3]["questions"][0]["gpu_source"] == "gate_pass"
    # nothing recorded this round's layout and the child has no requirements,
    # so its device is only a prediction — and it must not look like an
    # observation or like HE's own layout record
    assert by_gpu[2]["questions"][0]["gpu_source"] == "predicted"


def test_a_child_without_gate_records_is_marked_as_a_prediction(tmp_path):
    """An observed device and a predicted one must not look the same."""
    exp = tmp_path / "exp"
    _seed_child(exp, 1, "no_gate_yet")
    cards = _gpu_cards(exp, 1)
    q = cards[0]["questions"][0]
    assert q["gpu_source"] == "predicted"
    assert q["gate_audit"]["checks"] == 0
    assert q["gate_audit"]["device"] is None


def test_the_round_layout_beats_a_probe_run_on_another_card(tmp_path):
    """The real case: three children were listed under GPU2 because their
    *generate probe* ran there, even though HE had given them GPU0/1/2/3.

    A probe may legitimately run on any passing device ("this task's own card
    first, otherwise any idle one"), so it must never decide which card a
    question is shown under — otherwise a four-card view shows two cards.
    """
    exp = tmp_path / "exp"
    (exp / "runs" / "iteration_002" / "input" / "benchmark").mkdir(parents=True)
    (exp / "runs" / "iteration_002" / "input" / "benchmark"
     / "gpu_preflight.json").write_text(json.dumps({
         "iteration": 2, "gpu_count": 4, "managed_by": "dcu_kernel_auto_opt",
         "devices": {"m16_a": 0, "m16_b": 1},
     }), encoding="utf-8")
    # both children's last *passing* row is the probe, on device 2
    _seed_child(exp, 2, "m16_a", gate_rows=[
        _gate_row(1.0, "gate_pass", gpu=2, site="generate_probe",
                  candidates=[0, 1, 2, 3], passing=[2]),
    ])
    _seed_child(exp, 2, "m16_b", gate_rows=[
        _gate_row(2.0, "gate_pass", gpu=2, site="generate_probe",
                  candidates=[0, 1, 2, 3], passing=[2]),
    ])

    cards = _gpu_cards(exp, 2)
    by_gpu = {c["gpu"]: c for c in cards}

    assert sorted(by_gpu) == [0, 1], "the layout decides the card"
    assert [q["question"] for q in by_gpu[0]["questions"]] == ["m16_a"]
    assert [q["question"] for q in by_gpu[1]["questions"]] == ["m16_b"]
    assert by_gpu[0]["questions"][0]["gpu_source"] == "layout"
    # ... and the probe's card is still reported, as a separate fact
    assert by_gpu[0]["questions"][0]["gate_audit"]["probe_device"] == 2
    assert by_gpu[0]["questions"][0]["gate_audit"]["devices"] == [2]


def test_a_measuring_site_row_decides_over_a_probe_row(tmp_path):
    """Without a layout record, the card that *measured* is the child's card."""
    exp = tmp_path / "exp"
    _seed_child(exp, 1, "m16_a", gate_rows=[
        _gate_row(1.0, "gate_pass", gpu=2, site="generate_probe",
                  candidates=[0, 2], passing=[2]),
        _gate_row(2.0, "gate_pass", gpu=0, site="benchmark",
                  candidates=[0], passing=[0]),
    ])
    cards = _gpu_cards(exp, 1)
    q = cards[0]["questions"][0]
    assert cards[0]["gpu"] == 0 and q["gpu_source"] == "gate_pass"
    assert q["gate_audit"]["probe_device"] == 2


def test_gpu_cards_carry_the_child_phase_and_never_a_lease(tmp_path):
    exp = tmp_path / "exp"
    _seed_child(exp, 1, "only", phase="serial_validate")
    cards = _gpu_cards(exp, 1)
    assert len(cards) == 1
    q = cards[0]["questions"][0]
    assert q["question"] == "only"
    assert q["current_phase"] == "serial_validate"
    assert q["gpu"] == 0
    assert "gate_audit" in q
    # nothing in this payload is a lease HE took
    assert "lease" not in q and "holder" not in q


def test_gpu_cards_are_empty_before_any_child_is_dispatched(tmp_path):
    exp = tmp_path / "exp"
    (exp / "children").mkdir(parents=True)
    assert _gpu_cards(exp, 4) == []


# -------------------------------------------------- the verdict is not ignored


def test_gate_exit_code_matches_the_dkao_asset_that_raises_it():
    """The duplicated constant must not drift from the child's own value."""
    import re
    from pathlib import Path

    asset = (Path(__file__).resolve().parents[2] / "dcu_kernel_auto_opt"
             / "assets" / "w8a8_bench.py")
    match = re.search(r"^GATE_EXIT_CODE\s*=\s*(\d+)", asset.read_text(
        encoding="utf-8"), re.MULTILINE)
    assert match, "w8a8_bench.py no longer defines GATE_EXIT_CODE"
    assert int(match.group(1)) == GATE_EXIT_CODE


# ------------------------------------------------------------- the Web route


def test_the_web_route_serves_the_cards_and_offers_no_lease_control(
        tmp_path, client):
    """The page's own endpoint: read-only, no lease, no release/drain verbs."""
    from metainfer.server import tasks as _tasks
    from metainfer.server.tasks import TaskEntry

    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    state_dir.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (state_dir / "requirements.json").write_text(json.dumps({
        "task_id": "he-gpu", "task_type": "harness-evolve",
        "answers": {"ahe_repo_root": str(tmp_path / "repos")},
    }), encoding="utf-8")
    (state_dir / "run.json").write_text(json.dumps({"task_id": "he-gpu"}),
                                        encoding="utf-8")
    _seed_child(workspace, 2, "m16_a", gate_rows=[
        _gate_row(1.0, "gate_blocked", gpu=3,
                  reasons=["device busy: HCU 100.0% > 0.0%"]),
    ])
    _tasks.add_task(TaskEntry(
        id="he-gpu", type="harness-evolve", label="device cards",
        state_dir=str(state_dir), workspace_dir=str(workspace),
        created_at=0.0))

    resp = client.get("/api/harness-evolve/he-gpu/iterations/2/gpu")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["managed_by"] == "dcu_kernel_auto_opt"
    assert body["leases"] == []                # HE holds nothing
    assert body["gpu_count"] == 4
    assert [c["gpu"] for c in body["cards"]] == [3]
    q = body["cards"][0]["questions"][0]
    assert q["question"] == "m16_a"
    assert q["gate_audit"]["blocked"] == 1
    assert q["gate_audit"]["last_reasons"] == ["device busy: HCU 100.0% > 0.0%"]
    # the operator controls are gone with the lease they controlled
    for verb in ("release", "drain"):
        assert client.post(f"/api/harness-evolve/he-gpu/gpu/{verb}").status_code == 404
    assert client.get("/api/harness-evolve/he-gpu/gpu").status_code == 404
