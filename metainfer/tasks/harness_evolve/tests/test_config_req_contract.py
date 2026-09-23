"""load_experiment_config must honor the WebUI/shell requirements contract.

The shell/server flattens form answers onto the requirements top level (the
same contract dcu_kernel_auto_opt consumes); the legacy CLI/tests path passes
them under an ``answers`` dict. Both must yield the same ExperimentConfig so a
WebUI-launched harness-evolve experiment actually runs dkao-cli against the
registered pool instead of silently falling back to dry-run defaults.
"""

from __future__ import annotations

import json

import pytest

from metainfer.tasks.harness_evolve.orchestrator.config import (
    load_experiment_config,
)

_FLAT_FIELDS = {
    "task_id": "he-webui-task",
    "task_type": "harness-evolve",
    "label": "webui task",
    "raw_request": "",
    "pool_source": "/root/zth_agent/ahe-kernel-repos/registered_pool.yaml",
    "per_round_budget": 4,
    "default_rounds": 5,
    "max_iterations": 1,
    "harness_source": "dcu_default",
    "execution_mode": "dkao-cli",
    "ahe_repo_root": "/root/zth_agent/ahe-kernel-repos",
    "child_timeout_minutes": "0",
    "evolve_mode": "agent",
    "evolve_model": "deepseek/deepseek-flash",
    "evolve_timeout_seconds": "1800",
    "agent_framework": "dsh",
}


def _write_req(tmp_path, payload) -> "object":
    req = tmp_path / "requirements.json"
    req.write_text(json.dumps(payload), encoding="utf-8")
    return req


def test_flat_top_level_requirements_are_honored(tmp_path):
    """WebUI form answers flattened onto req top level must not be ignored."""
    cfg = load_experiment_config(
        _write_req(tmp_path, _FLAT_FIELDS),
        tmp_path / "state",
        tmp_path / "ws",
    )
    assert cfg.task_id == "he-webui-task"
    assert cfg.execution_mode == "dkao-cli"
    assert cfg.pool_source == _FLAT_FIELDS["pool_source"]
    assert cfg.pool_mode is True
    assert cfg.per_round_budget == 4
    assert cfg.max_iterations == 1
    assert cfg.harness_source == "dcu_default"
    assert cfg.agent_framework == "dsh"
    assert cfg.answers.get("evolve_mode") == "agent"
    assert cfg.answers.get("default_rounds") == 5


def test_answers_dict_requirements_still_honored(tmp_path):
    """Legacy CLI/tests contract (answers dict) keeps working.

    Identity fields live on the req top level; the form answers (everything
    under ``answers``) are what load_experiment_config reads for behaviour.
    """
    form_fields = {
        k: v for k, v in _FLAT_FIELDS.items()
        if k not in {"task_id", "task_type", "label", "raw_request"}
    }
    payload = {
        "task_id": _FLAT_FIELDS["task_id"],
        "task_type": _FLAT_FIELDS["task_type"],
        "answers": form_fields,
    }
    cfg = load_experiment_config(
        _write_req(tmp_path, payload),
        tmp_path / "state",
        tmp_path / "ws",
    )
    assert cfg.task_id == "he-webui-task"
    assert cfg.execution_mode == "dkao-cli"
    assert cfg.pool_mode is True
    assert cfg.per_round_budget == 4


def test_empty_requirements_fall_back_to_dry_defaults(tmp_path):
    """No form fields at all -> documented dry-run defaults (baseline only)."""
    cfg = load_experiment_config(
        _write_req(tmp_path, {"task_id": "empty", "task_type": "harness-evolve"}),
        tmp_path / "state",
        tmp_path / "ws",
    )
    assert cfg.execution_mode == "dry-run"
    assert cfg.pool_mode is False
    assert cfg.max_iterations == 3
