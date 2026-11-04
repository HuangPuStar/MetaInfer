"""Trajectory service: discovery, caching and summary/detail shaping."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import source_root
from .dsh import analyze_session, discover_session_files
from .links import infer_context


def _summary(session: Dict[str, Any]) -> Dict[str, Any]:
    # The list view needs metrics, not the full audit trail or event histogram.
    return {
        key: value
        for key, value in session.items()
        if key not in ("timeline", "eventTypes", "warnings", "path", "file")
    }


class TrajectoryService:
    """Read-only DSH trajectory index.

    A single instance is cheap; every operation is derived from files on disk.
    The cache is keyed by path + mtime + size so a growing DSH session is picked
    up on the next request without a separate watcher.
    """

    def __init__(self, root: Optional[Path] = None, cache_limit: int = 256) -> None:
        if root is None:
            resolved, source = source_root()
            self.root = resolved
            self.root_source = source
        else:
            self.root = Path(root)
            self.root_source = "explicit"
        self.cache_limit = max(1, int(cache_limit))
        self._cache: Dict[str, Tuple[int, int, Dict[str, Any]]] = {}
        self._lock = threading.Lock()

    def _analyze_cached(self, path: Path) -> Dict[str, Any]:
        try:
            stat = path.stat()
            key = str(path)
            signature = (int(stat.st_mtime * 1000), int(stat.st_size))
            with self._lock:
                cached = self._cache.get(key)
                if cached is not None and cached[0] == signature[0] and cached[1] == signature[1]:
                    return cached[2]
            session = analyze_session(path)
            session["context"] = infer_context(session)
            with self._lock:
                self._cache[key] = (signature[0], signature[1], session)
                while len(self._cache) > self.cache_limit:
                    self._cache.pop(next(iter(self._cache)))
            return session
        except Exception as exc:  # noqa: BLE001 - one bad file must not hide the rest
            raise RuntimeError(f"{path}: {exc}") from exc

    def list_sessions(
        self,
        query: str = "",
        limit: int = 200,
        project_id: str = "",
        repo_path: str = "",
    ) -> Dict[str, Any]:
        files, warnings = discover_session_files(self.root)
        sessions: List[Dict[str, Any]] = []
        errors: List[str] = []
        needle = str(query or "").strip().lower()
        project = str(project_id or "").strip()
        repo = str(repo_path or "").strip()
        for path in files:
            try:
                session = self._analyze_cached(path)
            except Exception as exc:  # noqa: BLE001
                errors.append(str(exc))
                continue
            context = session.get("context") or {}
            if project:
                cwd = str(session.get("cwd") or "")
                matches_project = (
                    str(context.get("projectId") or "") == project
                    or f"/worktrees/{project}/" in cwd
                    or (bool(repo) and (cwd == repo or cwd.startswith(repo.rstrip("/") + "/")))
                )
                if not matches_project:
                    continue
            haystack = " ".join(
                str(session.get(key) or "")
                for key in ("id", "title", "cwd", "agentPreset", "model", "provider")
            ) + " " + " ".join(str(context.get(key) or "") for key in ("label", "projectId", "nodeId", "taskId"))
            haystack += " " + " ".join(
                str(item.get("releaseId") or "")
                for item in (session.get("skillOverlays") or [])
                if isinstance(item, dict)
            )
            haystack = haystack.lower()
            if needle and needle not in haystack:
                continue
            sessions.append(_summary(session))
        sessions.sort(key=lambda item: int(item.get("updatedAt") or 0), reverse=True)
        try:
            safe_limit = max(1, min(int(limit), 1000))
        except (TypeError, ValueError):
            safe_limit = 200
        return {
            "root": str(self.root),
            "count": len(sessions),
            "total": len(files),
            "sessions": sessions[:safe_limit],
            "warnings": warnings + errors,
        }

    def get_session(self, session_id: str) -> Dict[str, Any]:
        wanted = str(session_id or "").strip()
        if not wanted:
            raise KeyError("session id is empty")
        files, _warnings = discover_session_files(self.root)
        for path in files:
            if path.parent.name == wanted:
                return self._analyze_cached(path)
            try:
                session = self._analyze_cached(path)
            except Exception:  # noqa: BLE001 - keep looking for the id
                continue
            if session.get("id") == wanted:
                return session
        raise KeyError(f"trajectory not found: {wanted}")

    def health(self) -> Dict[str, Any]:
        files, warnings = discover_session_files(self.root)
        zstd_available = False
        try:
            from .dsh import zstd_available as _zstd_available
            zstd_available = _zstd_available()
        except Exception:  # noqa: BLE001
            zstd_available = False
        return {
            "source": "dsh",
            "root": str(self.root),
            "rootSource": self.root_source,
            "exists": self.root.is_dir(),
            "sessionFiles": len(files),
            "zstdAvailable": zstd_available,
            "warnings": warnings,
        }


_default_service: Optional[TrajectoryService] = None
_default_lock = threading.Lock()


def get_service() -> TrajectoryService:
    global _default_service
    with _default_lock:
        if _default_service is None:
            _default_service = TrajectoryService()
        return _default_service


def reset_service() -> None:
    global _default_service
    with _default_lock:
        _default_service = None
