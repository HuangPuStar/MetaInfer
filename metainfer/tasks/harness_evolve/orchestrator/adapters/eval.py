"""Evaluation adapters for harness_evolve.

Real evaluator contract:
- every question becomes one real dcu_kernel_auto_opt child task;
- artificial/production kernel repos are READ-ONLY seeds;
- all child output repos are forced under the isolated AHE repo root
  (default /root/zth_agent/ahe-kernel-repos);
- per-child final_report / worker rounds / token budget are normalized for the
  parent AHE benchmark and frontend.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import uuid

from pathlib import Path
from typing import Any, Dict, List

import yaml

from ..config import ExperimentConfig, InstanceSpec
from ..process_control import ChildProcess, ProcessRegistry, spawn
from ..rounds import (
    CHILDREN_DIR, GPU_COUNT, STAGE_GENERALIZATION, STAGE_PERFORMANCE,
    device_for_index, stage_dir_name,
)


def _round_stage(cfg: Any) -> str:
    """Which stage this evaluation is: the pipeline sets ``answers[round_stage]``.

    Missing means "an old/legacy run": the performance stage is the shape the
    adapter had before the stages existed, so that is the fallback.
    """
    answers = getattr(cfg, "answers", None) or {}
    try:
        return str(answers.get("round_stage") or STAGE_PERFORMANCE)
    except AttributeError:
        return STAGE_PERFORMANCE

#: The exit code DKAO's in-harness measurement gate uses when it has waited its
#: whole budget (``METAINFER_GATE_MAX_WAITS``, 48 x 30 min = 24 h) without ever
#: seeing a clean device (VRAM <= 90% and HCU == 0). Mirrors
#: ``metainfer/tasks/dcu_kernel_auto_opt/assets/w8a8_bench.py::GATE_EXIT_CODE``;
#: duplicated on purpose so the HE adapter does not import the child's asset
#: module just for a number, and asserted against it in the tests.
GATE_EXIT_CODE = 75


class Evaluator:
    name = "base"

    def evaluate(
        self,
        cfg: ExperimentConfig,
        workspace: Path,
        iteration: int,
        instances: "List[InstanceSpec] | None" = None,
    ) -> Dict[str, Dict[str, Any]]:
        raise NotImplementedError


class DryRunEvaluator(Evaluator):
    """Deterministic offline evaluator (tests / CI / protocol dry runs)."""

    name = "dry-run"

    def evaluate(self, cfg, workspace, iteration, instances=None):
        targets = list(instances) if instances else list(cfg.suite)
        fixture: Dict[str, Any] = dict(cfg.answers.get("dry_fixture") or {})
        # ``dry_fixture_all`` sets the default for questions the fixture does
        # not name, so an offline run can be steered wholesale (used by the
        # variant-round end-to-end test).
        default_pass = cfg.answers.get("dry_fixture_all")
        results: Dict[str, Dict[str, Any]] = {}
        for idx, inst in enumerate(targets):
            override = fixture.get(inst.id)
            if override is None:
                override = default_pass
            passed = bool(override) if override is not None else (idx != 0)
            threshold = float(inst.pass_median_us_le or 1.0)
            scale = 0.8 if passed else 1.4
            median = round(threshold * scale, 3)
            results[inst.id] = {
                "status": "completed",
                "passed": passed,
                "correctness_ok": True,
                "p90_ok": True,
                "median_us": median,
                "p90_us": median * 1.01,
                "rounds_used": inst.budget_rounds,
                "tokens": 0,
                "reason": "dry-run fixture",
                "child_task_id": f"dry-{iteration}-{inst.id}",
                "repo_path": None,
                "harness_revision": _harness_revision(workspace),
            }
        return results


class DkaoCliEvaluator(Evaluator):
    """Real DKAO evaluator (one isolated child task per question)."""

    name = "dkao-cli"

    def __init__(self) -> None:
        # live child handles, so a question can be terminated while it runs
        # (see process_control.py). Freezing a child because "its" device was
        # taken over is gone with the rest of HE's GPU management: the child's
        # own gate never measures on a busy card in the first place.
        self.children = ProcessRegistry()

    def evaluate(self, cfg, workspace, iteration, instances=None):
        targets = list(instances) if instances else list(cfg.suite)
        if not targets:
            return {}
        stage = _round_stage(cfg)
        repo_root = Path(
            str(cfg.answers.get("ahe_repo_root") or
                "/root/zth_agent/ahe-kernel-repos")
        ).expanduser().resolve()
        repo_root.mkdir(parents=True, exist_ok=True)
        # One DKAO child per question, under this *attempt's* own directory.
        # Each attempt is a different DKAO run, so none of them may share a
        # child workspace: DKAO binds that workspace to the exact kernel repo it
        # was launched with, and a second run pointed at the same directory dies
        # on its own ownership check before it does any work.
        children_root = cfg.exp_dir / CHILDREN_DIR
        children_root.mkdir(parents=True, exist_ok=True)
        # HE does not manage GPU occupancy. Every question this round is handed
        # to its own DKAO child immediately, pinned to a device by the fixed
        # ``index % GPU_COUNT`` rotation; whether that device is free is DKAO's
        # business, not ours. The child's measurement gate
        # (``ensure_measurement_gate``: VRAM <= 90% and HCU == 0, 30 min per
        # check, at most 24 h) waits for the card, and the child's own
        # contamination handling discards a round measured on a shared device.
        # HE therefore never takes a lease, never pre-checks the cards and never
        # freezes a child for a device it does not own — it only records the
        # round's device layout (``_save_preflight``) for audit.
        #
        # The wave exists for one reason only: not to launch more children than
        # there are devices (a wave is at most GPU_COUNT questions), so N
        # questions land as N / 4 sequential waves with one question per device
        # in each.
        layout = self._device_layout(cfg, iteration, targets)
        self._save_preflight(cfg, iteration, layout)
        self._append_timeline(cfg, "gpu_layout_fixed", {
            "iteration": iteration,
            "gpu_count": GPU_COUNT,
            "devices": layout["devices"],
            "managed_by": layout["managed_by"],
        })

        results: Dict[str, Dict[str, Any]] = {}
        pending = list(targets)
        max_attempts = int(cfg.answers.get("env_retry_attempts") or 3)
        attempt = 0
        gate_blocked: List[str] = []
        while pending:
            wave_size = min(GPU_COUNT, len(pending))
            wave = pending[:wave_size]
            attempt += 1
            child_root = (children_root
                          / stage_dir_name(stage, iteration, attempt=attempt))
            child_root.mkdir(parents=True, exist_ok=True)
            if attempt > 1:
                # The retry owns a fresh directory, so the failed attempt's
                # evidence -- its logs above all -- stays where it is.
                self._append_timeline(cfg, "env_retry_attempt", {
                    "iteration": iteration, "stage": stage, "attempt": attempt,
                    "dir": child_root.name,
                    "questions": [inst.id for inst in wave],
                })
            wave_results = self._run_wave(cfg, workspace, iteration, wave,
                                          repo_root, child_root,
                                          wave_size)
            results.update(wave_results)
            # A child that produced no usable number (build/toolchain/crash) is
            # retried: the environment owes us a measurement. Two things are NOT
            # retried:
            #  - a device the child's own gate refused to measure on (exit 75):
            #    DKAO already waited its whole 24 h budget on that card. HE has
            #    no cards to reassign, so relaunching would only ignore a verdict
            #    it has no standing to overrule. The round stops instead.
            #  - a contention window: gone entirely — HE no longer detects or
            #    reacts to contention, DKAO's gate and contamination handling do.
            gave_up = [inst for inst in pending
                       if (wave_results.get(inst.id) or {}).get("gate_blocked")]
            gate_blocked.extend(inst.id for inst in gave_up)
            retry = [inst for inst in pending
                     if inst not in gave_up
                     and self._env_failed(wave_results.get(inst.id) or {})]
            done = [inst for inst in pending if inst not in retry]
            pending = [inst for inst in pending if inst not in done]
            if not retry:
                break
            if attempt >= max_attempts:
                # The budget counts attempts, not retries: with
                # ``env_retry_attempts: 2`` a question runs at most twice.
                self._append_timeline(cfg, "env_retry_exhausted", {
                    "iteration": iteration, "attempts": attempt,
                    "pending": [inst.id for inst in retry],
                })
                break
            pending = retry
        self._stop_on_incomplete_round(cfg, iteration, targets, results,
                                       reason=("gpu_gate_blocked" if gate_blocked
                                               else "environment_failed"))
        return results

    def _save_preflight(self, cfg: ExperimentConfig, iteration: int,
                        layout: Dict[str, Any]) -> None:
        """Record the round's device *layout* next to the iteration's evidence.

        This is a layout record, not an occupancy check: it says which device
        each question was handed to and that HE took no lease. Whether that
        device was free at the time is answered by the child's own
        ``measurement_gate.jsonl`` — the only place a gate verdict exists now.
        """
        stage = _round_stage(cfg)
        name = "gpu_preflight.json" if stage != STAGE_GENERALIZATION else \
            "gpu_preflight_generalization.json"
        try:
            bench_dir = (cfg.exp_dir / "runs" / f"iteration_{iteration:03d}"
                         / "input" / "benchmark")
            bench_dir.mkdir(parents=True, exist_ok=True)
            (bench_dir / name).write_text(
                json.dumps(layout, ensure_ascii=False, indent=2),
                encoding="utf-8")
        except OSError:
            pass

    @classmethod
    def _device_layout(cls, cfg: ExperimentConfig, iteration: int,
                       targets: List[Any]) -> Dict[str, Any]:
        """The fixed ``index % GPU_COUNT`` device assignment for one round."""
        devices = [device_for_index(idx) for idx, _ in enumerate(targets)]
        return {
            "schema": "he-gpu-layout/1",
            "enabled": False,
            "managed_by": "dcu_kernel_auto_opt",
            "reason": ("harness_evolve does not manage GPU occupancy; DKAO's "
                       "measurement gate (VRAM<=90% and HCU==0) decides when a "
                       "device may be measured on"),
            "leases": [],
            "gpu_count": GPU_COUNT,
            "iteration": iteration,
            "devices": {
                str(getattr(inst, "id", f"question_{idx}")): gpu
                for idx, (inst, gpu) in enumerate(zip(targets, devices))
            },
            "assigned_devices": sorted(set(devices)),
        }

    def _run_wave(self, cfg: ExperimentConfig, workspace: Path, iteration: int,
                  wave: List[Any], repo_root: Path,
                  child_root: Path,
                  wave_size: int) -> Dict[str, Dict[str, Any]]:
        """Run one wave: one DKAO child per question, one question per device.

        The device is chosen by the fixed ``index % GPU_COUNT`` rotation rather
        than by a reading of the cards: HE hands the task over, DKAO's own
        measurement gate decides when the card is clean enough to time a
        kernel. Nothing here watches the devices — a round that DKAO's gate
        holds up is visible in the child's ``measurement_gate.jsonl``, not in a
        verdict HE invents.
        """
        results: Dict[str, Dict[str, Any]] = {}
        if not wave:
            return results
        with concurrent.futures.ThreadPoolExecutor(max_workers=wave_size) as ex:
            futures = {
                ex.submit(
                    self._run_one, cfg, workspace, iteration, inst,
                    device_for_index(idx),
                    repo_root, child_root, None,
                ): inst.id
                for idx, inst in enumerate(wave)
            }
            for fut in concurrent.futures.as_completed(futures):
                iid = futures[fut]
                try:
                    results[iid] = fut.result()
                except Exception as exc:  # noqa: BLE001
                    import traceback as _traceback
                    tb_text = _traceback.format_exc(limit=8)
                    results[iid] = {
                        "status": "exception",
                        "passed": False,
                        "correctness_ok": False,
                        "p90_ok": False,
                        "median_us": None,
                        "p90_us": None,
                        "reason": (
                            f"evaluator exception: {exc}\n{tb_text}"
                        ),
                        "child_task_id": None,
                        "repo_path": None,
                        "harness_revision": _harness_revision(workspace),
                    }
        return results

    #: statuses that mean "no usable measurement because the environment broke".
    #: ``partial_worker_result`` is deliberately absent: the child may have
    #: produced a valid measurement whose only problem is that final synthesis
    #: did not land. Treating that as an environment failure requeued questions
    #: that had already measured, and the retry then collided with the child's
    #: own kernel repo — which is how a round ended up with zero medians.
    ENV_FAILURE_STATUSES = ("missing_report", "exception", "timeout")

    #: statuses that mean "the workers measured, the round did not finish"
    PARTIAL_STATUSES = ("partial_worker_result",)

    #: reason fragments that mean "the toolchain/environment broke", i.e. the
    #: question deserves a retry rather than being counted as a bad kernel
    ENV_FAILURE_HINTS = ("compile", "build failed", "ninja", "hipcc",
                         "undefined template", "no space left",
                         "outofmemory", "out of memory", "timed out",
                         "timeout", "killed")

    def _env_failed(self, result: Dict[str, Any],
                    *, retry: bool = False) -> bool:
        """A failure caused by the environment (not by the candidate kernel).

        The rule is "no usable number => the environment owes us a measurement":
        a child that could not be built, timed out or crashed is retried (30
        minutes of rest, up to 3 attempts). A child that *did* measure is not
        retried — its number is evidence even when the run ended early (for
        example ``partial_worker_result``: the workers measured, final synthesis
        did not land).

        ``retry=True`` marks a re-measurement of a question that already ran
        once, where even a measured partial is an environment problem: its
        device was taken over mid-run, so the number describes a shared card.
        """
        if not isinstance(result, dict):
            return False
        if result.get("passed") is True:
            return False
        status = str(result.get("status") or "").lower()
        measured = result.get("median_us") not in (None, "")
        if status in self.ENV_FAILURE_STATUSES:
            return True
        if measured:
            # a real number: only a retry treats a partial finish as an
            # environment problem, and only because the device was shared
            return bool(retry and status in self.PARTIAL_STATUSES)
        reason = str(result.get("reason") or "").lower()
        if any(hint in reason for hint in self.ENV_FAILURE_HINTS):
            return True
        return True

    def _request_stop(self, cfg: ExperimentConfig, reason: str,
                      **fields: Any) -> None:
        """Ask the outer loop to stop the whole experiment (terminal state)."""
        try:
            (cfg.exp_dir / "stop_requested.json").write_text(
                json.dumps({"reason": reason, **fields}, ensure_ascii=False,
                           indent=2), encoding="utf-8")
        except OSError:
            pass

    #: statuses that mean "the round ended without a measurement"
    INCOMPLETE_STATUSES = ENV_FAILURE_STATUSES + ("rejected", "failed")

    def _incomplete_ids(self, targets: List[Any],
                        results: Dict[str, Dict[str, Any]]) -> List[str]:
        """Questions the round never measured (no number, or a broken run).

        A round that ran out of retries used to be recorded as "these
        questions just failed", and the decisions downstream then compared
        against whatever numbers happened to exist. That silently weakens the
        evidence for a promotion, so the caller stops the run instead.
        """
        out: List[str] = []
        for inst in targets:
            iid = getattr(inst, "id", str(inst))
            res = results.get(iid)
            if not isinstance(res, dict) or res.get("passed") is True:
                continue
            if not self._is_measured(res):
                out.append(iid)
        return out

    def _is_measured(self, result: Dict[str, Any]) -> bool:
        """True when the result carries a usable number of its own."""
        if not isinstance(result, dict):
            return False
        median = result.get("median_us")
        if median in (None, ""):
            return False
        status = str(result.get("status") or "").lower()
        return status not in self.ENV_FAILURE_STATUSES

    def _stop_on_incomplete_round(self, cfg: ExperimentConfig, iteration: int,
                                  targets: List[Any],
                                  results: Dict[str, Dict[str, Any]],
                                  *, reason: str) -> bool:
        """True when the round must stop instead of deciding on partial data."""
        missing = self._incomplete_ids(list(targets), results or {})
        if not missing:
            return False
        unmeasured = sorted(set(missing))
        self._append_timeline(cfg, "round_incomplete", {
            "iteration": iteration, "reason": reason,
            "unmeasured": unmeasured,
            "measured": sorted(set(results or {}) - set(unmeasured)),
        })
        self._request_stop(cfg, "round_incomplete", iteration=iteration,
                           cause=reason, unmeasured=unmeasured)
        return True

    def _append_timeline(self, cfg: ExperimentConfig, event: str,
                         payload: Dict[str, Any]) -> None:
        try:
            from metainfer.tasks.harness_evolve.orchestrator.state import (
                append_timeline,
            )
            append_timeline(cfg.state_dir, event, payload)
        except Exception:  # noqa: BLE001 - progress records are best effort
            pass

    def _run_one(
        self, cfg: ExperimentConfig, workspace: Path, iteration: int,
        inst: InstanceSpec, index: int, repo_root: Path, child_root: Path,
        preflight: Optional[Dict[str, Any]] = None,
        gpu_override: "int | None" = None,
    ) -> Dict[str, Any]:
        # Device layout: the machine exposes 4 GPUs; spread the concurrent
        # children over 0..3 in submission order and repeat cyclically, so a
        # 4-multiple question set keeps every card busy exactly once per wave.
        # (worker id == GPU id is enforced by DKAO manual assignments, hence
        # _build_dkao_requirements names the worker worker_<gpu>.)
        gpu = (int(gpu_override) if gpu_override is not None
               else device_for_index(index))
        suffix = uuid.uuid4().hex[:6]
        child_id = _slug(
            f"ahe-{cfg.task_id}-it{iteration:03d}-candidate-{inst.id}-{suffix}"
        )
        repo_name = child_id
        state_dir = child_root / inst.id / "state"
        work_dir = child_root / inst.id / "workspace"
        state_dir.mkdir(parents=True, exist_ok=True)
        work_dir.mkdir(parents=True, exist_ok=True)
        req = self._build_dkao_requirements(
            cfg, inst, iteration, child_id, repo_name, gpu, workspace
        )
        req_path = child_root / inst.id / "requirements.json"
        req_path.parent.mkdir(parents=True, exist_ok=True)
        req_path.write_text(json.dumps(req, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        log_path = child_root / inst.id / "orchestrator-external.log"

        cmd = [
            _python_executable(), "-m",
            "metainfer.tasks.dcu_kernel_auto_opt.orchestrator.cli", "run",
            str(req_path), "--state-dir", str(state_dir),
            "--workspace-dir", str(work_dir),
        ]
        env = _child_env(cfg, repo_root, workspace,
                         child_state_dir=state_dir)
        timeout_min = float(cfg.answers.get("child_timeout_minutes") or 0)
        timeout = timeout_min * 60 if timeout_min > 0 else None
        started = time.time()
        # Spawn (not run): the parent keeps a handle so it can terminate the
        # child on a timeout. Freezing a child for "its" device is gone with the
        # rest of HE's GPU management — that device is DKAO's to arbitrate.
        child = spawn(cmd, cwd=str(Path(__file__).resolve().parents[5]),
                      env=env, log_path=log_path)
        self.children.add(inst.id, child)
        rc, timed_out = 0, False
        try:
            if timeout:
                rc = child.proc.wait(timeout=timeout)
            else:
                rc = child.proc.wait()
        except subprocess.TimeoutExpired:
            child.terminate(reason=f"child timeout after {timeout:.0f}s")
            rc, timed_out = 124, True
        finally:
            self.children.drop(inst.id)
            try:
                child.proc.wait(timeout=30)
            except Exception:  # noqa: BLE001 - already dead or unkillable
                pass
        terminated_by = child.terminate_reason
        duration = time.time() - started
        report_path = work_dir / "final_report.json"
        report = _load_json(report_path) or {}
        normalized = (
            _normalize_report(inst, report)
            if report else _normalize_workspace_result(inst, work_dir)
        )
        normalized.update({
            "child_task_id": child_id,
            "parent_ahe_task_id": cfg.task_id,
            "ahe_iteration": iteration,
            "candidate_role": "candidate",
            "repo_path": str(repo_root / repo_name),
            "repo_root": str(repo_root),
            "harness_revision": _harness_revision(workspace),
            "child_state_dir": str(state_dir),
            "child_workspace_dir": str(work_dir),
            "log_path": str(log_path),
            "duration_s": round(duration, 3),
            "returncode": rc,
            "timed_out": timed_out,
            "gpu": gpu,
            "terminated_by": terminated_by or None,
        })
        # No ``gpu_preflight`` / ``measurement_suspect`` stamping here any more:
        # HE takes no reading of the device it handed out, so it has no verdict
        # to attach. The child records every admission check it made in
        # ``<child_state_dir>/measurement_gate.jsonl``, which is what the HE
        # detail page reads when it shows why a question is waiting.
        #
        # ``GATE_EXIT_CODE`` (75) is the child's *own* gate saying "I waited 48
        # x 30 min and no card ever became clean". That is an authoritative
        # verdict, not a flaky environment: HE does not repeal it by launching
        # the same child again, so it is marked and the round stops.
        if rc == GATE_EXIT_CODE:
            normalized["gate_blocked"] = True
            normalized.setdefault("status", "environment_failed")
            normalized["reason"] = (
                f"DKAO measurement gate gave up on device "
                f"{gpu} after its full wait budget"
            )
        #
        # final_report.json does not carry a canonical rounds field (its shape
        # changed over DKAO revisions), so fall back to the authoritative
        # per-attempt records the workers wrote.
        counted = _worker_rounds(work_dir)
        if counted and int(normalized.get("rounds_used") or 0) < counted:
            normalized["rounds_used"] = counted
        if rc != 0 and normalized.get("status") == "missing_report":
            normalized["reason"] = _tail(log_path)
        return normalized

    def _build_dkao_requirements(
        self, cfg: ExperimentConfig, inst: InstanceSpec, iteration: int,
        child_id: str, repo_name: str, gpu: int, workspace: Path,
    ) -> Dict[str, Any]:
        s = inst.shape
        shape_yaml = {
            "model": str(s.get("model", "AHE registered GEMM")),
            "assignment_mode": "manual",
            "shape_scope": "subset",
            "shapes": [{
                "id": inst.id,
                "M": int(s["M"]), "N": int(s["N"]), "K": int(s["K"]),
                "tp_size": int(s.get("tp_size", 8)),
                "operator": str(s["operator"]),
            }],
            "assignments": {
                # DKAO's manual mode requires worker_N to map to GPU N
                # (gen_and_opt_pipeline validates worker_id == gpu). Name the
                # single worker after the assigned GPU so parallel children
                # spread across devices 0..3 without tripping the check.
                f"worker_{gpu}": {"gpu": gpu, "shapes": [inst.id]},
            },
        }
        return {
            "task_id": child_id,
            "task_type": "dcu-kernel-auto-opt",
            "label": child_id,
            "operator": "Quantized GEMM",
            "kernel_language": "HIP C++",
            "target_hardware": "K500SM_AI / gfx928",
            "dtype": "INT8 W8A8",
            "agent_framework": cfg.agent_framework,
            # The child DKAO task runs on the same DSH model generation as the
            # AHE evolve agent (agent_model is a DKAO form label, resolved to an
            # id by DKAO's own orchestrator/config.py).
            "agent_model": "deepseek-flash-4.1",
            "execution_mode": "Generate & optimize (auto-create kernel repo)",
            "target_repo_path": repo_name,
            "model": str(s.get("model", "AHE registered GEMM")),
            "shape_assignment_mode": "Manual by GPU",
            "shape_scope": "Selected shapes only",
            "shape_config": yaml.safe_dump(shape_yaml, sort_keys=False),
            "correctness_ref": "PyTorch eager",
            "perf_target": "AHE automatic baseline-relative criterion",
            "max_iterations": str(inst.budget_rounds),
            "minimum_improvement_percent": 0,
            # Parent/trace metadata: ignored by old DKAO code, preserved in req.
            "parent_ahe_task_id": cfg.task_id,
            "ahe_iteration": iteration,
            "harness_revision": _harness_revision(workspace),
            "candidate_role": "candidate",
        }


def _normalize_workspace_result(inst: InstanceSpec, work_dir: Path) -> Dict[str, Any]:
    """Best-effort evidence when final synthesis/serial validate fails.

    Partial worker metrics are visible in the AHE frontend but never pass the
    system gate (no final validation = candidate cannot be promoted).
    """
    for path in sorted((work_dir / "workers").glob("*/result.json")):
        data = _load_json(path) or {}
        shape = (data.get("shapes") or {}).get(inst.id) or {}
        metrics = shape.get("metrics") or {}
        if not metrics:
            continue
        median, p90 = metrics.get("median_us"), metrics.get("p90_us")
        correctness = bool(
            metrics.get("graph_capture_passed") is True
            and metrics.get("correctness_passed_in_precheck") is True
        )
        rounds_path = path.parent / "runs" / inst.id / "experiments.jsonl"
        rounds = 0
        if rounds_path.is_file():
            rounds = len(rounds_path.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines())
        return {
            "status": "partial_worker_result",
            "passed": False,
            "correctness_ok": correctness,
            "p90_ok": bool(p90 is not None),
            "median_us": float(median) if median is not None else None,
            "p90_us": float(p90) if p90 is not None else None,
            "rounds_used": rounds,
            "tokens": None,
            "new_best_known": False,
            "reason": "final report missing; worker best preserved as evidence",
        }
    return {
        "status": "missing_report", "passed": False,
        "correctness_ok": False, "p90_ok": False,
        "median_us": None, "p90_us": None, "rounds_used": 0,
        "tokens": None, "reason": "final_report.json and worker result missing",
    }


def _normalize_report(inst: InstanceSpec, report: Dict[str, Any]) -> Dict[str, Any]:
    if not report:
        return {
            "status": "missing_report", "passed": False,
            "correctness_ok": False, "p90_ok": False,
            "median_us": None, "p90_us": None, "rounds_used": 0,
            "tokens": None, "reason": "final_report.json missing",
        }
    final = (report.get("final_validation") or {}).get(inst.id) or {}
    worker = (report.get("worker_validation") or {}).get(inst.id) or {}
    metrics = final or (worker.get("metrics") or {})
    correctness = bool(
        metrics.get("passed") is True
        or (
            metrics.get("graph_capture_passed") is True
            and (metrics.get("mismatch_count") in (None, 0))
            and report.get("status") == "success"
        )
    )
    median = metrics.get("median_us")
    p90 = metrics.get("p90_us")
    return {
        "status": str(report.get("status") or "unknown"),
        "passed": bool(report.get("status") == "success" and correctness),
        "correctness_ok": correctness,
        "p90_ok": bool(p90 is not None),
        "median_us": float(median) if median is not None else None,
        "p90_us": float(p90) if p90 is not None else None,
        "rounds_used": _count_rounds(report, inst.id),
        "tokens": None,
        "new_best_known": False,
        "reason": "final_report parsed",
        "final_report_status": report.get("status"),
    }


def _count_rounds(report: Dict[str, Any], shape_id: str) -> int:
    # final report does not currently expose a canonical rounds_used field;
    # worker result/details remain available through child_workspace_dir.
    workers = report.get("workers") or {}
    for worker in workers.values():
        shape = (worker.get("shapes") or {}).get(shape_id) if isinstance(worker, dict) else None
        if isinstance(shape, dict):
            try:
                return int(shape.get("iterations") or shape.get("rounds_used") or 0)
            except (TypeError, ValueError):
                pass
    return 0


def _harness_revision(workspace: Path) -> str:
    manifest = _load_json(workspace / "manifest.json")
    if not manifest and (workspace / "manifest.yaml").is_file():
        try:
            manifest = yaml.safe_load(
                (workspace / "manifest.yaml").read_text(encoding="utf-8")
            ) or {}
        except (OSError, ValueError):
            manifest = {}
    return str((manifest or {}).get("revision") or "unknown")


def _load_json(path: Path) -> Dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value[:120] or f"ahe-child-{uuid.uuid4().hex[:8]}"


def _tail(path: Path, size: int = 2000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "child failed; log unavailable"
    return text[-size:]


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}


def _child_env(cfg: ExperimentConfig, repo_root: Path,
               workspace: Path,
               child_state_dir: Optional[Path] = None) -> Dict[str, str]:
    """Environment for one DKAO child task.

    ``METAINFER_PLANNER=1`` is what makes the evaluated harness' planner
    actually drive DKAO's round instructions; without it the harness snapshot
    is inert for planning decisions. The form switch (default on) keeps that
    auditable.

    ``METAINFER_CHILD_STATE_DIR`` points the child's own measurement gate at a
    state directory, so every "gate blocked / gate ok" check it makes while
    iterating is auditable next to the round's other evidence.
    """
    env = os.environ.copy()
    env["METAINFER_KERNEL_REPOS"] = str(repo_root)
    env["METAINFER_HARNESS_ROOT"] = str(workspace)
    if child_state_dir is not None:
        env["METAINFER_CHILD_STATE_DIR"] = str(child_state_dir)
    if _truthy(cfg.answers.get("planner_enabled"), default=True):
        env["METAINFER_PLANNER"] = "1"
    else:
        env.pop("METAINFER_PLANNER", None)

    # Validation budget: one question = one shape, so AHE defaults to the
    # task-scoped serial validation with the quick bench profile (production
    # DKAO tasks keep the full API sweep unless their form says otherwise).
    answers = cfg.answers
    scope = str(answers.get("validate_scope") or "task").strip().lower()
    env["METAINFER_VALIDATE_SCOPE"] = scope if scope in {"api", "task"} else "task"
    profile = str(answers.get("bench_profile") or "quick").strip().lower()
    quick = {}
    if profile in {"quick", "fast"}:
        try:
            from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.validation_budget import (  # noqa: E501
                QUICK_BENCH,
            )
            quick = dict(QUICK_BENCH)
        except Exception:  # noqa: BLE001
            quick = {"warmups": 10, "samples": 20, "replays_per_sample": 20}
    explicit = {
        "METAINFER_BENCH_WARMUPS": answers.get("bench_warmups"),
        "METAINFER_BENCH_SAMPLES": answers.get("bench_samples"),
        "METAINFER_BENCH_REPLAYS": answers.get("bench_replays"),
    }
    if quick:
        env["METAINFER_BENCH_WARMUPS"] = str(quick["warmups"])
        env["METAINFER_BENCH_SAMPLES"] = str(quick["samples"])
        env["METAINFER_BENCH_REPLAYS"] = str(quick["replays_per_sample"])
    for name, value in explicit.items():
        if value not in (None, ""):
            try:
                env[name] = str(int(value))
            except (TypeError, ValueError):
                pass
    return env


def _worker_rounds(work_dir: Path) -> int:
    """Rounds actually attempted, from each worker's experiments.jsonl."""
    total = 0
    workers = work_dir / "workers"
    if not workers.is_dir():
        return 0
    for exp_file in workers.glob("*/runs/*/experiments.jsonl"):
        try:
            total += len(exp_file.read_text(
                encoding="utf-8", errors="replace").splitlines())
        except OSError:
            continue
    return total


def _python_executable() -> str:
    """A reliable python binary for spawning DKAO child orchestrators.

    ``sys.executable`` can be ``''`` when the WebUI launcher renames argv[0]
    to a friendly process name (``metainfer-orchestrator``) via Popen's
    ``executable=`` split: CPython then cannot resolve its own path, and
    spawning a child with the empty string fails with
    ``PermissionError [Errno 13] Permission denied: ''``. Prefer the explicit
    ``METAINFER_PYTHON`` override, then a valid ``sys.executable``, then
    ``python3`` on PATH.
    """
    import shutil

    env_py = str(os.environ.get("METAINFER_PYTHON") or "").strip()
    if env_py:
        return env_py
    exe = str(sys.executable or "").strip()
    if exe and os.path.isfile(exe) and os.access(exe, os.X_OK):
        return exe
    for cand in ("python3", "python"):
        found = shutil.which(cand)
        if found:
            return found
    return "/usr/bin/python3"


def build_evaluator(mode: str) -> Evaluator:
    return DkaoCliEvaluator() if mode == "dkao-cli" else DryRunEvaluator()
