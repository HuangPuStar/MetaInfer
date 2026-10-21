"""Deterministic ABCDEF orchestrator for GPU kernel optimization.

Control flow is driven by the transition table in .phases. The orchestrator
runs phase-at-a-time: Plan → Implement → Test → Review → Perf Test → Perf Plan.

C_test uses agent-written test.sh (no immutable oracle — the test compares
kernel output against a reference implementation).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import phases as P
from . import feedback
from . import lessons
from . import kernel_zoo
from . import metrics
from .profiler import profiler_skill_text
from metainfer.orchestrator.iteration import IterationWorkspace
from .prompts import (
    c_repair_followup_prompt,
    c_repair_prompt,
    failure_retrospective_prompt,
    implement_prompt,
    implement_redo_prompt,
    perf_plan_prompt,
    perf_test_prompt,
    plan_prompt,
    retrospective_prompt,
    review_prompt,
    review_prompt_a,
    review_prompt_b,
    write_test_harness_prompt,
)
from metainfer.orchestrator.state import StateStore
from metainfer.orchestrator.subagent_manager import AgentSpec, SubAgentManager
from .iteration_record import IterationRecord


MAX_PHASE_ATTEMPTS = 3
# NOTE: the perf-regression THRESHOLD lives in ``oracles/perf.py``
# (``REGRESSION_THRESHOLD``) — that is the single source of truth. The
# oracle stamps the threshold it actually used into ``report.regression``
# (``regression["threshold"]``), and :func:`_regression_failure` reads it
# from there. Do NOT re-declare a threshold here (the old
# ``PERF_REGRESSION_THRESHOLD`` constant was an unused duplicate that
# violated the single-source-of-truth rule).


# --------------------------------------------------------------------------- #
# IterationContext
# --------------------------------------------------------------------------- #


@dataclass
class IterationContext:
    failure: Optional[str] = None
    last_perf: Optional[Dict[str, float]] = None
    best_perf: Optional[Dict[str, float]] = None
    this_iter_perf: Optional[Dict[str, float]] = None
    last_outcome: Optional[P.Outcome] = None
    review_feedback: Optional[str] = None
    perf_plan: Optional[str] = None
    phase_attempts: Dict[str, int] = field(default_factory=dict)
    b_session_id: Optional[str] = None
    # P2 (AHE decision observability): free-text verdict of the most recent
    # ``change_evaluation.json`` (confirmed/falsified/inconclusive per
    # prediction). Set by ``_evaluate_predictions`` after E; consumed by F and
    # the next iteration's A_plan. Advisory only — never drives the state
    # machine. See ``docs/opt_kernel_ahe.md`` §4.
    prediction_verdict: Optional[str] = None


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #


@dataclass
class AgentDebuggerConfig:
    """Config for the Agent Debugger advisory step (P1, AHE experience obs.).

    See ``docs/opt_kernel_ahe.md`` §5. The debugger runs after each iteration
    closes (advisory — never changes the phase outcome) and writes a two-layer
    evidence corpus under ``<iterations_root>/analysis/``:
    ``detail/iter_NNN.md`` (per-iteration root-cause) + ``overview.md``
    (cross-iteration summary). The next A_plan consumes ``overview.md`` as
    prompt text (read by the orchestrator, not the planner agent).
    """
    enabled: bool = True
    interval: int = 1            # run every N iterations (0 = disabled)
    detail_timeout_s: int = 900
    llm_model: Optional[str] = None   # None = use the orchestrator's main model
    overview_cap_chars: int = 4096    # cap injected into the planner prompt


@dataclass
class OrchestratorConfig:
    workdir: Path
    repo_root: Path
    notebooks_dir: Path
    iterations_root: Path
    state_dir: Path
    logs_root: Optional[Path] = None
    max_iterations: int = 20
    plan_timeout_s: int = 1800
    impl_timeout_s: int = 3600
    review_timeout_s: int = 1800
    optimize_timeout_s: int = 3600
    stuck_timeout_s: int = 600
    retro_timeout_s: int = 600
    max_c_retries: int = 3
    claude_bin: str = "ccb"
    model: Optional[str] = None
    permission_mode: str = "bypassPermissions"
    extra_claude_args: List[str] = field(default_factory=list)
    primary_perf_metric: Optional[str] = "tokens_per_sec"
    # e2e model-level oracle: run a real sglang serve + bench_serving every
    # ``e2e_interval`` iterations (0 = disabled). Advisory-only: it writes
    # e2e_report.json + a timeline event but never alters the phase state
    # machine. See ``oracles/e2e.py``.
    e2e_interval: int = 0
    e2e_baseline_cache: Optional[Path] = None
    # P1 (AHE experience observability): Agent Debugger advisory step. Writes
    # a two-layer evidence corpus (detail + overview) under
    # ``<iterations_root>/analysis/``; the next planner consumes the overview
    # as prompt text. See ``docs/opt_kernel_ahe.md`` §5.
    agent_debugger: AgentDebuggerConfig = field(default_factory=AgentDebuggerConfig)


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #


class Orchestrator:
    def __init__(
        self,
        req: Dict[str, Any],
        store: StateStore,
        cfg: OrchestratorConfig,
        manager: Optional[SubAgentManager] = None,
    ) -> None:
        self.req = req
        self.store = store
        self.cfg = cfg
        self.manager = manager or SubAgentManager(
            claude_bin=cfg.claude_bin,
            default_model=cfg.model,
            permission_mode=cfg.permission_mode,
            extra_add_dirs=[
                cfg.notebooks_dir,
                *([cfg.logs_root] if cfg.logs_root else []),
            ],
        )
        self.workspace = IterationWorkspace(cfg.iterations_root, logs_root=cfg.logs_root)
        self._stop = False
        self.nooped = False

    def _logs_dir_for(self, n: int) -> Path:
        return self.workspace.logs_dir_for(n)

    # ------------------------------------------------------------------ #
    # Public entry
    # ------------------------------------------------------------------ #

    def run(self) -> None:
        task_id = self.req.get("task_id", "task")
        _, is_resume = self.store.init_or_resume(task_id=task_id)

        resume_from: Optional[Dict[str, Any]] = None
        if is_resume:
            rs = self.store.load_run()
            if rs.finished:
                self.store.append_timeline(
                    "orchestrator_restart",
                    {"prior_final_status": rs.final_status, "prior_phase": rs.current_phase},
                )
                self.store.update_run(finished=False, final_status=None,
                                      current_phase="idle", last_outcome=None,
                                      last_transition_label=None)
            self.store.append_timeline("orchestrator_resume", {"task_id": task_id})
            resume_from = self._prepare_resume()
        else:
            self.store.append_timeline("orchestrator_start", {"task_id": task_id})

        try:
            self._loop(resume_from=resume_from)
        except KeyboardInterrupt:
            self.store.append_timeline("orchestrator_abort", {"reason": "keyboard-interrupt"})
            self.store.update_run(finished=True, final_status="aborted", current_phase="finished")
        finally:
            self.manager.shutdown()
            self.store.append_timeline("orchestrator_end", {"task_id": task_id})

    def _prepare_resume(self) -> Dict[str, Any]:
        discarded = self.workspace.discard_latest_incomplete()
        if discarded is not None:
            old_rec_data = self.store.load_iteration(discarded)
            old_rec = IterationRecord.from_dict(old_rec_data) if old_rec_data else None
            interrupted_in = None
            if old_rec is not None and old_rec.phases:
                interrupted_in = max(old_rec.phases.keys(),
                                     key=lambda k: old_rec.phases[k].get("started_at", 0))
            reason = (f"user interrupted mid-{interrupted_in}" if interrupted_in
                      else "user interrupted (orchestrator process exited unexpectedly)")
            self.store.archive_interrupted_iteration(discarded, reason=reason)
            self.store.append_timeline("iteration_interrupted",
                                       {"iteration": discarded, "reason": reason})
            start_phase = (old_rec.start_phase if old_rec else "A_plan") or "A_plan"
            carried_failure = None
            prev_rec_data = self.store.load_iteration(discarded - 1) if discarded > 1 else None
            prev_rec = IterationRecord.from_dict(prev_rec_data) if prev_rec_data else None
            last_outcome = prev_rec.outcome if prev_rec else None
            if prev_rec and start_phase == "B_implement" and prev_rec.outcome != P.OK:
                carried_failure = prev_rec.failure_reason
        else:
            last_complete = self.workspace.latest_complete_number()
            prev_rec_data = self.store.load_iteration(last_complete) if last_complete else None
            prev_rec = IterationRecord.from_dict(prev_rec_data) if prev_rec_data else None
            discarded = last_complete + 1
            start_phase = self._phase_after(prev_rec)
            carried_failure = None
            if prev_rec and start_phase == "B_implement" and prev_rec.outcome != P.OK:
                carried_failure = prev_rec.failure_reason
            last_outcome = prev_rec.outcome if prev_rec else None

        return {
            "iter_num": discarded,
            "start_phase": start_phase,
            "carried_failure": carried_failure,
            "last_outcome": last_outcome,
            # Restore the carry-perf state so PERF_REGRESSION can still fire
            # after a restart. ``ctx.last_perf`` normally persists across
            # iterations (set by the E→F transition's carry_perf), but a
            # resume rebuilds ``ctx`` empty — without this, the first E after
            # a restart always sees ``prev_perf=None`` and the perf oracle
            # reports "no previous baseline", silently disabling regression
            # gating on every resumed run (the common case for long opt-kernel
            # tasks). ``prev_rec`` is the last *complete* iteration, whose
            # ``.perf`` is exactly the baseline the next E should compare to.
            "last_perf": (dict(prev_rec.perf) if prev_rec and prev_rec.perf else None),
        }

    @staticmethod
    def _phase_after(rec: Optional[IterationRecord]) -> P.Phase:
        if rec is None:
            return "A_plan"
        if rec.outcome == P.OK:
            return "A_plan"
        return "B_implement"

    def stop(self) -> None:
        self._stop = True

    # ------------------------------------------------------------------ #
    # Main loop
    # ------------------------------------------------------------------ #

    def _loop(self, resume_from: Optional[Dict[str, Any]] = None) -> None:
        max_iters = self._resolve_max_iterations()
        ctx = IterationContext()

        if resume_from is not None:
            phase: P.Phase = resume_from["start_phase"]
            iter_num = resume_from["iter_num"] - 1
            ctx.failure = resume_from.get("carried_failure")
            ctx.last_outcome = resume_from.get("last_outcome")
            ctx.last_perf = resume_from.get("last_perf")
        else:
            phase = "A_plan"
            iter_num = 0

        iter_dir: Optional[Path] = None
        iter_rec: Optional[IterationRecord] = None
        final_status: Optional[str] = None

        while not self._stop and not P.is_terminal(phase):
            if iter_dir is None:
                if iter_num >= max_iters:
                    final_status = "success" if ctx.last_outcome == P.OK else "stopped"
                    phase = "finished"
                    break
                iter_num += 1
                iter_dir = self.workspace.open_iteration(iter_num)
                iter_rec = IterationRecord(
                    iteration=iter_num, started_at=time.time(), start_phase=phase,
                )
                self.store.write_iteration(iter_rec.iteration, iter_rec.to_dict())
                ctx.b_session_id = None
                ctx.this_iter_perf = None
                self.store.update_run(current_iteration=iter_num, current_phase=phase,
                                      last_outcome=ctx.last_outcome)
                self.store.append_timeline("iteration_start",
                                           {"iteration": iter_num, "start_phase": phase})
                ctx.phase_attempts.clear()

            assert iter_rec is not None
            self._set_phase(iter_num, iter_dir, phase)
            outcome, perf, failure = self._run_phase(phase, iter_num, iter_dir, iter_rec, ctx)

            ctx.last_outcome = outcome
            ctx.phase_attempts[phase] = ctx.phase_attempts.get(phase, 0) + 1

            phase_rec = iter_rec.phases.setdefault(phase, {})
            phase_rec["outcome"] = outcome
            phase_rec["attempts"] = ctx.phase_attempts[phase]
            phase_rec["ended_at"] = time.time()
            if failure:
                phase_rec["failure"] = failure
            if perf:
                phase_rec["perf"] = perf

            # Escalation: too many attempts → close iteration, start fresh at A
            if outcome != P.OK and ctx.phase_attempts[phase] >= MAX_PHASE_ATTEMPTS:
                forced_failure = failure or f"{phase} exceeded {MAX_PHASE_ATTEMPTS} attempts"
                self._close_iteration(iter_rec, status="failed", failure=forced_failure,
                                      perf=ctx.this_iter_perf, outcome=outcome)
                ctx.failure = forced_failure
                ctx.last_outcome = outcome
                iter_dir = None
                iter_rec = None
                phase = "A_plan"
                continue

            t = P.next_transition(phase, outcome)
            if t is None:
                err = f"no transition for ({phase}, {outcome})"
                self._close_iteration(iter_rec, status="failed", failure=err,
                                      perf=ctx.this_iter_perf, outcome=outcome)
                ctx.failure = err
                ctx.last_outcome = outcome
                iter_dir = None
                iter_rec = None
                phase = "A_plan"
                continue

            if t.carry_failure:
                ctx.failure = failure
            elif outcome == P.OK:
                ctx.failure = None

            if perf:
                if t.carry_perf:
                    ctx.last_perf = perf
                ctx.best_perf = _merge_best(ctx.best_perf, perf)
                ctx.this_iter_perf = perf

            self.store.append_timeline("transition", {
                "from": phase, "outcome": outcome, "to": t.to_phase,
                "label": t.label, "iteration": iter_num,
                "consume_iteration": t.consume_iteration,
            })
            self.store.update_run(current_phase=t.to_phase, last_outcome=outcome,
                                  last_transition_label=t.label, current_iteration=iter_num)

            if t.consume_iteration:
                iter_status = "success" if outcome == P.OK else "failed"
                self._close_iteration(iter_rec, status=iter_status,
                                      failure=(failure if outcome != P.OK else None),
                                      perf=ctx.this_iter_perf, outcome=outcome)
                iter_dir = None
                iter_rec = None

            phase = t.to_phase

        if final_status is None:
            final_status = "success" if ctx.last_outcome == P.OK else "stopped"
        self.store.update_run(finished=True, final_status=final_status,
                              current_phase="finished", last_outcome=ctx.last_outcome)
        # Cross-task lessons wiki (AHE experience accumulation): distill this
        # task's debugger-written ``analysis/lessons.jsonl`` snapshot into the
        # node-level wiki so future tasks of the same type can read it. The
        # per-task snapshot is a historical record; the node wiki is the only
        # authority read back. Advisory: never blocks the finish path.
        self._append_lessons_to_wiki(final_status)
        # Self-evolving wiki (KDA kernel-wiki tenet): compact the node wiki
        # (dedup + recency cap) so it stays lean and correct over time. Runs
        # after the append so this task's lessons are subject to compaction
        # too. Advisory.
        self._maintain_wiki()
        # Kernel zoo (KDA): promote this task's best kernel into the node zoo
        # so future tasks of the same kind can reuse it as a scaffold. The
        # zoo is a self-contained compacted authority (source inlined, capped).
        # Advisory: never blocks the finish path.
        self._promote_kernel_to_zoo(final_status)

    def _append_lessons_to_wiki(self, final_status: str) -> None:
        """Append this task's lessons snapshot to the node-level wiki (advisory)."""
        try:
            from metainfer.orchestrator.requirements import req_field
            task_id = self.req.get("task_id", "task")
            task_type = req_field(self.req, "task_type", "opt-kernel")
            n = lessons.append_task_lessons(
                self.cfg.state_dir, self._analysis_dir, task_id, task_type,
            )
            if n:
                self.store.append_timeline("lessons_wiki_append", {
                    "task_id": task_id, "task_type": task_type,
                    "n_lessons": n, "final_status": final_status,
                })
        except Exception as exc:  # noqa: BLE001 — advisory: never block finish
            self.store.append_timeline("lessons_wiki_error", {"error": repr(exc)})

    def _maintain_wiki(self) -> None:
        """Compact the node lessons wiki (dedup + recency cap), advisory."""
        try:
            remaining = lessons.maintain_wiki(self.cfg.state_dir)
            if remaining:
                self.store.append_timeline("lessons_wiki_maintain", {
                    "remaining": remaining,
                })
        except Exception as exc:  # noqa: BLE001 — advisory: never block finish
            self.store.append_timeline("lessons_wiki_maintain_error", {"error": repr(exc)})

    def _promote_kernel_to_zoo(self, final_status: str) -> None:
        """Promote this task's best kernel into the node kernel zoo (advisory)."""
        try:
            from metainfer.orchestrator.requirements import req_field
            task_id = self.req.get("task_id", "task")
            task_type = req_field(self.req, "task_type", "opt-kernel")
            entry = kernel_zoo.promote_best(
                self.cfg.state_dir, self.workspace, self.store,
                task_id, task_type, self.req,
            )
            if entry:
                self.store.append_timeline("kernel_zoo_promote", {
                    "task_id": task_id, "task_type": task_type,
                    "iter": entry.get("note", ""),
                    "primary": entry.get("primary"), "final_status": final_status,
                })
        except Exception as exc:  # noqa: BLE001 — advisory: never block finish
            self.store.append_timeline("kernel_zoo_promote_error", {"error": repr(exc)})

    # ------------------------------------------------------------------ #
    # Phase dispatcher
    # ------------------------------------------------------------------ #

    def _run_phase(
        self, phase: P.Phase, iter_num: int, iter_dir: Path,
        rec: IterationRecord, ctx: IterationContext,
    ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        if phase == "A_plan":
            return self._do_plan(iter_num, iter_dir, ctx)
        if phase == "B_implement":
            return self._do_implement(iter_num, iter_dir, ctx)
        if phase == "C_test":
            return self._do_test(iter_num, iter_dir, ctx)
        if phase == "D_review":
            return self._do_review(iter_num, iter_dir, ctx)
        if phase == "E_perf_test":
            return self._do_perf_test(iter_num, iter_dir, ctx, rec)
        if phase == "F_perf_plan":
            return self._do_perf_plan(iter_num, iter_dir, ctx)
        raise ValueError(f"no handler for phase {phase!r}")

    # ---- A: plan --------------------------------------------------------- #

    def _do_plan(self, n: int, iter_dir: Path, ctx: IterationContext,
                 ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        # Operator feedback is persistent guidance: read ALL submitted
        # opinions and inject into the planner prompt every iteration
        # ("持久指导" design). Read-only, so it never races the WebUI appends.
        user_feedback = feedback.feedback_text_for_prompt(self.cfg.state_dir)
        if user_feedback:
            self.store.append_timeline(
                "user_feedback_injected",
                {"iteration": n, "n_entries": len(feedback.read_feedback(self.cfg.state_dir))},
            )
        # Search mode (flame-chase-style rewrite↔fine-tune). Advisory only —
        # nudges the planner prompt, never the state machine. Computed
        # statelessly from stored iteration records so a restart recomputes
        # the same plateau signal. See ``_resolve_search_mode`` / ``_resolve_flow_mode``.
        from metainfer.orchestrator.requirements import req_field
        task_type = req_field(self.req, "task_type", "opt-kernel")
        flow = req_field(self.req, "flow", "flame_chase")
        iters_since_best = _count_iters_since_best(self.store, self.workspace)
        search_mode = _resolve_flow_mode(flow, n, iters_since_best)
        self.store.append_timeline("search_mode", {
            "iteration": n, "mode": search_mode, "iters_since_best": iters_since_best,
            "flow": flow,
        })
        # Cross-task lessons wiki (AHE experience accumulation): read the
        # node-level wiki for prior tasks of this type and inject a lessons
        # section into the planner prompt so the agent reuses known failure
        # modes / do-not-repeat lists instead of rediscovering them. Advisory:
        # missing wiki → no section (lessons_prompt_block returns None).
        wiki_lessons = lessons.read_wiki_lessons(self.cfg.state_dir, task_type)
        cross_task_lessons = lessons.lessons_prompt_block(wiki_lessons)
        if cross_task_lessons:
            self.store.append_timeline("lessons_wiki_read", {
                "iteration": n, "n_lessons": len(wiki_lessons),
            })
        # Kernel zoo (KDA): reusable kernels from prior finished tasks of the
        # same kind. The planner gets matching proven kernels as scaffolds / a
        # starting point so it does not start every task from a blank page.
        # Advisory: missing zoo → no section (zoo_prompt_block returns None).
        zoo_entries = kernel_zoo.read_zoo(
            self.cfg.state_dir, task_type,
            operator=req_field(self.req, "operator", None),
            hardware=req_field(self.req, "target_hardware", None),
            language=req_field(self.req, "kernel_language", None),
        )
        kernel_zoo_block = kernel_zoo.zoo_prompt_block(zoo_entries)
        if kernel_zoo_block:
            self.store.append_timeline("kernel_zoo_read", {
                "iteration": n, "n_entries": len(zoo_entries),
            })
        ok, err, mode, _sid = self._run_agent(
            name=f"iter{n}-planner", role="planner", iteration=n, iter_dir=iter_dir,
            prompt=plan_prompt(
                req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                iteration=n, prev_failures=ctx.failure,
                review_feedback=ctx.review_feedback, perf_plan=ctx.perf_plan,
                logs_dir=self._logs_dir_for(n), user_feedback=user_feedback,
                prediction_verdict=ctx.prediction_verdict,
                debugger_overview=self._read_debugger_overview(),
                search_mode=search_mode,
                cross_task_lessons=cross_task_lessons,
                flow=flow,
                kernel_zoo_block=kernel_zoo_block,
            ),
            timeout=self.cfg.plan_timeout_s,
        )
        return (P.OK, None, None) if ok else (_failure_outcome(mode), None, err)

    # ---- B: implement --------------------------------------------------- #

    def _do_implement(self, n: int, iter_dir: Path, ctx: IterationContext,
                      ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        is_redo = ctx.b_session_id is not None
        if is_redo:
            prompt = implement_redo_prompt(
                req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                iteration=n, prev_failure=ctx.failure, logs_dir=self._logs_dir_for(n),
            )
        else:
            prompt = implement_prompt(
                req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                iteration=n, prev_failure=ctx.failure,
                review_feedback=ctx.review_feedback, perf_plan=ctx.perf_plan,
                logs_dir=self._logs_dir_for(n),
            )
        ok, err, mode, sid = self._run_agent(
            name=f"iter{n}-implementer", role="implementer", iteration=n, iter_dir=iter_dir,
            prompt=prompt, timeout=self.cfg.impl_timeout_s,
            resume_session_id=ctx.b_session_id,
        )
        if sid:
            ctx.b_session_id = sid
        if not ok:
            return _failure_outcome(mode), None, f"B (implement) failed: {err}"
        ctx.b_session_id = None
        return P.OK, None, None

    # ---- C: test -------------------------------------------------------- #
    # Uses agent-written test.sh. No immutable oracle.

    def _do_test(self, n: int, iter_dir: Path, ctx: IterationContext,
                 ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        test_sh = iter_dir / "test.sh"
        if not test_sh.exists():
            ok, err, mode, _sid = self._run_agent(
                name=f"iter{n}-testwriter", role="testwriter", iteration=n, iter_dir=iter_dir,
                prompt=write_test_harness_prompt(
                    req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                    iteration=n,
                ),
                timeout=self.cfg.review_timeout_s,
            )
            if not ok or not test_sh.exists():
                return _failure_outcome(mode), None, f"C (test harness) missing: {err}"

        max_attempts = max(1, int(self.cfg.max_c_retries))
        last_outcome: Optional[P.Outcome] = None
        last_perf: Optional[Dict[str, float]] = None
        last_failure: Optional[str] = None
        c_session_id: Optional[str] = None

        for attempt in range(1, max_attempts + 1):
            self.store.append_timeline("c_test_attempt", {
                "iteration": n, "attempt": attempt, "max": max_attempts,
                "mode": "test.sh",
            })
            success, perf, failure = self._run_test(test_sh, iter_dir, n)
            if success:
                # Immutable correctness oracle (referee). test.sh is
                # agent-written (contestant); this oracle is orchestrator-
                # owned and checks the kernel against a fixed PyTorch
                # reference on edge-case shapes the agent's test.sh may not
                # cover (odd M, K tails, K=1, small N). A failure here is
                # treated as a normal C logic failure so the existing
                # debugger-retry loop tries to fix the kernel.
                c_ok, c_failure = self._run_correctness_oracle(iter_dir, n)
                if not c_ok:
                    success = False
                    failure = c_failure
            if success:
                ctx.last_perf = perf
                return P.OK, perf, None
            outcome = P.LOGIC_FAIL
            if failure and _looks_like_infra(failure):
                outcome = P.INFRA_FAIL
                self.store.append_timeline("c_test_infra_fail", {
                    "iteration": n, "attempt": attempt, "error": failure,
                })
                return outcome, perf, failure
            last_outcome, last_perf, last_failure = outcome, perf, failure

            if attempt >= max_attempts:
                break

            # Dispatch debugger
            dbg_name = f"iter{n}-c-debugger.attempt{attempt}"
            if c_session_id is None:
                prompt = c_repair_prompt(
                    req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                    iteration=n, attempt=attempt, max_attempts=max_attempts,
                    failure=failure, logs_dir=self._logs_dir_for(n),
                )
            else:
                prompt = c_repair_followup_prompt(
                    iteration=n, attempt=attempt, max_attempts=max_attempts,
                    new_failure=failure, logs_dir=self._logs_dir_for(n),
                )
            ok, err, mode, sid = self._run_agent(
                name=dbg_name, role="c_debugger", iteration=n, iter_dir=iter_dir,
                prompt=prompt, timeout=self.cfg.impl_timeout_s,
                resume_session_id=c_session_id,
            )
            if sid:
                c_session_id = sid

        return last_outcome or P.LOGIC_FAIL, last_perf, last_failure

    # ---- D: review ------------------------------------------------------ #

    def _do_review(self, n: int, iter_dir: Path, ctx: IterationContext,
                   ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        c_outcome = ctx.last_outcome
        c_failure = ctx.failure
        c_perf = ctx.last_perf
        logs_dir = self._logs_dir_for(n)

        # Dual parallel reviewers: A=correctness, B=performance.
        # Each writes review-A.md / review-B.md; we merge into review.md.
        self.store.append_timeline("review_start", {
            "iteration": n, "mode": "dual-parallel",
        })
        threads = []
        for suffix, prompt_fn in (
            ("A", review_prompt_a),
            ("B", review_prompt_b),
        ):
            spec = self._make_reviewer_spec(
                name=f"iter{n}-reviewer-{suffix}",
                role="reviewer",
                iteration=n,
                iter_dir=iter_dir,
                logs_dir=logs_dir,
                prompt=prompt_fn(
                    req=self.req, iter_dir=iter_dir,
                    notebooks_dir=self.cfg.notebooks_dir,
                    iteration=n, outcome=c_outcome, failure=c_failure, perf=c_perf,
                    logs_dir=logs_dir,
                ),
            )
            t = self.manager.launch_async(spec)
            threads.append((suffix, t))

        # Wait for both reviewers to finish
        for _suffix, t in threads:
            t.join()

        # Collect results
        results: Dict[str, Optional[Any]] = {}
        for suffix, _t in threads:
            name = f"iter{n}-reviewer-{suffix}"
            results[suffix] = self.manager.result(name)

        # Merge the two reviews into review.md
        feedback = self._merge_reviews(n, logs_dir)
        ctx.review_feedback = feedback
        self.store.append_timeline("review_done", {
            "iteration": n, "c_outcome": c_outcome,
            "mode": "dual-parallel",
            "feedback_captured": feedback is not None,
            "reviewer_a_ok": results.get("A") is not None and results["A"].success,
            "reviewer_b_ok": results.get("B") is not None and results["B"].success,
        })
        if c_outcome == P.OK:
            return P.OK, None, None
        return P.LOGIC_FAIL, None, None

    def _make_reviewer_spec(self, name: str, role: str, iteration: int,
                            iter_dir: Path, logs_dir: Path, prompt: str) -> AgentSpec:
        """Build an AgentSpec for a reviewer sub-agent."""
        logs_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = logs_dir / f"{name}.prompt.txt"
        prompt_file.write_text(prompt, encoding="utf-8")
        return AgentSpec(
            name=name, role=role, prompt_file=prompt_file, workdir=iter_dir,
            log_dir=logs_dir, timeout_s=self.cfg.review_timeout_s,
            stuck_timeout_s=self.cfg.stuck_timeout_s,
            extra_args=list(self.cfg.extra_claude_args),
        )

    def _merge_reviews(self, n: int, logs_dir: Path) -> Optional[str]:
        """Merge review-A.md and review-B.md into a single review.md.

        Returns the merged text (truncated) for the next iteration's
        review_feedback context.
        """
        parts: List[str] = []
        for label, fname in (("A (Correctness)", "review-A.md"),
                             ("B (Performance)", "review-B.md")):
            path = logs_dir / fname
            if path.is_file():
                try:
                    text = path.read_text(encoding="utf-8", errors="replace").strip()
                    if text:
                        parts.append(f"## Reviewer {label}\n\n{text}")
                except OSError:
                    pass
        merged = "\n\n---\n\n".join(parts) if parts else ""
        if not merged:
            return None
        review_path = logs_dir / "review.md"
        try:
            review_path.write_text(merged, encoding="utf-8")
        except OSError:
            pass
        return merged[:8192] if len(merged) > 8192 else merged

    # ---- E: perf test --------------------------------------------------- #

    def _do_perf_test(self, n: int, iter_dir: Path, ctx: IterationContext, rec: IterationRecord,
                      ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        # Use the immutable perf oracle instead of an agent-written perf.sh.
        # The oracle owns the benchmark (fixed shapes, warmup, CUDA Graph
        # timing, lmslim baseline, rocprof capture) so iter(N) vs iter(N-1)
        # comparisons are meaningful.
        #
        # iter #17 P0a: reload the ``oracles.perf`` module from disk on EVERY
        # E-phase. The long-running orchestrator caches the first-imported
        # module in ``sys.modules``; without this reload, any edit to
        # ``perf.py`` made mid-run (as iters #14/#15/#16 did) is silently
        # ignored -- the cached iteration-1 module keeps executing and
        # ``perf_report.json`` reflects the OLD code (the 17-iteration
        # ``speedup=0.0`` blindness root cause). Reloading guarantees the
        # E-phase uses the latest on-disk ``perf.py`` (and its
        # ``PERF_ORACLE_VERSION`` stamp). ``oracles.perf`` is a stateless
        # module (dataclasses + ``KernelPerfOracle``), so reload is safe; a
        # reload failure degrades to the cached module rather than crashing
        # the E-phase.
        import importlib
        from .oracles import perf as _perf_mod
        try:
            importlib.reload(_perf_mod)
        except Exception:  # noqa: BLE001 -- never crash the E-phase on reload
            pass
        from .oracles.perf import KernelPerfOracle

        logs_dir = self._logs_dir_for(n)
        logs_dir.mkdir(parents=True, exist_ok=True)
        prev_perf = dict(ctx.last_perf) if ctx.last_perf else None

        oracle = KernelPerfOracle()
        try:
            report = oracle.run(
                iter_dir=iter_dir,
                req=self.req,
                report_dir=logs_dir,
                iteration=n,
                prev_perf=prev_perf,
                timeout_s=self.cfg.optimize_timeout_s,
            )
        except Exception as e:  # noqa: BLE001 — oracle crash shouldn't kill the run
            err = f"perf oracle crashed: {e!r}"
            self._write_retrospective(
                n=n, iter_dir=iter_dir, ctx=ctx, rec=rec,
                this_perf=None, e_ok=False, e_error=err,
            )
            return P.INFRA_FAIL, None, f"E (perf oracle) crashed: {err}"

        perf = self._read_perf_report(n, iter_dir)
        e_ok = bool(perf) and (perf.get("speedup", 0) > 0 or perf.get("ms_per_op", 0) > 0)
        e_error = None if e_ok else (report.notes or "perf oracle produced no usable data")

        self._write_retrospective(n=n, iter_dir=iter_dir, ctx=ctx, rec=rec,
                                  this_perf=perf, e_ok=e_ok, e_error=e_error)
        if not e_ok:
            return P.INFRA_FAIL, perf, f"E (perf oracle): {e_error}"

        # P2 (AHE decision observability): advisory falsifiable-prediction
        # evaluation. Compares the planner's ``predictions.json`` (written in
        # A_plan) against the actual perf delta vs the previous iteration's
        # authoritative baseline (``IterationRecord.perf``), writes
        # ``change_evaluation.json`` + a timeline event, and feeds a verdict
        # digest into ``ctx.prediction_verdict`` for F and the next A_plan.
        # Advisory only: never changes the outcome/transition; any failure
        # degrades to a timeline log (mirrors ``_maybe_run_e2e_oracle``).
        # See ``docs/opt_kernel_ahe.md`` §4.
        self._evaluate_predictions(n, iter_dir, perf, report.regression, ctx)

        # Perf regression: the oracle already populated ``report.regression``
        # (single source of truth — computed in ``oracles/perf.py``
        # ``_check_regression`` from prev_perf vs the current primary metric).
        # If it fired, emit PERF_REGRESSION so the transition table routes
        # back to B_implement to re-do the implementation and undo the
        # regression (see ``phases.TRANSITIONS``). We do NOT re-compute the
        # threshold here — we read it straight off the oracle's dict.
        reg_failure = _regression_failure(report.regression)
        if reg_failure is not None:
            self.store.append_timeline("perf_regression", {
                "iteration": n, "regression": report.regression,
            })
            return P.PERF_REGRESSION, perf, reg_failure

        # Advisory e2e model-level oracle: every ``e2e_interval`` iterations,
        # run the agent kernel inside a real sglang serve and compare TTFT /
        # TPOT / output throughput / capture cost against the cached stock-
        # lmslim baseline. Advisory-only — it NEVER changes the outcome; it
        # just writes ``e2e_report.json`` + a timeline event so the per-shape
        # bench blind spots (prefill amortisation, capture cost) become
        # visible. Oracle crash degrades to a timeline log, never blocks.
        self._maybe_run_e2e_oracle(n, iter_dir, perf)
        return P.OK, perf, None

    def _write_retrospective(self, n: int, iter_dir: Path, ctx: IterationContext,
                             rec: IterationRecord, *, this_perf: Optional[Dict[str, float]],
                             e_ok: bool, e_error: Optional[str]) -> None:
        prev_rec_data = self.store.load_iteration(n - 1) if n > 1 else None
        prev_rec = IterationRecord.from_dict(prev_rec_data) if prev_rec_data else None
        prev_perf = dict(prev_rec.perf) if prev_rec and prev_rec.perf else None
        goal: Optional[str] = rec.failure_reason or rec.goal or None
        logs_dir = self._logs_dir_for(n)
        try:
            self._run_agent(
                name=f"iter{n}-retro", role="retro_writer", iteration=n, iter_dir=iter_dir,
                prompt=retrospective_prompt(
                    req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                    iteration=n, this_perf=this_perf, prev_perf=prev_perf,
                    review_feedback=ctx.review_feedback, e_ok=e_ok, e_error=e_error,
                    logs_dir=logs_dir, goal=goal,
                ),
                timeout=self.cfg.retro_timeout_s,
            )
        except Exception:
            pass
        retro_path = logs_dir / "retrospective.md"
        if retro_path.is_file():
            rec.retrospective_path = str(retro_path)
            self.store.write_iteration(rec.iteration, rec.to_dict())

    # ---- F: perf plan --------------------------------------------------- #

    def _do_perf_plan(self, n: int, iter_dir: Path, ctx: IterationContext,
                      ) -> Tuple[P.Outcome, Optional[Dict[str, float]], Optional[str]]:
        ok, err, mode, _sid = self._run_agent(
            name=f"iter{n}-perf-planner", role="perf_planner", iteration=n, iter_dir=iter_dir,
            prompt=perf_plan_prompt(
                req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                iteration=n, last_perf=ctx.last_perf or ctx.best_perf,
                review_feedback=ctx.review_feedback, logs_dir=self._logs_dir_for(n),
                prediction_verdict=ctx.prediction_verdict,
                profiler_hint=profiler_skill_text(self.cfg.repo_root),
            ),
            timeout=self.cfg.review_timeout_s,
        )
        plan_path = iter_dir / "perf_plan.md"
        plan_text: Optional[str] = None
        if plan_path.is_file():
            try:
                text = plan_path.read_text(encoding="utf-8", errors="replace")
                plan_text = text[:12288] if len(text) > 12288 else text
            except OSError:
                plan_text = None
        ctx.perf_plan = plan_text
        if ok:
            return P.OK, ctx.last_perf, None
        return _failure_outcome(mode), None, f"F (perf plan) failed: {err}"

    # ------------------------------------------------------------------ #
    # Agent runner
    # ------------------------------------------------------------------ #

    def _run_agent(self, name: str, role: str, iteration: int, iter_dir: Path,
                   prompt: str, timeout: int, *,
                   resume_session_id: Optional[str] = None,
                   session_id: Optional[str] = None,
                   ) -> Tuple[bool, Optional[str], Optional[str], Optional[str]]:
        logs_dir = self._logs_dir_for(iteration)
        logs_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = logs_dir / f"{name}.prompt.txt"
        prompt_file.write_text(prompt, encoding="utf-8")
        spec = AgentSpec(
            name=name, role=role, prompt_file=prompt_file, workdir=iter_dir,
            log_dir=logs_dir, timeout_s=timeout, stuck_timeout_s=self.cfg.stuck_timeout_s,
            extra_args=list(self.cfg.extra_claude_args), session_id=session_id,
            resume_session_id=resume_session_id,
        )
        self.store.append_timeline("agent_launch", {
            "name": name, "role": role, "iteration": iteration,
        })
        self.manager.launch(spec)
        result = self.manager.result(name)
        if result is None:
            return False, "no result recorded", "infra", None
        return result.success, result.error, result.failure_mode, result.session_id

    # ------------------------------------------------------------------ #
    # Bookkeeping
    # ------------------------------------------------------------------ #

    def _set_phase(self, n: int, iter_dir: Path, phase: P.Phase) -> None:
        self.store.update_run(current_iteration=n, current_phase=phase)
        self.store.append_timeline("phase_start", {"iteration": n, "phase": phase})

    def _close_iteration(self, rec: IterationRecord, *, status: str,
                         failure: Optional[str], perf: Optional[Dict[str, float]],
                         outcome: Optional[P.Outcome]) -> None:
        rec.ended_at = time.time()
        rec.duration_s = rec.ended_at - rec.started_at
        rec.status = status
        rec.failure_reason = failure
        rec.outcome = outcome
        if perf:
            rec.perf = perf
        if status == "failed" and not rec.retrospective_path:
            try:
                iter_dir = self.workspace.iter_dir(rec.iteration)
                self._write_failure_retrospective(rec.iteration, iter_dir, rec)
            except Exception:
                pass
        self.store.write_iteration(rec.iteration, rec.to_dict())
        self.workspace.mark_complete(rec.iteration)
        self.store.append_timeline("iteration_end", {
            "iteration": rec.iteration, "status": status, "outcome": outcome,
            "perf": perf, "failure_reason": failure, "duration_s": rec.duration_s,
        })
        # P1 (AHE experience observability): Agent Debugger advisory step.
        # Runs after the iteration record + retrospective are on disk so the
        # debugger can read the full trajectory. Advisory: never changes the
        # outcome; any failure degrades to a timeline log (mirrors the e2e
        # oracle). See ``docs/opt_kernel_ahe.md`` §5.
        self._maybe_run_debugger(rec)

    def _write_failure_retrospective(self, n: int, iter_dir: Path, rec: IterationRecord) -> None:
        failed_phase: Optional[str] = None
        phase_attempts: Optional[int] = None
        if rec.phases:
            for phase_id in ("A_plan", "B_implement", "C_test", "D_review", "E_perf_test", "F_perf_plan"):
                info = rec.phases.get(phase_id)
                if info and info.get("outcome") != P.OK:
                    failed_phase = phase_id
                    phase_attempts = info.get("attempts")
        logs_dir = self._logs_dir_for(n)
        goal: Optional[str] = rec.goal or rec.failure_reason or None
        try:
            self._run_agent(
                name=f"iter{n}-fail-retro", role="retro_writer", iteration=n, iter_dir=iter_dir,
                prompt=failure_retrospective_prompt(
                    req=self.req, iter_dir=iter_dir, notebooks_dir=self.cfg.notebooks_dir,
                    iteration=n, failure_reason=rec.failure_reason,
                    failed_phase=failed_phase, phase_attempts=phase_attempts,
                    logs_dir=logs_dir, goal=goal,
                ),
                timeout=self.cfg.retro_timeout_s,
            )
        except Exception:
            return
        retro_path = logs_dir / "retrospective.md"
        if retro_path.is_file():
            rec.retrospective_path = str(retro_path)

    # ------------------------------------------------------------------ #
    # Test runner
    # ------------------------------------------------------------------ #

    def _run_test(self, test_sh: Path, iter_dir: Path, iteration: int,
                  ) -> Tuple[bool, Optional[Dict[str, float]], Optional[str]]:
        log_path = self._logs_dir_for(iteration) / f"iter{iteration}-test.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["METAINFER_ITER_DIR"] = str(iter_dir)
        env["METAINFER_ITERATION"] = str(iteration)
        # Resolve to an absolute path: when iter_dir is relative and used as
        # cwd, bash would otherwise look up the (relative) script path under
        # the *new* cwd and fail with "No such file or directory".
        test_sh_abs = str(Path(test_sh).resolve())
        try:
            with open(log_path, "w", encoding="utf-8") as logf:
                proc = subprocess.run(
                    ["bash", test_sh_abs], cwd=str(iter_dir), env=env,
                    stdout=subprocess.PIPE, stderr=logf,
                    timeout=self.cfg.impl_timeout_s, text=True,
                )
        except subprocess.TimeoutExpired:
            return False, None, "test timed out"
        except Exception as exc:
            return False, None, f"test runner exception: {exc!r}"

        stdout = proc.stdout or ""
        parsed = self._parse_test_json(stdout)
        if parsed is None:
            return False, None, f"test did not emit parseable JSON. stdout tail: {stdout[-1000:]!r}"
        passed = bool(parsed.get("passed", False))
        perf = parsed.get("perf") if isinstance(parsed.get("perf"), dict) else {}
        perf = {k: float(v) for k, v in perf.items() if _is_num(v)}
        if passed:
            return True, perf, None
        err = parsed.get("error") or parsed.get("traceback") or "test failed"
        return False, perf, str(err)[:4000]

    def _run_correctness_oracle(
        self, iter_dir: Path, n: int,
    ) -> Tuple[bool, Optional[str]]:
        """Run the immutable correctness referee after the agent's test.sh passes.

        Returns ``(ok, failure_or_None)``. ``ok=False`` means the kernel is
        numerically wrong on at least one edge-case shape; the caller treats
        it as a C logic failure so the debugger-retry loop fixes the kernel.
        An oracle *crash* degrades to ``ok=True`` (pass-through) so a bug in
        new oracle code does not block iterations — it is logged on the
        timeline for diagnosis. This is a deliberate, gradual-rollout
        choice: the oracle is additive gating, not a hard dependency yet.
        """
        from .oracles.correctness import KernelCorrectnessOracle
        logs_dir = self._logs_dir_for(n)
        try:
            oracle = KernelCorrectnessOracle()
            report = oracle.run(
                iter_dir=iter_dir, req=self.req, report_dir=logs_dir, iteration=n,
            )
        except Exception as exc:  # noqa: BLE001 — never block C on an oracle bug
            self.store.append_timeline("c_correctness_oracle_error", {
                "iteration": n, "error": repr(exc),
            })
            return True, None
        self.store.append_timeline("c_correctness_oracle", {
            "iteration": n, "all_correct": report.all_correct,
            "n_total": report.n_total, "n_pass": report.n_pass, "n_fail": report.n_fail,
        })
        if report.all_correct:
            return True, None
        fails = report.failures[:3]
        detail = "; ".join(
            f"{f.get('shape')}: {f.get('error', '')}" for f in fails
        )
        return False, (
            f"C (correctness oracle): {report.n_fail}/{report.n_total} "
            f"shapes failed — {detail}"
        )

    def _evaluate_predictions(
        self, n: int, iter_dir: Path,
        this_perf: Optional[Dict[str, float]],
        regression: Optional[Dict[str, Any]],
        ctx: IterationContext,
    ) -> None:
        """Advisory falsifiable-prediction evaluation (P2, AHE decision obs.).

        Called from ``_do_perf_test`` once a usable perf exists. Reads the
        planner's ``iter_dir/predictions.json`` (historical claim), compares
        it against the actual perf delta vs the previous iteration's
        authoritative baseline (``IterationRecord.perf``), writes
        ``iter_dir/change_evaluation.json`` (derived snapshot), emits a
        ``prediction_evaluated`` timeline event, and stores a verdict digest
        on ``ctx.prediction_verdict`` for F and the next A_plan.

        Advisory / non-blocking: ``predictions.json`` is optional — if absent
        or unparseable this is a no-op (no timeline event). Any exception is
        caught and logged as ``prediction_eval_error`` so the run continues.
        Perf numbers remain authoritative in ``perf_report.json``; this only
        derives a planner-context snapshot. See ``docs/opt_kernel_ahe.md`` §4.
        """
        import json as _json
        from .predictions import evaluate_predictions

        pred_path = iter_dir / "predictions.json"
        if not pred_path.is_file():
            return  # planner wrote no predictions this round — nothing to falsify
        try:
            raw = _json.loads(pred_path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            self.store.append_timeline("prediction_eval_error", {
                "iteration": n, "error": "predictions.json unparseable",
            })
            return
        preds = raw.get("predictions") if isinstance(raw, dict) else None
        if not isinstance(preds, list) or not preds:
            return  # empty/missing predictions list — nothing to evaluate

        # Authoritative baseline = previous iteration's persisted perf dict
        # (IterationRecord.perf is a derived snapshot of perf_report.json).
        prev_rec_data = self.store.load_iteration(n - 1) if n > 1 else None
        prev_rec = IterationRecord.from_dict(prev_rec_data) if prev_rec_data else None
        baseline_perf = dict(prev_rec.perf) if prev_rec and prev_rec.perf else None

        try:
            eval_result = evaluate_predictions(
                predictions=preds,
                baseline_perf=baseline_perf,
                actual_perf=this_perf,
                regression=regression,
                iteration=n,
            )
        except Exception as exc:  # noqa: BLE001 — advisory: never block E
            self.store.append_timeline("prediction_eval_error", {
                "iteration": n, "error": repr(exc),
            })
            return

        try:
            (iter_dir / "change_evaluation.json").write_text(
                _json.dumps(eval_result, indent=2), encoding="utf-8")
        except OSError:
            pass  # writing the snapshot is best-effort; the verdict still flows

        verdict_text = eval_result.get("verdict_text")
        n_conf = sum(1 for p in eval_result.get("predictions", [])
                     if p.get("verdict") == "confirmed")
        n_fals = sum(1 for p in eval_result.get("predictions", [])
                     if p.get("verdict") == "falsified")
        self.store.append_timeline("prediction_evaluated", {
            "iteration": n,
            "n_predictions": len(eval_result.get("predictions", [])),
            "n_confirmed": n_conf,
            "n_falsified": n_fals,
            "summary": eval_result.get("summary"),
        })
        ctx.prediction_verdict = verdict_text

    # ---------------------------------------------------------------- #
    # P1: Agent Debugger (AHE experience observability)                #
    # ---------------------------------------------------------------- #

    @property
    def _analysis_dir(self) -> Path:
        """Two-layer evidence corpus root (detail/ + overview.md).

        Lives under the workspace ``iterations_root`` so the debugger agent
        (whose cwd is ``iterations_root``) can read every iteration dir and
        write here without needing ``state_dir`` access. The orchestrator
        reads ``overview.md`` back via Python to inject into the planner
        prompt — the planner agent itself never touches this dir.
        """
        return self.cfg.iterations_root / "analysis"

    def _read_debugger_overview(self) -> Optional[str]:
        """Read ``analysis/overview.md`` (capped) for the planner prompt, or None."""
        cap = self.cfg.agent_debugger.overview_cap_chars
        path = self._analysis_dir / "overview.md"
        if not path.is_file():
            return None
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        return text[:cap] if len(text) > cap else text

    def _maybe_run_debugger(self, rec: IterationRecord) -> None:
        """Advisory Agent Debugger step (P1, AHE experience observability).

        Runs after an iteration closes (from ``_close_iteration``). Distills
        the iteration's full trajectory into a two-layer, sourced evidence
        corpus: ``analysis/detail/iter_NNN.md`` (per-iteration root-cause) +
        ``analysis/overview.md`` (cross-iteration summary, rewritten each
        run). The next A_plan consumes ``overview.md`` as prompt text (read
        by the orchestrator, not the planner agent).

        Advisory / non-blocking: gated by ``cfg.agent_debugger.enabled`` /
        ``interval``; any exception is caught and logged as ``debugger_error``
        so the run continues (mirrors ``_maybe_run_e2e_oracle``). The
        debugger's cwd is ``iterations_root`` so it can read sibling iter
        dirs and write under ``analysis/``. Trajectory data (timeline +
        iteration records) is embedded into the prompt as text — the agent
        has no direct ``state_dir`` access. See ``docs/opt_kernel_ahe.md`` §5.
        """
        dbg = self.cfg.agent_debugger
        if not dbg.enabled or dbg.interval <= 0:
            return
        if rec.iteration % dbg.interval != 0:
            return

        iter_dir = self.workspace.iter_dir(rec.iteration)
        logs_dir = self._logs_dir_for(rec.iteration)
        analysis_dir = self._analysis_dir
        try:
            (analysis_dir / "detail").mkdir(parents=True, exist_ok=True)
        except OSError:
            return

        # Compact, pre-computed trajectory context (agent can't see state_dir).
        iteration_summary = self._debugger_iteration_summary(rec)
        timeline_excerpt = self._debugger_timeline_excerpt(rec.iteration)
        prior_detail_paths = self._debugger_prior_detail_paths(rec.iteration)
        prior_overview_exists = (analysis_dir / "overview.md").is_file()

        from .prompts import debugger_prompt
        prompt = debugger_prompt(
            req=self.req, iterations_root=self.cfg.iterations_root,
            iteration=rec.iteration, iter_dir=iter_dir, logs_dir=logs_dir,
            iteration_summary=iteration_summary, timeline_excerpt=timeline_excerpt,
            prior_overview_exists=prior_overview_exists,
            prior_detail_paths=prior_detail_paths,
        )
        try:
            ok, err, _mode, _sid = self._run_agent(
                name=f"iter{rec.iteration}-debugger", role="debugger",
                iteration=rec.iteration, iter_dir=self.cfg.iterations_root,
                prompt=prompt, timeout=dbg.detail_timeout_s,
            )
        except Exception as exc:  # noqa: BLE001 — advisory: never block on debugger
            self.store.append_timeline("debugger_error", {
                "iteration": rec.iteration, "error": repr(exc),
            })
            return
        if not ok:
            self.store.append_timeline("debugger_error", {
                "iteration": rec.iteration, "error": err or "debugger agent failed",
            })
            return
        self.store.append_timeline("agent_debugger", {
            "iteration": rec.iteration,
            "detail": f"analysis/detail/iter_{rec.iteration:03d}.md",
            "overview": "analysis/overview.md",
        })

    def _debugger_iteration_summary(self, rec: IterationRecord) -> str:
        """One-paragraph compact summary of the iteration for the debugger prompt."""
        perf = rec.perf or {}
        perf_str = ", ".join(f"{k}={v:.4g}" for k, v in perf.items()) if perf else "(none)"
        lines = [
            f"iteration: {rec.iteration}",
            f"status: {rec.status}",
            f"outcome: {rec.outcome}",
            f"failure_reason: {rec.failure_reason or '(none)'}",
            f"perf: {perf_str}",
            f"duration_s: {rec.duration_s:.1f}",
            f"phases: {', '.join(sorted(rec.phases.keys()))}",
        ]
        return "\n".join(lines)

    def _debugger_timeline_excerpt(self, iteration: int) -> str:
        """Compact timeline events for ONE iteration (type + key payload fields)."""
        path = self.store.timeline_path
        if not path.is_file():
            return "(no timeline)"
        lines = []
        try:
            for ln in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not ln.strip():
                    continue
                try:
                    import json as _json
                    ev = _json.loads(ln)
                except ValueError:
                    continue
                payload = ev.get("payload") or {}
                # keep only events tagged with this iteration
                if payload.get("iteration") != iteration:
                    continue
                t = ev.get("type", "")
                key = {k: payload[k] for k in ("phase", "outcome", "status",
                                              "regression", "summary", "error")
                       if k in payload}
                lines.append(f"- {t}: {key}" if key else f"- {t}")
        except OSError:
            return "(timeline unreadable)"
        return "\n".join(lines) if lines else "(no events for this iteration)"

    def _debugger_prior_detail_paths(self, iteration: int) -> List[str]:
        """Relative paths of prior detail files (for pattern-building), newest first."""
        detail_dir = self._analysis_dir / "detail"
        if not detail_dir.is_dir():
            return []
        paths = []
        for p in sorted(detail_dir.glob("iter_*.md"), reverse=True):
            paths.append(f"analysis/detail/{p.name}")
            if len(paths) >= 10:
                break
        return paths

    def _maybe_run_e2e_oracle(self, n: int, iter_dir: Path,
                              perf: Optional[Dict[str, float]]) -> None:
        """Advisory e2e model-level oracle hook (called after a passing E).

        Runs only when ``cfg.e2e_interval > 0`` and the iteration is a
        multiple of it. Advisory: writes ``e2e_report.json`` + a timeline
        event and returns ``None`` — it never influences the phase outcome.
        Any exception (missing sglang/lmslim/GPU, parse error, serve crash)
        is caught and logged on the timeline so the run continues; this is
        the same gradual-rollout posture as the correctness oracle.
        """
        interval = getattr(self.cfg, "e2e_interval", 0) or 0
        if interval <= 0 or n % interval != 0:
            return
        from .oracles.e2e import E2EOracle
        from .oracles._sglang_runner import SglangE2ERunner
        logs_dir = self._logs_dir_for(n)
        prev_e2e = self._load_prev_e2e(n)
        try:
            oracle = E2EOracle(
                runner=SglangE2ERunner(),
                baseline_cache_path=self.cfg.e2e_baseline_cache,
            )
            report = oracle.run(
                iter_dir=iter_dir, req=self.req, report_dir=logs_dir,
                iteration=n, prev_e2e=prev_e2e,
            )
        except Exception as exc:  # noqa: BLE001 — advisory: never block on e2e
            self.store.append_timeline("e2e_oracle_error", {
                "iteration": n, "error": repr(exc),
            })
            return
        self.store.append_timeline("e2e_oracle", {
            "iteration": n,
            "baseline_cached": report.baseline_cached,
            "comparison": report.comparison,
            "regression": report.regression,
            "notes": report.notes,
        })

    def _load_prev_e2e(self, n: int) -> Optional[Dict[str, Any]]:
        """Load the most recent prior e2e_report.json for trend comparison."""
        for k in range(n - 1, 0, -1):
            path = self._logs_dir_for(k) / "e2e_report.json"
            if path.is_file():
                try:
                    return json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    return None
        return None

    def _read_perf_report(self, n: int, iter_dir: Path) -> Optional[Dict[str, float]]:
        path = iter_dir / "perf_report.json"
        if not path.is_file():
            return None
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(obj, dict):
            return None
        return {k: float(v) for k, v in obj.items() if _is_num(v)}

    @staticmethod
    def _parse_test_json(stdout: str) -> Optional[Dict[str, Any]]:
        candidates: List[str] = []
        for ln in reversed(stdout.splitlines()):
            ln = ln.strip()
            if ln.startswith("{") and ln.endswith("}"):
                candidates.append(ln)
                if len(candidates) >= 5:
                    break
        for c in candidates:
            try:
                obj = json.loads(c)
                if isinstance(obj, dict) and "passed" in obj:
                    return obj
            except json.JSONDecodeError:
                continue
        return None

    def _resolve_max_iterations(self) -> int:
        from metainfer.orchestrator.requirements import req_field_int
        return req_field_int(self.req, "max_iterations", self.cfg.max_iterations)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _failure_outcome(mode: Optional[str]) -> P.Outcome:
    return P.INFRA_FAIL if mode == "infra" else P.LOGIC_FAIL


def _looks_like_infra(failure: str) -> bool:
    f = failure.lower()
    return any(s in f for s in ("timed out", "timeout", "exception", "traceback",
                                "no such file", "permission denied", "killed"))


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _regression_failure(reg: Optional[Dict[str, Any]]) -> Optional[str]:
    """Turn the perf oracle's ``report.regression`` dict into a failure string.

    The oracle (``oracles/perf.py`` ``_check_regression``) is the single
    source of truth for *whether* a regression happened and *which*
    threshold applied. It returns a dict shaped like::

        {"regressed": bool, "drop": float, "threshold": float, ...}   # speedup
        {"regressed": bool, "increase": float, "threshold": float, ...} # ms_per_op
        {"regressed": False, "note": "no previous baseline"}

    Returns ``None`` when there is no regression (so the caller emits OK),
    or a human-readable failure string (so the caller emits PERF_REGRESSION).
    Kept as a module-level pure function so it is trivially unit-testable
    without constructing the whole pipeline.
    """
    if not reg or not reg.get("regressed"):
        return None
    drop = reg.get("drop")
    inc = reg.get("increase")
    if drop is not None:
        metric = f"speedup dropped {float(drop) * 100:.1f}%"
    elif inc is not None:
        metric = f"ms_per_op increased {float(inc) * 100:.1f}%"
    else:
        metric = "primary metric regressed"
    # Threshold authority is the oracle's dict; fall back only if absent.
    thr = reg.get("threshold", 0.20)
    return f"E (perf regression): {metric} vs prev iter (threshold {float(thr) * 100:.0f}%)"


def _merge_best(best: Optional[Dict[str, float]], new: Dict[str, float]) -> Dict[str, float]:
    out = dict(best or {})
    for k, v in new.items():
        if k not in out or v > out[k]:
            out[k] = v
    return out


# --------------------------------------------------------------------------- #
# Search-mode (flame-chase-style rewrite↔fine-tune alternation)
# --------------------------------------------------------------------------- #
#
# A simplified port of Humanize's ``flame_chase`` flow (see
# docs.humanfia.ai/humanize): on a kernel-optimization task a single fine-tuning
# agent stalls on the nearest local optimum (our 16-iter run plateaued on
# prefill ~1610 µs for 14 iterations). flame_chase alternates a *rewrite*
# (structural change, escape the optimum) with *fine-tuning* (climb the next
# peak). We trigger ``rewrite`` deterministically when the primary metric has
# not improved beyond noise for ``PLATEAU_WINDOW`` consecutive completed
# iterations; otherwise ``fine_tune``. Advisory only — it nudges the planner
# prompt and never touches the state machine or the perf gate.

PLATEAU_WINDOW = 3
# Improvement margin + headline-metric selection live in ``metrics`` (single
# source of truth, shared with ``kernel_zoo``). The thin wrappers below keep
# the existing call sites / tests unchanged.


def _primary_metric(perf: Dict[str, float]) -> Optional[Tuple[float, str]]:
    """Delegate to :func:`metrics.primary_metric` (see its docstring)."""
    return metrics.primary_metric(perf)


def _is_improvement(new: float, best: float, direction: str) -> bool:
    """Delegate to :func:`metrics.is_improvement` (see its docstring)."""
    return metrics.is_improvement(new, best, direction)


def _resolve_search_mode(iteration: int, iters_since_best: int,
                         plateau_window: int = PLATEAU_WINDOW) -> str:
    """``fine_tune`` unless a plateau is detected, then ``rewrite``.

    Pure function over its inputs so it is trivially unit-testable. The
    pipeline computes ``iters_since_best`` from the stored iteration records
    (see :func:`_count_iters_since_best`) and passes it here.
    """
    if iteration > 1 and iters_since_best >= plateau_window:
        return "rewrite"
    return "fine_tune"


def _count_iters_since_best(store, workspace) -> int:
    """Completed iterations since the last iteration that set a new best on the
    primary metric (beyond the noise margin).

    Walks the stored iteration records in order, tracking the running best
    primary value; returns ``(last_complete) - (index of the last new best)``.
    Stateless and resume-safe: it reads history from the store rather than
    carrying a counter in ``IterationContext``, so a restart recomputes the
    same value. Returns 0 when there is no history or no usable perf.
    """
    last = workspace.latest_complete_number()
    if not last:
        return 0
    best: Optional[Tuple[float, str]] = None
    best_idx = None
    for i in range(1, last + 1):
        rec = store.load_iteration(i)
        if rec is None:
            continue
        # ``StateStore.load_iteration`` returns a *plain dict* (the shell
        # ships no IterationRecord dataclass); ``perf`` is a top-level dict
        # key. Reading it as an attribute (``rec.perf``) silently skips
        # every record and makes the plateau detector a no-op.
        perf = rec.get("perf") if isinstance(rec, dict) else getattr(rec, "perf", None)
        if not perf:
            continue
        m = _primary_metric(perf)
        if m is None:
            continue
        val, direction = m
        if best is None or _is_improvement(val, best[0], direction):
            best = (val, direction)
            best_idx = i
    if best_idx is None:
        return 0  # no usable perf signal -> fine_tune (per docstring)
    return last - best_idx


# Humanize-style flow selection (see https://docs.humanfia.ai/humanize/ and
# https://humanfia.ai/flows). Different problems need different flows; the
# ``flow`` form field picks one. Advisory only — it selects the plan-mode
# policy and a prompt directive, never the state machine. The A->B->...->F
# state machine and the perf gate are unchanged for every flow.
FLOW_MODES = ("flame_chase", "ralph_loop", "rlar")


def _resolve_flow_mode(flow: Optional[str], iteration: int,
                        iters_since_best: int,
                        plateau_window: int = PLATEAU_WINDOW) -> str:
    """Resolve the plan ``mode`` (``fine_tune`` / ``rewrite``) for the
    configured Humanize-style ``flow``.

    - ``flame_chase`` (default): plateau -> ``rewrite`` (escape the local
      optimum), else ``fine_tune``. A simplified port of Humanize's
      flame_chase flow.
    - ``ralph_loop``: always ``fine_tune``. Humanize's ralph_loop runs the
      same task round after round in a fresh session until the budget stops
      it — there is no plateau-triggered rewrite.
    - ``rlar``: always ``fine_tune``. Humanize's rlar is an actor + fresh
      reviewer loop (notes -> next prompt); the rlar flavor is a prompt
      directive, not a mode change. Our D_review phase already provides the
      fresh-reviewer loop; ``rlar`` adds a directive nudging the agent toward
      a reviewer-satisfying, self-contained kernel.
    """
    f = (flow or "flame_chase").strip().lower()
    if f in ("ralph_loop", "rlar"):
        return "fine_tune"
    # flame_chase (default / unknown -> safe default)
    return _resolve_search_mode(iteration, iters_since_best, plateau_window)
