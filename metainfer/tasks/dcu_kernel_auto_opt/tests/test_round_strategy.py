"""systemprompt/round_strategy.yaml is wired: the worker-facing mandate is data.

What these tests pin down:

* the built-in texts are byte-identical to the historical Python literals, so an
  un-evolved harness tells the worker exactly what it always did;
* the seed file reproduces those defaults (drift guard, like gates.yaml);
* editing the seed changes the runtime mandate, including inside the pipeline's
  own call path;
* ``wired: false`` in the manifest makes the component inert;
* a malformed / partial harness file degrades to built-in text instead of
  raising (a broken harness is a performance problem, not a crash).
"""

from __future__ import annotations

import shutil

import pytest
import yaml

from ..orchestrator import round_strategy as rs
from ..orchestrator.harness_io import default_harness_dir
from ..orchestrator.prompts import w8a8_round_strategy

import importlib.util

import pytest
_HARNESS_EVOLVE_AVAILABLE = (
    importlib.util.find_spec(
        "metainfer.tasks.harness_evolve.orchestrator.pipeline"
    )
    is not None
)
requires_harness_evolve = pytest.mark.skipif(
    not _HARNESS_EVOLVE_AVAILABLE,
    reason="metainfer.tasks.harness_evolve is not available in this tree",
)

M16 = {"model": "hy3", "M": 16, "N": 2048, "K": 256}
SMALL = {"model": "hy3", "M": 2, "N": 2048, "K": 256}
PREFILL = {"model": "hy3", "M": 3072, "N": 2048, "K": 256}


@pytest.fixture(autouse=True)
def _clear_cache():
    rs.reset_cache()
    yield
    rs.reset_cache()


def _workspace(tmp_path, *, wired=True):
    root = tmp_path / "harness"
    shutil.copytree(default_harness_dir(), root)
    manifest = yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8"))
    manifest["components"]["systemprompt"]["wired"] = wired
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    return root


def _strategy_file(root):
    return root / rs.RELATIVE_PATH


def _edit(root, mutate):
    data = yaml.safe_load(_strategy_file(root).read_text(encoding="utf-8"))
    mutate(data)
    _strategy_file(root).write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8")


# --------------------------------------------------------------------------- #
# Built-in defaults and the seed file agree
# --------------------------------------------------------------------------- #

def test_seed_matches_builtin_defaults():
    """The seed file mirrors the built-in texts (so nothing drifts silently)."""
    seed = yaml.safe_load(_strategy_file(default_harness_dir()).read_text(
        encoding="utf-8"))
    defaults = rs.builtin_strategy()
    for section in ("repair", "phases", "append"):
        for key, value in defaults[section].items():
            assert seed[section][key].strip() == value, f"{section}.{key}"
    for regime, portfolio in defaults["portfolios"].items():
        for slot, value in portfolio.items():
            assert seed["portfolios"][regime][slot].strip() == value, (
                f"portfolios.{regime}.{slot}")


def test_seed_round_trips_through_the_loader(tmp_path, monkeypatch):
    """Loading the seed yields exactly the built-in texts."""
    root = _workspace(tmp_path)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.source.endswith("round_strategy.yaml")
    assert loaded.repair == rs.builtin_strategy()["repair"]
    assert loaded.phases == rs.builtin_strategy()["phases"]
    assert loaded.append == rs.builtin_strategy()["append"]
    assert loaded.portfolios == rs.builtin_strategy()["portfolios"]


def test_no_harness_root_uses_the_plugin_seed(monkeypatch):
    """Without METAINFER_HARNESS_ROOT the plugin's own seed is the workspace.

    Resolution falls back to ``harness_default/`` (not to an in-code sentinel),
    so the seed file is what production tasks read — and the drift test above
    proves it carries the built-in texts.
    """
    monkeypatch.delenv("METAINFER_HARNESS_ROOT", raising=False)
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.source.endswith("harness_default/systemprompt/round_strategy.yaml")
    assert loaded.portfolios["m16"]["2"].startswith("Architecture round")
    assert loaded.portfolios == rs.builtin_strategy()["portfolios"]


# --------------------------------------------------------------------------- #
# Editing the file changes the runtime mandate
# --------------------------------------------------------------------------- #

def test_editing_the_seed_changes_runtime_mandate(tmp_path, monkeypatch):
    root = _workspace(tmp_path)

    def mutate(data):
        data["portfolios"]["m16"]["2"] = (
            "EVOLVED: benchmark 3-wave and 4-wave geometries before anything else.")

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()

    rendered = w8a8_round_strategy(M16, 2, [], {}, 10, None)
    assert rendered.startswith("EVOLVED: benchmark 3-wave")
    # Untouched branches keep their historical text.
    assert w8a8_round_strategy(M16, 1, [], {}, 10, None).startswith(
        "Establish a minimal 16x16x32 DUMMA tile")


def test_edited_text_is_seen_by_the_pipeline_call_path(tmp_path, monkeypatch):
    """w8a8_pipeline's non-planner path renders the harness text too."""
    root = _workspace(tmp_path)

    def mutate(data):
        data["repair"]["build_failure"] = "EVOLVED BUILD REPAIR for {iteration}"

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    monkeypatch.delenv("METAINFER_PLANNER", raising=False)
    rs.reset_cache()

    from ..orchestrator import w8a8_pipeline as W

    history = [{"iteration": 4, "build_success": False,
                "failure_reason": "hipcc: undefined template",
                "artifact_dir": "/tmp/a4"}]
    text = W.w8a8_round_strategy(M16, 4, history, {}, max_iterations=10,
                                 isa_policy={})
    assert text == "EVOLVED BUILD REPAIR for 4"


def test_repeated_scale_can_be_edited(tmp_path, monkeypatch):
    root = _workspace(tmp_path)

    def mutate(data):
        data["phases"]["isa_guided_hip"] = "EVOLVED ISA round {completed} of many"

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    text = w8a8_round_strategy(
        M16, 3, [], {}, 10,
        {"phase": "isa_guided_hip", "valid_isa_guided_rounds": 1})
    assert text == "EVOLVED ISA round 2 of many"


def test_append_suffixes_can_be_edited(tmp_path, monkeypatch):
    root = _workspace(tmp_path)

    def mutate(data):
        data["append"]["split_candidates"] = " SUSPECTS={split_candidates}."

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    text = w8a8_round_strategy(
        M16, 3, [], {"grid_blocks": 500, "device_cu_count": 60}, 10, None)
    assert "SUSPECTS=" in text
    assert "Trusted occupancy-probe split candidates" not in text


# --------------------------------------------------------------------------- #
# The manifest decides whether the file applies at all
# --------------------------------------------------------------------------- #

def test_unwired_component_falls_back_to_builtin(tmp_path, monkeypatch):
    root = _workspace(tmp_path, wired=False)

    def mutate(data):
        data["portfolios"]["m16"]["2"] = "EVOLVED: should never be used"

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.source == "builtin"
    assert loaded.portfolios["m16"]["2"].startswith("Architecture round")
    assert any("wired:false" in note for note in loaded.notes)


def test_missing_component_entry_still_applies(tmp_path, monkeypatch):
    """A manifest without the component key must not disable the file."""
    root = _workspace(tmp_path)
    manifest = yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8"))
    manifest["components"].pop("systemprompt")
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")

    def mutate(data):
        data["portfolios"]["m16"]["2"] = "EVOLVED without a manifest entry"

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    assert w8a8_round_strategy(M16, 2, [], {}, 10, None).startswith("EVOLVED without")


# --------------------------------------------------------------------------- #
# Degradation: a broken harness must not break a round
# --------------------------------------------------------------------------- #

def test_missing_file_uses_builtin(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    _strategy_file(root).unlink()
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.source == "builtin"
    assert loaded.repair == rs.builtin_strategy()["repair"]


def test_malformed_yaml_is_reported_not_raised(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    _strategy_file(root).write_text("repair: [unclosed\n", encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.source == "builtin"
    assert loaded.notes and "round_strategy.yaml" in loaded.notes[0]
    assert w8a8_round_strategy(M16, 2, [], {}, 10, None).startswith("Architecture")


def test_partial_file_keeps_unlisted_branches(tmp_path, monkeypatch):
    """Omitting a key keeps its built-in text instead of blanking the branch."""
    root = _workspace(tmp_path)
    # A file that only carries a reformatted large-M round 3.
    _strategy_file(root).write_text(
        "portfolios:\n  large:\n    \"3\": EVOLVED large round three\n",
        encoding="utf-8")
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.portfolios["large"]["3"] == "EVOLVED large round three"
    assert loaded.portfolios["large"]["2"] == (
        rs.builtin_strategy()["portfolios"]["large"]["2"])
    assert loaded.portfolios["m16"]["2"].startswith("Architecture round")


def test_unknown_fields_degrade_to_builtin_text(tmp_path, monkeypatch):
    """A renamed format field must not raise mid-round."""
    root = _workspace(tmp_path)

    def mutate(data):
        data["append"]["grid_warning"] = " warning for {cus} CUs"

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    text = w8a8_round_strategy(
        M16, 3, [], {"grid_blocks": 4, "device_cu_count": 60}, 10, None)
    # The suffix falls back to the built-in wording rather than raising.
    assert "Trusted control-plane warning" in text


def test_unknown_regime_is_ignored(tmp_path, monkeypatch):
    root = _workspace(tmp_path)

    def mutate(data):
        data["portfolios"]["medium"] = {"2": "nonsense"}

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert "medium" not in loaded.portfolios
    assert any("unknown regime" in note for note in loaded.notes)


def test_empty_string_is_ignored(tmp_path, monkeypatch):
    """An empty value keeps the built-in text (a mandate is never blank)."""
    root = _workspace(tmp_path)

    def mutate(data):
        data["portfolios"]["m16"]["2"] = "   "

    _edit(root, mutate)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    loaded = rs.load_round_strategy()
    assert loaded.portfolios["m16"]["2"].startswith("Architecture round")


# --------------------------------------------------------------------------- #
# Cache invalidation: a mid-run harness swap is picked up
# --------------------------------------------------------------------------- #

def test_cache_is_invalidated_by_file_change(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    assert w8a8_round_strategy(M16, 2, [], {}, 10, None).startswith("Architecture")

    _edit(root, lambda data: data["portfolios"]["m16"].__setitem__(
        "2", "EVOLVED after a mid-run swap"))
    import os
    stat = _strategy_file(root).stat()
    os.utime(_strategy_file(root), (stat.st_atime, stat.st_mtime + 10))
    assert w8a8_round_strategy(M16, 2, [], {}, 10, None) == "EVOLVED after a mid-run swap"


def test_cache_is_invalidated_by_manifest_change(tmp_path, monkeypatch):
    root = _workspace(tmp_path)
    monkeypatch.setenv("METAINFER_HARNESS_ROOT", str(root))
    rs.reset_cache()
    assert rs.load_round_strategy().source.endswith("round_strategy.yaml")

    manifest = yaml.safe_load((root / "manifest.yaml").read_text(encoding="utf-8"))
    manifest["components"]["systemprompt"]["wired"] = False
    (root / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    import os
    stat = (root / "manifest.yaml").stat()
    os.utime(root / "manifest.yaml", (stat.st_atime, stat.st_mtime + 10))
    assert rs.load_round_strategy().source == "builtin"


# --------------------------------------------------------------------------- #
# The small-M late-round crash is fixed
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("max_iterations", [9, 10, 11, 20])
@pytest.mark.parametrize("iteration", [8, 9, 10, 11, 12])
def test_small_m_late_rounds_never_raise(max_iterations, iteration):
    """M<16 has no slot 9/10; it used to raise KeyError for max_iterations 9..10."""
    text = w8a8_round_strategy(SMALL, iteration, [], {}, max_iterations, None)
    assert text
    assert isinstance(text, str)


def test_small_m_keeps_its_consolidation_round_late():
    text = w8a8_round_strategy(SMALL, 10, [], {}, 20, None)
    assert text.startswith("HIP-only consolidation round")


def test_normal_regimes_are_unaffected_by_the_fix():
    # 16..127 and >=128 still reach the late slots.
    assert w8a8_round_strategy(M16, 9, [], {}, 10, None).startswith(
        "Late ISA-diagnosis round")
    assert w8a8_round_strategy(M16, 10, [], {}, 10, None).startswith(
        "Final conditional inline-asm round")
    assert w8a8_round_strategy(PREFILL, 20, [], {}, 20, None).startswith(
        "Final conditional inline-asm round")


# --------------------------------------------------------------------------- #
# End-to-end: seeding, and the AHE write-scope check reaches the new component
# --------------------------------------------------------------------------- #

def test_seed_workspace_carries_the_systemprompt_component(tmp_path):
    """HE seeds the experiment workspace from harness_default/, so the file ships."""
    from ..orchestrator.harness_io import seed_workspace

    dst = tmp_path / "seeded"
    seed_workspace(dst)
    assert (dst / rs.RELATIVE_PATH).is_file()
    manifest = yaml.safe_load((dst / "manifest.yaml").read_text(encoding="utf-8"))
    entry = manifest["components"]["systemprompt"]
    assert entry["path"] == rs.RELATIVE_PATH
    assert entry["wired"] is True


#: Rendered outputs of a 5400-case matrix (M regime x iteration x history x PMC
#: x ISA phase), frozen after the externalisation refactor. Any edit to a
#: mandate — in the built-in defaults *or* in the seed file — changes this
#: digest, which makes an accidental behaviour change impossible to merge
#: unnoticed. Regenerate deliberately when a wording change is intended.
_RENDERED_DIGEST = "8a3bb533a7779a45e6ad2a7b45128d0cc1b406155f83d04f1fc74fcb15255fea"

_SHAPES = {
    "m16": {"model": "hy3", "M": 16, "N": 2048, "K": 256},
    "m64": {"model": "hy3", "M": 64, "N": 4096, "K": 512},
    "large": {"model": "hy3", "M": 3072, "N": 2048, "K": 256},
    "prefill": {"model": "hy3", "M": 4096, "N": 1024, "K": 256},
    "small": {"model": "hy3", "M": 2, "N": 2048, "K": 256},
    "tiny": {"model": "hy3", "M": 1, "N": 2048, "K": 256},
}
_HISTORIES = {
    "empty": [],
    "faster_wrong": [
        {"iteration": 2, "correctness_passed": False, "speedup": 1.4,
         "artifact_dir": "/tmp/arch/iter2", "failure_reason": "mismatch_count 12"},
        {"iteration": 4, "correctness_passed": True, "speedup": 0.9,
         "artifact_dir": "/tmp/arch/iter4", "failure_reason": ""},
    ],
    "infra": [{"iteration": 3, "correctness_passed": True, "build_success": True,
               "failure_reason": "agent timeout after 900s",
               "artifact_dir": "/tmp/i3"}],
    "build": [{"iteration": 3, "correctness_passed": True, "build_success": False,
               "failure_reason": "hipcc: undefined template",
               "artifact_dir": "/tmp/i3"}],
    "assert": [{"iteration": 3, "correctness_passed": True, "build_success": True,
                "failure_reason": "mismatch_count 3", "artifact_dir": "/tmp/i3"}],
}
_PMCS = [
    {},
    {"grid_blocks": 4, "device_cu_count": 60, "l2_hit_rate": 0.55},
    {"grid_blocks": 400, "device_cu_count": 60, "l2_hit_rate": 0.9},
]
_ISA_POLICIES = [
    {},
    {"phase": "hip_only"},
    {"phase": "isa_guided_hip", "valid_isa_guided_rounds": 0},
    {"phase": "isa_guided_hip", "valid_isa_guided_rounds": 3},
    {"phase": "conditional_inline_asm"},
]


def test_rendered_mandates_match_the_frozen_digest():
    """The worker-facing mandates are frozen: 5400 rendered strings, one hash."""
    import hashlib
    import json

    payload = {}
    for regime, shape in _SHAPES.items():
        for iteration in range(1, 13):
            for hlabel, history in _HISTORIES.items():
                for pidx, pmc in enumerate(_PMCS):
                    for iidx, isa in enumerate(_ISA_POLICIES):
                        payload[
                            f"{regime}-it{iteration:02d}-{hlabel}"
                            f"-pmc{pidx}-isa{iidx}"
                        ] = w8a8_round_strategy(shape, iteration, history, pmc, 10, isa)
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    assert len(payload) == 5400
    assert hashlib.sha256(blob).hexdigest() == _RENDERED_DIGEST, (
        "a round mandate changed; if that was intended, regenerate the digest "
        "intentionally and describe the new wording in the change manifest")


@requires_harness_evolve
def test_ahe_wired_scope_check_covers_the_systemprompt_component(tmp_path):
    """An edit to the component while it is wired:false is reported by AHE.

    This is what makes the wider write scope auditable: harness_evolve compares
    each component's declared path, so a new component is covered as soon as it
    is registered in the manifest.
    """
    from metainfer.tasks.harness_evolve.orchestrator.pipeline import (
        _wired_scope_violations,
    )

    before = tmp_path / "before"
    after = tmp_path / "after"
    shutil.copytree(default_harness_dir(), before)
    shutil.copytree(default_harness_dir(), after)
    manifest = yaml.safe_load((after / "manifest.yaml").read_text(encoding="utf-8"))
    manifest["components"]["systemprompt"]["wired"] = False
    (after / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    # Unchanged file: not a violation.
    assert _wired_scope_violations(before, after) == []
    # Edited file while declared unwired: a violation, with the component named.
    text = (after / rs.RELATIVE_PATH).read_text(encoding="utf-8")
    (after / rs.RELATIVE_PATH).write_text(
        text + "\n# evolved by hand\n", encoding="utf-8")
    violations = _wired_scope_violations(before, after)
    assert violations == [{"component": "systemprompt",
                           "path": rs.RELATIVE_PATH}]
