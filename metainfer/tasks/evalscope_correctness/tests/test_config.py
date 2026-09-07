"""Config parsing/validation + fingerprint stability."""

from __future__ import annotations

import pytest

from metainfer.tasks.evalscope_correctness.orchestrator import config as _config
from metainfer.tasks.evalscope_correctness.orchestrator.config import (
    ConfigError,
    parse_requirements,
)


def _req(**over):
    base = {
        "task_type": "evalscope-correctness",
        "api_url": "http://127.0.0.1:30000/v1",
        "model": "Qwen",
        "benchmarks": ["gsm8k", "humaneval"],
    }
    base.update(over)
    return base


def test_parses_presets_and_gates():
    cfg = parse_requirements(_req(gate_gsm8k="0.7", gate_humaneval="0.5"))
    assert cfg.dataset_ids == ["gsm8k", "humaneval"]
    assert cfg.gate_for("gsm8k") == pytest.approx(0.7)
    assert cfg.gate_for("humaneval") == pytest.approx(0.5)
    humaneval = [t for t in cfg.targets if t.dataset == "humaneval"][0]
    assert humaneval.needs_sandbox is True
    gsm = [t for t in cfg.targets if t.dataset == "gsm8k"][0]
    assert gsm.needs_sandbox is False


def test_custom_dataset_and_json_gate():
    cfg = parse_requirements(_req(
        benchmarks=["gsm8k"],
        custom_benchmarks="arc, mmlu",
        gate_custom_json='{"arc": 0.6}',
    ))
    assert cfg.dataset_ids == ["gsm8k", "arc", "mmlu"]
    assert cfg.gate_for("arc") == pytest.approx(0.6)
    assert cfg.gate_for("mmlu") is None


def test_custom_gate_referencing_unrequested_dataset_is_error():
    with pytest.raises(ConfigError, match="was not requested"):
        parse_requirements(_req(
            benchmarks=["gsm8k"],
            custom_benchmarks="arc",
            gate_custom_json='{"mmlu": 0.6}',
        ))


def test_gate_custom_without_custom_dataset_is_error():
    with pytest.raises(ConfigError, match="no custom benchmarks requested"):
        parse_requirements(_req(
            benchmarks=["gsm8k"],
            gate_custom_json='{"arc": 0.6}',
        ))


@pytest.mark.parametrize("field,value", [
    ("api_url", ""),
    ("model", "   "),
])
def test_required_fields(field, value):
    with pytest.raises(ConfigError, match="required"):
        parse_requirements(_req(**{field: value}))


def test_no_benchmarks_is_error():
    with pytest.raises(ConfigError, match="select at least one benchmark"):
        parse_requirements(_req(benchmarks=[]))


def test_bad_url_is_error():
    with pytest.raises(ConfigError, match="http"):
        parse_requirements(_req(api_url="not a url"))


def test_gate_out_of_range_is_error():
    for val in ("1.2", "-0.1"):
        with pytest.raises(ConfigError, match=r"\[0, 1\]"):
            parse_requirements(_req(gate_gsm8k=val))


def test_batch_size_validated():
    with pytest.raises(ConfigError, match="eval_batch_size"):
        parse_requirements(_req(eval_batch_size="16"))
    assert parse_requirements(_req(eval_batch_size="1")).eval_batch_size == 1


def test_temperature_forced_to_zero():
    cfg = parse_requirements(_req(seed="7", max_tokens="4096"))
    assert cfg.temperature == 0.0
    assert cfg.seed == 7
    assert cfg.max_tokens == 4096


def test_env_var_name_rejects_secret_shaped_value():
    # A bare secret (with a hyphen) must not be accepted as an env-var name.
    with pytest.raises(ConfigError, match="environment variable"):
        parse_requirements(_req(api_key_env_var="sk-abc123secret"))
    # A valid NAME is fine.
    assert parse_requirements(_req(api_key_env_var="MY_LLM_KEY")).api_key_env_var == "MY_LLM_KEY"


def test_empty_env_var_means_no_auth():
    assert parse_requirements(_req(api_key_env_var="")).api_key_env_var == ""


def test_fingerprint_ignores_gate_and_model_id():
    a = parse_requirements(_req(gate_gsm8k="0.5", model_id="alias"))
    b = parse_requirements(_req(gate_gsm8k="0.9", model_id="other"))
    assert a.fingerprint() == b.fingerprint()


def test_fingerprint_changes_with_immutable_inputs():
    base = parse_requirements(_req())
    # max_tokens change → different request → new fingerprint.
    other = parse_requirements(_req(max_tokens="4096"))
    assert base.fingerprint() != other.fingerprint()


def test_child_json_never_contains_secret():
    cfg = parse_requirements(_req(api_key_env_var="EVALSCOPE_API_KEY"))
    child = cfg.to_child_json()
    # Only the NAME is present; no key value, no key field.
    assert child["api_key_env_var"] == "EVALSCOPE_API_KEY"
    assert "api_key" not in child
    assert "secret" not in json_dumps_lower(child)


def json_dumps_lower(obj) -> str:
    import json
    return json.dumps(obj).lower()
