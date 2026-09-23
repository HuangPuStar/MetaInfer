"""Suite and experiment configuration for harness_evolve."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

import yaml

from .rounds import normalized_per_gate

#: default instance used by dry-run when the suite spec is empty
DRY_DEFAULT_INSTANCES = [
    {
        "id": "hy3_tp8_qkv_m4096_w4",
        "shape": {"model": "hy3", "tp_size": 8, "operator": "qkv_proj",
                  "M": 4096, "N": 1280, "K": 4096},
        "warm_start_from": "best_known",
        "budget_rounds": 4,
        "pass_median_us_le": 500.0,
    },
    {
        "id": "glm52_tp4_o_m16_w4",
        "shape": {"model": "glm52", "tp_size": 4, "operator": "o_proj",
                  "M": 16, "N": 6144, "K": 2048},
        "warm_start_from": "best_known",
        "budget_rounds": 4,
        "pass_median_us_le": 60.0,
    },
]


@dataclass
class InstanceSpec:
    id: str
    shape: Dict[str, Any]
    budget_rounds: int = 4
    warm_start_from: str = "best_known"
    pass_median_us_le: float = 0.0

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "InstanceSpec":
        return cls(
            id=str(d["id"]),
            shape=dict(d.get("shape") or {}),
            budget_rounds=int(d.get("budget_rounds") or 4),
            warm_start_from=str(d.get("warm_start_from") or "best_known"),
            pass_median_us_le=float(d.get("pass_median_us_le") or 0.0),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "shape": self.shape,
            "budget_rounds": self.budget_rounds,
            "warm_start_from": self.warm_start_from,
            "pass_median_us_le": self.pass_median_us_le,
        }


@dataclass
class ExperimentConfig:
    task_id: str
    state_dir: Path
    workspace_dir: Path
    suite: List[InstanceSpec]
    max_iterations: int = 3
    harness_source: str = "dcu_default"   # dir path or "dcu_default"
    execution_mode: str = "dry-run"       # dry-run | dkao-cli
    agent_framework: str = "dsh"
    pool_source: str = ""                 # "" = legacy suite mode; builtin|path = pool v2
    per_round_budget: int = 0             # 0 = unlimited (legacy); pool budget cap
    answers: Dict[str, Any] = field(default_factory=dict)

    @property
    def exp_dir(self) -> Path:
        return self.workspace_dir

    def dump_snapshot(self, path: Path) -> None:
        path.write_text(json.dumps({
            "schema_version": 1,
            "task_id": self.task_id,
            "max_iterations": self.max_iterations,
            "harness_source": self.harness_source,
            "execution_mode": self.execution_mode,
            "pool_source": self.pool_source,
            "per_round_budget": self.per_round_budget,
            "suite": [s.to_dict() for s in self.suite],
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    @property
    def pool_mode(self) -> bool:
        return bool(self.pool_source) and self.pool_source != "suite"


def load_experiment_config(
    requirements_path: Path, state_dir: Path, workspace_dir: Path
) -> ExperimentConfig:
    req = json.loads(requirements_path.read_text(encoding="utf-8"))
    # The shell/server frontend flattens form answers onto the requirements
    # top level (same contract dcu_kernel_auto_opt consumes via its
    # ``_answers`` fallback). Accept either an ``answers`` dict (CLI/tests) or
    # the flattened top level so a WebUI-launched experiment honors the form.
    req_answers = req.get("answers")
    answers = req_answers if isinstance(req_answers, dict) else req
    task_id = str(req.get("task_id", "task"))

    suite_yaml = str(answers.get("suite_yaml") or "")
    raw_instances: List[Dict[str, Any]] = []
    if suite_yaml.strip():
        data = yaml.safe_load(suite_yaml)
        if isinstance(data, dict):
            raw_instances = list(data.get("instances") or [])
        elif isinstance(data, list):
            raw_instances = list(data)
    if not raw_instances:
        raw_instances = DRY_DEFAULT_INSTANCES

    return ExperimentConfig(
        task_id=task_id,
        state_dir=Path(state_dir),
        workspace_dir=Path(workspace_dir),
        suite=[InstanceSpec.from_dict(d) for d in raw_instances],
        max_iterations=int(answers.get("max_iterations") or 3),
        harness_source=str(answers.get("harness_source") or "dcu_default"),
        execution_mode=str(answers.get("execution_mode") or "dry-run"),
        agent_framework=str(answers.get("agent_framework") or "dsh"),
        pool_source=str(answers.get("pool_source") or ""),
        per_round_budget=_normalized_budget(answers.get("per_round_budget")),
        answers=dict(answers),
    )


def _normalized_budget(value: Any) -> int:
    """This round's question count: always a multiple of 4 (FLOW.md §1.1).

    The machine has four HCUs, so a round is sized in whole waves; a request of
    5 or 7 questions would leave devices idle in the second wave, so it is
    rounded up (never down) here, at the single point where the form/CLI answer
    enters the run. ``0``/empty keeps the legacy meaning "no cap, use the whole
    pool", which is why this cannot simply be ``normalized_per_gate`` (that one
    maps 0 to the 4-question default).
    """
    try:
        count = int(value)
    except (TypeError, ValueError):
        return 0
    if count <= 0:
        return 0
    return normalized_per_gate(count)


def harness_seed_dir(harness_source: str) -> Path:
    """Resolve the harness seed directory.

    ``dcu_default`` maps to the dcu_kernel_auto_opt plugin's harness_default/.
    An explicit path (absolute or relative to the experiment workspace) is used
    as-is. Later this becomes the "champion workspace" an AHE experiment forks.
    """
    if harness_source and harness_source != "dcu_default":
        p = Path(harness_source).expanduser()
        return p.resolve()
    dcu_plugin = (
        Path(__file__).resolve().parents[2]
        / "dcu_kernel_auto_opt" / "harness_default"
    )
    return dcu_plugin.resolve()
