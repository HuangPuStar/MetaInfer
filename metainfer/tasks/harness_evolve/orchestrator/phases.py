"""harness_evolve phases (state graph) for the shell."""

from __future__ import annotations

from typing import Any, Dict, List

PREPARE = "prepare"
EVALUATE = "evaluate"
ANALYZE = "analyze"
EVOLVE = "evolve"
REPORT = "report"
FINISHED = "finished"

_ORDER = [PREPARE, EVALUATE, ANALYZE, EVOLVE, REPORT, FINISHED]
_LABELS = {
    PREPARE: "Prepare",
    EVALUATE: "Evaluate",
    ANALYZE: "Analyze",
    EVOLVE: "Evolve",
    REPORT: "Report",
    FINISHED: "Finished",
}


def graph_payload(current: str, **_: Any) -> Dict[str, Any]:
    nodes = [
        {"id": phase, "label": _LABELS[phase], "is_terminal": phase == FINISHED}
        for phase in _ORDER
    ]
    edges = [
        {"from": _ORDER[i], "to": _ORDER[i + 1], "label": "ok",
         "outcomes": ["ok"]}
        for i in range(len(_ORDER) - 1)
    ]
    return {
        "current": current,
        "nodes": nodes,
        "edges": edges,
        "terminal_nodes": [FINISHED],
    }
