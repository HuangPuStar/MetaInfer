"""FastAPI router for opt-kernel.

Borrowed from gen-infer-framework — same iteration/charts/state-graph/QA endpoints.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from metainfer.server._helpers import (
    require_task_type,
    state_dir_for,
    task_or_404,
    workspace_dir_for,
)
from metainfer.server.qa_routes import register_qa_routes

from . import _state_readers
from ..orchestrator import feedback

PLUGIN_TYPE = "opt-kernel"


class FeedbackBody(BaseModel):
    """Body for the operator-feedback POST endpoint."""
    text: str


def build_router(plugin) -> APIRouter:
    router = APIRouter()

    @router.get("/iterations")
    def ok_iterations(task_id: str) -> list:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_iterations(state_dir_for(entry))

    @router.get("/iterations/{n}")
    def ok_iteration_detail(task_id: str, n: int) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        rec = _state_readers.read_iteration(state_dir_for(entry), n)
        if rec is None:
            raise HTTPException(404, f"no iteration {n} for task {task_id}")
        return rec

    @router.get("/iterations/{n}/retrospective")
    def ok_retrospective(task_id: str, n: int) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_retrospective(state_dir_for(entry), n)

    @router.get("/iterations/{n}/reviews")
    def ok_reviews(task_id: str, n: int) -> Dict[str, Any]:
        """Return the dual-reviewer output (review-A.md, review-B.md, merged)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_reviews(state_dir_for(entry), n)

    @router.get("/iterations/{n}/profile")
    def ok_profile(task_id: str, n: int) -> Dict[str, Any]:
        """Return the perf profile data (perf_report.json + rocprof artifacts)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_profile(state_dir_for(entry), n,
                                            workspace_dir_for(entry))

    @router.get("/charts")
    def ok_charts(task_id: str) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_charts(state_dir_for(entry))

    @router.get("/state-graph")
    def ok_state_graph(task_id: str) -> Dict[str, Any]:
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_state_graph(state_dir_for(entry))

    @router.get("/ahe")
    def ok_ahe(task_id: str) -> Dict[str, Any]:
        """AHE (falsifiable predictions + agent debugger) artifacts.

        Read-only view of the two advisory loops: per-iteration
        prediction-vs-actual verdicts (``change_evaluation.json`` /
        ``predictions.json``) and the cross-iteration debugger overview
        (``analysis/overview.md``). All derived; perf SSOT is
        ``perf_report.json``.
        """
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_ahe(state_dir_for(entry),
                                        workspace_dir_for(entry))

    @router.get("/ahe/detail/{n}")
    def ok_ahe_detail(task_id: str, n: int) -> Dict[str, Any]:
        """One iteration's agent-debugger detail markdown (lazy-loaded)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        return _state_readers.read_ahe_detail(state_dir_for(entry), n,
                                                workspace_dir_for(entry))

    @router.get("/feedback")
    def ok_feedback_list(task_id: str) -> Dict[str, Any]:
        """Return all operator feedback entries (oldest first)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        items = feedback.read_feedback(state_dir_for(entry))
        return {"entries": items, "count": len(items)}

    @router.post("/feedback")
    def ok_feedback_post(task_id: str, body: FeedbackBody) -> Dict[str, Any]:
        """Append one operator opinion (persistent guidance for the run)."""
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        sd = state_dir_for(entry)
        cur_iter = _state_readers._read_run(sd).get("current_iteration")
        try:
            written = feedback.append_feedback(sd, body.text, cur_iter)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True, "entry": written,
                "count": len(feedback.read_feedback(sd))}

    register_qa_routes(router, plugin, prefix="/qa")

    return router
