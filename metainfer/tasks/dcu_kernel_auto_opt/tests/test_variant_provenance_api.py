"""The user-facing variant write boundary records only this board's ratios.

``POST /variants`` is where an accepted kernel becomes shared evidence, and the
``speedup`` it stamps travels with that kernel into every later agent's
``references/``.  The rule under test: the number may only come from this
machine's hardware profile.

Motivating case (measured, 2026-09-29): the single air variant in the tree was
promoted from a task that ran *before* the profile split, so the only baseline
available was the hardcoded reference-board table.  The header recorded
``baseline_us=19.98 speedup=1.967`` while this board's own value for the same
shape is 25.936 us -- a cross-profile ratio filed as a same-machine fact.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metainfer.orchestrator import hw_profile
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import variant_store as vs

from .conftest import register_dkao_task

#: A shape no baseline table carries, so the *task report* is the only
#: candidate baseline and the provenance rule alone decides.
SHAPE = "hy3_tp4_o_proj_m99"
ANSWERS = {
    "operator": "Quantized GEMM",
    "dtype": "INT8 W8A8",
    "model": "Hy3 (Hunyuan 3)",
    "target_hardware": "K500SM_AI / gfx928",     # the wrong label, on purpose
}


@pytest.fixture()
def variant_root(tmp_path, monkeypatch):
    root = tmp_path / "variant"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(vs, "variant_root", lambda: root)
    return root


@pytest.fixture()
def air_machine(monkeypatch):
    monkeypatch.setenv("METAINFER_HW_PROFILE", "air-k100ai")
    hw_profile.clear_cache()
    yield
    hw_profile.clear_cache()


def _task(tmp_path: Path, *, report_baseline=None, median_us: float = 10.16,
          task_profile: str = "air-k100ai") -> tuple:
    """A registered task whose worker lane holds one accepted kernel.

    ``task_profile`` is the board its numbers came from: the promote route
    refuses a task whose recorded profile is not this machine's, so every test
    stamps one (``""`` = an unrecorded task).
    """
    state_dir = tmp_path / "state"
    workspace = tmp_path / "ws"
    register_dkao_task(state_dir, workspace, task_id="dkao-prov")
    requirements = {"task_id": "dkao-prov", "task_type": "dcu-kernel-auto-opt",
                    **ANSWERS}
    if task_profile:
        requirements["hw_profile"] = task_profile
    (state_dir / "requirements.json").write_text(json.dumps(requirements),
                                                 encoding="utf-8")
    leaf = workspace / "workers" / "worker_0" / "accepted" / SHAPE
    leaf.mkdir(parents=True)
    (leaf / "kernel.hip").write_text("// accepted kernel\n", encoding="utf-8")
    _set_candidate(workspace, median_us)
    if report_baseline is not None:
        (workspace / "final_report.json").write_text(json.dumps({
            "initial_metrics": {SHAPE: report_baseline},
        }), encoding="utf-8")
    return state_dir, workspace


def _set_candidate(workspace: Path, median_us: float) -> None:
    """What the lane's accepted kernel measures this time around."""
    leaf = workspace / "workers" / "worker_0" / "accepted" / SHAPE
    (leaf / "manifest.json").write_text(json.dumps({
        "commit": "abc123",
        "shape": {"M": 99, "N": 4096, "K": 2048},
        "metrics": {"median_us": median_us, "p90_us": median_us * 1.13},
    }), encoding="utf-8")


def _post(client, task_id: str):
    return client.post(f"/api/dcu-kernel-auto-opt/{task_id}/variants",
                       json={"shape_id": SHAPE})


def test_a_pre_split_report_baseline_is_not_stamped_as_a_speedup(
    client, tmp_path, variant_root, air_machine,
):
    """The regression: 19.98 us is the reference board's number, not this one's."""
    _task(tmp_path, report_baseline={
        "median_us": 19.984, "baseline_us": 19.984,
        "source": "user_supplied_fixed_table",      # pre-split, no provenance
    })
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 200, resp.text
    written = Path(resp.json()["path"]).read_text(encoding="utf-8")
    assert "median_us=10.16" in written
    assert "speedup=" not in written
    assert "baseline_us=" not in written


def test_a_baseline_from_this_board_is_stamped(
    client, tmp_path, variant_root, air_machine,
):
    _task(tmp_path, report_baseline={
        "median_us": 25.936, "baseline_us": 25.936,
        "baseline_profile": "air-k100ai", "profile_mismatch": False,
        "source": "profile_table:air-k100ai",
    })
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 200, resp.text
    written = Path(resp.json()["path"]).read_text(encoding="utf-8")
    # 4-significant-digit rendering, same as the header writer.
    assert "baseline_us=25.94" in written
    assert "speedup=2.553" in written


def test_an_explicit_reference_fallback_is_not_stamped(
    client, tmp_path, variant_root, air_machine,
):
    _task(tmp_path, report_baseline={
        "median_us": 19.984, "baseline_profile": "liquid-k500sm",
        "profile_mismatch": True, "source": "profile_table:liquid-k500sm",
    })
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 200, resp.text
    assert "speedup=" not in Path(resp.json()["path"]).read_text(encoding="utf-8")


def test_the_kernel_is_still_recorded_when_the_ratio_is_not(
    client, tmp_path, variant_root, air_machine,
):
    """Refusing the ratio must not refuse the evidence itself."""
    _task(tmp_path, report_baseline={"median_us": 19.984})
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["profile"] == "air-k100ai"
    assert body["action"] == "added"
    leaf = Path(body["path"])
    assert leaf.parent.name == "M99" and leaf.name == "o_proj.hip"
    assert "air-k100ai" in str(leaf)
    header = vs._parse_variant_header(leaf.read_text(encoding="utf-8"))
    assert header["hw_profile"] == "air-k100ai"
    assert header["median_us"] == 10.16


# --------------------------------------------------------------------------- #
# "加入 variant": faster replaces, slower is not added (the liquid mechanism)
# --------------------------------------------------------------------------- #


def test_a_faster_candidate_replaces_this_boards_variant(
    client, tmp_path, variant_root, air_machine,
):
    _, workspace = _task(tmp_path, median_us=20.0)
    first = _post(client, "dkao-prov")
    assert first.status_code == 200, first.text
    assert first.json()["action"] == "added"

    _set_candidate(workspace, 10.0)              # this round is faster
    second = _post(client, "dkao-prov")
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["action"] == "updated"
    assert body["path"] == first.json()["path"]
    header = vs._parse_variant_header(Path(body["path"]).read_text(encoding="utf-8"))
    assert header["median_us"] == 10.0


def test_a_slower_candidate_is_not_added(
    client, tmp_path, variant_root, air_machine,
):
    """The reported requirement: a slower round must not overwrite the variant."""
    _, workspace = _task(tmp_path, median_us=10.0)
    first = _post(client, "dkao-prov")
    assert first.status_code == 200, first.text
    before = Path(first.json()["path"]).read_text(encoding="utf-8")

    _set_candidate(workspace, 20.0)              # this round is slower
    second = _post(client, "dkao-prov")
    assert second.status_code == 409, second.text
    assert "slower" in second.json()["detail"]
    after = Path(first.json()["path"]).read_text(encoding="utf-8")
    assert after == before, "the faster variant was overwritten anyway"


def test_an_equal_candidate_may_replace(client, tmp_path, variant_root,
                                        air_machine):
    """Equal is allowed, matching the server's documented rule.

    Only a *strictly* slower candidate is refused, which is what the liquid
    board has always done; the 3% improvement gate belongs to the automatic
    promotion path (``variant_promote``), not to this manual button.
    """
    _, workspace = _task(tmp_path, median_us=10.0)
    assert _post(client, "dkao-prov").status_code == 200
    _set_candidate(workspace, 10.0)
    same = _post(client, "dkao-prov")
    assert same.status_code == 200, same.text
    assert same.json()["action"] == "updated"


def test_the_slower_check_never_fires_across_profiles(
    client, tmp_path, variant_root, air_machine,
):
    """A liquid variant must not block this board's first write.

    ``_reject_slower_replacement`` skips the comparison when the existing file
    belongs to another profile -- otherwise a fast liquid kernel would refuse
    every air candidate and the air tree could never be seeded.
    """
    meta = vs.derive_variant_meta(ANSWERS, SHAPE)
    liquid_leaf = vs.variant_path(meta, profile="liquid-k500sm")
    liquid_leaf.parent.mkdir(parents=True, exist_ok=True)
    liquid_leaf.write_text(vs.section_header(
        meta, commit="liquid", metrics={"median_us": 5.0},
        profile="liquid-k500sm", machine="j20r1n08",
    ) + "// liquid kernel\n// @@end\n", encoding="utf-8")

    _, workspace = _task(tmp_path, median_us=50.0)     # far slower than liquid
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 200, resp.text
    written = Path(resp.json()["path"])
    assert "air-k100ai" in str(written)
    assert liquid_leaf.read_text(encoding="utf-8").endswith("// @@end\n")
    assert vs._parse_variant_header(
        liquid_leaf.read_text(encoding="utf-8"))["median_us"] == 5.0


# --------------------------------------------------------------------------- #
# A task's numbers may only be filed under the board that measured them
# --------------------------------------------------------------------------- #


def test_a_liquid_tasks_kernel_is_not_filed_into_the_air_library(
    client, tmp_path, variant_root, air_machine,
):
    """The write lands in this machine's profile; the data is the task's.

    Promoting a liquid task's accepted kernel on the air machine would record a
    liquid median (and a speedup against a liquid baseline) inside
    ``variant/air-k100ai/`` -- the exact mix-up the split exists to prevent.
    """
    _task(tmp_path, task_profile="liquid-k500sm")
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 409, resp.text
    assert "liquid-k500sm" in resp.json()["detail"]
    assert not list(variant_root.rglob("*.hip"))


def test_an_unrecorded_task_cannot_be_promoted(
    client, tmp_path, variant_root, air_machine,
):
    """No record -> no way to tell whose numbers these are: refuse and say how."""
    _task(tmp_path, task_profile="")
    resp = _post(client, "dkao-prov")
    assert resp.status_code == 409, resp.text
    assert "backfill_task_hw_profile" in resp.json()["detail"]
    assert not list(variant_root.rglob("*.hip"))


def test_the_variants_payload_reports_the_tasks_own_board(
    client, tmp_path, variant_root, air_machine,
):
    """The page needs both boards: the task's (to display) and the machine's."""
    _task(tmp_path, task_profile="liquid-k500sm")
    body = client.get(
        "/api/dcu-kernel-auto-opt/dkao-prov/variants"
    ).json()
    assert body["task_hw_profile"] == "liquid-k500sm"
    assert body["task_hw_profile_source"] == "requirements.json"
    assert body["hw_profile"]["hw_profile"] == "air-k100ai"
