"""Manual GPU choice: a task may place its (at most four) workers on any card.

The cap of four workers is policy and stays; which four **cards** they use is a
machine fact (eight on the air board, four on liquid) and is now discovered.  A
four-card machine must behave exactly as before, which is what the parity test
at the bottom pins.
"""

from __future__ import annotations

import pytest

from metainfer.orchestrator import gpu_inventory as gi

from ..orchestrator.config import load_config
from ..orchestrator.gpu_binding import bind_worker_gpu


def _req(shape_config: str):
    return {
        "answers": {
            "execution_mode": "Mock (no GPU)",
            "shape_config": shape_config,
            "mock_iterations": "2",
            "minimum_improvement_percent": 1.0,
        }
    }


AIR = "0,1,2,3,4,5,6,7"
LIQUID = "0,1,2,3"


@pytest.fixture(autouse=True)
def _fresh_cache():
    gi.reset_cache()
    yield
    gi.reset_cache()


@pytest.fixture
def air_board(monkeypatch):
    monkeypatch.setenv(gi.DEVICES_ENV, AIR)
    gi.reset_cache()


@pytest.fixture
def liquid_board(monkeypatch):
    monkeypatch.setenv(gi.DEVICES_ENV, LIQUID)
    gi.reset_cache()


def test_eight_card_machine_accepts_any_card(air_board):
    """The operator's case: 0/1 busy, so place the four workers on 4..7.

    A worker is named after the card it runs on -- that is the contract the
    generate phase validates (`_require_valid_child_assignments`), and it is how
    harness_evolve names its children.
    """
    cfg = load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
  - {id: b, M: 8, N: 4096, K: 1024}
assignments:
  worker_4: {gpu: 4, shapes: [a]}
  worker_5: {gpu: 5, shapes: [b]}
"""))
    assert [(a.worker_id, a.gpu) for a in cfg.assignments] == [
        ("worker_4", 4), ("worker_5", 5),
    ]


def test_non_contiguous_cards_are_fine(air_board):
    """Nothing requires the chosen cards to be contiguous or ascending."""
    cfg = load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
  - {id: b, M: 8, N: 4096, K: 1024}
assignments:
  worker_7: {gpu: 7, shapes: [a]}
  worker_3: {gpu: 3, shapes: [b]}
"""))
    assert [(a.worker_id, a.gpu) for a in cfg.assignments] == [
        ("worker_7", 7), ("worker_3", 3),
    ]


def test_manual_occupy_rejects_a_worker_not_named_after_its_card(air_board):
    """The failure the operator hit, caught at submission instead of later.

    ``worker_0: {gpu: 2}`` used to pass config validation and then die inside
    generate_kernel_repo with "manual assignments must map worker_N to GPU N".
    """
    with pytest.raises(ValueError, match=r"name each worker after the card"):
        load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
  - {id: b, M: 8, N: 4096, K: 1024}
assignments:
  worker_0: {gpu: 2, shapes: [a]}
  worker_1: {gpu: 3, shapes: [b]}
"""))


def test_the_message_says_what_the_mapping_should_be(air_board):
    with pytest.raises(ValueError) as excinfo:
        load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
assignments:
  worker_0: {gpu: 6, shapes: [a]}
"""))
    message = str(excinfo.value)
    assert "{'worker_0': 6}" in message
    assert "{'worker_6': 6}" in message


def test_scheduled_mode_does_not_require_the_name_rule(air_board, monkeypatch):
    """The broker re-derives worker names from the devices it leases."""
    from ..orchestrator import config as C

    def _fake_lease(assignments, answers, *, production=False):
        reborn = [
            C.WorkerAssignment(f"worker_{item.gpu}", item.gpu, item.shape_ids)
            for item in assignments
        ]
        return reborn, {"mode": "scheduled", "gpus": [item.gpu for item in reborn]}

    monkeypatch.setattr(C, "lease_gpus_for_task", _fake_lease)
    req = _req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
assignments:
  worker_0: {gpu: 2, shapes: [a]}
""")
    req["answers"]["gpu_mode"] = "scheduled"
    cfg = load_config(req)
    assert cfg.gpu_mode == "scheduled"
    assert [(a.worker_id, a.gpu) for a in cfg.assignments] == [("worker_2", 2)]


def test_a_card_beyond_the_machine_is_rejected(air_board):
    with pytest.raises(ValueError, match="gpu must be one of 0,1,2,3,4,5,6,7"):
        load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
assignments:
  worker_8: {gpu: 8, shapes: [a]}
"""))


def test_two_workers_may_not_share_one_card(air_board):
    with pytest.raises(ValueError, match="assigned more than once"):
        load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
  - {id: b, M: 8, N: 4096, K: 1024}
assignments:
  worker_5: {gpu: 5, shapes: [a]}
  worker_0: {gpu: 5, shapes: [b]}
"""))


def test_the_worker_cap_is_still_four(air_board):
    """Choosing among eight cards must not become eight parallel workers."""
    with pytest.raises(ValueError, match="at most four workers"):
        load_config(_req("""
shapes:
  - {id: a, M: 8, N: 1536, K: 4096}
  - {id: b, M: 8, N: 4096, K: 1024}
  - {id: c, M: 8, N: 8192, K: 1024}
  - {id: d, M: 8, N: 512, K: 4096}
  - {id: e, M: 8, N: 4096, K: 256}
assignments:
  worker_0: {gpu: 0, shapes: [a]}
  worker_1: {gpu: 1, shapes: [b]}
  worker_2: {gpu: 2, shapes: [c]}
  worker_3: {gpu: 3, shapes: [d]}
  worker_4: {gpu: 4, shapes: [e]}
"""))


def test_guidance_accepts_a_worker_named_after_a_high_card(tmp_path):
    """The lane endpoints must know `worker_6`, not only `worker_0..3`."""
    from ..orchestrator.guidance import add_guidance, claim_next_guidance

    root = tmp_path / "guidance"
    add_guidance(root, "worker_6", "prefer contiguous weight reads")
    claimed = claim_next_guidance(root, "worker_6", 1)
    assert claimed and claimed.get("text") == "prefer contiguous weight reads"
    with pytest.raises(ValueError, match="unknown worker"):
        add_guidance(root, "worker_six", "nope")


def test_binding_refuses_a_card_outside_the_task(liquid_board):
    """A task placed on 0..3 must not bind to card 5 even though it exists."""
    env = {"ROCR_VISIBLE_DEVICES": "3"}
    assert bind_worker_gpu(env, 2, allowed=[0, 1, 2]) == {
        "HIP_VISIBLE_DEVICES": "2"
    }
    with pytest.raises(ValueError, match="physical_gpu must be one of 0,1,2"):
        bind_worker_gpu({}, 5, allowed=[0, 1, 2])


def test_binding_accepts_a_high_card_on_the_air_board(air_board):
    env = {}
    assert bind_worker_gpu(env, 6, allowed=[4, 5, 6, 7]) == {
        "HIP_VISIBLE_DEVICES": "6"
    }
    assert env["HIP_VISIBLE_DEVICES"] == "6"
    # ... and without an explicit set, any card this machine exposes.
    assert bind_worker_gpu({}, 7) == {"HIP_VISIBLE_DEVICES": "7"}
    with pytest.raises(ValueError, match="physical_gpu must be one of 0,1,2,3,4,5,6,7"):
        bind_worker_gpu({}, 9)


def test_frontend_payload_round_trips(air_board):
    """The exact text the shape-input control emits for lanes on cards 5..7,4.

    ``worker_<n>`` is the lane; ``gpu:`` is the card.  Keeping the two apart is
    what lets the UI keep four lanes while the cards underneath change.
    """
    cfg = load_config(_req("""
model: MiniMax M3
assignment_mode: manual
shape_scope: subset
shapes:
  - {id: minimax_tp8_qkv_proj_m8, M: 8, N: 1280, K: 6144, tp_size: 8, operator: "qkv_proj"}
  - {id: minimax_tp8_o_proj_m8, M: 8, N: 6144, K: 1024, tp_size: 8, operator: "o_proj"}
  - {id: minimax_tp8_shared_down_proj_m8, M: 8, N: 6144, K: 384, tp_size: 8, operator: "shared_down_proj"}
assignments:
  worker_5: {gpu: 5, shapes: [minimax_tp8_qkv_proj_m8]}
  worker_7: {gpu: 7, shapes: [minimax_tp8_o_proj_m8]}
  worker_4: {gpu: 4, shapes: [minimax_tp8_shared_down_proj_m8]}
"""))
    assert [(a.worker_id, a.gpu) for a in cfg.assignments] == [
        ("worker_5", 5), ("worker_7", 7), ("worker_4", 4),
    ]
    assert cfg.assignment_mode == "manual"


def test_four_card_board_is_unchanged(liquid_board):
    """Liquid parity: the same text behaves exactly as before the change."""
    cfg = load_config(_req("""
shapes:
  - {id: a, M: 16, N: 1536, K: 4096}
  - {id: b, M: 16, N: 4096, K: 1024}
assignments:
  worker_0: {gpu: 0, shapes: [a]}
  worker_1: {gpu: 1, shapes: [b]}
"""))
    assert [(a.worker_id, a.gpu) for a in cfg.assignments] == [
        ("worker_0", 0), ("worker_1", 1),
    ]
    # card 4 is not offered by a four-card machine ...
    with pytest.raises(ValueError, match="gpu must be one of 0,1,2,3"):
        load_config(_req("""
shapes:
  - {id: a, M: 16, N: 1536, K: 4096}
assignments:
  worker_0: {gpu: 4, shapes: [a]}
"""))
    # ... and the plain binding path accepts exactly 0..3, as it always did.
    assert bind_worker_gpu({}, 3) == {"HIP_VISIBLE_DEVICES": "3"}
    with pytest.raises(ValueError):
        bind_worker_gpu({}, 4)
