"""Shell router — type-agnostic endpoints for task CRUD, lifecycle, monitoring.

All routes are mounted at ``/api/sys-shell`` by ``create_app``. Each is
a relative-path endpoint (no ``/api/sys-shell`` prefix); the shell's
mount prefix carries it.

Moved here from ``metainfer/server/app.py`` so the shell is a true task
package alongside calc_value / gen_infer_framework.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from starlette.responses import StreamingResponse

from metainfer.server import launcher as _launcher
from metainfer.server import forms as _forms
from metainfer.server import paths as _paths
from metainfer.server import sse as _sse
from metainfer.server import state_reader as _sr
from metainfer.server import tasks as _tasks
from metainfer.server._helpers import (
    state_dir_for as _state_dir_for,
    task_or_404 as _task_or_404,
    workspace_dir_for as _workspace_dir_for,
)
from metainfer.server.registry import get as _get_web_plugin


def _plugin_view_hint(task_type: str) -> Dict[str, Any]:
    """Return the frontend detail-view hint fields for a task type.

    Plugins set ``detail_view_module`` (an importmap key) on their
    WebPlugin; the frontend uses it to dynamically dispatch the task
    detail view. Returns an empty dict when no plugin is registered for
    this task type (the frontend then renders its default view).
    """
    plugin = _get_web_plugin(task_type)
    if plugin is None or not plugin.detail_view_module:
        return {}
    return {
        "detail_view_module": plugin.detail_view_module,
        "detail_view_export": plugin.detail_view_export,
    }


def build_router(plugin):
    """Build and return the shell APIRouter with all type-agnostic routes.

    Called by ``create_app`` once at startup; the returned router is
    mounted at ``/api/sys-shell``.
    """
    router = APIRouter()

    # -- task types / forms ---------------------------------------------------
    @router.get("/task-types")
    def task_types() -> List[Dict[str, str]]:
        return _forms.list_task_types()

    @router.get("/task-types/{task_type}/schema")
    def task_type_schema(task_type: str) -> Dict[str, Any]:
        schema = _forms.load_form_schema(task_type)
        if schema is None:
            raise HTTPException(404, f"unknown task type: {task_type}")
        return schema

    # -- task listing / creation (no {task_id} in path) ------------------------
    @router.get("/tasks")
    def list_tasks() -> Dict[str, Any]:
        launcher = _launcher.get_default_launcher()
        out = []
        for e in _tasks.list_tasks():
            status = launcher.status(e.id).to_dict()
            out.append({
                "id": e.id, "type": e.type, "label": e.label,
                "state_dir": e.state_dir, "created_at": e.created_at,
                "launcher": e.launcher,
                "status": status,
                **_plugin_view_hint(e.type),
            })
        return {"tasks": out}

    # -- DSH trajectory analysis (read-only, source-agnostic shell surface) ----
    @router.get("/trajectories/health")
    def trajectory_health() -> Dict[str, Any]:
        from metainfer.trajectory import get_service

        return get_service().health()

    @router.post("/trajectories/config")
    async def trajectory_config(request: Request) -> Dict[str, Any]:
        from metainfer.trajectory import get_service, reset_service
        from metainfer.trajectory.config import write_config

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            write_config(str(body.get("root") or ""))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        reset_service()
        return get_service().health()

    @router.get("/trajectories")
    def list_trajectories(
        q: str = "", limit: int = 200, projectId: str = "", repoPath: str = ""
    ) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.annotations import read_annotation

        try:
            result = get_service().list_sessions(
                query=q, limit=limit, project_id=projectId, repo_path=repoPath
            )
            for session in result.get("sessions", []):
                annotation = read_annotation(session.get("id", ""))
                session["annotation"] = {
                    "outcome": annotation["outcome"],
                    "failureCategory": annotation["failureCategory"],
                    "updatedAt": annotation["updatedAt"],
                }
            return result
        except Exception as exc:  # noqa: BLE001 - surface a readable source error
            raise HTTPException(503, f"trajectory source unavailable: {exc}") from exc

    @router.get("/trajectories/curation")
    def trajectory_curation() -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.curation import curation_summary

        try:
            return curation_summary(get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"trajectory curation unavailable: {exc}") from exc

    @router.get("/trajectories/datasets")
    def trajectory_datasets() -> Dict[str, Any]:
        from metainfer.trajectory.curation import list_datasets

        return {"datasets": list_datasets()}

    @router.post("/trajectories/datasets")
    async def create_trajectory_dataset(request: Request) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.curation import create_dataset

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            return create_dataset(
                get_service(),
                str(body.get("name") or ""),
                include_uncertain=bool(body.get("includeUncertain")),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/datasets/{dataset_id}")
    def get_trajectory_dataset(dataset_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.curation import get_dataset

        try:
            return get_dataset(dataset_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/datasets/{dataset_id}/export")
    def export_trajectory_dataset(dataset_id: str) -> Response:
        from metainfer.trajectory.curation import get_dataset

        try:
            dataset = get_dataset(dataset_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            json.dumps(dataset, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{dataset_id}.json"'},
        )

    @router.get("/trajectories/proposals")
    def trajectory_proposals() -> Dict[str, Any]:
        from metainfer.trajectory.proposals import list_proposals

        return {"proposals": list_proposals()}

    @router.get("/trajectories/proposals/{proposal_id}")
    def get_trajectory_proposal(proposal_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.proposals import get_proposal

        try:
            return get_proposal(proposal_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/proposals/{proposal_id}/export")
    def export_trajectory_proposal(proposal_id: str) -> Response:
        from metainfer.trajectory.proposals import get_proposal

        try:
            proposal = get_proposal(proposal_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            proposal.get("markdown") or json.dumps(proposal, ensure_ascii=False, indent=2) + "\n",
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{proposal_id}.md"'},
        )

    @router.post("/trajectories/proposals/{proposal_id}/review")
    async def review_trajectory_proposal(proposal_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory.evaluation import list_evaluations
        from metainfer.trajectory.proposals import (
            ProposalGateError,
            get_proposal,
            review_proposal,
        )

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            proposal = get_proposal(proposal_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        dataset_id = proposal.get("datasetId")
        has_evaluation = any(
            item.get("datasetId") == dataset_id and item.get("rule") == "proposal_v1"
            for item in list_evaluations()
        )
        try:
            return review_proposal(
                proposal_id,
                str(body.get("status") or ""),
                str(body.get("reviewer") or ""),
                str(body.get("note") or ""),
                has_evaluation=has_evaluation,
            )
        except ProposalGateError as exc:
            raise HTTPException(409, str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/datasets/{dataset_id}/proposals")
    async def create_trajectory_proposal(dataset_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory.curation import get_dataset
        from metainfer.trajectory.proposals import create_proposal

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            dataset = get_dataset(dataset_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            return create_proposal(
                dataset,
                str(body.get("role") or ""),
                str(body.get("title") or ""),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/evaluations")
    def trajectory_evaluations() -> Dict[str, Any]:
        from metainfer.trajectory.evaluation import list_evaluations

        return {"evaluations": list_evaluations()}

    @router.get("/trajectories/evaluations/{evaluation_id}")
    def get_trajectory_evaluation(evaluation_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.evaluation import get_evaluation

        try:
            return get_evaluation(evaluation_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/evaluations/{evaluation_id}/export")
    def export_trajectory_evaluation(evaluation_id: str) -> Response:
        from metainfer.trajectory.evaluation import get_evaluation

        try:
            evaluation = get_evaluation(evaluation_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            json.dumps(evaluation, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{evaluation_id}.json"'},
        )

    @router.post("/trajectories/datasets/{dataset_id}/evaluations")
    async def create_trajectory_evaluation(dataset_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory.curation import get_dataset
        from metainfer.trajectory.evaluation import evaluate_and_save

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            dataset = get_dataset(dataset_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            return evaluate_and_save(dataset, str(body.get("rule") or "baseline_v1"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/skills")
    def trajectory_skills() -> Dict[str, Any]:
        from metainfer.trajectory.skills import list_skills

        return {"skills": list_skills()}

    @router.get("/trajectories/skills/{skill_id}")
    def get_trajectory_skill(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import get_skill

        try:
            return get_skill(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/skills/{skill_id}/export")
    def export_trajectory_skill(skill_id: str) -> Response:
        from metainfer.trajectory.skills import get_skill

        try:
            skill = get_skill(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            json.dumps(skill, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{skill_id}.json"'},
        )

    @router.post("/trajectories/proposals/{proposal_id}/skill")
    async def create_trajectory_skill(proposal_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory.proposals import get_proposal
        from metainfer.trajectory.skills import create_skill

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            proposal = get_proposal(proposal_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            return create_skill(proposal, str(body.get("name") or "") or None)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/versions")
    async def add_trajectory_skill_version(skill_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory.proposals import get_proposal
        from metainfer.trajectory.skills import add_version

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        proposal_id = str(body.get("proposalId") or "")
        try:
            proposal = get_proposal(proposal_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            return add_version(skill_id, proposal)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/versions/{version_number}/evaluate")
    async def evaluate_trajectory_skill(
        skill_id: str, version_number: int, request: Request
    ) -> Dict[str, Any]:
        from metainfer.trajectory.evaluation import get_evaluation, list_evaluations
        from metainfer.trajectory.skills import evaluate_skill_version, get_skill

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            skill = get_skill(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        version = next(
            (item for item in skill.get("versions", []) if int(item.get("version") or 0) == version_number),
            None,
        )
        if version is None:
            raise HTTPException(404, f"skill version not found: {skill_id} v{version_number}")
        dataset_id = version.get("datasetId")
        evaluation = None
        evaluation_id = str(body.get("evaluationId") or "")
        if evaluation_id:
            try:
                evaluation = get_evaluation(evaluation_id)
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
        else:
            candidates = [
                item for item in list_evaluations()
                if item.get("datasetId") == dataset_id and item.get("rule") == "proposal_v1"
            ]
            if candidates:
                try:
                    evaluation = get_evaluation(str(candidates[0].get("id")))
                except KeyError:
                    evaluation = None
        if evaluation is None:
            raise HTTPException(409, "run a proposal_v1 rubric evaluation for this dataset first")
        try:
            return evaluate_skill_version(skill_id, version_number, evaluation)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/regressions")
    def trajectory_regressions() -> Dict[str, Any]:
        from metainfer.trajectory.regression import list_regressions

        return {"regressions": list_regressions()}

    @router.get("/trajectories/regressions/{regression_id}")
    def get_trajectory_regression(regression_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.regression import get_regression

        try:
            return get_regression(regression_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/regressions/{regression_id}/export")
    def export_trajectory_regression(regression_id: str) -> Response:
        from metainfer.trajectory.regression import get_regression

        try:
            report = get_regression(regression_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{regression_id}.json"'},
        )

    @router.post("/trajectories/skills/{skill_id}/versions/{version_number}/regression")
    async def run_trajectory_skill_regression(
        skill_id: str, version_number: int, request: Request
    ) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.curation import get_dataset
        from metainfer.trajectory.regression import run_skill_regression, save_regression
        from metainfer.trajectory.skills import attach_agent_regression, get_skill

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            skill = get_skill(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        version = next(
            (item for item in skill.get("versions", []) if int(item.get("version") or 0) == version_number),
            None,
        )
        if version is None:
            raise HTTPException(404, f"skill version not found: {skill_id} v{version_number}")
        try:
            dataset = get_dataset(str(version.get("datasetId") or ""))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            max_items = int(body.get("maxItems") or 3)
        except (TypeError, ValueError):
            max_items = 3
        try:
            report = run_skill_regression(
                dataset, skill, version_number, get_service(), max_items=max_items
            )
            report = save_regression(report)
            updated = attach_agent_regression(skill_id, version_number, report)
            return {"report": report, "skill": updated}
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/releases")
    def trajectory_releases() -> Dict[str, Any]:
        from metainfer.trajectory.skills import list_releases

        return {"releases": list_releases()}

    @router.get("/trajectories/releases/{release_id}")
    def get_trajectory_release(release_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import get_release

        try:
            return get_release(release_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/trajectories/releases/{release_id}/export")
    def export_trajectory_release(release_id: str) -> Response:
        from metainfer.trajectory.skills import get_release

        try:
            release = get_release(release_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(
            json.dumps(release, ensure_ascii=False, indent=2) + "\n",
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{release_id}.json"'},
        )

    @router.post("/trajectories/skills/{skill_id}/versions/{version_number}/release")
    async def create_trajectory_release(
        skill_id: str, version_number: int, request: Request
    ) -> Dict[str, Any]:
        from metainfer.trajectory.skills import create_release

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            return create_release(
                skill_id,
                version_number,
                str(body.get("reviewer") or ""),
                str(body.get("note") or ""),
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/releases/{release_id}/activate")
    def activate_trajectory_skill(skill_id: str, release_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import activate_release

        try:
            return activate_release(skill_id, release_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/rollback")
    def rollback_trajectory_skill(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import rollback_skill

        try:
            return rollback_skill(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/releases/{release_id}/apply-runtime")
    async def apply_trajectory_runtime_skill(
        skill_id: str, release_id: str, request: Request
    ) -> Dict[str, Any]:
        from metainfer.trajectory.skills import apply_runtime_release

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            percent = int(body.get("canaryPercent") or 100)
        except (TypeError, ValueError):
            raise HTTPException(400, "canaryPercent must be an integer")
        try:
            return apply_runtime_release(skill_id, release_id, percent)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/skills/{skill_id}/promotion-readiness")
    def trajectory_promotion_readiness(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.canary import promotion_readiness

        try:
            return promotion_readiness(skill_id, get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"promotion readiness unavailable: {exc}") from exc

    @router.post("/trajectories/skills/{skill_id}/promote-runtime")
    async def promote_trajectory_runtime_skill(skill_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.canary import promotion_readiness
        from metainfer.trajectory.skills import promote_runtime

        try:
            readiness = promotion_readiness(skill_id, get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"promotion readiness unavailable: {exc}") from exc
        if not readiness.get("ready"):
            raise HTTPException(409, "; ".join(readiness.get("reasons") or ["canary gate failed"]))
        try:
            return promote_runtime(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/rollback-runtime")
    def rollback_trajectory_runtime_skill(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import rollback_runtime

        try:
            return rollback_runtime(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/skills/{skill_id}/canary")
    def trajectory_skill_canary(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.canary import canary_report

        try:
            return canary_report(skill_id, get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"canary evidence unavailable: {exc}") from exc

    @router.post("/trajectories/skills/{skill_id}/releases/{release_id}/apply-lab")
    async def apply_trajectory_lab_skill(
        skill_id: str, release_id: str, request: Request
    ) -> Dict[str, Any]:
        from metainfer.trajectory.skills import apply_lab_runtime_release

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            percent = int(body.get("canaryPercent") or 100)
        except (TypeError, ValueError):
            raise HTTPException(400, "canaryPercent must be an integer")
        try:
            return apply_lab_runtime_release(skill_id, release_id, percent)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/skills/{skill_id}/lab-promotion-readiness")
    def trajectory_lab_promotion_readiness(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.canary import lab_promotion_readiness

        try:
            return lab_promotion_readiness(skill_id, get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"Lab promotion readiness unavailable: {exc}") from exc

    @router.post("/trajectories/skills/{skill_id}/promote-lab")
    async def promote_trajectory_lab_skill(skill_id: str, request: Request) -> Dict[str, Any]:
        from metainfer import trajectory as _trajectory
        from metainfer.trajectory.canary import lab_promotion_readiness
        from metainfer.trajectory.skills import promote_lab_runtime

        try:
            readiness = lab_promotion_readiness(skill_id, _trajectory.get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"Lab promotion readiness unavailable: {exc}") from exc
        if not readiness.get("ready"):
            raise HTTPException(409, "; ".join(readiness.get("reasons") or ["Lab canary gate failed"]))
        try:
            return promote_lab_runtime(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post("/trajectories/skills/{skill_id}/rollback-lab")
    def rollback_trajectory_lab_skill(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory.skills import rollback_lab_runtime

        try:
            return rollback_lab_runtime(skill_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/trajectories/skills/{skill_id}/lab-canary")
    def trajectory_skill_lab_canary(skill_id: str) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.canary import lab_canary_report

        try:
            return lab_canary_report(skill_id, get_service())
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"lab canary evidence unavailable: {exc}") from exc

    @router.get("/trajectories/{session_id}")
    def get_trajectory(session_id: str) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.annotations import read_annotation

        try:
            session = get_service().get_session(session_id)
            session["annotation"] = read_annotation(session_id)
            return session
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"trajectory read failed: {exc}") from exc

    @router.post("/trajectories/{session_id}/annotation")
    async def annotate_trajectory(session_id: str, request: Request) -> Dict[str, Any]:
        from metainfer.trajectory import get_service
        from metainfer.trajectory.annotations import write_annotation

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            get_service().get_session(session_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, f"trajectory read failed: {exc}") from exc
        try:
            return write_annotation(session_id, body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/agent-backend")
    def get_agent_backend() -> Dict[str, Any]:
        from metainfer.server.agent_settings import BACKENDS, dsh_home, read_settings

        settings = read_settings()
        profile_path = dsh_home() / "profiles" / str(settings.get("dshProfile") or "")
        return {
            **settings,
            "backends": list(BACKENDS),
            "dshProfilePath": str(profile_path),
            "dshProfileExists": profile_path.is_dir(),
        }

    @router.post("/agent-backend")
    async def set_agent_backend(request: Request) -> Dict[str, Any]:
        from metainfer.server.agent_settings import write_settings

        try:
            body = await request.json()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, "request body must be valid JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        try:
            settings = write_settings(
                str(body.get("backend") or ""),
                str(body.get("dshBin") or ""),
                str(body.get("dshProfile") or ""),
            )
            profile_info = None
            if settings.get("backend") == "dsh":
                from metainfer.server.agent_settings import ensure_dsh_profile
                profile_info = ensure_dsh_profile(str(settings.get("dshProfile") or ""))
            return {**settings, "profile": profile_info}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get("/{task_id}")
    def get_task(task_id: str) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        sd = _state_dir_for(entry)
        launcher = _launcher.get_default_launcher()
        return {
            "id": entry.id, "type": entry.type, "label": entry.label,
            "state_dir": entry.state_dir, "created_at": entry.created_at,
            "launcher": entry.launcher,
            "status": launcher.status(task_id).to_dict(),
            "requirements": _sr.read_requirements(sd),
            "run": _sr.read_run(sd),
            **_plugin_view_hint(entry.type),
        }

    @router.delete("/{task_id}")
    def delete_task(task_id: str, purge: bool = False) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        launcher = _launcher.get_default_launcher()
        if launcher.status(task_id).running:
            launcher.kill(task_id, force=True)
        removed_files = False
        if purge:
            import shutil
            sd = Path(entry.state_dir)
            if sd.exists():
                shutil.rmtree(sd, ignore_errors=True)
                removed_files = True
            wd = _workspace_dir_for(entry)
            if wd.exists():
                shutil.rmtree(wd, ignore_errors=True)
                removed_files = True
        _tasks.remove_task(task_id)
        return {"removed_from_registry": True, "purged_files": removed_files}

    @router.get("/{task_id}/run")
    def task_run(task_id: str) -> Dict[str, Any]:
        """RunStatus only — convenience for clients that don't need the
        full task envelope. Same file as ``get_task()['run']``."""
        entry = _task_or_404(task_id)
        return _sr.read_run(_state_dir_for(entry))

    @router.post("/tasks")
    async def create_task(request: Request) -> Dict[str, Any]:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 — malformed JSON
            raise HTTPException(400, "request body must be valid JSON")
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        task_type = body.get("type")
        label = body.get("label") or ""
        answers = body.get("answers") or {}
        extra_args = body.get("extra_args") or []
        if not task_type:
            raise HTTPException(400, "missing 'type'")
        # Validate against schema before doing anything destructive.
        v = _forms.validate_submission(task_type, answers)
        if not v["ok"]:
            raise HTTPException(400, detail={"errors": v["errors"]})
        # Generate a unique task id.
        task_id = _tasks.gen_task_id(task_type, label)
        sd = _paths.task_dir(task_id)
        sd.mkdir(parents=True, exist_ok=True)
        # Workspace dir holds task-package-generated artifacts (each task
        # type owns its own workspace subtree); state_dir holds metadata + logs.
        wd = _paths.workspace_dir(task_id)
        wd.mkdir(parents=True, exist_ok=True)
        # Build the requirements.json the orchestrator will read.
        _plugin = _get_web_plugin(task_type)
        _default_label = (_plugin.label if _plugin else "") or task_type
        requirements = {
            "task_id": task_id,
            "task_type": task_type,
            "raw_request": body.get("raw_request") or "",
            "label": label or _default_label,
            **answers,
        }
        # Register first (so list view picks it up even if spawn fails).
        entry = _tasks.TaskEntry(
            id=task_id, type=task_type, label=label or _default_label,
            state_dir=str(sd), workspace_dir=str(wd),
            created_at=time.time(), launcher="local",
        )
        _tasks.add_task(entry)
        # Spawn the orchestrator.
        launcher = _launcher.get_default_launcher()
        try:
            pid = launcher.start(task_id, requirements, sd, wd, extra_args=extra_args)
        except Exception as e:  # noqa: BLE001
            # Spawn failed — stamp orchestrator.pid with finished_at so
            # launcher.status() reports not-running. Process state lives
            # only in orchestrator.pid (SSOT); registry holds identity.
            pf = sd / "orchestrator.pid"
            try:
                import json as _json
                data = _json.dumps({
                    "pid": None,
                    "task_id": task_id,
                    "finished_at": time.time(),
                    "exit_hint": "spawn-failed",
                }, indent=2)
                tmp = pf.with_suffix(".tmp")
                tmp.write_text(data, encoding="utf-8")
                tmp.replace(pf)
            except OSError:
                pass
            raise HTTPException(500, detail={"error": f"spawn failed: {e!r}"})
        return {"task_id": task_id, "pid": pid,
                "state_dir": str(sd), "workspace_dir": str(wd)}

    @router.post("/{task_id}/control")
    async def control_task(task_id: str, request: Request) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        body = await request.json()
        action = body.get("action")
        launcher = _launcher.get_default_launcher()
        if action == "kill":
            force = bool(body.get("force", False))
            ok = launcher.kill(task_id, force=force)
            return {"ok": ok, "action": "kill", "force": force}
        if action == "restart":
            sd = _state_dir_for(entry)
            req = _sr.read_requirements(sd)
            if req is None:
                raise HTTPException(400, "no requirements.json to restart from")
            prior_status = launcher.status(task_id).to_dict()
            prior_run = _sr.read_run(sd) or {}
            _sr.append_timeline_event(sd, "restart_initiated", {
                "task_id": task_id,
                "prior_pid": prior_status.get("pid"),
                "prior_running": prior_status.get("running"),
                "prior_phase": prior_run.get("current"),
                "prior_iteration": prior_run.get("iteration_count")
                                or prior_run.get("iteration"),
                "prior_outcome": prior_run.get("outcome"),
                "resume_mode": "preserve_state",
            })
            if prior_status.get("running"):
                launcher.kill(task_id, force=True)
                await asyncio.sleep(0.5)
            wd = _workspace_dir_for(entry)
            pid = launcher.start(task_id, req, sd, wd)
            return {
                "ok": True, "action": "restart", "pid": pid,
                "prior_status": prior_status,
            }
        if action == "reset":
            if launcher.status(task_id).running:
                raise HTTPException(
                    409, "task is still running; kill it before resetting",
                )
            sd = _state_dir_for(entry)
            prior_run = _sr.read_run(sd) or {}
            tid = prior_run.get("task_id") or task_id
            wd = _workspace_dir_for(entry)
            summary = _sr.reset_state_dir(sd, wd, tid)
            return {"ok": True, "action": "reset", **summary}
        raise HTTPException(400, f"unknown action: {action}")

    # -- per-task shell data ---------------------------------------------------

    @router.get("/{task_id}/timeline")
    def task_timeline(task_id: str, since: float = 0.0) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        return {"events": _sr.read_timeline(_state_dir_for(entry), since=since)}

    @router.get("/{task_id}/agents")
    def task_agents(task_id: str) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        return _sr.read_agents(_state_dir_for(entry))

    @router.get("/{task_id}/agents/{agent_name}/tail")
    def task_agent_tail(task_id: str, agent_name: str, max_events: int = 50) -> Dict[str, Any]:
        """Tail of one agent's recent stream-json activity.

        Lets the operator see what an agent is currently doing (text
        responses, tool calls) without SSHing in to read the raw log.
        Returns 404 if the agent isn't in agents.json (finished agents
        not in the current snapshot, or wrong name).
        """
        entry = _task_or_404(task_id)
        out = _sr.read_agent_tail(_state_dir_for(entry), agent_name, max_events)
        if not out.get("found"):
            raise HTTPException(
                status_code=404,
                detail=f"agent {agent_name!r} not in current agents.json snapshot",
            )
        return out

    @router.get("/{task_id}/token-budget")
    def task_token_budget(task_id: str) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        budget_path = _state_dir_for(entry) / "token_budget.json"
        if not budget_path.exists():
            return {"configured": False}
        try:
            data = json.loads(budget_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {"configured": False, "error": "budget file unreadable"}
        cfg = data.get("config") or {}
        totals = data.get("totals") or {}
        used = float(totals.get("total_cost_usd", 0.0))
        limit = cfg.get("max_cost_usd")
        hard = cfg.get("max_cost_usd_hard")
        exhausted = bool(totals.get("exhausted"))
        hard_exhausted = bool(totals.get("hard_exhausted"))
        pct = None
        if isinstance(limit, (int, float)) and limit > 0:
            pct = round(min(100.0, (used / float(limit)) * 100.0), 2)
        return {
            "configured": True,
            "used_cost_usd": used,
            "limit_cost_usd": limit,
            "hard_limit_cost_usd": hard,
            "exhausted": exhausted,
            "hard_exhausted": hard_exhausted,
            "used_pct": pct,
            "agent_count": int(totals.get("agent_count", 0)),
            "total_input_tokens": int(totals.get("total_input_tokens", 0)),
            "total_output_tokens": int(totals.get("total_output_tokens", 0)),
            "total_cache_read_input_tokens": int(
                totals.get("total_cache_read_input_tokens", 0)),
            "per_source": data.get("per_source") or {},
            "per_phase": data.get("per_phase") or {},
        }

    @router.post("/{task_id}/token-budget")
    def task_token_budget_update(task_id: str, body: dict) -> Dict[str, Any]:
        entry = _task_or_404(task_id)
        sd = _state_dir_for(entry)
        budget_path = sd / "token_budget.json"
        if budget_path.exists():
            try:
                data = json.loads(budget_path.read_text(encoding="utf-8"))
            except (ValueError, OSError) as exc:
                raise HTTPException(500, f"cannot read budget file: {exc}")
        else:
            data = {
                "schema_version": 1,
                "config": {},
                "totals": {
                    "total_cost_usd": 0.0,
                    "total_input_tokens": 0,
                    "total_output_tokens": 0,
                    "total_cache_read_input_tokens": 0,
                    "agent_count": 0,
                    "exhausted": False,
                    "hard_exhausted": False,
                },
                "per_source": {},
                "per_phase": {},
                "records": [],
            }
        if not isinstance(data, dict):
            data = {}
        cfg = data.setdefault("config", {})
        if not isinstance(cfg, dict):
            cfg = {}
            data["config"] = cfg
        body = body or {}
        if "max_cost_usd" in body:
            v = body["max_cost_usd"]
            cfg["max_cost_usd"] = (float(v) if v is not None else None)
        if "max_cost_usd_hard" in body:
            v = body["max_cost_usd_hard"]
            cfg["max_cost_usd_hard"] = (float(v) if v is not None else None)
        totals = data.setdefault("totals", {})
        if not isinstance(totals, dict):
            totals = {}
            data["totals"] = totals
        totals.setdefault("total_cost_usd", 0.0)
        used = float(totals.get("total_cost_usd", 0.0))
        soft = cfg.get("max_cost_usd")
        hard = cfg.get("max_cost_usd_hard")
        totals["exhausted"] = bool(
            isinstance(soft, (int, float)) and used >= soft)
        totals["hard_exhausted"] = bool(
            isinstance(hard, (int, float)) and used >= hard)
        tmp = budget_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        from metainfer.server.filelock import lock_file
        with lock_file(budget_path):
            tmp.replace(budget_path)
        os.utime(budget_path)
        return task_token_budget(task_id)

    @router.get("/{task_id}/log")
    def task_log(task_id: str, tail_bytes: int = 65536) -> Dict[str, Any]:
        """Tail of the orchestrator's stdout+stderr log."""
        entry = _task_or_404(task_id)
        p = _state_dir_for(entry) / "orchestrator.log"
        if not p.exists():
            return {"content": "", "truncated": False}
        try:
            data = p.read_bytes()
        except OSError:
            return {"content": "", "truncated": False}
        truncated = len(data) > tail_bytes
        if truncated:
            data = data[-tail_bytes:]
        return {
            "content": data.decode("utf-8", errors="replace"),
            "truncated": truncated,
        }

    # -- SSE stream ------------------------------------------------------------
    @router.get("/events")
    async def events(request: Request) -> StreamingResponse:
        await _sse.watcher.start()
        q = await _sse.watcher.subscribe()

        async def gen():
            try:
                # Initial hello so the client knows the stream is alive.
                yield "event: hello\ndata: {}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15.0)
                        yield f"event: {ev['type']}\ndata: {json.dumps(ev)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                await _sse.watcher.unsubscribe(q)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    return router
