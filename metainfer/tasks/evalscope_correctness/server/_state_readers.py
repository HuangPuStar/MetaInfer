"""State-dir readers for evalscope-correctness.

Reads only the authoritative normalized result from
``<state_dir>/result.json``. Raw EvalScope artifacts live under the
workspace and are intentionally NOT served through an unbounded API
response — they stay on disk as immutable evidence. We read one fixed
file, so this module stays trivially small and safe.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional


def read_result(state_dir: Path) -> Optional[Dict[str, Any]]:
    """Return the parsed ``result.json`` or ``None`` if not yet written /
    malformed.

    ``None`` is indistinguishable to the caller from "not ready", which is
    exactly what we want for a task whose result appears once at the end of
    a run.
    """
    path = state_dir / "result.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    return data
