"""FastAPI router for evalscope-correctness.

Routes mounted under ``/api/evalscope-correctness/{task_id}``:

    GET /result   → normalized result.json (204 when not yet available)

We deliberately expose only this one fixed endpoint. There is no route that
takes a free-form filename or streams raw prediction content — the raw
EvalScope artifacts stay on disk in the workspace.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from metainfer.server._helpers import (
    require_task_type,
    state_dir_for,
    task_or_404,
)
from . import _state_readers

PLUGIN_TYPE = "evalscope-correctness"


def build_router(plugin) -> APIRouter:
    router = APIRouter()

    @router.get("/result")
    def get_result(task_id: str):
        entry = task_or_404(task_id)
        require_task_type(entry, PLUGIN_TYPE)
        data = _state_readers.read_result(state_dir_for(entry))
        if data is None:
            raise HTTPException(404, "result not yet available")
        return data

    return router
