"""Link a DSH session to the MetaInfer task / research-lab node it belongs to.

DSH sessions only carry a cwd and optional parent session; the platform can
derive a stable context from path conventions without writing anything into the
source session.  This is a read-only projection used by the list and detail API.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Optional

from metainfer.server import paths as _paths

_LAB_WORKTREE = re.compile(
    r"(?:^|/)metainfer-research-lab/worktrees/(?P<project>prj-[A-Za-z0-9_-]+)/(?P<node>n-[A-Za-z0-9_-]+)(?:/|$)"
)


def infer_context(session: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    cwd = str(session.get("cwd") or "").strip()
    if not cwd:
        return None
    normalized = cwd.replace("\\", "/").rstrip("/")

    match = _LAB_WORKTREE.search(normalized)
    if match:
        project = match.group("project")
        node = match.group("node")
        return {
            "kind": "research-lab",
            "projectId": project,
            "nodeId": node,
            "label": f"{project} / {node}",
        }

    try:
        workspaces = _paths.workspaces_root().resolve()
        candidate = Path(cwd).resolve()
        relative = candidate.relative_to(workspaces)
    except (OSError, ValueError):
        relative = None
    if relative is not None and relative.parts:
        task_id = relative.parts[0]
        if task_id:
            return {
                "kind": "metainfer-task",
                "taskId": task_id,
                "label": task_id,
            }

    preset = str(session.get("agentPreset") or "")
    if preset.startswith("lab-") or preset in ("lab-controller", "lab-worker"):
        return {
            "kind": "research-lab",
            "label": preset,
        }
    return None
