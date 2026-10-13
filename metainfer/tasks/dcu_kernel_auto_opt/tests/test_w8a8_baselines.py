from __future__ import annotations

import pytest

from ..orchestrator.w8a8_baselines import fixed_triton_graph_baseline


@pytest.mark.parametrize(
    ("shape", "expected"),
    [
        ({"M": 2, "N": 1536, "K": 4096}, 66.924),
        ({"M": 16, "N": 1536, "K": 4096}, 66.597),
        ({"M": 2, "N": 8192, "K": 1024}, 47.181),
        ({"M": 16, "N": 8192, "K": 1024}, 48.049),
        ({"M": 2, "N": 4096, "K": 2048}, 54.453),
        ({"M": 16, "N": 4096, "K": 2048}, 54.617),
        ({"M": 2, "N": 1024, "K": 4096}, 60.389),
        ({"M": 16, "N": 1024, "K": 4096}, 60.965),
        ({"M": 2, "N": 4096, "K": 512}, 18.975),
        ({"M": 16, "N": 4096, "K": 512}, 21.372),
        ({"M": 3072, "N": 1536, "K": 4096}, 9488.0),
        ({"M": 3072, "N": 8192, "K": 1024}, 15437.0),
        ({"M": 3072, "N": 4096, "K": 2048}, 14680.0),
        ({"M": 3072, "N": 1024, "K": 4096}, 5985.0),
        ({"M": 3072, "N": 4096, "K": 512}, 4199.0),
        ({"M": 4096, "N": 1536, "K": 4096}, 13247.253),
        ({"M": 4096, "N": 8192, "K": 1024}, 20590.225),
        ({"M": 4096, "N": 4096, "K": 2048}, 19881.949),
        ({"M": 4096, "N": 1024, "K": 4096}, 8790.192),
        ({"M": 4096, "N": 4096, "K": 512}, 5545.821),
    ],
)
def test_fixed_triton_graph_baseline(shape, expected):
    # The expectations are the *reference* (liquid) catalog; this board has
    # measured some of these families itself, so the lookup is pinned.
    record = fixed_triton_graph_baseline("shape", shape, hw_profile="liquid-k500sm")
    assert record["median_us"] == expected
    assert record["baseline_kind"] == "triton_graph"
    expected_scope = (
        "prefill_graph_replay" if int(shape["M"]) > 16
        else "decode_graph_replay"
    )
    assert record["timing_scope"] == expected_scope
    assert record["distribution_stats_available"] is False


def test_prefill_baseline_has_prefill_timing_scope():
    record = fixed_triton_graph_baseline(
        "tp4_wqkv_a_m3072",
        {"M": 3072, "N": 1536, "K": 4096},
        hw_profile="liquid-k500sm",
    )
    assert record["timing_scope"] == "prefill_graph_replay"


def test_fixed_baseline_rejects_unknown_shape():
    with pytest.raises(ValueError, match="no fixed Triton Graph baseline"):
        fixed_triton_graph_baseline(
            "m4_wqkv_a", {"M": 4, "N": 1536, "K": 4096}
        )


@pytest.mark.parametrize(
    ("shape", "expected"),
    [
        # Hy3 TP8 M=4096 (measured 2026-08-27, CUDA-graph replay).
        ({"tp_size": 8, "M": 4096, "N": 1280, "K": 4096}, 19381.383),
        ({"tp_size": 8, "M": 4096, "N": 4096, "K": 1024}, 14151.792),
        ({"tp_size": 8, "M": 4096, "N": 384, "K": 4096}, 16712.231),
        ({"tp_size": 8, "M": 4096, "N": 4096, "K": 192}, 10762.616),
        # MiniMax M3 TP8 M=4096.
        ({"tp_size": 8, "M": 4096, "N": 1280, "K": 6144}, 41000.618),
        ({"tp_size": 8, "M": 4096, "N": 1536, "K": 6144}, 35604.698),
        ({"tp_size": 8, "M": 4096, "N": 6144, "K": 1024}, 19897.517),
        ({"tp_size": 8, "M": 4096, "N": 768, "K": 6144}, 31882.257),
        ({"tp_size": 8, "M": 4096, "N": 6144, "K": 384}, 22389.162),
        # GLM5.2 TP8 M=4096.
        ({"tp_size": 8, "M": 4096, "N": 2624, "K": 6144}, 68661.417),
        ({"tp_size": 8, "M": 4096, "N": 2048, "K": 2048}, 14385.571),
        ({"tp_size": 8, "M": 4096, "N": 3584, "K": 512}, 6939.939),
        ({"tp_size": 8, "M": 4096, "N": 6144, "K": 2048}, 54775.797),
        ({"tp_size": 8, "M": 4096, "N": 512, "K": 6144}, 21254.589),
        ({"tp_size": 8, "M": 4096, "N": 6144, "K": 256}, 17700.262),
    ],
)
def test_model_catalog_tp8_m4096_baselines(shape, expected):
    # Pinned to the reference (liquid) profile: these are its measurements.
    # This board has since measured its own M=4096 baselines (2026-09-29), so an
    # unpinned lookup would return those instead.
    record = fixed_triton_graph_baseline("shape", shape, hw_profile="liquid-k500sm")
    assert record["median_us"] == expected
    assert record["timing_scope"] == "prefill_graph_replay"
    assert record["baseline_profile"] == "liquid-k500sm"


@pytest.mark.parametrize(
    ("shape", "expected"),
    [
        # Hy3 TP8 M=8 (measured 2026-09-20, CUDA-graph replay).
        ({"tp_size": 8, "M": 8, "N": 1280, "K": 4096}, 66.432),
        ({"tp_size": 8, "M": 8, "N": 4096, "K": 1024}, 31.472),
        ({"tp_size": 8, "M": 8, "N": 384, "K": 4096}, 57.008),
        ({"tp_size": 8, "M": 8, "N": 4096, "K": 192}, 14.592),
        # MiniMax M3 TP8 M=8.
        ({"tp_size": 8, "M": 8, "N": 1280, "K": 6144}, 98.865),
        ({"tp_size": 8, "M": 8, "N": 1536, "K": 6144}, 99.473),
        ({"tp_size": 8, "M": 8, "N": 6144, "K": 1024}, 32.960),
        ({"tp_size": 8, "M": 8, "N": 768, "K": 6144}, 92.928),
        ({"tp_size": 8, "M": 8, "N": 6144, "K": 384}, 19.984),
        # GLM5.2 TP8 M=8.
        ({"tp_size": 8, "M": 8, "N": 2624, "K": 6144}, 87.200),
        ({"tp_size": 8, "M": 8, "N": 2048, "K": 2048}, 36.704),
        ({"tp_size": 8, "M": 8, "N": 3584, "K": 512}, 15.808),
        ({"tp_size": 8, "M": 8, "N": 6144, "K": 2048}, 58.864),
        ({"tp_size": 8, "M": 8, "N": 512, "K": 6144}, 88.448),
        ({"tp_size": 8, "M": 8, "N": 6144, "K": 256}, 15.136),
    ],
)
def test_model_catalog_tp8_m8_baselines(shape, expected):
    # M=8 is the model-catalog short-decode boundary added on 2026-09-20 and
    # resolves as a decode baseline (M <= 16).
    #
    # Pinned to the *reference* profile on purpose: these expectations are the
    # liquid-board measurements. Baselines are now per hardware profile, so a
    # machine whose own table covers the shape returns its own numbers instead
    # (see test_air_profile_uses_its_own_baselines below).
    record = fixed_triton_graph_baseline("shape", shape, hw_profile="liquid-k500sm")
    assert record["median_us"] == expected
    assert record["timing_scope"] == "decode_graph_replay"
    assert record["profile_mismatch"] is False
    assert record["baseline_profile"] == "liquid-k500sm"


def test_air_profile_uses_its_own_baselines():
    """The air board measured its own M=8 baselines (2026-09-29, kme6).

    Asserts the *relationship* rather than a second copy of the numbers: every
    measured shape must resolve locally (no cross-profile borrowing), and the
    air baseline must be slower than the liquid one by a plausible factor --
    the recorded 15-shape range is 1.06x-1.40x, so anything outside 1.0-1.6
    means the table was corrupted or measured on the wrong board.
    """
    shape_ids = [
        ("hy3_tp8_qkv_proj_m8", {"tp_size": 8, "M": 8, "N": 1280, "K": 4096}),
        ("hy3_tp8_o_proj_m8", {"tp_size": 8, "M": 8, "N": 4096, "K": 1024}),
        ("hy3_tp8_shared_gate_up_proj_m8",
         {"tp_size": 8, "M": 8, "N": 384, "K": 4096}),
        ("hy3_tp8_shared_down_proj_m8",
         {"tp_size": 8, "M": 8, "N": 4096, "K": 192}),
        ("minimax_tp8_qkv_proj_m8", {"tp_size": 8, "M": 8, "N": 1280, "K": 6144}),
        ("minimax_tp8_qkv_proj_and_indexer_qk_m8",
         {"tp_size": 8, "M": 8, "N": 1536, "K": 6144}),
        ("minimax_tp8_o_proj_m8", {"tp_size": 8, "M": 8, "N": 6144, "K": 1024}),
        ("minimax_tp8_shared_gate_up_proj_m8",
         {"tp_size": 8, "M": 8, "N": 768, "K": 6144}),
        ("minimax_tp8_shared_down_proj_m8",
         {"tp_size": 8, "M": 8, "N": 6144, "K": 384}),
        ("glm52_tp8_fused_qkv_a_proj_m8",
         {"tp_size": 8, "M": 8, "N": 2624, "K": 6144}),
        ("glm52_tp8_q_b_proj_m8", {"tp_size": 8, "M": 8, "N": 2048, "K": 2048}),
        ("glm52_tp8_kv_b_proj_m8", {"tp_size": 8, "M": 8, "N": 3584, "K": 512}),
        ("glm52_tp8_o_proj_m8", {"tp_size": 8, "M": 8, "N": 6144, "K": 2048}),
        ("glm52_tp8_shared_gate_up_proj_m8",
         {"tp_size": 8, "M": 8, "N": 512, "K": 6144}),
        ("glm52_tp8_shared_down_proj_m8",
         {"tp_size": 8, "M": 8, "N": 6144, "K": 256}),
    ]
    ratios = []
    for shape_id, shape in shape_ids:
        local = fixed_triton_graph_baseline(shape_id, shape, hw_profile="air-k100ai")
        assert local["profile_mismatch"] is False, shape_id
        assert local["baseline_profile"] == "air-k100ai", shape_id
        reference = fixed_triton_graph_baseline(
            shape_id, shape, hw_profile="liquid-k500sm"
        )
        ratio = local["median_us"] / reference["median_us"]
        ratios.append(ratio)
    assert all(1.0 <= r <= 1.6 for r in ratios), ratios
    # The table must actually differ from the reference (a copy would be 1.0).
    assert sum(1 for r in ratios if r > 1.02) >= 10


#: A profile with no table at all: stands in for "a machine whose family has not
#: been measured yet". Using a synthetic id keeps this test independent of how
#: far the real coverage has progressed.
_UNMEASURED_PROFILE = "some-future-board"
_SHAPE = ("tp4_wqkv_a_m16", {"tp_size": 4, "M": 16, "N": 1536, "K": 4096})


def test_shape_absent_from_the_local_profile_flags_the_reference():
    """A shape the local profile has not measured must not masquerade as ours."""
    shape_id, shape = _SHAPE
    record = fixed_triton_graph_baseline(
        shape_id, shape, hw_profile=_UNMEASURED_PROFILE
    )
    assert record["profile_mismatch"] is True
    assert record["baseline_profile"] == "liquid-k500sm"
    assert "NOT a same-machine comparison" in record["profile_note"]


def test_reference_fallback_can_be_refused():
    shape_id, shape = _SHAPE
    with pytest.raises(ValueError):
        fixed_triton_graph_baseline(
            shape_id, shape, hw_profile=_UNMEASURED_PROFILE,
            allow_reference_profile=False,
        )


def test_shape_missing_everywhere_is_unavailable():
    """Not in the local table and not in the reference either -> refuse."""
    with pytest.raises(ValueError, match="no fixed Triton Graph baseline"):
        fixed_triton_graph_baseline(
            "m4_wqkv_a", {"tp_size": 4, "M": 4, "N": 1536, "K": 4096},
            hw_profile="liquid-k500sm",
        )


def test_measured_families_resolve_locally_on_air():
    """TP8 M=8 and M=4096 were measured on this board -> no fallback needed."""
    for shape in (
        {"tp_size": 8, "M": 8, "N": 6144, "K": 384},
        {"tp_size": 8, "M": 4096, "N": 1280, "K": 4096},
    ):
        record = fixed_triton_graph_baseline("shape", shape, hw_profile="air-k100ai")
        assert record["profile_mismatch"] is False
        assert record["baseline_profile"] == "air-k100ai"


def test_bootstrap_metrics_are_kept_separate():
    bootstrap = {"passed": True, "median_us": 123.0}
    record = fixed_triton_graph_baseline(
        "m2_wqkv_a",
        {"M": 2, "N": 1536, "K": 4096},
        bootstrap_metrics=bootstrap,
        hw_profile="liquid-k500sm",   # the 66.924 expectation is reference data
    )
    assert record["median_us"] == 66.924
    assert record["bootstrap_metrics"] == bootstrap


@pytest.mark.parametrize(
    ("shape", "eager_median", "eager_p90", "graph_median", "graph_p90"),
    [
        ((16, 1536, 4096), 97.660, 98.404, 66.591, 67.347),
        ((16, 4096, 1024), 95.284, 96.092, 32.137, 35.969),
        ((16, 8192, 1024), 96.204, 96.796, 48.274, 50.794),
        ((16, 512, 4096), 96.056, 97.788, 59.210, 59.962),
        ((16, 4096, 256), 94.540, 95.740, 14.849, 18.001),
        ((3072, 1536, 4096), 9423.243, 9446.877, 9422.539, 9486.942),
        ((3072, 4096, 1024), 7637.209, 8033.128, 7617.880, 7686.395),
        ((3072, 8192, 1024), 15461.000, 15528.571, 15466.648, 15958.569),
        ((3072, 512, 4096), 2775.526, 2780.134, 2740.757, 2751.685),
        ((3072, 4096, 256), 2414.377, 2424.569, 2370.583, 2376.343),
    ],
)
def test_tp8_hot_cache_baselines(
    shape, eager_median, eager_p90, graph_median, graph_p90
):
    m, n, k = shape
    # These P90/eager expectations are the reference catalogue, so the lookup is
    # pinned: this board has since measured its own M=16/M=3072 rows.
    record = fixed_triton_graph_baseline(
        "tp8_shape", {"tp_size": 8, "M": m, "N": n, "K": k},
        hw_profile="liquid-k500sm",
    )
    assert record["tp_size"] == 8
    assert record["median_us"] == graph_median
    assert record["p90_us"] == graph_p90
    assert record["eager_median_us"] == eager_median
    assert record["eager_p90_us"] == eager_p90
    assert record["cache_state"] == "hot"
    assert record["distribution_stats_available"] is True
    expected_protocol = (
        {"warmups": 50, "samples": 50, "launches_per_sample": 20}
        if m == 16
        else {"warmups": 10, "samples": 20, "launches_per_sample": 5}
    )
    assert record["measurement_protocol"] == expected_protocol


def test_same_shape_uses_tp_specific_baseline():
    shape = {"M": 16, "N": 1536, "K": 4096}
    assert fixed_triton_graph_baseline(
        "tp4", {**shape, "tp_size": 4}, hw_profile="liquid-k500sm"
    )["median_us"] == 66.597
    assert fixed_triton_graph_baseline(
        "tp8", {**shape, "tp_size": 8}, hw_profile="liquid-k500sm"
    )["median_us"] == 66.591


# --------------------------------------------------------------------------- #
# Baseline provenance: whose number is this?
# --------------------------------------------------------------------------- #


def test_a_record_without_provenance_belongs_to_the_reference_board():
    """Pre-split task tables are the reference board's data, not neutral.

    A ``final_report.json`` written before the profile split carries a bare
    ``median_us`` (``source: user_supplied_fixed_table``).  Treating it as
    "this machine's" is how an air variant ended up recording
    ``baseline_us=19.98 speedup=1.967`` while this board's own value for the
    same shape is 25.936 us.
    """
    from ..orchestrator.w8a8_baselines import (
        REFERENCE_PROFILE, baseline_origin,
    )

    legacy = {"median_us": 19.984, "source": "user_supplied_fixed_table"}
    assert baseline_origin(legacy) == (REFERENCE_PROFILE, False)
    # A bare number is the same case.
    assert baseline_origin(19.984) == (REFERENCE_PROFILE, False)
    # A provenanced record reports what it says.
    local = {"median_us": 25.936, "baseline_profile": "air-k100ai",
             "profile_mismatch": False}
    assert baseline_origin(local) == ("air-k100ai", False)
    fallback = {"median_us": 19.984, "baseline_profile": REFERENCE_PROFILE,
                "profile_mismatch": True}
    assert baseline_origin(fallback) == (REFERENCE_PROFILE, True)


def test_only_this_boards_numbers_are_trusted_for_recording():
    from ..orchestrator.w8a8_baselines import (
        REFERENCE_PROFILE, trusted_baseline_us,
    )

    legacy = {"median_us": 19.984, "source": "user_supplied_fixed_table"}
    local = {"median_us": 25.936, "baseline_profile": "air-k100ai",
             "profile_mismatch": False}
    # Air: the legacy number is the other board's -> refused; its own is used.
    assert trusted_baseline_us(legacy, profile="air-k100ai") is None
    assert trusted_baseline_us(local, profile="air-k100ai") == 25.936
    # Liquid: the same legacy number *is* that board's own data, so it stands.
    assert trusted_baseline_us(legacy, profile=REFERENCE_PROFILE) == 19.984
    assert trusted_baseline_us(
        {"median_us": 66.597, "baseline_profile": REFERENCE_PROFILE},
        profile=REFERENCE_PROFILE,
    ) == 66.597
    # An explicit fallback is refused even where the number came from.
    assert trusted_baseline_us(
        {"median_us": 19.984, "baseline_profile": REFERENCE_PROFILE,
         "profile_mismatch": True},
        profile=REFERENCE_PROFILE,
    ) is None


def test_the_reference_number_is_only_usable_when_displayed_explicitly():
    from ..orchestrator.w8a8_baselines import (
        REFERENCE_PROFILE, trusted_baseline_us,
    )

    reference = {"median_us": 19.984, "baseline_profile": REFERENCE_PROFILE,
                 "profile_mismatch": True}
    assert trusted_baseline_us(reference, profile="air-k100ai") is None
    assert trusted_baseline_us(
        reference, profile="air-k100ai", allow_reference_profile=True
    ) == 19.984


def test_an_unresolvable_machine_has_nothing_provably_local(monkeypatch):
    from ..orchestrator import w8a8_baselines as wb

    monkeypatch.setattr(wb, "current_profile", lambda: None)
    assert wb.trusted_baseline_us({"median_us": 25.936,
                                   "baseline_profile": "air-k100ai"}) is None
    assert wb.trusted_baseline_us(19.984) is None
    assert wb.trusted_baseline_us(None) is None


#: Keys the air table has and the reference (liquid) table does not: the
#: DeepSeek V4 Flash TP8 M=8 / M=4096 shapes, measured on this board on
#: 2026-10-11 so the panel catalog for that model resolves locally.  Baselines
#: are per profile and must never be copied across boards, so widening one table
#: leaves the other without those shapes -- this test keeps that gap explicit
#: instead of letting "the two tables look aligned" hide it.
DEEPSEEK_TP8_AIR_ONLY_KEYS = {
    "8,8,1536,4096",
    "8,8,8192,1024",
    "8,8,512,4096",
    "8,8,4096,256",
    "8,4096,1536,4096",
    "8,4096,8192,1024",
    "8,4096,512,4096",
    "8,4096,4096,256",
}


def _profile_keys(profile: str) -> set[str]:
    from ..orchestrator import w8a8_baselines as wb

    table = wb._load_profile(profile)
    return set(table["graph"]) | set(table["tp8"])


def test_profile_tables_differ_only_by_the_documented_deepseek_tp8_keys():
    from ..orchestrator.w8a8_baselines import REFERENCE_PROFILE

    air = _profile_keys("air-k100ai")
    reference = _profile_keys(REFERENCE_PROFILE)

    assert air - reference == DEEPSEEK_TP8_AIR_ONLY_KEYS, (
        "unexpected air-only baseline keys: "
        f"{sorted((air - reference) - DEEPSEEK_TP8_AIR_ONLY_KEYS)}; missing: "
        f"{sorted(DEEPSEEK_TP8_AIR_ONLY_KEYS - (air - reference))}"
    )
    # The reference table must not have grown ahead of this board either: a
    # liquid-only key would resolve here as a profile_mismatch number.
    assert reference - air == set()


def test_deepseek_tp8_extra_m_values_resolve_on_this_board():
    """The panel's new DeepSeek TP8 shapes must be local, not cross-profile."""
    import pytest as _pytest

    from ..orchestrator.w8a8_baselines import current_profile

    if current_profile() != "air-k100ai":
        _pytest.skip("pinned to the air board; this host is not air-k100ai")
    for m, nk in (
        (8, (1536, 4096)),
        (8, (8192, 1024)),
        (8, (512, 4096)),
        (8, (4096, 256)),
        (8, (4096, 1024)),
        (4096, (1536, 4096)),
        (4096, (8192, 1024)),
        (4096, (512, 4096)),
        (4096, (4096, 256)),
        (4096, (4096, 1024)),
    ):
        record = fixed_triton_graph_baseline(
            "probe", {"tp_size": 8, "M": m, "N": nk[0], "K": nk[1]}
        )
        assert record["median_us"] > 0
        assert record["profile_mismatch"] is False, (m, nk)
        assert record["baseline_profile"] == "air-k100ai"
