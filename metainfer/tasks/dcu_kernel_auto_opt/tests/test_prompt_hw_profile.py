"""Prompt-side hardware-profile awareness.

Two requirements, in tension:

* the air board needs extra guidance (no HBM address hashing: concurrent strided
  reads collapse onto the same channels, so contiguous/chunked reads beat
  occupancy micro-tuning), and the agent must know the staged ``references/``
  variants were measured **on this board**; and
* the liquid prompt must stay **byte-identical** -- the operator's requirement is
  that the air work changes nothing on the liquid board.

So the injection is a single helper that returns ``""`` off the air profile, and
these tests pin both halves.
"""

from __future__ import annotations

from metainfer.orchestrator import hw_profile
from metainfer.tasks.dcu_kernel_auto_opt.orchestrator import prompts


def _pin(monkeypatch, profile: str):
    monkeypatch.setenv("METAINFER_HW_PROFILE", profile)
    hw_profile.clear_cache()


def test_air_profile_gets_a_guidance_block(monkeypatch):
    _pin(monkeypatch, "air-k100ai")
    block = prompts.hw_profile_guidance()
    assert "AIR-COOLED" in block
    assert "K100_AI" in block
    # The two things the agent has to act on.
    assert "contiguous" in block.lower()
    assert "measured **on this board**" in block or "on this board" in block
    hw_profile.clear_cache()


def test_liquid_profile_gets_nothing(monkeypatch):
    """Liquid must be untouched: same code path, empty block."""
    _pin(monkeypatch, "liquid-k500sm")
    assert prompts.hw_profile_guidance() == ""
    hw_profile.clear_cache()


def test_unresolved_machine_gets_nothing(monkeypatch):
    monkeypatch.setenv("METAINFER_HW_PROFILE_NO_PROBE", "1")
    monkeypatch.setattr(hw_profile, "_hostname", lambda: "ci-runner")
    hw_profile.clear_cache()
    assert prompts.hw_profile_guidance() == ""
    hw_profile.clear_cache()


def test_prompts_are_unchanged_when_the_block_is_empty(monkeypatch, tmp_path):
    """Byte-identity check: a liquid prompt equals the pre-change text.

    ``hw_profile_guidance()`` is the only thing this work added to the prompt
    templates, so a prompt rendered with the block forced empty must equal the
    prompt rendered on a liquid machine -- and, because the helper is the only
    interpolation added, that equals what the templates produced before.
    """
    _pin(monkeypatch, "liquid-k500sm")
    coordinator = prompts.generate_kernel_prompt(
        operator="Quantized GEMM",
        dtype="INT8 W8A8",
        shapes={"m2": {"M": 2, "N": 1536, "K": 4096}},
        hardware="K500SM_AI / gfx928",
        kernel_language="HIP C++",
        source_dir=tmp_path,
        harness_path=tmp_path / "harness.sh",
    )
    monkeypatch.setattr(prompts, "hw_profile_guidance", lambda: "")
    same = prompts.generate_kernel_prompt(
        operator="Quantized GEMM",
        dtype="INT8 W8A8",
        shapes={"m2": {"M": 2, "N": 1536, "K": 4096}},
        hardware="K500SM_AI / gfx928",
        kernel_language="HIP C++",
        source_dir=tmp_path,
        harness_path=tmp_path / "harness.sh",
    )
    assert coordinator == same
    assert "AIR-COOLED" not in coordinator
    hw_profile.clear_cache()


def test_air_block_reaches_both_prompt_kinds(monkeypatch, tmp_path):
    _pin(monkeypatch, "air-k100ai")
    coordinator = prompts.generate_kernel_prompt(
        operator="Quantized GEMM",
        dtype="INT8 W8A8",
        shapes={"m2": {"M": 2, "N": 1536, "K": 4096}},
        hardware="K100_AI / gfx928",
        kernel_language="HIP C++",
        source_dir=tmp_path,
        harness_path=tmp_path / "harness.sh",
    )
    worker = prompts.bootstrap_worker_prompt(
        worker_id="worker_0",
        gpu=0,
        shapes={"m2": {"M": 2, "N": 1536, "K": 4096}},
        hardware="K100_AI / gfx928",
        kernel_language="HIP C++",
        source_dir=tmp_path,
        harness_path=tmp_path / "harness.sh",
        api_contract_path=tmp_path / "api.py",
        attempt=1,
    )
    assert "AIR-COOLED" in coordinator
    assert "AIR-COOLED" in worker
    hw_profile.clear_cache()


def test_air_block_marks_the_legacy_flat_bundle_as_liquid_data(monkeypatch):
    """Not every staged reference is this board's.

    ``references/w8a8_gemm_variants.hip`` predates the profile split and is
    staged on every board, so the air prompt has to say so -- otherwise the
    block above it ("the staged references were measured on this board") reads
    as a claim about that file too.
    """
    _pin(monkeypatch, "air-k100ai")
    block = prompts.hw_profile_guidance()
    assert "w8a8_gemm_variants.hip" in block
    assert "liquid" in block.lower()
    hw_profile.clear_cache()


def test_liquid_block_does_not_advertise_its_own_file_as_foreign(monkeypatch):
    """Liquid is the board that bundle was measured on: nothing to add."""
    _pin(monkeypatch, "liquid-k500sm")
    assert prompts.hw_profile_guidance() == ""
    hw_profile.clear_cache()
