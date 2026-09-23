"""Role-based question selection: roles, family quota, overlap, rotation."""

from __future__ import annotations

from metainfer.tasks.harness_evolve.orchestrator.question_roles import (
    PURPOSE_PROBE, PURPOSE_REGRESSION, PURPOSE_REPAIR, main_purposes,
    overlap_ratio, probe_ids, select_questions,
)


class _Inst:
    def __init__(self, iid: str, family: str) -> None:
        self.id = iid
        self.family = family


class _Pool:
    def __init__(self, rows) -> None:
        self.instances = {i: _Inst(i, f) for i, f in rows}

    def all_ids(self):
        return list(self.instances)

    def get(self, iid):
        return self.instances[iid]

    def historical_ids(self):
        return list(self.instances)


def _pool():
    return _Pool([
        ("a1", "famA"), ("a2", "famA"), ("a3", "famA"),
        ("b1", "famB"), ("b2", "famB"),
        ("c1", "famC"), ("c2", "famC"),
        ("d1", "famD"), ("d2", "famD"),
    ])


def _big_pool():
    """Six families: enough for a genuinely cross-family probe at budget 4."""
    return _Pool([
        ("a1", "famA"), ("a2", "famA"), ("a3", "famA"),
        ("b1", "famB"), ("b2", "famB"), ("b3", "famB"),
        ("c1", "famC"), ("c2", "famC"), ("c3", "famC"),
        ("d1", "famD"), ("d2", "famD"), ("d3", "famD"),
        ("e1", "famE"), ("e2", "famE"), ("e3", "famE"),
        ("f1", "famF"), ("f2", "famF"), ("f3", "famF"),
    ])


PREV = ["a1", "b1", "c1", "d1"]
PREV_RESULTS = {
    "a1": {"passed": True}, "b1": {"passed": True},
    "c1": {"passed": False}, "d1": {"passed": True},
}


def test_roles_regression_repair_and_probe():
    pool = _big_pool()
    sel = select_questions(pool=pool, budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS)
    assert len(sel.selected) == 4
    roles = [sel.purposes[i] for i in sel.selected]
    assert roles.count(PURPOSE_REGRESSION) >= 2      # anchors from passed set
    assert PURPOSE_REPAIR in roles                   # the failed question
    assert PURPOSE_PROBE in roles                    # cross-family probe
    assert "c1" in sel.selected
    # the probe never shares a family with the rest of the round
    probe = probe_ids(sel.purposes)[0]
    others = {pool.get(i).family for i in sel.selected if i != probe}
    assert pool.get(probe).family not in others


def test_family_quota_and_minimum_coverage():
    pool = _big_pool()
    sel = select_questions(pool=pool, budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS, min_families=3,
                           max_per_family=2)
    families = [pool.get(i).family for i in sel.selected]
    assert len(set(families)) >= 3
    assert max(families.count(f) for f in set(families)) <= 2


def test_overlap_guardrail_holds():
    sel = select_questions(pool=_big_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS)
    assert overlap_ratio(sel.selected, PREV) >= 0.6


def test_small_pool_degrades_to_the_freshest_question():
    """With four families and four slots no family is left for a probe."""
    sel = select_questions(pool=_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS)
    assert len(sel.selected) == 4
    assert PURPOSE_PROBE in sel.purposes.values()
    assert any("probe" in n for n in sel.notes)


def test_agent_picks_are_honoured_when_they_fit_a_role():
    class Plan:
        selected = ["b1", "a1", "c1", "d2"]
        changes: list = []

    sel = select_questions(pool=_big_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS, plan=Plan())
    # passed agent picks become regression anchors, the failed one repair
    assert sel.purposes.get("b1") == PURPOSE_REGRESSION
    assert sel.purposes.get("c1") == PURPOSE_REPAIR


def test_agent_picks_are_replaced_when_family_quota_breaks():
    class Plan:
        selected = ["a1", "a2", "a3", "b1"]      # three from famA
        changes: list = []

    sel = select_questions(pool=_big_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS, plan=Plan(),
                           max_per_family=2, min_families=3)
    pool = _big_pool()
    families = [pool.get(i).family for i in sel.selected]
    assert families.count("famA") <= 2
    assert len(set(families)) >= 3


def test_rotation_prefers_least_recently_used_for_the_probe():
    sel = select_questions(pool=_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS,
                           rotation={"a1": 9, "a2": 9, "a3": 9, "b1": 9,
                                     "b2": 9, "c1": 9, "c2": 9, "d1": 9,
                                     "d2": 0})
    assert "d2" in sel.selected


def test_first_round_without_history_still_covers_families():
    pool = _big_pool()
    sel = select_questions(pool=pool, budget=4)
    assert len(sel.selected) == 4
    families = {pool.get(i).family for i in sel.selected}
    assert len(families) >= 3
    assert len(main_purposes(sel.purposes)) >= 3


def test_scope_ids_bias_the_regression_anchors():
    class Plan:
        selected: list = []
        changes = [{"scope": {"expected_improve": ["b2"], "at_risk": ["c2"]}}]

    sel = select_questions(pool=_big_pool(), budget=4, prev_selected=PREV,
                           prev_results=PREV_RESULTS, plan=Plan())
    assert "b2" in sel.selected or "c2" in sel.selected


class _MInst:
    def __init__(self, iid: str, family: str, m: int) -> None:
        self.id = iid
        self.family = family
        self.M = m


class _MPool:
    def __init__(self, rows) -> None:
        self.instances = {i: _MInst(i, f, m) for i, f, m in rows}

    def all_ids(self):
        return list(self.instances)

    def get(self, iid):
        return self.instances[iid]

    def historical_ids(self):
        return list(self.instances)


def test_fresh_round_covers_both_regimes():
    """decode (M<=32) and prefill need different kernels: both must appear."""
    pool = _MPool([
        ("p1", "prefill__o_proj", 4096), ("p2", "prefill__qkv_proj", 4096),
        ("p3", "prefill__shared_down_proj", 4096),
        ("p4", "prefill__fused_qkv_a_proj", 4096),
        ("d1", "decode__o_proj", 16), ("d2", "decode__qkv_proj", 16),
        ("d3", "decode__shared_down_proj", 16),
    ])
    sel = select_questions(pool=pool, budget=4)
    regimes = {pool.get(i).M <= 32 and "decode" or "prefill" for i in sel.selected}
    assert regimes == {"decode", "prefill"}, sel.selected
    assert len(sel.families) >= 3
