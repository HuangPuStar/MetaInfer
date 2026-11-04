"""DSH-only trajectory ingestion and deterministic analysis.

This package is the MetaInfer-side home for trajectory capability.  It is
deliberately independent from the task plugins: a trajectory is a read-only
view over DSH session files, not a task that executes work.

The first slice only reads DSH v4 session JSONL files.  Additional sources are
out of scope by design; the platform is currently integrating DSH only.
"""

from .dsh import DSH_SESSION_VERSION, analyze_session, discover_session_files, sessions_root
from .service import TrajectoryService, get_service, reset_service

__all__ = [
    "DSH_SESSION_VERSION",
    "TrajectoryService",
    "analyze_session",
    "discover_session_files",
    "get_service",
    "reset_service",
    "sessions_root",
]
