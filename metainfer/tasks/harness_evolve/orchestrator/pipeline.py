"""harness_evolve main pipeline (AHE outer loop).

Iteration layout (double generation, mirrors ahe-ref semantics):
    runs/iteration_NNN/
      input/workspace/          snapshot of the workspace evaluated this loop
      input/benchmark/results.json
      input/benchmark/scored_ids.json      (pool mode: ids scored this round)
      input/diff.json           vs previous loop's eval (overlap ids)
      input/analysis/overview.md
      evolve/change_manifest.json
      evolve/round_plan.json               (pool mode: next round's question set)
      evolve/evolve_summary.md
      evolve/workspace/         (only when the evolver reported a change)

Root artifacts: best_ever.json, iteration_scores.jsonl, report.md.
Auto rollback: when an iteration's decision pass rate falls below best-ever, the
best snapshot is restored over the live workspace (workspace/).

Two suite modes:
- legacy (pool_source=""): evaluate cfg.suite every round (v0 behaviour).
- pool v2 (pool_source="builtin"|<path>): questions come from the registered
  pool; the single Evolve role's round_plan picks next-round sets; machine
  guardrails enforce in-pool + >=60% overlap + budget; decisions (best-ever /
  rollback / attribution) are computed on the overlap pairs.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from .adapters.eval import build_evaluator
from .champion_selection import (
    Generation, best_generation, load_generations, record_generation,
)
from .attribution import (
    copy_tree, diff_results, evaluate_changes, pass_rate, replace_tree, save_json,
)
from .config import ExperimentConfig, InstanceSpec, harness_seed_dir
from .decision_engine import DecisionPolicy, decide
from .evolve import DEFAULT_EVOLVE_MODEL, build_evolver
from .phases import (
    ANALYZE, EVALUATE, EVOLVE, FINISHED, PREPARE, REPORT,
)
from .pool import Pool, builtin_pool
from .promotion import (
    restore_promoted_harness, write_pending_promotion,
)
from .rounds import (
    GENERALIZATION_ROUND_COST, OPERATORS_PER_GATE, PERFORMANCE_ROUND_COST,
    STAGE_BASELINE, STAGE_GENERALIZATION, STAGE_PERFORMANCE,
    baseline_round_verdict, child_dir_map, clear_pending_generalization,
    evaluate_gate, group_state, normalized_per_gate,
    read_pending_generalization, record_paper, resolve_child_dir, round_stage,
    select_round_questions, write_pending_generalization,
)
from .variant import (
    load_variant_table, pool_instances, record_variants, save_variant_table,
)
from .question_roles import select_questions
from .round_plan import (
    RoundPlan, enforce_guardrails, load_rotation, load_round_plan,
    mark_selected,
)
from .state import (
    append_timeline, harness_revision, loaded_harness_revision,
    read_target_iterations, set_run, write_harness_revision,
)

BEST_EVER_FILE = "best_ever.json"
SCORES_FILE = "iteration_scores.jsonl"
#: This run's question plan (performance set + the fixed generalization paper).
ROUND_QUESTIONS_FILE = "round_questions.json"
REPORT_FILE = "report.md"
LAST_SCORED_FILE = "last_scored_ids.json"


def _uses_variant_rounds(cfg: ExperimentConfig) -> bool:
    """Whether this run measures operators against the variant table.

    This is the **default protocol** (operator decision, 2026-09-15): one HE
    run chases one promotable harness, every round draws fresh random operators
    judged against their current variant, and round 1 fixes the generalization
    paper. Pool mode without a real pool file, and legacy suite mode, keep the
    old path; ``round_questions: legacy`` restores it explicitly.
    """
    raw = str(cfg.answers.get("round_questions") or "").strip().lower()
    if raw in {"legacy", "suite", "off", "0", "false"}:
        return False
    if raw in {"variant", "on", "1", "true", "yes"}:
        return True
    if not cfg.pool_mode:
        return False
    source = str(cfg.answers.get("question_pool") or cfg.pool_source or "").strip()
    if not source or source == "builtin":
        return False          # nothing to draw operators from: stay on the old path
    return Path(source).expanduser().is_file()


def _question_pool_path(cfg: ExperimentConfig) -> Optional[Path]:
    """The pool file holding the operators a round may draw from."""
    raw = str(cfg.answers.get("question_pool") or cfg.pool_source or "").strip()
    if not raw or raw == "builtin":
        return None
    path = Path(raw).expanduser()
    return path if path.is_file() else None


def _round_rng(cfg: ExperimentConfig, iteration: int,
               stage: str = "") -> "tuple[Any, str]":
    """This round's draw RNG, plus the seed it came from.

    The draw is what the round is judged on, so "why these four operators?" has
    to be answerable later. ``round_seed`` in the form pins it explicitly; with
    no pin the seed is derived from the task id, the iteration and the stage,
    which is still a fresh draw per round (A_i ≠ A_{i-1}) but reproducible when
    somebody has to re-run one pass.

    Returns ``(rng, seed_label)``.
    """
    import random

    pinned = cfg.answers.get("round_seed")
    if pinned in (None, ""):
        seed: Any = f"{cfg.task_id}:{iteration}:{stage or 'round'}"
        return random.Random(str(seed)), str(seed)
    try:
        return random.Random(int(pinned) + int(iteration)), f"round_seed={pinned}+{iteration}"
    except (TypeError, ValueError):
        seed = f"{pinned}:{iteration}"
        return random.Random(seed), seed


def _legacy_protocol_reason(cfg: ExperimentConfig) -> str:
    """Why this run is not on the fixed protocol, in one sentence.

    ``FLOW.md`` describes the only protocol a new HE task may use (variant
    rounds: a fixed generalization paper, two gates, rounds sized in waves of 4).
    The older paths still exist for offline suite runs and for experiments
    started before 2026-09-15 — but "opt-in" was *invisible*: nothing said the
    run had left the protocol, so a pass that judges neither gate looked like any
    other. This sentence is what the operator reads instead.
    """
    raw = str(cfg.answers.get("round_questions") or "").strip().lower()
    if raw in {"legacy", "suite", "off", "0", "false"}:
        return f"round_questions={raw!r} was requested explicitly"
    source = str(cfg.answers.get("question_pool") or cfg.pool_source or "").strip()
    if not source:
        return ("no question pool is configured, so the questions come from the "
                "inline suite and neither gate is judged")
    if source == "builtin":
        return "the built-in demo pool is in use instead of a measured pool file"
    path = Path(source).expanduser()
    if not path.is_file():
        return f"the configured pool file does not exist: {source}"
    return "this run is not on the variant-round protocol"


def _announce_legacy_protocol(cfg: ExperimentConfig, exp: Path) -> None:
    """Say out loud that this run bypasses the fixed protocol. Never raises.

    Three places, because the three audiences are different: the orchestrator log
    (whoever is watching the process), the task timeline (the run's own record,
    and what the WebUI lists), and ``protocol.json`` (what the task page reads to
    put a banner on screen instead of a run that merely looks quiet).
    """
    reason = _legacy_protocol_reason(cfg)
    payload = {
        "protocol": "legacy",
        "mode": "legacy",
        "reason": reason,
        "round_questions": cfg.answers.get("round_questions") or None,
        "pool_source": cfg.pool_source or None,
        "pool_file": (str(_question_pool_path(cfg)) if _question_pool_path(cfg)
                      else None),
        "since": time.time(),
        "policy": ("FLOW.md §1–§4 is the fixed protocol for new tasks: a frozen "
                   "generalization paper, the performance/generalization gates, "
                   "rounds sized in waves of 4. This run judges neither gate, so "
                   "its rounds cannot promote a harness."),
    }
    try:
        append_timeline(cfg.state_dir, "legacy_protocol_selected", payload)
    except Exception:  # noqa: BLE001 - progress records are best effort
        pass
    try:
        from .attribution import save_json

        save_json(Path(exp) / "protocol.json", payload)
    except Exception:  # noqa: BLE001
        pass
    try:
        print(f"[harness_evolve] WARNING: running the LEGACY protocol ({reason}). "
              f"New tasks must use a measured pool file — see FLOW.md",
              file=sys.stderr, flush=True)
    except OSError:
        pass


def _judgeable_ids(instances: Dict[str, Dict[str, Any]],
                   table: Dict[str, Any]) -> List[str]:
    """Pool operators that can produce a win/loss (they have a variant)."""
    from .variant import resolve_variant

    out: List[str] = []
    for iid in instances:
        try:
            if resolve_variant(table or {}, iid, instances=instances) is not None:
                out.append(str(iid))
        except Exception:  # noqa: BLE001 - a malformed row is simply not judgeable
            continue
    return sorted(out)


def _mechanism_gate_for_round(cfg: ExperimentConfig, exp: Path,
                              iteration: int) -> Dict[str, Any]:
    """Grade the previous round's declared mechanism against what was observed.

    Round N evaluates the harness change that round N-1's evolve produced, so
    the manifest to grade is the previous round's one. Round 1 tests the seed,
    which declares nothing: the gate is then ``NOT_DECLARED``, which the lenient
    policy allows.
    """
    manifest = None
    if iteration > 1:
        manifest = _load_json(
            exp / "runs" / f"iteration_{iteration - 1:03d}" / "evolve"
            / "change_manifest.json")
    if not manifest:
        return {"status": "NOT_DECLARED", "hits": [], "misses": [],
                "reason": "no previous-round change manifest to verify"}
    try:
        from .mechanism_checks import (
            collect_candidate_evidence, evaluate_changes,
        )
        from .decision_engine import _mechanism_status

        evidence = collect_candidate_evidence(
            exp, iteration,
            planner_enabled=_truthy(cfg.answers.get("planner_enabled"),
                                    default=True),
            candidate_workspace=(exp / "runs" / f"iteration_{iteration:03d}"
                                 / "input" / "workspace"))
        checks, detail = evaluate_changes(manifest, evidence)
        status = _mechanism_status(manifest, checks)
        status["detail"] = detail
        append_timeline(cfg.state_dir, "mechanism_gate", {
            "iteration": iteration, "status": status.get("status"),
            "hits": status.get("hits"), "misses": status.get("misses"),
            "contradicted": status.get("contradicted"),
        })
        return status
    except Exception as exc:  # noqa: BLE001 - the gate is advisory here
        append_timeline(cfg.state_dir, "mechanism_check_failed",
                        {"iteration": iteration, "error": repr(exc)})
        return {"status": "NOT_CHECKED", "hits": [], "misses": [],
                "error": repr(exc)}


def _seed_workspace(cfg: ExperimentConfig) -> Path:
    workspace = cfg.exp_dir / "workspace"
    if not (workspace / "manifest.yaml").exists():
        copy_tree(harness_seed_dir(cfg.harness_source), workspace)
    if not (workspace / ".git").exists():
        subprocess.run(["git", "init"], cwd=workspace, check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(["git", "config", "user.name", "MetaInfer AHE"],
                       cwd=workspace, check=True)
        subprocess.run(["git", "config", "user.email", "ahe@metainfer.local"],
                       cwd=workspace, check=True)
        subprocess.run(["git", "add", "-A"], cwd=workspace, check=True)
        subprocess.run(["git", "commit", "-m", "baseline: seed harness"],
                       cwd=workspace, check=True, stdout=subprocess.DEVNULL)
    return workspace


def _head_revision(workspace: Path) -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=workspace, text=True
    ).strip()


def _current_revision(workspace: Path) -> str:
    """HEAD of the live harness workspace, or ``""`` when it is not a repo.

    Used to stamp each round with *its own* revision: reading it from the
    previous round's manifest left ``workspace_revision`` empty in every
    generation record, which is what made the rollback machinery unable to
    restore a precise revision.
    """
    try:
        return _head_revision(workspace)
    except (OSError, subprocess.SubprocessError):
        return ""


def _commit_workspace(workspace: Path, iteration: int) -> str:
    """Commit one evolved harness generation; return the exact revision."""
    subprocess.run(["git", "add", "-A"], cwd=workspace, check=True)
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"], cwd=workspace
    )
    if diff.returncode != 0:
        subprocess.run(
            ["git", "commit", "-m", f"evolve: iteration {iteration}"],
            cwd=workspace, check=True, stdout=subprocess.DEVNULL,
        )
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=workspace, text=True
    ).strip()


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def _load_ids(path: Path) -> List[str]:
    data = _load_json(path)
    return list(data) if isinstance(data, list) else []


def _save_scores(cfg: ExperimentConfig, entry: Dict[str, Any]) -> None:
    with (cfg.exp_dir / SCORES_FILE).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _update_best_ever(cfg: ExperimentConfig, iteration: int, rate: float,
                      snapshot: Path) -> Dict[str, Any]:
    best = _load_json(cfg.exp_dir / BEST_EVER_FILE) or {}
    if not best or rate > float(best.get("pass_rate", -1.0)):
        best = {
            "iteration": iteration,
            "pass_rate": rate,
            "snapshot_dir": str(snapshot),
        }
        save_json(cfg.exp_dir / BEST_EVER_FILE, best)
    return best


def _write_overview(input_dir: Path, iteration: int,
                    results: Dict[str, Dict[str, Any]],
                    diff: Optional[Dict[str, Any]]) -> None:
    lines = [
        f"# Analysis overview — iteration {iteration}",
        "",
        "| instance | passed | median_us | reason |",
        "|---|---:|---:|---|",
    ]
    for inst_id, r in sorted(results.items()):
        lines.append(
            f"| {inst_id} | {r.get('passed')} | {r.get('median_us')} | "
            f"{r.get('reason')} |"
        )
    if diff:
        lines.append("")
        lines.append(f"- flipped: {diff.get('flipped')}")
        lines.append(f"- regressed: {diff.get('regressed')}")
    analysis = input_dir / "analysis"
    analysis.mkdir(parents=True, exist_ok=True)
    (analysis / "overview.md").write_text("\n".join(lines) + "\n",
                                          encoding="utf-8")


def _variant_instance_spec(entry: Dict[str, Any], *, budget_rounds: int) -> InstanceSpec:
    """Build an :class:`InstanceSpec` straight from a pool entry (no Pool object)."""
    contract = dict(entry.get("contract") or {})
    variant = entry.get("best_known_us")
    baseline = entry.get("baseline_us")
    threshold = variant if variant is not None else (baseline or 0.0)
    return InstanceSpec.from_dict({
        "id": str(contract.get("id") or entry.get("id") or ""),
        "shape": {
            "model": str(contract.get("model") or ""),
            "tp_size": int(contract.get("tp_size") or 8),
            "operator": str(contract.get("operator") or ""),
            "M": int(contract.get("M") or 0),
            "N": int(contract.get("N") or 0),
            "K": int(contract.get("K") or 0),
        },
        "budget_rounds": int(budget_rounds),
        "warm_start_from": "best_known",
        "pass_median_us_le": float(threshold or 0.0),
    })


def _pool_instance_spec(inst: Any, budget_rounds: int = 4) -> InstanceSpec:
    def _g(name: str, default: Any = "") -> Any:
        value = getattr(inst, name, default)
        return default if value is None else value

    return InstanceSpec.from_dict({
        "id": inst.id,
        "shape": {
            "model": _g("model"),
            "tp_size": _g("tp_size", 8),
            "operator": _g("operator"),
            "M": _g("M", 0),
            "N": _g("N", 0),
            "K": _g("K", 0),
        },
        "budget_rounds": budget_rounds,
        "warm_start_from": "best_known",
        # Dry evaluator uses this to synthesize median; choose the registered
        # best/target scale so pool.auto_pass still yields first-fail/rest-pass.
        "pass_median_us_le": (
            getattr(inst, "best_known_us", None)
            or 0.5 * float(getattr(inst, "baseline_us", 1.0))
        ),
    })


def _harness_validate_error(workspace: Path) -> Optional[str]:
    """Malformed harness component (bad YAML) must never be benchmarked.

    Returns the first offending file's error text, or None when valid.
    """
    import yaml as _yaml
    for path in sorted(workspace.rglob("*.yaml")) + sorted(workspace.rglob("*.yml")):
        try:
            _yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            return f"{path.name}: {exc}"
    return None


def _wired_scope_violations(before: Path, after: Path) -> List[Dict[str, str]]:
    """Components a harness change touched although the manifest says unwired.

    A component with ``wired: false`` is not read by the runtime, so changing
    it cannot show any effect — the round would be spent for nothing. The
    manifest is therefore load-bearing: it declares which components apply.
    """
    import yaml as _yaml

    before = Path(before)
    after = Path(after)
    manifest_path = after / "manifest.yaml"
    if not manifest_path.is_file():
        return []
    try:
        manifest = _yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return []
    components = manifest.get("components")
    if not isinstance(components, dict):
        return []
    out: List[Dict[str, str]] = []
    for name, entry in components.items():
        if not isinstance(entry, dict) or entry.get("wired", True):
            continue
        relative = str(entry.get("path") or "")
        if not relative:
            continue
        old_file = before / relative
        new_file = after / relative
        try:
            old_text = old_file.read_text(encoding="utf-8") if old_file.is_file() else None
            new_text = new_file.read_text(encoding="utf-8") if new_file.is_file() else None
        except OSError:
            continue
        if old_text != new_text:
            out.append({"component": str(name), "path": relative})
    return out


def _load_pool(cfg: ExperimentConfig) -> Optional[Pool]:
    if not cfg.pool_mode:
        return None
    if cfg.pool_source == "builtin":
        if cfg.execution_mode == "dkao-cli":
            raise ValueError(
                "dkao-cli requires a measured registered pool YAML; "
                "builtin contains dry-run fixture baselines only"
            )
        return builtin_pool()
    return Pool.from_yaml(Path(cfg.pool_source).expanduser())


def _record_state(cfg: ExperimentConfig, phase: str,
                  iteration: Optional[int] = None,
                  event: Optional[str] = None,
                  **payload: Any) -> None:
    """Mirror the outer-loop position into run.json + timeline (WebUI)."""
    fields: Dict[str, Any] = {"current_phase": phase}
    if phase == FINISHED:
        fields["finished"] = True
        fields["final_status"] = "success"
    if iteration is not None:
        fields["current_iteration"] = iteration
    set_run(cfg.state_dir, **fields)
    if event:
        append_timeline(cfg.state_dir, event,
                        {"iteration": iteration, **payload})


def completed_iterations(exp: Path) -> int:
    """Highest iteration number that already has *end-of-pass* artifacts.

    "Done" is a judged pass: the variant protocol leaves ``baseline_round.json``
    (round 1), ``performance_gate.json`` / ``generalization_gate.json``, or a
    ``decision.json`` behind — reading only ``results.json`` made this return 0
    for a run that had just finished three real rounds, and ``resume`` then
    refused to continue (it believes nothing has been measured yet).

    ``input/stage.json`` is deliberately **not** in the list: it is written when
    a pass *starts* (it records which stage this pass is). Counting it made a
    round that had just begun indistinguishable from a finished one, so the
    resume the sweep launches computed ``start = done + 1`` and opened the next
    round in parallel with the one being measured.
    """
    runs = exp / "runs"
    if not runs.is_dir():
        return 0
    done = 0
    for d in sorted(runs.glob("iteration_*")):
        if not d.is_dir():
            continue
        input_dir = d / "input"
        judged = any(
            (input_dir / name).is_file()
            for name in ("decision.json", "baseline_round.json",
                         "performance_gate.json", "generalization_gate.json")
        ) or (input_dir / "benchmark" / "results.json").is_file()
        if not judged:
            continue
        try:
            done = max(done, int(d.name.split("_")[-1]))
        except ValueError:
            continue
    return done


def _iteration_results(exp: Path, iteration: int) -> Optional[Dict[str, Any]]:
    """Benchmark results recorded for one iteration (None when absent)."""
    data = _load_json(
        exp / "runs" / f"iteration_{iteration:03d}"
        / "input" / "benchmark" / "results.json"
    )
    if not data:
        return None
    results = data.get("results")
    return dict(results) if isinstance(results, dict) else None


def _record_champion_generation(cfg: ExperimentConfig, exp: Path, *,
                                iteration: int, decision: Dict[str, Any],
                                decision_rate: Any, snapshot: Path,
                                live_workspace: Path,
                                results: Dict[str, Any],
                                current: Dict[str, Any]) -> Dict[str, Any]:
    """Record this generation and update the champion. **Never raises.**

    Which generation the champion points at is what every later round compares
    against, so losing this bookkeeping silently is not acceptable. It *used* to
    be swallowed into a timeline row and nothing else (26 ``champion_record_failed
    / AttributeError`` rows in one run on 2026-09-11), which left the run
    comparing against a champion chain nobody could vouch for.

    A failure is now loud (stderr, i.e. the orchestrator log), carries its
    traceback, and is followed by a rebuild of ``best_ever.json`` from the
    generations already on disk so the chain survives the error.

    Returns ``{"best_ever", "recorded", "recovered", ...}``; the caller adopts
    ``best_ever``.
    """
    best = dict(current or {})
    outcome: Dict[str, Any] = {"iteration": iteration, "recorded": False,
                               "recovered": False, "best_ever": best}
    try:
        record_generation(exp, Generation(
            iteration=iteration,
            verdict=str(decision.get("verdict") or ""),
            results=dict(results),
            snapshot_dir=str(snapshot),
            # This generation's own revision (not the previous round's
            # manifest field, which was always empty here).
            workspace_revision=_current_revision(live_workspace),
            pass_count=sum(1 for r in results.values()
                           if isinstance(r, dict) and r.get("passed") is True),
        ))
        pinned = _load_json(exp / "champion_override.json") or {}
        pinned_iter = int(pinned.get("champion_iteration") or 0)
        measured_now = None
        if pinned_iter:
            # An explicit baseline (resume --champion-iteration) stays in force
            # until it is changed: automation must not silently override a
            # human's comparison choice.
            pinned_results = _iteration_results(exp, pinned_iter)
            best = {
                "iteration": pinned_iter,
                "pass_rate": (decision_rate
                              if pinned_iter == iteration else None),
                "snapshot_dir": str(
                    exp / "runs" / f"iteration_{pinned_iter:03d}"
                    / "input" / "workspace"),
                "workspace_revision": _current_revision(live_workspace),
                "verdict": "MANUAL_BASELINE",
            }
            save_json(exp / BEST_EVER_FILE, best)
            append_timeline(cfg.state_dir, "champion_pinned_held", {
                "iteration": iteration, "champion_iteration": pinned_iter,
                "pinned_results_present": bool(pinned_results),
            })
        else:
            measured_now = best_generation(load_generations(exp))
        if measured_now is not None and measured_now.results:
            best = {
                "iteration": measured_now.iteration,
                "pass_rate": (decision_rate
                              if measured_now.iteration == iteration else None),
                "snapshot_dir": measured_now.snapshot_dir or str(snapshot),
                "workspace_revision": measured_now.workspace_revision,
                "verdict": ("BEST_MEASURED"
                            if measured_now.iteration != iteration
                            else str(decision.get("verdict") or "")),
            }
            save_json(exp / BEST_EVER_FILE, best)
            append_timeline(cfg.state_dir, "champion_best_measured", {
                "iteration": iteration,
                "champion_iteration": measured_now.iteration,
                "verdict": best["verdict"],
            })
        outcome.update({"recorded": True, "best_ever": best})
        return outcome
    except Exception as exc:  # noqa: BLE001 - never break the loop
        append_timeline(cfg.state_dir, "champion_record_failed", {
            "iteration": iteration, "error": repr(exc),
            "traceback": traceback.format_exc()[-1500:],
        })
        try:
            print(f"[harness_evolve] champion bookkeeping failed at iteration "
                  f"{iteration}: {exc!r} — rebuilding best_ever from the "
                  f"generations on disk", file=sys.stderr, flush=True)
        except OSError:
            pass
        outcome["error"] = repr(exc)
        recovered = None
        try:
            recovered = best_generation(load_generations(exp))
        except Exception as exc2:  # noqa: BLE001 - the fallback is best effort
            append_timeline(cfg.state_dir, "champion_rebuild_failed",
                            {"iteration": iteration, "error": repr(exc2)})
        if recovered is not None and recovered.results:
            best = {
                "iteration": recovered.iteration,
                "pass_rate": (decision_rate
                              if recovered.iteration == iteration else None),
                "snapshot_dir": recovered.snapshot_dir or str(snapshot),
                "workspace_revision": recovered.workspace_revision,
                "verdict": "REBUILT_AFTER_ERROR",
            }
            try:
                save_json(exp / BEST_EVER_FILE, best)
                outcome["recovered"] = True
                append_timeline(cfg.state_dir, "champion_rebuilt", {
                    "iteration": iteration,
                    "champion_iteration": recovered.iteration,
                })
            except OSError:
                pass
        outcome["best_ever"] = best
        return outcome


def _truthy(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"0", "false", "no", "off", ""}


def _promote_iteration(cfg: ExperimentConfig, exp: Path, iteration: int,
                       results: Dict[str, Any],
                       instances: List[InstanceSpec],
                       *, freeze: bool = False,
                       ) -> Optional[Dict[str, Any]]:
    """Promote this iteration's better-than-variant kernels into DKAO.

    A question that beats the existing variant for its shape by at least
    ``promote_min_improvement_percent`` (default 3%) and did not fail
    correctness becomes the new shared variant — i.e. DKAO gains a better
    operator. Writes are backed up by the variant store and both the outcome
    table and an append-only log are recorded for audit/rollback.
    """
    if not _truthy(cfg.answers.get("promote_kernels"), default=True):
        return None
    children = exp / "children"
    if not children.is_dir():
        return None
    try:
        from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.variant_promote import (  # noqa: E501
            model_label_for, promote_variant,
        )
    except Exception as exc:  # noqa: BLE001 - promotion must never break the loop
        return {"iteration": iteration, "enabled": True, "error": repr(exc),
                "results": []}
    threshold = float(cfg.answers.get("promote_min_improvement_percent") or 3.0)
    outcomes: List[Dict[str, Any]] = []
    for inst in instances:
        result = results.get(inst.id) or {}
        # The question's newest attempt owns the workspace that produced the
        # result (a retry runs in its own directory).
        # The question's newest attempt owns the workspace that produced the
        # result (a retry runs in its own directory).
        child_dir = resolve_child_dir(children, iteration, inst.id)
        workspace = (child_dir / "workspace") if child_dir else Path("")
        if not workspace.is_dir():
            outcomes.append({"shape": inst.id, "action": "skipped",
                             "reason": "no child workspace for this question"})
            continue
        shape = inst.shape or {}
        answers = {
            "operator": "Quantized GEMM",
            "dtype": "INT8 W8A8",
            "model": str(shape.get("model") or ""),
            "tp_size": shape.get("tp_size"),
        }
        outcome = promote_variant(
            workspace_dir=workspace,
            answers=answers,
            shape_id=inst.id,
            source_task=f"{cfg.task_id}/iteration_{iteration:03d}/{inst.id}",
            correctness_ok=result.get("correctness_ok"),
            min_improvement_percent=threshold,
            tp=shape.get("tp_size"),
            m=shape.get("M"),
            model_label=(model_label_for(inst.id, str(shape.get("model") or ""))
                         or None),
            dry_run=freeze,
        )
        outcome["ahe_passed"] = result.get("passed")
        outcome["ahe_median_us"] = result.get("median_us")
        outcomes.append(outcome)
        if freeze:
            with (exp / "promotion_candidates.jsonl").open(
                    "a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "ts": time.time(), "iteration": iteration,
                    "shape": inst.id, "workspace": str(workspace),
                    "source_task": f"{cfg.task_id}/iteration_{iteration:03d}/{inst.id}",
                    "answers": answers, "tp": shape.get("tp_size"),
                    "m": shape.get("M"),
                    "model_label": (model_label_for(
                        inst.id, str(shape.get("model") or "")) or None),
                    "action": outcome.get("action"),
                    "ahe_passed": result.get("passed"),
                    "ahe_median_us": result.get("median_us"),
                    "variant_median_us": outcome.get("old_median_us"),
                }, ensure_ascii=False) + "\n")

    promoted = [o["shape"] for o in outcomes
                if o.get("action") in {"added", "updated"}]
    payload = {
        "iteration": iteration,
        "enabled": True,
        "frozen": bool(freeze),
        "min_improvement_percent": threshold,
        "promoted": promoted,
        "results": outcomes,
        "note": ("frozen: candidates recorded, promotion happens once at the end"
                 if freeze else None),
    }
    save_json(exp / "runs" / f"iteration_{iteration:03d}" / "promotion.json",
              payload)
    with (exp / "promotion_log.jsonl").open("a", encoding="utf-8") as fh:
        for outcome in outcomes:
            fh.write(json.dumps({
                "ts": time.time(), "iteration": iteration,
                "task_id": cfg.task_id, **outcome,
            }, ensure_ascii=False) + "\n")
    append_timeline(cfg.state_dir, "kernel_promotion", {
        "iteration": iteration, "promoted": promoted,
        "min_improvement_percent": threshold, "frozen": bool(freeze),
    })
    return payload


def _promote_baseline_kernels(cfg: ExperimentConfig, exp: Path,
                              variant_pool: Dict[str, Any],
                              results: Dict[str, Any]) -> Dict[str, Any]:
    """Round 1's faster kernels go into the variant pool — as the new bar.

    A kernel result is a fact about the hardware, not a verdict about a
    harness: the operator's rule is that the baseline round's improvements enter
    the variant pool immediately, so every later gate (and DKAO's own
    ``warm_start: best_known``) compares against what the baseline round
    actually achieved. The *harness* still waits for approval — this only moves
    kernels.

    Only operators the round actually measured are touched, only a real
    improvement (>= ``promote_min_improvement_percent`` faster than the recorded
    best) is written, and the pool file is backed up before being rewritten.
    """
    if not results:
        return {"ok": True, "updated": [], "promoted": [],
                "skipped": "no measurements"}
    pool_path = _question_pool_path(cfg)
    if pool_path is None:
        return {"ok": True, "updated": [], "promoted": [],
                "skipped": "no question pool file"}
    try:
        from .promotion import promote_kernels_for_round
    except Exception as exc:  # noqa: BLE001 - promotion must never break the loop
        return {"ok": False, "updated": [], "errors": [repr(exc)]}
    measured = {
        iid: row for iid, row in (results or {}).items()
        if isinstance(row, dict) and row.get("correctness_ok") is not False
        and row.get("median_us") is not None
    }
    # Same improvement rule as every other kernel write (production default 3%),
    # so a measurement inside the noise band cannot churn the pool.
    threshold = float(cfg.answers.get("promote_min_improvement_percent") or 3.0)
    kept: Dict[str, Any] = {}
    for iid, row in measured.items():
        old = (variant_pool.get(iid) or {}).get("best_known_us")
        try:
            new = float(row["median_us"])
            old_value = float(old) if old is not None else None
        except (TypeError, ValueError):
            continue
        if new <= 0:
            continue
        if old_value is not None and \
                (old_value - new) / old_value * 100.0 < threshold:
            continue
        kept[iid] = row
    if not kept:
        append_timeline(cfg.state_dir, "baseline_kernels_promoted", {
            "iteration": 1, "operators": [], "pool": str(pool_path),
            "reason": f"no operator improved by >= {threshold:.2f}%",
        })
        return {"ok": True, "updated": [], "promoted": [],
                "pool": str(pool_path),
                "reason": f"no operator improved by >= {threshold:.2f}%"}
    version = "baseline:it1"
    outcome = promote_kernels_for_round(
        exp, pool_path, kept, version=version, iteration=1,
        reason="baseline round: faster kernels enter the variant pool")
    updated = outcome.get("updated") or []
    outcome["promoted"] = sorted(str(u["operator_id"]) for u in updated)
    append_timeline(cfg.state_dir, "baseline_kernels_promoted", {
        "iteration": 1, "operators": [u["operator_id"] for u in updated],
        "pool": str(pool_path), "backup": outcome.get("backup"),
        "min_improvement_percent": threshold,
    })
    for change in updated:
        # Keep the experiment's own view in step with the pool it just moved.
        iid = str(change["operator_id"])
        entry = variant_pool.get(iid)
        if isinstance(entry, dict):
            entry["best_known_us"] = change["median_us"]
    return outcome


_FAILING_VERDICTS = {"REJECT", "REJECT_OVERFIT", "INCONCLUSIVE"}
_RECOVERING_VERDICTS = {"PROMOTE", "PROMOTE_UNEXPLAINED", "NO_SIGNAL"}


def _next_fail_streak(verdict: str, streak: int) -> int:
    """Consecutive failing rounds.

    INCONCLUSIVE counts: rounds where nothing could be measured are exactly the
    situation that used to spin forever (a run reached 513 rounds with 510
    REJECTs while a shared GPU made every measurement unusable).
    """
    verdict = str(verdict or "")
    if verdict in _FAILING_VERDICTS:
        return int(streak) + 1
    if verdict in _RECOVERING_VERDICTS:
        return 0
    return int(streak)


def _stop_requested(exp: Path) -> Optional[Dict[str, Any]]:
    """A request (from the evaluator) to stop the whole experiment.

    Raised when no device satisfied the gate for the configured number of
    hourly checks: waiting forever would burn wall-clock time, so the task
    stops with an auditable reason instead.
    """
    data = _load_json(Path(exp) / "stop_requested.json")
    return data or None


def _variant_policy(cfg: ExperimentConfig) -> str:
    """``freeze`` (default): collect candidates, promote once at the end.

    Freezing keeps the reference implementation identical across rounds, so
    every round compares under the same conditions. ``per_round`` restores the
    old behaviour (write the variant as soon as a round beats it).

    Under the variant-round protocol this knob is bypassed on purpose: the
    baseline round's faster kernels go into the variant pool immediately (the
    operator's rule — a kernel result is a fact, while the *harness* is what
    waits for approval).
    """
    raw = str(cfg.answers.get("variant_policy") or "freeze").strip().lower()
    return "per_round" if raw in {"per_round", "always", "each", "immediate"} \
        else "freeze"


def _seed_variant_entry(operators: Dict[str, Any], iid: str,
                        entry: Dict[str, Any]) -> None:
    """Mirror one pool ``best_known`` into the experiment's variant table."""
    operators[iid] = {
        "median_us": entry.get("best_known_us"),
        "p90_us": None,
        "correctness_ok": True,
        "kernel_source": "pool:best_known",
        "harness_version": None,
        "source_iteration": None,
        "family": entry.get("family") or "",
        "contract": entry.get("contract") or {},
        "conditions": {"origin": "variant_pool_refresh"},
        "recorded_at": None,
    }


def _reload_variant_baseline(cfg: ExperimentConfig,
                             variant_pool: Dict[str, Any],
                             variant_table: Dict[str, Any]) -> List[str]:
    """Pull externally-updated ``best_known_us`` back into this run's view.

    The baseline round writes the kernels it beat the variant with straight
    into the question pool. Every later round must therefore compare against —
    and DKAO must warm-start from — that *new* number, not the one this process
    read at startup. Returns the operators whose reference moved, so the gates
    can say out loud that the bar was raised.
    """
    path = _question_pool_path(cfg)
    if path is None:
        return []
    try:
        fresh = pool_instances(path)
    except (OSError, ValueError):
        return []
    moved: List[str] = []
    operators = variant_table.setdefault("operators", {})
    for iid, entry in fresh.items():
        variant_pool[iid] = entry
        best = entry.get("best_known_us")
        recorded = (operators.get(iid) or {}).get("median_us")
        try:
            better = best is not None and (recorded is None
                                           or float(best) < float(recorded))
        except (TypeError, ValueError):
            better = False
        if not better:
            continue
        moved.append(str(iid))
        _seed_variant_entry(operators, str(iid), entry)
    if moved:
        save_variant_table(cfg.exp_dir, variant_table)
        append_timeline(cfg.state_dir, "variant_reference_refreshed", {
            "operators": sorted(moved)})
    return sorted(moved)


def _baseline_stop(cfg: ExperimentConfig, exp: Path, *, iteration: int,
                   verdict: Dict[str, Any]) -> None:
    """Round 1 could not measure the paper: the run stops right there.

    Round 1 judges nothing, so it has no gate to fail — but it owes one usable
    measurement per operator: those kernels seed the pool every later round has
    to beat, and the paper is the run's exam. If a child crashed, was blocked by
    DKAO's own measurement gate or reported nothing usable, there is no honest
    way to continue, so the task ends with an auditable reason instead of
    inventing evidence.
    """
    reason = "; ".join(verdict.get("reasons") or []) or "baseline round failed"
    save_json(Path(exp) / "stop_requested.json", {
        "iteration": iteration, "reason": "baseline_round_failed",
        "detail": {"failed": verdict.get("failed"),
                   "measured": verdict.get("measured"),
                   "message": reason},
    })
    append_timeline(cfg.state_dir, "baseline_round_failed", {
        "iteration": iteration, "failed": verdict.get("failed"),
        "measured": verdict.get("measured"), "reason": reason,
    })
    _record_state(cfg, FINISHED, iteration, event="baseline_round_failed",
                  failed=list(verdict.get("failed") or []))
    set_run(cfg.state_dir, final_status="baseline_round_failed")



def _track_best_known(cfg: ExperimentConfig, exp: Path, iteration: int,
                      results: Dict[str, Any]) -> Dict[str, Any]:
    """Per-shape best-known curve + explicit regression detection.

    Before this, a round whose kernel was slower than the known best only
    silently failed to promote. Recording the curve makes "this round got
    worse starting point" visible in the record and the UI.
    """
    path = exp / "best_known.json"
    data = _load_json(path) or {}
    regressions: List[Dict[str, Any]] = []
    tolerance = 1.02
    for iid, row in (results or {}).items():
        if not isinstance(row, dict):
            continue
        median = row.get("median_us")
        entry = data.setdefault(iid, {"best_median_us": None,
                                      "best_iteration": None, "history": []})
        entry.setdefault("history", []).append({
            "iteration": iteration, "median_us": median,
            "passed": row.get("passed"),
        })
        entry["history"] = entry["history"][-40:]
        try:
            value = float(median)
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        best = entry.get("best_median_us")
        if best is None or value < float(best):
            entry["best_median_us"] = value
            entry["best_iteration"] = iteration
        elif value > float(best) * tolerance:
            regressions.append({
                "shape": iid, "iteration": iteration, "median_us": value,
                "best_median_us": best, "best_iteration": entry.get("best_iteration"),
                "delta_percent": round((value - float(best)) / float(best) * 100, 2),
            })
    save_json(path, data)
    if regressions:
        with (exp / "regressions.jsonl").open("a", encoding="utf-8") as fh:
            for row in regressions:
                fh.write(json.dumps({"ts": time.time(), **row},
                                    ensure_ascii=False) + "\n")
        append_timeline(cfg.state_dir, "kernel_regression", {
            "iteration": iteration, "regressions": regressions,
        })
    return {"regressions": regressions}


def _finalize_promotion(cfg: ExperimentConfig, exp: Path) -> Optional[Dict[str, Any]]:
    """Promote the best kernel per shape once, after a frozen experiment."""
    if not _truthy(cfg.answers.get("promote_kernels"), default=True):
        return None
    candidates_path = exp / "promotion_candidates.jsonl"
    if not candidates_path.is_file():
        return None
    best: Dict[str, Dict[str, Any]] = {}
    for line in candidates_path.read_text(encoding="utf-8",
                                          errors="replace").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("ahe_passed") is not True:
            continue
        if row.get("action") not in {"would_add", "would_update", "added",
                                    "updated"}:
            continue
        current = best.get(str(row.get("shape")))
        if current is None or (row.get("ahe_median_us") or float("inf")) < (
                current.get("ahe_median_us") or float("inf")):
            best[str(row.get("shape"))] = row
    if not best:
        payload = {"enabled": True, "frozen": True, "promoted": [],
                   "results": [], "note": "no eligible candidate"}
        save_json(exp / "final_promotion.json", payload)
        return payload
    try:
        from metainfer.tasks.dcu_kernel_auto_opt.orchestrator.variant_promote import (  # noqa: E501
            promote_variant,
        )
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "error": repr(exc), "results": []}
    threshold = float(cfg.answers.get("promote_min_improvement_percent") or 3.0)
    outcomes: List[Dict[str, Any]] = []
    for shape_id, row in sorted(best.items()):
        workspace = Path(str(row.get("workspace") or ""))
        if not workspace.is_dir():
            outcomes.append({"shape": shape_id, "action": "skipped",
                             "reason": "candidate workspace is gone"})
            continue
        outcome = promote_variant(
            workspace_dir=workspace,
            answers=row.get("answers") or {},
            shape_id=shape_id,
            source_task=str(row.get("source_task") or ""),
            correctness_ok=True,
            min_improvement_percent=threshold,
            tp=row.get("tp"), m=row.get("m"),
            model_label=row.get("model_label"),
        )
        outcome["ahe_median_us"] = row.get("ahe_median_us")
        outcome["candidate_iteration"] = row.get("iteration")
        outcomes.append(outcome)
    promoted = [o["shape"] for o in outcomes
                if o.get("action") in {"added", "updated"}]
    payload = {
        "enabled": True, "frozen": True, "min_improvement_percent": threshold,
        "promoted": promoted, "results": outcomes,
        "candidates_considered": sorted(best),
    }
    save_json(exp / "final_promotion.json", payload)
    with (exp / "promotion_log.jsonl").open("a", encoding="utf-8") as fh:
        for outcome in outcomes:
            fh.write(json.dumps({"ts": time.time(), "iteration": -1,
                                 "task_id": cfg.task_id, "final": True,
                                 **outcome}, ensure_ascii=False) + "\n")
    append_timeline(cfg.state_dir, "final_kernel_promotion", {
        "promoted": promoted, "candidates": sorted(best),
    })
    return payload


def _write_round_review(cfg: ExperimentConfig, exp: Path) -> Dict[str, Any]:
    """Cross-round review: every generation, medians, champion and regressions."""
    from .champion_selection import best_generation, load_generations, summarize

    generations = load_generations(exp)
    rows = summarize(generations)
    champion = best_generation(generations)
    review = {
        "task_id": cfg.task_id,
        "generations": rows,
        "champion_iteration": champion.iteration if champion else None,
        "champion_verdict": champion.verdict if champion else None,
        "final_promotion": _load_json(exp / "final_promotion.json"),
        "best_known": _load_json(exp / "best_known.json"),
        "variant_policy": _variant_policy(cfg),
        "pinned_baseline": _load_json(exp / "champion_override.json"),
    }
    save_json(exp / "round_review.json", review)
    lines = ["# Cross-round review (AHE)", "",
             f"- variant policy: **{review['variant_policy']}**",
             f"- champion generation: **iteration {review['champion_iteration']}**"
             f" ({review['champion_verdict']})", ""]
    if rows:
        shapes = sorted({iid for row in rows for iid in row.get("medians", {})})
        header = "| gen | verdict | pass | " + " | ".join(shapes) + " |"
        lines += [header, "|" + "---|" * (3 + len(shapes))]
        for row in rows:
            medians = row.get("medians") or {}
            cells = []
            for shape in shapes:
                value = medians.get(shape)
                cells.append(f"{value:.1f}" if isinstance(value, (int, float))
                             else "-")
            lines.append(
                f"| {row['iteration']}{' ⭐' if row.get('champion') else ''} "
                f"| {row.get('verdict')} | {row.get('pass_count')} | "
                + " | ".join(cells) + " |")
        lines.append("")
    best_known = review["best_known"] or {}
    if best_known:
        lines.append("## Best known per shape")
        for shape, entry in sorted(best_known.items()):
            lines.append(
                f"- `{shape}`: {entry.get('best_median_us')} us "
                f"(iteration {entry.get('best_iteration')})")
        lines.append("")
    promotion = review["final_promotion"] or {}
    if promotion:
        lines.append("## Final promotion")
        for outcome in promotion.get("results") or []:
            lines.append(
                f"- `{outcome.get('shape')}`: {outcome.get('action')} "
                f"({outcome.get('reason') or outcome.get('improvement_percent') or ''})")
    (exp / "round_review.md").write_text("\n".join(lines) + "\n",
                                         encoding="utf-8")
    append_timeline(cfg.state_dir, "round_review_written", {
        "champion_iteration": review["champion_iteration"],
        "generations": len(rows),
    })
    return review


def _code_reload_pending(cfg: ExperimentConfig,
                         loaded: str) -> Optional[Dict[str, Any]]:
    """Whether the harness code on disk changed since this process started.

    A round runs for hours, so an operator who fixes the loop (a new GPU gate,
    a new retry policy) cannot expect the live process to honour it — the
    modules are already imported. Rather than running one more round of stale
    logic, the loop stops here: the recorded revision marker makes the restart
    idempotent (a fresh process records its own revision and carries on), and
    the supervisor/server resumes at the next iteration with the new code.
    """
    current = harness_revision()
    if not loaded or current == loaded:
        return None
    return {
        "loaded_revision": loaded,
        "on_disk_revision": current,
        "resumes_at_iteration": None,  # filled by the caller
    }


def _rounds_used_on_disk(exp: Path) -> float:
    """How many rounds this experiment has already spent.

    ``rounds_used`` lives in ``run.json`` (the WebUI reads it). When it is
    missing — a run created before the field — it is derived from the round
    artifacts, so a resumed run does not silently start with a fresh budget.
    """
    stored = _load_json(Path(exp) / "run.json") or {}
    raw = stored.get("rounds_used")
    try:
        if raw is not None:
            return max(0.0, float(raw))
    except (TypeError, ValueError):
        pass
    used = 0.0
    for stage_file in (Path(exp) / "runs").glob("iteration_*/input/stage.json"):
        data = _load_json(stage_file) or {}
        try:
            used += float(data.get("round_cost") or 0.0)
        except (TypeError, ValueError):
            continue
    return used


#: A round is an iteration: the baseline round is round 1, and each later round
#: is one performance pass plus (when it wins) the generalization retake inside
#: the same iteration, so a retake never consumes a round of its own.
ROUNDS_DEFAULT = 10
ROUNDS_MAX = 50

#: Cost guardrail, deliberately far above any real run: a judged pass costs 1.0
#: and a retake 0.5, so ROUNDS_MAX rounds of steady retakes still cost well under
#: this. It exists only so a pathological loop cannot spend forever.
COST_GUARDRAIL = 100.0


def _rounds_limit(cfg: ExperimentConfig) -> int:
    """How many rounds (iterations) this task may run — the form's "Rounds".

    ``max_iterations`` is still honoured for runs whose requirements were built
    before the form field was renamed; the default is ROUNDS_DEFAULT.
    """
    for key in ("rounds", "max_iterations"):
        raw = cfg.answers.get(key)
        if raw in (None, ""):
            continue
        try:
            return max(1, min(ROUNDS_MAX, int(raw)))
        except (TypeError, ValueError):
            continue
    return ROUNDS_DEFAULT


def _rounds_used_on_disk(exp: Path) -> float:
    """The judged-pass cost this experiment has already spent (1.0 / 0.5).

    Only used by the cost guardrail; the round *limit* is an iteration number.
    """
    stored = _load_json(Path(exp) / "run.json") or {}
    raw = stored.get("rounds_used")
    try:
        if raw is not None:
            return max(0.0, float(raw))
    except (TypeError, ValueError):
        pass
    used = 0.0
    for stage_file in (Path(exp) / "runs").glob("iteration_*/input/stage.json"):
        data = _load_json(stage_file) or {}
        try:
            used += float(data.get("round_cost") or 0.0)
        except (TypeError, ValueError):
            continue
    return used


def run_experiment(cfg: ExperimentConfig, *,
                   start_iteration: int = 1,
                   iterations_to_run: Optional[int] = None,
                   champion_iteration: Optional[int] = None) -> Path:
    """Run (or continue) the AHE outer loop.

    ``start_iteration`` > 1 resumes an existing experiment: the champion and
    previous-round state are rebuilt from disk (best_ever + the iteration
    artifacts) so a new generation of the harness can be evaluated against
    the already-measured champion without re-running earlier rounds.
    """
    exp = cfg.exp_dir
    (exp / "runs").mkdir(parents=True, exist_ok=True)
    cfg.dump_snapshot(exp / "config_snapshot.json")
    # Record the revision of the code this process loaded, so a later round can
    # tell "the operator changed the harness" from "nothing happened".
    loaded_revision = write_harness_revision(cfg.state_dir)
    _record_state(
        cfg, PREPARE,
        event="experiment_start" if start_iteration <= 1 else "experiment_resume",
        start_iteration=start_iteration,
        max_iterations=cfg.max_iterations,
        execution_mode=cfg.execution_mode,
        pool_source=cfg.pool_source,
        harness_revision=loaded_revision,
    )

    live_workspace = _seed_workspace(cfg)
    evaluator = build_evaluator(cfg.execution_mode)
    evolver = build_evolver(
        str(cfg.answers.get("evolve_mode") or "dry-run"),
        model=str(cfg.answers.get("evolve_model") or DEFAULT_EVOLVE_MODEL),
        timeout_seconds=float(cfg.answers.get("evolve_timeout_seconds") or 3600),
    )

    pool = _load_pool(cfg)
    # FLOW.md §1.1: a round is sized in whole waves of 4 questions. The
    # configured count is already normalized on load (config.py); this is the
    # second call site, where "no cap" means "the whole pool" and the pool size
    # itself is the only remaining source of a non-multiple count.
    budget = cfg.per_round_budget or (len(pool.all_ids()) if pool else 0)
    if budget > 0:
        budget = normalized_per_gate(budget)
    purposes: Dict[str, str] = {}
    selection_notes: List[str] = []
    prev_selected: List[str] = _load_ids(exp / LAST_SCORED_FILE)

    prev_results: Optional[Dict[str, Any]] = None
    champion_results: Optional[Dict[str, Any]] = None
    pending_confirmation = False
    best_ever: Dict[str, Any] = _load_json(exp / BEST_EVER_FILE) or {}

    if start_iteration > 1:
        # Resume: the champion is whichever generation best_ever recorded; its
        # measured results and the previous round's set come back from disk.
        # ``champion_iteration`` lets the caller pin the comparison baseline
        # explicitly (e.g. "compare iteration 3 against iteration 2").
        prev_results = _iteration_results(exp, start_iteration - 1)
        # The champion is the best *measured* generation among the ones that
        # were not rejected: a generation can hold the best result and still
        # not have been promoted in its own round (it needed confirmation, or
        # too few questions won). Comparing against "the last promoted
        # generation" would let a worse harness take the champion slot.
        measured = best_generation(load_generations(exp))
        champ_iter = int(champion_iteration
                         or (measured.iteration if measured else 0)
                         or best_ever.get("iteration")
                         or start_iteration - 1)
        if champion_iteration is None and measured is not None and measured.results:
            champion_results = dict(measured.results)
            best_ever = {
                "iteration": measured.iteration,
                "pass_rate": None,
                "snapshot_dir": measured.snapshot_dir or str(
                    exp / "runs" / f"iteration_{measured.iteration:03d}"
                    / "input" / "workspace"),
                "workspace_revision": measured.workspace_revision,
                "verdict": "BEST_MEASURED",
            }
            save_json(exp / BEST_EVER_FILE, best_ever)
        else:
            champion_results = _iteration_results(exp, champ_iter)
        if champion_iteration is not None:
            snapshot_dir = (exp / "runs" / f"iteration_{champ_iter:03d}"
                            / "input" / "workspace")
            scores = [row for row in _load_jsonl(exp / SCORES_FILE)
                      if int(row.get("iteration") or 0) == champ_iter]
            revision = ""
            manifest = _load_json(
                exp / "runs" / f"iteration_{champ_iter:03d}" / "evolve"
                / "change_manifest.json")
            if manifest:
                revision = str(manifest.get("workspace_revision") or "")
            best_ever = {
                "iteration": champ_iter,
                "pass_rate": (scores[-1].get("pass_rate") if scores else None),
                "snapshot_dir": str(snapshot_dir),
                "workspace_revision": revision,
                "verdict": "MANUAL_BASELINE",
            }
            save_json(exp / BEST_EVER_FILE, best_ever)
            save_json(exp / "champion_override.json",
                      {"champion_iteration": champ_iter,
                       "pinned_by": "resume --champion-iteration"})
            append_timeline(cfg.state_dir, "champion_baseline_pinned",
                            {"iteration": champ_iter})
        if not prev_selected:
            prev_selected = _load_ids(exp / LAST_SCORED_FILE)
        set_run(cfg.state_dir, finished=False, final_status=None)

    # Stop condition is re-read every round, so the WebUI can raise or lower
    # the target while the loop is running ("run to iteration N"). The hard
    # cap only bounds a runaway target.
    HARD_ITERATION_CAP = 50
    #: One HE run chases one promotable harness and stops when it gets one.
    #: The round budget keeps a run that never succeeds from going forever.
    max_rounds = max(1.0, COST_GUARDRAIL)

    # Variant table: what every operator is measured against. Seeded from the
    # existing pool (each operator's best known result) and only updated when a
    # harness is accepted and promoted, so the reference never drifts.
    variant_pool: Dict[str, Any] = {}
    variant_table: Dict[str, Any] = {"operators": {}, "groups": {}}
    if not _uses_variant_rounds(cfg):
        _announce_legacy_protocol(cfg, exp)
    if _uses_variant_rounds(cfg):
        pool_path = _question_pool_path(cfg)
        variant_pool = pool_instances(pool_path) if pool_path else {}
        variant_table = load_variant_table(exp, pool_path=pool_path)
        per_gate = normalized_per_gate(
            cfg.answers.get("questions_per_round")
            or cfg.answers.get("per_round_budget")
            or OPERATORS_PER_GATE)
        append_timeline(cfg.state_dir, "variant_table_ready", {
            "operators": len(variant_table.get("operators") or {}),
            "pool_operators": len(variant_pool),
            "harness_version": variant_table.get("harness_version"),
            "questions_per_gate": per_gate,
        })
        if not variant_pool:
            # Nothing to measure: fail loudly instead of spinning through the
            # round budget. This happens when the pool file is missing/empty.
            append_timeline(cfg.state_dir, "variant_pool_empty", {
                "pool": str(_question_pool_path(cfg) or cfg.pool_source)})
            _record_state(cfg, FINISHED, start_iteration,
                          event="variant_pool_empty")
            set_run(cfg.state_dir, final_status="no_question_pool")
            return _final_report(cfg)
        judgeable = _judgeable_ids(variant_pool, variant_table)
        if len(judgeable) < per_gate:
            # A round is a whole wave of 4 questions (FLOW.md §1.1). Drawing
            # fewer would silently change what the gate means: with 3 measured
            # operators "at least 75% win" becomes "all three must win". Say so
            # and stop instead of judging a round the pool cannot fill.
            append_timeline(cfg.state_dir, "variant_pool_too_small", {
                "pool": str(_question_pool_path(cfg) or cfg.pool_source),
                "judgeable": judgeable,
                "judgeable_count": len(judgeable),
                "questions_per_round": per_gate,
                "policy": ("a round is sized in whole waves of 4; add judgeable "
                           "operators (variant + baseline) to the pool or lower "
                           "the round size"),
            })
            _record_state(cfg, FINISHED, start_iteration,
                          event="variant_pool_too_small")
            set_run(cfg.state_dir, final_status="no_question_pool")
            return _final_report(cfg)
    # ``iterations_to_run`` is the *current call's* batch (the server resumes one
    # round at a time), not the run's bound: the bound is the form's "Rounds".
    fallback_end = start_iteration + (iterations_to_run or cfg.max_iterations) - 1
    while_end = max(fallback_end, start_iteration) + HARD_ITERATION_CAP
    iteration = start_iteration
    #: Round budget. A pass that judges the performance gate costs a full
    #: round; the generalization retake (the same harness handed to DKAO again
    #: with the frozen paper) costs half a round — the operator calls it
    #: "iteration 2.5". ``iteration`` therefore stays an integer (it names the
    #: ``runs/iteration_NNN`` directory) while this counter is fractional.
    # Reported cost of the judged passes so far (1.0 per performance pass, 0.5
    # per retake). It is bookkeeping for the guardrail below, not the run limit:
    # the limit is an iteration number.
    rounds_used = _rounds_used_on_disk(exp)
    rounds_limit = _rounds_limit(cfg)
    #: Round 1 could not measure the paper, so the run has no foundation and
    #: already ended: the tail below must not overwrite that verdict.
    baseline_stopped = False
    while iteration <= while_end:
        target = read_target_iterations(exp)
        set_run(cfg.state_dir, target_iterations=target, max_rounds=max_rounds,
                rounds_used=rounds_used)
        # The form's "Rounds" is the limit; the WebUI target can raise or lower
        # it for a live run. Either way the unit is a round = an iteration, so
        # round 10 means the run may start iteration 10 and no further.
        rounds_limit_now = max(1, int(target)) if target is not None else rounds_limit
        # The variant protocol counts rounds here; the legacy/pool path keeps its
        # historical "requested iterations" bound (its callers pass an explicit
        # batch and its rounds are not the same unit).
        if not _uses_variant_rounds(cfg) and iteration > fallback_end:
            break
        if iteration > rounds_limit_now:
            append_timeline(cfg.state_dir, "rounds_reached", {
                "iteration": iteration - 1, "rounds": rounds_limit_now,
                "target": target,
                "stage": "variant" if _uses_variant_rounds(cfg) else "legacy"})
            break
        if _uses_variant_rounds(cfg) and rounds_used >= max_rounds:
            # The cost guardrail tripped: far above any real run, it only stops
            # a pathological loop. The run limit is the form's "Rounds".
            append_timeline(cfg.state_dir, "round_budget_exhausted", {
                "rounds_used": rounds_used, "max_rounds": max_rounds,
                "rounds_limit": rounds_limit_now,
                "reason": "cost guardrail tripped"})
            set_run(cfg.state_dir, final_status="rounds_exhausted",
                    rounds_used=rounds_used)
            break
        # A pending retake means the previous performance stage passed: this
        # pass re-measures the frozen paper with the same harness bytes and
        # judges the generalization gate. Nothing else happens in it.
        pending_retake = (read_pending_generalization(exp)
                          if _uses_variant_rounds(cfg) else None)
        stage = round_stage(iteration=iteration, pending=pending_retake)
        #: Set when this pass produced its own gate decision (baseline and the
        #: generalization retake do): the frozen-champion decision engine must
        #: not run, and the loop steps on by itself.
        own_decision = False
        hist_index = len(load_generations(exp))
        iter_dir = exp / "runs" / f"iteration_{iteration:03d}"
        input_dir = iter_dir / "input"
        evolve_dir = iter_dir / "evolve"

        # --- select this round's instances ---------------------------------
        # Variant-driven rounds: the operators come from the question pool
        # (which already records each operator's current best), and they are
        # judged against the variant table instead of a frozen champion. This
        # is what makes "one HE run chases one promotable harness" work.
        if _uses_variant_rounds(cfg):
            # The round draws exactly the configured number of operators (a
            # multiple of the 4 HCUs): the count comes from the New Task form
            # and is never reduced to fit the cards. Whether a card is free is
            # DKAO's business — the child's engine waits on its own admission
            # gate — so a round is always the size the operator asked for.
            fit = {"requested": per_gate, "count": per_gate,
                   "free_devices": None, "reduced": False}
            draw_count = fit["count"] or per_gate
            reference_moved: List[str] = []
            if stage == STAGE_PERFORMANCE:
                # The baseline round may have raised the bar (its kernels go
                # straight into the pool); every later round has to see it.
                reference_moved = _reload_variant_baseline(
                    cfg, variant_pool, variant_table)
            round_questions = select_round_questions(
                iteration=iteration, table=variant_table,
                instances=variant_pool, state={"groups": group_state(variant_table)},
                count=draw_count, rng=_round_rng(cfg, iteration, stage)[0],
                pending=pending_retake)
            selected = list(round_questions["performance_ids"])
            purposes = {iid: "performance" for iid in selected}
            for iid in round_questions.get("generalization_ids") or []:
                purposes.setdefault(iid, "generalization")
            if stage == STAGE_GENERALIZATION:
                purposes = {iid: "generalization" for iid in selected}
            selection_notes = [
                {
                    STAGE_BASELINE: ("baseline round: measures the new run's "
                                     "generalization paper; judges no gate"),
                    STAGE_PERFORMANCE: ("performance gate: fresh random "
                                        "operators, judged against each "
                                        "operator's variant"),
                    STAGE_GENERALIZATION: ("generalization retake: the same "
                                           "harness handed to DKAO again with "
                                           "the frozen paper"),
                }.get(stage, "variant-driven round"),
                f"questions={len(selected)} (requested {fit['requested']})"]
            if reference_moved:
                selection_notes.append(
                    "variant reference refreshed from the baseline round's "
                    "kernels: " + ", ".join(reference_moved))
            # Fresh pool data also decides what DKAO warm-starts from, so the
            # retake and the performance stage always launch children against
            # the current best-known kernel.
            inst_budget = int(cfg.answers.get("default_rounds") or 5)
            instances = [
                _variant_instance_spec({"id": i, **dict(variant_pool[i])},
                                       budget_rounds=inst_budget)
                for i in selected if i in variant_pool]
            save_json(input_dir / "benchmark" / "scored_ids.json", selected)
            save_json(input_dir / "benchmark" / "purposes.json", {
                "iteration": iteration, "stage": stage,
                "purposes": purposes,
                "families": [], "rationale": "variant-driven selection",
                "notes": selection_notes,
                "generalization_ids": round_questions.get("generalization_ids"),
                "defines_paper": round_questions.get("defines_paper"),
            })
            save_json(exp / ROUND_QUESTIONS_FILE, {
                "iteration": iteration, "stage": stage,
                "performance_ids": selected,
                "generalization_ids": round_questions.get("generalization_ids"),
                "defines_paper": round_questions.get("defines_paper"),
            })
            save_json(input_dir / "stage.json", {
                "iteration": iteration, "stage": stage,
                "round_cost": {
                    # The baseline round judges nothing, so it costs nothing:
                    # the budget is spent on judged passes.
                    STAGE_BASELINE: 0.0,
                    STAGE_GENERALIZATION: GENERALIZATION_ROUND_COST,
                }.get(stage, PERFORMANCE_ROUND_COST),
                "rounds_used_before": rounds_used,
                "retake_of_iteration": (pending_retake or {}).get("iteration"),
            })
            prev_selected = list(selected)
            if round_questions.get("defines_paper"):
                # Persist the run's fixed generalization paper immediately: it
                # is the exam for the rest of the run, so it must survive even
                # if the baseline round is the last thing that happens.
                variant_table["groups"] = record_paper(
                    variant_table, iteration=iteration,
                    generalization_ids=round_questions["generalization_ids"],
                    performance_ids=selected)
                save_variant_table(exp, variant_table)
            append_timeline(cfg.state_dir, "variant_round_selection", {
                "iteration": iteration, "stage": stage,
                "performance_ids": selected,
                "generalization_ids": round_questions.get("generalization_ids"),
                "defines_paper": round_questions.get("defines_paper"),
                # Which draw this was: the seed is what makes "why these four
                # operators?" reproducible after the fact.
                "seed": _round_rng(cfg, iteration, stage)[1],
                "count": draw_count,
                "judgeable_in_pool": len(_judgeable_ids(variant_pool, variant_table)),
                "rounds_used": rounds_used,
            })
        elif pool is not None:
            plan = None
            if iteration > 1:
                prev_dir = iter_dir.parent / f"iteration_{iteration - 1:03d}"
                plan = load_round_plan(prev_dir / "evolve" / "round_plan.json")
            # Role-based selection: regression anchors + repair + a
            # cross-family generalisation probe, with family quota, overlap
            # and least-recently-used rotation. The evolve agent's picks are
            # honoured where they fit a role.
            rotation = load_rotation(exp)
            selection = select_questions(
                pool=pool,
                budget=budget or len(pool.all_ids()),
                prev_selected=prev_selected,
                prev_results=prev_results,
                plan=plan,
                rotation=rotation,
            )
            selected = selection.selected
            purposes = dict(selection.purposes)
            selection_notes = list(selection.notes)
            inst_budget = int(cfg.answers.get("default_rounds") or 5)
            instances = [
                _pool_instance_spec(pool.get(i), budget_rounds=inst_budget)
                for i in selected
            ]
            save_json(input_dir / "benchmark" / "scored_ids.json", selected)
            save_json(input_dir / "benchmark" / "purposes.json", {
                "iteration": iteration,
                "purposes": purposes,
                "families": selection.families,
                "rationale": selection.rationale,
                "notes": selection_notes,
            })
            save_json(exp / LAST_SCORED_FILE, selected)
            mark_selected(exp, selected, iteration)
            append_timeline(cfg.state_dir, "question_selection", {
                "iteration": iteration,
                "selected": selected,
                "purposes": purposes,
                "families": selection.families,
                "notes": selection_notes,
            })
            prev_selected = list(selected)
        else:
            instances = list(cfg.suite)

        # --- safety net: a malformed evolved harness rolls back immediately ---
        malformed = _harness_validate_error(live_workspace)
        if malformed and iteration > 1:
            best_dir = Path(str(best_ever.get("snapshot_dir", "")))
            if best_dir.is_dir():
                replace_tree(best_dir, live_workspace)
                best_rev = best_ever.get("workspace_revision")
                if best_rev:
                    subprocess.run(
                        ["git", "reset", "--hard", str(best_rev)],
                        cwd=live_workspace, check=True,
                        stdout=subprocess.DEVNULL,
                    )
            save_json(iter_dir / "rollback.json", {
                "iteration": iteration,
                "verdict": "REJECT",
                "action": "RESTORE_CHAMPION",
                "reason": f"harness malformed: {malformed}",
                "restored_from": str(best_dir),
            })
            save_json(input_dir / "decision.json", {
                "iteration": iteration,
                "verdict": "REJECT",
                "action": "RESTORE_CHAMPION",
                "reason": f"harness malformed: {malformed}",
            })
            # end the experiment early: champion restored and recorded
            break

        # --- snapshot + evaluate the live workspace ------------------------
        snapshot = input_dir / "workspace"
        copy_tree(live_workspace, snapshot)
        _record_state(cfg, EVALUATE, iteration, event="iteration_start",
                      stage=stage,
                      selected=list(selected) if pool is not None else
                      [i.id for i in instances])

        # The evaluator hands every question to its own DKAO child. Which stage
        # this is decides only where those children live on disk — the retake
        # gets its own directory so it is a fresh DKAO job, not a continuation
        # of the performance stage's optimization. DKAO itself is untouched.
        cfg.answers["round_stage"] = stage
        results = evaluator.evaluate(cfg, snapshot, iteration, instances=instances)
        stop = _stop_requested(exp)
        if stage == STAGE_BASELINE and _uses_variant_rounds(cfg):
            # The baseline round is the run's foundation: it judges no gate, but
            # it owes one usable measurement per operator (those kernels set the
            # bar every later round has to clear, and the paper is the run's
            # exam). Nothing — a crashed child, DKAO's own measurement gate
            # refusing the cards, a missing report — may be papered over.
            verdict = baseline_round_verdict(results, selected)
            if stop or verdict["status"] != "PASS":
                reason = (str(stop.get("reason")) if stop
                          else "; ".join(verdict.get("reasons") or []))
                append_timeline(cfg.state_dir, "round_failed", {
                    "iteration": iteration, "stage": stage,
                    "reason": reason or "baseline round failed",
                    "failed": verdict.get("failed"),
                })
                save_json(input_dir / "benchmark" / "results.json", {
                    "iteration": iteration, "results": results,
                    "round_failed": reason or "baseline round failed",
                })
                _record_state(cfg, ANALYZE, iteration,
                              event="baseline_round_failed")
                _baseline_stop(cfg, exp, iteration=iteration, verdict=verdict)
                baseline_stopped = True
                break
        if stop:
            append_timeline(cfg.state_dir, "round_failed", {
                "iteration": iteration, "stage": stage,
                "reason": str(stop.get("reason") or "stop requested"),
                "detail": {k: v for k, v in stop.items() if k != "iteration"},
            })
            try:
                (exp / "stop_requested.json").unlink()
            except OSError:
                pass
            save_json(input_dir / "benchmark" / "results.json", {
                "iteration": iteration, "results": results,
                "round_failed": str(stop.get("reason") or "stop requested"),
            })
            if _uses_variant_rounds(cfg):
                if stage == STAGE_GENERALIZATION:
                    # The retake is spent: a failed retake is a failed
                    # candidate, so the frozen request is cleared and the next
                    # pass is a normal round again. Its budget was already spent
                    # when it was launched.
                    clear_pending_generalization(exp)
                else:
                    rounds_used += PERFORMANCE_ROUND_COST
                _record_state(cfg, ANALYZE, iteration,
                              event="round_failed_retry",
                              rounds_used=rounds_used)
                iteration += 1
                continue
            _record_state(cfg, FINISHED, iteration, event="stop_requested",
                          **{k: v for k, v in stop.items() if k != "iteration"})
            set_run(cfg.state_dir,
                    final_status=str(stop.get("reason") or "stopped"))
            break

        # --- variant stages: baseline, then performance, then generalization -
        # Every comparison is against each operator's *current variant* (the
        # best kernel the variant pool holds). Which gates run depends on the
        # stage:
        #   baseline       — judges nothing; its faster kernels go into the
        #                    variant pool so later rounds have a real bar;
        #   performance    — fresh random operators, performance gate only;
        #   generalization — the *same* harness handed to DKAO a second time
        #                    with the frozen paper, generalization gate only.
        # Only a generalization pass that wins parks the candidate for a human.
        if _uses_variant_rounds(cfg):
            perf_ids = list(selected)
            perf_gate: Optional[Dict[str, Any]] = None
            general_gate: Optional[Dict[str, Any]] = None
            mechanism: Dict[str, Any] = {}
            baseline_promotion: Optional[Dict[str, Any]] = None
            reference_moved: List[str] = []

            if stage == STAGE_BASELINE:
                # The baseline round owes evidence, not a verdict.
                baseline_verdict = baseline_round_verdict(results, perf_ids)
                if baseline_verdict["status"] != "PASS":
                    _baseline_stop(cfg, exp, iteration=iteration,
                                   verdict=baseline_verdict)
                    _record_state(cfg, ANALYZE, iteration,
                                  event="baseline_round_failed")
                    break
                # Faster kernels are a kernel fact, not a harness verdict: they
                # enter the variant pool immediately, so every later gate — and
                # DKAO's own warm start — compares against what this round
                # achieved. Nothing about the *harness* moves here.
                baseline_promotion = _promote_baseline_kernels(
                    cfg, exp, variant_pool, results)
                record_variants(
                    exp, variant_table, results,
                    version=str(variant_table.get("harness_version") or "seed"),
                    iteration=iteration,
                    groups=variant_table.get("groups"))
                reference_moved = sorted(
                    f"{u['operator_id']} ({u.get('previous_best_us')} -> "
                    f"{u.get('median_us')} us)"
                    for u in ((baseline_promotion or {}).get("updated") or []))
                save_json(input_dir / "baseline_round.json", {
                    "iteration": iteration, "stage": stage,
                    "verdict": baseline_verdict,
                    "pool_promotion": baseline_promotion,
                    "reference_moved": reference_moved,
                })
                append_timeline(cfg.state_dir, "baseline_round_measured", {
                    "iteration": iteration,
                    "operators": perf_ids,
                    "pool_promoted": reference_moved,
                    "paper": perf_ids,
                })

            if stage != STAGE_BASELINE:
                # One gate per stage. The performance stage judges the fresh
                # draw; the generalization stage judges the paper it was
                # launched to re-measure.
                kind = ("generalization" if stage == STAGE_GENERALIZATION
                        else "performance")
                gate = evaluate_gate(kind=kind, operator_ids=perf_ids,
                                     results=results, table=variant_table,
                                     instances=variant_pool)
                gate["iteration"] = iteration
                gate["stage"] = stage
                if kind == "performance":
                    perf_gate = gate
                    save_json(input_dir / "performance_gate.json", gate)
                    # The round's own results, where every reader of this run
                    # expects them (the WebUI, resume, and the round review).
                    save_json(input_dir / "benchmark" / "results.json",
                              {"iteration": iteration, "stage": stage,
                               "results": results})
                else:
                    general_gate = gate
                    save_json(input_dir / "generalization_gate.json", gate)
                    save_json(input_dir / "benchmark"
                              / "generalization_results.json",
                              {"iteration": iteration, "results": results})
                    save_json(input_dir / "benchmark" / "results.json",
                              {"iteration": iteration, "stage": stage,
                               "results": results})
                append_timeline(cfg.state_dir, f"{kind}_gate", {
                    "iteration": iteration, "stage": stage,
                    "status": gate["status"], "wins": gate["wins"],
                    "wins_needed": gate["wins_needed"],
                    "below_floor": gate["below_floor"],
                    "unmeasured": gate["unmeasured"],
                    "operators": gate["operators"],
                    **({"paper": perf_ids}
                       if kind == "generalization" else {}),
                })

            # Mechanism gate (observability, lenient): a harness change must say
            # *why* it should help and produce evidence for it. A contradicted
            # mechanism does not veto an accepted win — the counter gates do
            # that — but it is recorded, so "we promoted it and cannot explain
            # it" is visible instead of silent.
            if stage != STAGE_BASELINE:
                mechanism = _mechanism_gate_for_round(cfg, exp, iteration)

            if stage != STAGE_BASELINE and gate.get("status") == "INCOMPLETE":
                # The round drew questions but did not measure all of them, and
                # the missing ones still leave the outcome open. There is no
                # verdict to reach: judging here would blame the harness for a
                # number the machine never produced — and on the retake it would
                # spend the candidate on it. Record it as an incomplete round and
                # try again; a frozen retake stays frozen, because the paper is
                # still owed a judgement.
                append_timeline(cfg.state_dir, "round_incomplete", {
                    "iteration": iteration,
                    "stage": stage,
                    "gate": ("generalization" if stage == STAGE_GENERALIZATION
                             else "performance"),
                    "unmeasured": gate["unmeasured"],
                    "measured": sorted(set(results) - set(gate["unmeasured"])),
                    "reasons": gate["reasons"],
                    "rounds_used": rounds_used,
                    "policy": ("no harness verdict this round; the missing "
                               "questions are measured in a later pass"),
                })
                if stage != STAGE_GENERALIZATION:
                    # A fresh round was spent, verdict or not.
                    rounds_used += PERFORMANCE_ROUND_COST
                restore_promoted_harness(cfg, exp, live_workspace)
                _record_state(cfg, ANALYZE, iteration,
                              event="round_incomplete",
                              stage=stage,
                              unmeasured=gate["unmeasured"],
                              rounds_used=rounds_used)
                iteration += 1
                continue

            both_passed = bool(
                stage == STAGE_GENERALIZATION and general_gate
                and general_gate["status"] == "PASS")
            if stage == STAGE_BASELINE:
                verdict, action = "BASELINE_MEASURED", "ITERATE"
                reason = ("baseline round: the paper was measured and the "
                          "faster kernels entered the variant pool; no gate is "
                          "judged this round")
            elif both_passed:
                verdict, action = "PROMOTE_CANDIDATE", "AWAIT_APPROVAL"
                reason = ("performance and generalization gates passed; "
                          "waiting for human approval before publishing the "
                          "harness to DKAO")
            elif stage == STAGE_GENERALIZATION:
                verdict, action = "REJECT", "RESTORE_CHAMPION"
                reason = ("generalization gate "
                          f"{(general_gate or {}).get('status')}")
            else:
                verdict, action = "REJECT", "RESTORE_CHAMPION"
                reason = f"performance gate {(perf_gate or {}).get('status')}"
            decision = {
                "iteration": iteration,
                "stage": stage,
                "round_cost": {
                    STAGE_BASELINE: 0.0,
                    STAGE_GENERALIZATION: GENERALIZATION_ROUND_COST,
                }.get(stage, PERFORMANCE_ROUND_COST),
                "verdict": verdict,
                "action": action,
                "reason": reason,
                "performance_gate": perf_gate,
                "generalization_gate": general_gate,
                "mechanism_gate": mechanism,
                "baseline_promotion": baseline_promotion,
                "variant_reference": {
                    iid: {"median_us": row.get("median_us"),
                          "source": row.get("variant_source")}
                    for iid, row in ((perf_gate or general_gate or {})
                                     .get("comparison", {})
                                     .get("per_instance") or {}).items()
                },
            }
            save_json(input_dir / "decision.json", decision)
            # The baseline round answers to no gate, so the legacy decision
            # engine (which compares against a frozen champion) has nothing to
            # say about it and must not overwrite this verdict.
            own_decision = stage == STAGE_BASELINE
            score_row = pass_rate(results)
            with (exp / SCORES_FILE).open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    **score_row, "iteration": iteration, "stage": stage,
                    "rounds_used": rounds_used,
                    "decision_pass_rate": score_row.get("pass_rate"),
                    "ts": time.time(),
                }, ensure_ascii=False) + "\n")
            _record_state(cfg, ANALYZE, iteration, event="iteration_decision",
                          stage=stage,
                          verdict=decision["verdict"],
                          action=decision["action"],
                          rounds_used=rounds_used,
                          performance_gate=(perf_gate or {}).get("status"),
                          generalization_gate=(general_gate or {}).get("status"),
                          mechanism_gate=mechanism.get("status"))
            if both_passed:
                # The harness that just proved itself is the one parked for
                # approval: the revision frozen when the retake was scheduled,
                # and the round number that *won* the performance gate — the
                # retake is half a round, not a round of its own.
                write_pending_promotion(
                    exp, iteration=int(pending_retake.get("iteration")
                                       or iteration),
                    revision=(pending_retake.get("harness_revision")
                              or _head_revision(live_workspace)),
                    snapshot_dir=str(snapshot),
                    performance_gate=perf_gate or general_gate or {},
                    generalization_gate=general_gate,
                    results=results)
                set_run(cfg.state_dir, final_status="awaiting_approval",
                        rounds_used=rounds_used)
                append_timeline(cfg.state_dir, "awaiting_approval", {
                    "iteration": iteration,
                    "performance_wins": (pending_retake.get("performance_wins")
                                         or []),
                    "generalization_wins": general_gate["wins"],
                })
                return _final_report(cfg)
            if stage == STAGE_PERFORMANCE:
                # The performance gate passed: do NOT re-measure the paper in
                # this pass. Freeze the retake — same harness bytes, the paper's
                # operators — and let the next pass hand that job to DKAO.
                if (perf_gate or {}).get("status") == "PASS":
                    pending = write_pending_generalization(
                        exp, iteration=iteration,
                        harness_revision=_head_revision(live_workspace),
                        snapshot_dir=str(snapshot),
                        operator_ids=round_questions.get("generalization_ids")
                        or perf_ids,
                        performance_gate=perf_gate or {})
                    # Both halves are spent the moment the retake is launched:
                    # the empty half is a launch in which the whole frozen
                    # document is retested. Accounting for it here (rather than
                    # when the retake is judged) also keeps the budget honest on
                    # the run's last pass, which ends inside the retake.
                    rounds_used += (PERFORMANCE_ROUND_COST
                                    + GENERALIZATION_ROUND_COST)
                    append_timeline(cfg.state_dir, "generalization_retake_frozen", {
                        "iteration": iteration,
                        "operators": pending["operator_ids"],
                        "harness_revision": pending["harness_revision"],
                        "rounds_used": rounds_used,
                    })
                    # This pass is spent: the retake owns the next one. It runs
                    # as its own stage, with its own DKAO launch of the frozen
                    # paper on the very same harness bytes.
                    iteration += 1
                    continue
                rounds_used += PERFORMANCE_ROUND_COST
                restore_promoted_harness(cfg, exp, live_workspace)
                iteration += 1
                continue
            if stage == STAGE_GENERALIZATION:
                # The retake did not win: the candidate is spent, so the frozen
                # request is cleared and the next pass is a normal round again.
                # Its budget was already spent when it was launched.
                clear_pending_generalization(exp)
                restore_promoted_harness(cfg, exp, live_workspace)
                iteration += 1
                continue
            # The baseline round judges nothing and keeps the iteration: the
            # harness it just measured still has to evolve before the next
            # round can test it.
            iteration += 1
            continue
        # Pool mode owns the pass criterion: turn real/dry measurements into an
        # automatic family-baseline pass decision (no user threshold required).
        if pool is not None:
            for iid, result in results.items():
                median = result.get("median_us")
                if iid in pool.instances and isinstance(median, (int, float)):
                    auto = pool.auto_pass(
                        iid, float(median),
                        correctness_ok=bool(result.get("correctness_ok")),
                        p90_ok=bool(result.get("p90_ok")),
                    )
                    result["raw_evaluator_passed"] = result.get("passed")
                    result["passed"] = auto["passed"]
                    result["automatic_pass"] = auto
        save_json(input_dir / "benchmark" / "results.json", {
            "iteration": iteration,
            "results": results,
        })
        stats = pass_rate(results)

        # overlap decision stats (pool mode keeps decisions comparable)
        overlap_stats = None
        if prev_results is not None:
            overlap = {
                k: v for k, v in results.items() if k in prev_results
            }
            if overlap:
                overlap_stats = pass_rate(overlap)

        decision_rate = (
            float(overlap_stats["pass_rate"])
            if pool is not None and overlap_stats is not None
            else float(stats["pass_rate"])
        )
        _save_scores(cfg, {
            "iteration": iteration,
            **stats,
            "overlap_pass_rate": (
                overlap_stats["pass_rate"] if overlap_stats is not None else None
            ),
            "decision_pass_rate": decision_rate,
            "ts": time.time(),
        })

        diff = diff_results(prev_results, results)
        save_json(input_dir / "diff.json", diff)
        _write_overview(input_dir, iteration, results, diff)

        # --- change attribution for the PREVIOUS loop's manifest -----------
        prev_manifest = None
        if iteration > 1:
            prev_manifest = _load_json(
                (iter_dir.parent / f"iteration_{iteration - 1:03d}"
                 / "evolve" / "change_manifest.json")
            )
            if prev_manifest:
                save_json(
                    input_dir / "change_evaluation.json",
                    evaluate_changes(prev_manifest, diff),
                )

        # --- system-level decision engine ----------------------------------
        # Performance is primary; mechanism evidence explains a win but cannot
        # veto a repeated real improvement. Held-out inputs land in a later
        # adapter iteration; current v1 writes NOT_RUN when absent.
        # Mechanism gate: grade the previous loop's declared changes against
        # what the candidate iteration actually did (planner plan ids, the
        # harness revision children loaded, gate events).
        mechanism_checks_map = None
        if prev_manifest is not None:
            try:
                from .mechanism_checks import (
                    collect_candidate_evidence,
                    evaluate_changes as evaluate_mechanism_checks,
                )
                evidence = collect_candidate_evidence(
                    exp, iteration,
                    planner_enabled=_truthy(
                        cfg.answers.get("planner_enabled"), default=True),
                    candidate_workspace=snapshot,
                )
                mechanism_checks_map, mechanism_detail = (
                    evaluate_mechanism_checks(prev_manifest, evidence))
                save_json(input_dir / "mechanism_evidence.json", {
                    "iteration": iteration,
                    "evidence": evidence,
                    "checks": mechanism_checks_map,
                    "detail": mechanism_detail,
                })
            except Exception as exc:  # noqa: BLE001 - never break the loop
                append_timeline(cfg.state_dir, "mechanism_check_failed",
                                {"iteration": iteration, "error": repr(exc)})

        wired_violations: List[Dict[str, str]] = []
        try:
            previous_workspace = (
                exp / "runs" / f"iteration_{iteration - 1:03d}"
                / "input" / "workspace"
            )
            if iteration > 1 and previous_workspace.is_dir():
                wired_violations = _wired_scope_violations(
                    previous_workspace, live_workspace)
                if wired_violations:
                    append_timeline(cfg.state_dir,
                                    "harness_wired_scope_violation",
                                    {"iteration": iteration,
                                     "components": wired_violations})
        except Exception:  # noqa: BLE001 - advisory only
            wired_violations = []

        # No pairing is dropped for a shared device any more: HE does not watch
        # the cards, and DKAO's admission gate refuses to time a kernel on a
        # busy one in the first place (a blocked round produces no measurement
        # at all, which the round handles as an environment failure).
        comparison_candidate = results
        comparison_champion = champion_results

        if not own_decision:
            decision = decide(
                comparison_champion,
                comparison_candidate,
                manifest=prev_manifest,
                mechanism_checks=mechanism_checks_map,
                confirmation_reproduced=pending_confirmation,
                purposes=purposes,
                policy=DecisionPolicy(
                    mechanism_policy=str(
                        cfg.answers.get("mechanism_policy") or "lenient"),
                ),
            )
            decision.update({
                "iteration": iteration,
                "candidate_snapshot": str(snapshot),
                "decision_pass_rate": decision_rate,
                "wired_scope_violations": wired_violations,
            })
            save_json(input_dir / "decision.json", decision)
            champion_outcome = _record_champion_generation(
                cfg, exp, iteration=iteration, decision=decision,
                decision_rate=decision_rate, snapshot=snapshot,
                live_workspace=live_workspace, results=results,
                current=best_ever)
            best_ever = champion_outcome.get("best_ever", best_ever)
            _record_state(cfg, ANALYZE, iteration, event="iteration_decision",
                          verdict=decision["verdict"], action=decision["action"],
                          decision_pass_rate=decision_rate)
        try:
            if not _uses_variant_rounds(cfg):
                # Legacy path only: promote this round's kernels immediately.
                # Under the variant protocol nothing reaches production until a
                # harness is accepted and approved, so a rejected round must not
                # leave its kernels behind (operator rule: only the accepted
                # round's optimizations survive).
                _promote_iteration(cfg, exp, iteration, results, instances,
                                   freeze=(_variant_policy(cfg) == "freeze"))
            _track_best_known(cfg, exp, iteration, results)
        except Exception as exc:  # noqa: BLE001 - never break the outer loop
            append_timeline(cfg.state_dir, "kernel_promotion_failed",
                            {"iteration": iteration, "error": repr(exc)})

        # No circuit breaker: under the variant protocol a round that does not
        # beat the current variants is a normal outcome, and the run's budget
        # (max_rounds) is what bounds it. Stopping early on "three rejections"
        # would kill a run that was still making progress on its own terms.
        verdict = str(decision.get("verdict") or "")

        if own_decision:
            # The variant-round protocol decides for itself (see the gates
            # above): there is no frozen-champion action to take here. The
            # baseline round measured the paper and moved the variant pool; a
            # passing performance stage re-launches as the generalization
            # retake; a failing gate already restored the promoted harness.
            iteration += 1
            continue

        action = decision["action"]
        if action == "SET_CHAMPION":
            best_ever = {
                "iteration": iteration,
                "pass_rate": decision_rate,
                "snapshot_dir": str(snapshot),
                "workspace_revision": _head_revision(live_workspace),
                "verdict": decision["verdict"],
            }
            save_json(exp / BEST_EVER_FILE, best_ever)
            champion_results = dict(results)
            pending_confirmation = False
        elif action in {"RESTORE_CHAMPION", "KEEP_CHAMPION_ARCHIVE_CANDIDATE",
                        "ARCHIVE_SPECIALIZED"}:
            if action == "ARCHIVE_SPECIALIZED":
                copy_tree(snapshot, exp / "specialized" / f"iteration_{iteration:03d}")
            best_dir = Path(str(best_ever.get("snapshot_dir", "")))
            if best_dir.is_dir():
                replace_tree(best_dir, live_workspace)
                best_rev = best_ever.get("workspace_revision")
                if best_rev:
                    subprocess.run(
                        ["git", "reset", "--hard", str(best_rev)],
                        cwd=live_workspace, check=True,
                        stdout=subprocess.DEVNULL,
                    )
            disposition = {
                "iteration": iteration,
                "verdict": decision["verdict"],
                "action": action,
                "champion_snapshot": str(best_dir),
                "candidate_snapshot": str(snapshot),
                "reason": decision["reason"],
            }
            save_json(iter_dir / "candidate_disposition.json", disposition)
            # rollback.json is reserved for true reject/overfit, not no-signal.
            if decision["verdict"] in {"REJECT", "REJECT_OVERFIT"}:
                save_json(iter_dir / "rollback.json", disposition)
            pending_confirmation = False
        elif action == "ARCHIVE_AND_CONFIRM":
            # Leave the candidate live for one confirmation round; no champion
            # switch yet. A reproduced win can become PROMOTE_UNEXPLAINED.
            save_json(iter_dir / "candidate_disposition.json", {
                "iteration": iteration,
                "verdict": decision["verdict"],
                "action": action,
                "candidate_snapshot": str(snapshot),
                "reason": decision["reason"],
            })
            pending_confirmation = True

        # --- analyze -> evolve ---------------------------------------------
        # A confirmation round must retest the SAME candidate; do not let the
        # Evolve Agent mutate it between the first unexplained win and repeat.
        final_round = (
            (target is not None and iteration >= int(target))
            or (target is None and iteration >= fallback_end)
        )
        if final_round:
            # No next round exists to evaluate a new generation: evolving here
            # would leave an unverified harness behind.
            evolve_out = {
                "summary": (
                    f"# Final round — iteration {iteration}\n\n"
                    "Evolve skipped: the target round was reached, so no "
                    "unverified next generation is produced."
                ),
                "manifest": {
                    "schema_version": 1,
                    "iteration": iteration,
                    "changes": [],
                    "verification": {"status": "target_reached_skip_evolve"},
                },
                "round_plan": None,
                "changed": False,
            }
            append_timeline(cfg.state_dir, "evolve_skipped_final_round", {
                "iteration": iteration, "target": target,
                "fallback_end": fallback_end,
            })
        elif action == "ARCHIVE_AND_CONFIRM":
            evolve_out = {
                "summary": (
                    f"# Confirmation scheduled — iteration {iteration}\n\n"
                    "Candidate kept byte-identical for one repeat evaluation."
                ),
                "manifest": {
                    "schema_version": 1,
                    "iteration": iteration,
                    "changes": [],
                    "verification": {"status": "confirmation_pending"},
                },
                "round_plan": None,
                "changed": False,
            }
        else:
            evolve_out = evolver.apply(
                live_workspace, iteration,
                query_context={
                    "overview": str(input_dir / "analysis" / "overview.md"),
                    "results": results,
                    "diff": diff,
                    "decision": decision,
                    "selected": (list(selected) if pool is not None else
                                 [i.id for i in instances]),
                    "pool_ids": (pool.all_ids() if pool is not None else
                                 [i.id for i in instances]),
                },
            )
        _record_state(cfg, EVOLVE, iteration, event="evolve_start",
                      evolve_mode=cfg.answers.get("evolve_mode"))
        evolve_dir.mkdir(parents=True, exist_ok=True)
        revision = _commit_workspace(live_workspace, iteration)
        evolve_out["manifest"]["workspace_revision"] = revision
        save_json(evolve_dir / "change_manifest.json", evolve_out["manifest"])
        (evolve_dir / "evolve_summary.md").write_text(
            evolve_out["summary"] + "\n", encoding="utf-8"
        )
        if pool is not None:
            agent_plan = evolve_out.get("round_plan")
            if isinstance(agent_plan, dict):
                plan_obj = RoundPlan.from_dict(agent_plan)
                # Validate agent output immediately. The next iteration applies
                # the overlap/budget guardrail and can auto-fill if needed.
                pool.assert_in_pool(plan_obj.selected)
            else:
                plan_obj = RoundPlan(
                    iteration=iteration,
                    strategy="balanced",
                    rationale="dry-run default: keep same scored set",
                    selected=list(selected),
                )
            save_json(evolve_dir / "round_plan.json", plan_obj.to_dict())
        if evolve_out.get("changed"):
            copy_tree(live_workspace, evolve_dir / "workspace")

        prev_results = results
        iteration += 1

        # Round boundary: apply a code change instead of running another round
        # of stale logic. The supervisor/server restarts the process, which
        # records its own revision and resumes at this iteration.
        reload_reason = _code_reload_pending(cfg, loaded_revision)
        if reload_reason is not None:
            reload_reason["resumes_at_iteration"] = iteration
            reload_reason["finished_iteration"] = iteration - 1
            append_timeline(cfg.state_dir, "code_reload_deferred", reload_reason)
            _record_state(
                cfg, PREPARE, iteration - 1,
                event="code_reload_deferred",
                loaded_revision=reload_reason["loaded_revision"],
                on_disk_revision=reload_reason["on_disk_revision"],
                resumes_at_iteration=iteration,
            )
            set_run(cfg.state_dir,
                    final_status=f"code_reload_pending:{iteration}")
            return _final_report(cfg)

    if baseline_stopped:
        # The task already ended on the baseline round: report and stop without
        # touching final_status (which ``_baseline_stop`` owns).
        _record_state(cfg, REPORT, event="experiment_report")
        return _final_report(cfg)
    try:
        # Variant-round protocol promotes kernels through the pool (the baseline
        # round) and the approved round, never through the frozen-candidate
        # sweep: running it here would promote kernels from rejected rounds.
        if _variant_policy(cfg) == "freeze" and not _uses_variant_rounds(cfg):
            _finalize_promotion(cfg, exp)
    except Exception as exc:  # noqa: BLE001 - reporting must still happen
        append_timeline(cfg.state_dir, "final_promotion_failed",
                        {"error": repr(exc)})
    try:
        _write_round_review(cfg, exp)
    except Exception as exc:  # noqa: BLE001
        append_timeline(cfg.state_dir, "round_review_failed",
                        {"error": repr(exc)})
    _record_state(cfg, REPORT, event="experiment_report")
    report = _final_report(cfg)
    _record_state(cfg, FINISHED, event="experiment_finished")
    return report


def _final_report(cfg: ExperimentConfig) -> Path:
    exp = cfg.exp_dir
    lines = [
        "# harness_evolve report (AHE outer loop)",
        "",
        f"- task: {cfg.task_id}",
        f"- iterations: {cfg.max_iterations}",
        f"- execution_mode: {cfg.execution_mode}",
        f"- suite size: {len(cfg.suite)}",
        f"- pool_mode: {cfg.pool_mode}",
    ]
    best = _load_json(exp / BEST_EVER_FILE) or {}
    if best:
        lines.append(
            f"- best-ever: iteration {best.get('iteration')} "
            f"pass_rate {best.get('pass_rate')}"
        )
    lines.append("")
    lines.append("See runs/iteration_*/ for per-iteration artifacts.")
    report = exp / REPORT_FILE
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report
