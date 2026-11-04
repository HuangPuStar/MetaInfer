"""Read and deterministically analyze DSH v4 session files.

The parser is intentionally tolerant at the read boundary (partial trailing
lines and unrecognised event types are recorded as warnings) but strict about
the facts it asserts: every event needs a sequence, timestamp and type; token
usage is only summed when the session actually contains usage records.

No model is called from this module.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

DSH_SESSION_VERSION = 4
SESSION_FILE_RE = re.compile(r"^session\.v(\d+)\.jsonl(?:\.zst|\.zstd)?$")
_MAX_TEXT = 4000
SKILL_MARKER = re.compile(r"METAINFER_SKILL_RELEASE:([A-Za-z0-9._-]+)(?:;ROLE:([A-Za-z0-9._-]+))?")
_MAX_TIMELINE = 800


def sessions_root() -> Path:
    """Resolve the DSH sessions directory (env override or ``~/.dsh/sessions``)."""

    configured = os.environ.get("DSH_SESSIONS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".dsh" / "sessions").resolve()


def _ms(value: Any) -> Optional[int]:
    """Normalize an epoch timestamp to milliseconds when possible."""

    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not (number == number and number not in (float("inf"), float("-inf"))):
        return None
    if number > 10_000_000_000:  # already milliseconds
        return int(number)
    return int(number * 1000)


def _text_from_content(content: Any) -> str:
    """Extract human-readable text from a DSH content block list."""

    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        if content.get("type") == "text" and isinstance(content.get("text"), str):
            return content["text"]
        return ""
    if not isinstance(content, list):
        return ""
    parts: List[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(part for part in parts if part)


def _clip(value: str, limit: int = _MAX_TEXT) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _event_reason(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    reason = data.get("reason")
    if isinstance(reason, str):
        return reason
    if isinstance(reason, dict):
        kind = reason.get("kind")
        if isinstance(kind, str):
            return kind
    return ""


def _read_text(path: Path) -> str:
    """Read a plain or zstd-compressed DSH JSONL file."""

    if path.suffix in {".zst", ".zstd"}:
        return _zstd_decompress(path.read_bytes()).decode("utf-8")
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# zstd through the system libzstd (ctypes).  MetaInfer deliberately has no
# compiled Python dependencies, and DSH writes sessions as zstd frames.
# --------------------------------------------------------------------------- #

_ZSTD_LIB: Any = None
_ZSTD_LOAD_TRIED = False


class _ZstdInBuffer(ctypes.Structure):
    _fields_ = [("src", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


class _ZstdOutBuffer(ctypes.Structure):
    _fields_ = [("dst", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


def _zstd_library() -> Any:
    global _ZSTD_LIB, _ZSTD_LOAD_TRIED
    if _ZSTD_LOAD_TRIED:
        return _ZSTD_LIB
    _ZSTD_LOAD_TRIED = True
    library = ctypes.util.find_library("zstd") or "libzstd.so.1"
    try:
        lib = ctypes.CDLL(library)
    except OSError:
        _ZSTD_LIB = None
        return None
    lib.ZSTD_createDStream.restype = ctypes.c_void_p
    lib.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_freeDStream.restype = ctypes.c_size_t
    lib.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_initDStream.restype = ctypes.c_size_t
    lib.ZSTD_decompressStream.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_ZstdOutBuffer),
        ctypes.POINTER(_ZstdInBuffer),
    ]
    lib.ZSTD_decompressStream.restype = ctypes.c_size_t
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    lib.ZSTD_isError.restype = ctypes.c_uint
    lib.ZSTD_getErrorName.argtypes = [ctypes.c_size_t]
    lib.ZSTD_getErrorName.restype = ctypes.c_char_p
    _ZSTD_LIB = lib
    return lib


def zstd_available() -> bool:
    return _zstd_library() is not None


def _zstd_decompress(data: bytes) -> bytes:
    if not data:
        return b""
    lib = _zstd_library()
    if lib is None:
        raise RuntimeError("libzstd is not available; cannot read compressed DSH sessions")

    source = ctypes.create_string_buffer(data)
    in_buffer = _ZstdInBuffer(ctypes.cast(source, ctypes.c_void_p), len(data), 0)
    stream = lib.ZSTD_createDStream()
    if not stream:
        raise RuntimeError("ZSTD_createDStream failed")
    chunks: List[bytes] = []
    try:
        result = lib.ZSTD_initDStream(stream)
        if lib.ZSTD_isError(result):
            raise RuntimeError(lib.ZSTD_getErrorName(result).decode("utf-8", "replace"))
        while True:
            output = ctypes.create_string_buffer(1 << 20)
            out_buffer = _ZstdOutBuffer(ctypes.cast(output, ctypes.c_void_p), len(output), 0)
            before_input = in_buffer.pos
            result = lib.ZSTD_decompressStream(stream, ctypes.byref(out_buffer), ctypes.byref(in_buffer))
            if lib.ZSTD_isError(result):
                # A writer may be mid-frame.  Keep the complete prefix rather
                # than hiding the session entirely.
                if chunks:
                    break
                raise RuntimeError(lib.ZSTD_getErrorName(result).decode("utf-8", "replace"))
            if out_buffer.pos:
                chunks.append(output.raw[: out_buffer.pos])
            if result == 0:
                if in_buffer.pos >= in_buffer.size:
                    break
                # DSH may append multiple frames to one session file.
                init = lib.ZSTD_initDStream(stream)
                if lib.ZSTD_isError(init):
                    raise RuntimeError(lib.ZSTD_getErrorName(init).decode("utf-8", "replace"))
                continue
            # No input progress and no flushed output means a truncated frame.
            if in_buffer.pos >= in_buffer.size and out_buffer.pos == 0 and in_buffer.pos == before_input:
                break
    finally:
        lib.ZSTD_freeDStream(stream)
    return b"".join(chunks)


def read_session_rows(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[str]]:
    """Read header + events from one DSH session file.

    A truncated final line (the writer may be mid-append) is dropped with a
    warning rather than failing the whole session.
    """

    warnings: List[str] = []
    text = _read_text(path)
    raw_lines = text.splitlines()
    rows: List[Dict[str, Any]] = []
    for index, line in enumerate(raw_lines):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            if index == len(raw_lines) - 1:
                warnings.append("dropped a truncated trailing JSON line")
                continue
            raise ValueError(f"invalid JSON at line {index + 1}")
        if not isinstance(row, dict):
            raise ValueError(f"line {index + 1} is not a JSON object")
        rows.append(row)
    if not rows:
        raise ValueError("empty session file")
    header = rows[0]
    if header.get("type") != "session" or header.get("version") != DSH_SESSION_VERSION:
        raise ValueError("unsupported session: expected a v4 session header")
    if not isinstance(header.get("id"), str) or header["id"] == "":
        raise ValueError("session header is missing id")

    events: List[Dict[str, Any]] = []
    expected = 0
    for row in rows[1:]:
        if not isinstance(row.get("type"), str) or "seq" not in row or "time" not in row:
            warnings.append("ignored an event with an invalid envelope")
            continue
        try:
            seq = int(row["seq"])
        except (TypeError, ValueError):
            warnings.append("ignored an event with a non-numeric seq")
            continue
        if seq != expected:
            warnings.append(f"non-contiguous event sequence: expected {expected}, got {seq}")
            expected = seq
        events.append(row)
        expected = seq + 1
    return header, events, warnings


def _tool_name(value: Any) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "unknown"


def _tool_arguments(value: Any) -> str:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return _clip(json.dumps(parsed, ensure_ascii=False, sort_keys=True))
        except Exception:  # noqa: BLE001 - plain string arguments are valid
            return _clip(value)
    if isinstance(value, dict):
        return _clip(json.dumps(value, ensure_ascii=False, sort_keys=True))
    return ""


def analyze_session(path: Path) -> Dict[str, Any]:
    """Project one DSH session into a compact, UI-friendly analysis document."""

    path = Path(path)
    header, events, warnings = read_session_rows(path)
    created_at = _ms(header.get("createdAt"))
    file_mtime = path.stat().st_mtime * 1000

    title = ""
    preset = header.get("agentPreset") if isinstance(header.get("agentPreset"), str) else ""
    provider = ""
    model = ""
    reasoning_effort = ""
    event_types: Dict[str, int] = {}
    turns = 0
    steps = 0
    user_messages = 0
    assistant_messages = 0
    assistant_text_entries = 0
    tool_calls = 0
    tool_errors = 0
    structured_output = False
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    total_tokens = 0
    stop_reason = ""
    status = "incomplete"
    timeline: List[Dict[str, Any]] = []
    skill_overlays: List[Dict[str, str]] = []
    calls: Dict[str, Dict[str, Any]] = {}
    tool_stats: Dict[str, Dict[str, Any]] = {}
    first_time: Optional[int] = created_at
    last_time: Optional[int] = created_at
    max_seq = 0

    for event in events:
        event_type = str(event.get("type") or "")
        event_time = _ms(event.get("time"))
        event_types[event_type] = event_types.get(event_type, 0) + 1
        try:
            seq = int(event.get("seq", 0))
        except (TypeError, ValueError):
            seq = 0
        max_seq = max(max_seq, seq)
        if event_time is not None:
            first_time = event_time if first_time is None else min(first_time, event_time)
            last_time = event_time if last_time is None else max(last_time, event_time)
        data = event.get("data") if isinstance(event.get("data"), dict) else {}

        if event_type == "session/title":
            candidate = data.get("title")
            if isinstance(candidate, str) and candidate.strip():
                title = candidate.strip()
            continue

        if event_type == "agent-preset/selected":
            value = data.get("agentPreset")
            if isinstance(value, str) and value.strip():
                preset = value.strip()
            continue

        if event_type == "subagent/descriptor":
            candidate = data.get("agentProvider")
            if isinstance(candidate, str) and candidate:
                provider = candidate
            candidate = data.get("agentModel")
            if isinstance(candidate, str) and candidate:
                model = candidate
            candidate = data.get("agentReasoningEffort")
            if isinstance(candidate, str) and candidate:
                reasoning_effort = candidate
            continue

        if event_type == "request/header":
            config = data.get("header", {}).get("config", {}) if isinstance(data.get("header"), dict) else {}
            if isinstance(config, dict):
                if not provider and isinstance(config.get("provider"), str):
                    provider = config["provider"]
                if not model and isinstance(config.get("model"), str):
                    model = config["model"]
                if not reasoning_effort and isinstance(config.get("reasoningEffort"), str):
                    reasoning_effort = config["reasoningEffort"]
            continue

        if event_type == "turn/start":
            turns += 1
            if len(timeline) < _MAX_TIMELINE:
                timeline.append({
                    "seq": seq, "time": event_time, "turn": data.get("turn"), "step": None,
                    "type": "turn_start", "title": "Turn started", "text": "",
                })
            continue

        if event_type == "turn/end":
            reason = _event_reason(data)
            stop_reason = reason or stop_reason
            status = "completed" if reason == "completed" else ("aborted" if reason == "aborted" else "error")
            if len(timeline) < _MAX_TIMELINE:
                timeline.append({
                    "seq": seq, "time": event_time, "turn": data.get("turn"), "step": None,
                    "type": "turn_end", "title": "Turn ended", "text": reason,
                })
            continue

        if event_type == "step/start":
            steps += 1
            continue

        if event_type == "user/message":
            source = data.get("source") if isinstance(data.get("source"), dict) else {}
            source_kind = str(source.get("kind") or "")
            text = _text_from_content(data.get("content"))
            # Runtime/time snapshots are model context, not human turns.
            if source_kind not in ("user", ""):
                continue
            user_messages += 1
            for match in SKILL_MARKER.finditer(text):
                release_id, role = match.group(1), match.group(2) or ""
                if not any(item["releaseId"] == release_id for item in skill_overlays):
                    skill_overlays.append({"releaseId": release_id, "role": role})
            visible_text = re.sub(r"<!--\s*-->", "", SKILL_MARKER.sub("", text)).strip()
            if visible_text and len(timeline) < _MAX_TIMELINE:
                timeline.append({
                    "seq": seq, "time": event_time, "turn": data.get("turn"), "step": data.get("step"),
                    "type": "user", "title": "User", "text": _clip(visible_text),
                })
            continue

        if event_type == "assistant/message":
            assistant_messages += 1
            message = data.get("message") if isinstance(data.get("message"), dict) else {}
            message_source = message.get("source") if isinstance(message.get("source"), dict) else {}
            if not provider and isinstance(message_source.get("provider"), str):
                provider = message_source["provider"]
            if not model and isinstance(message_source.get("model"), str):
                model = message_source["model"]
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            for key, target in (
                ("inputTokens", "input"), ("outputTokens", "output"),
                ("cacheReadTokens", "cacheRead"), ("cacheWriteTokens", "cacheWrite"),
                ("totalTokens", "total"),
            ):
                try:
                    amount = int(usage.get(key) or 0)
                except (TypeError, ValueError):
                    amount = 0
                if target == "input":
                    input_tokens += amount
                elif target == "output":
                    output_tokens += amount
                elif target == "cacheRead":
                    cache_read_tokens += amount
                elif target == "cacheWrite":
                    cache_write_tokens += amount
                else:
                    total_tokens += amount
            text = _text_from_content(message.get("content"))
            if text.strip():
                assistant_text_entries += 1
                if len(timeline) < _MAX_TIMELINE:
                    timeline.append({
                        "seq": seq, "time": event_time, "turn": data.get("turn"), "step": data.get("step"),
                        "type": "assistant", "title": "Assistant", "text": _clip(text),
                    })
            continue

        if event_type == "tool/call":
            name = _tool_name(data.get("name"))
            call_id = str(data.get("callId") or "")
            arguments = _tool_arguments(data.get("arguments"))
            tool_calls += 1
            if name in ("structured_output", "structured-output"):
                structured_output = True
            calls[call_id] = {"name": name, "time": event_time, "seq": seq, "error": False}
            stat = tool_stats.setdefault(name, {"name": name, "count": 0, "errors": 0, "durationMs": 0})
            stat["count"] += 1
            if len(timeline) < _MAX_TIMELINE:
                timeline.append({
                    "seq": seq, "time": event_time, "turn": data.get("turn"), "step": data.get("step"),
                    "type": "tool_call", "title": name, "text": arguments,
                    "callId": call_id,
                })
            continue

        if event_type == "tool/result":
            call_id = str(data.get("toolCallId") or data.get("callId") or "")
            message = data.get("message") if isinstance(data.get("message"), dict) else {}
            is_error = bool(message.get("isError")) or bool(data.get("isError"))
            call = calls.get(call_id)
            name = call["name"] if call else "unknown"
            duration = None
            if call and call.get("time") is not None and event_time is not None:
                duration = max(0, event_time - call["time"])
                stat = tool_stats.get(name)
                if stat is not None:
                    stat["durationMs"] += duration
            if call:
                call["error"] = is_error
            if is_error:
                tool_errors += 1
                if call:
                    stat = tool_stats.get(name)
                    if stat is not None:
                        stat["errors"] += 1
            text = _text_from_content(message.get("content"))
            if len(timeline) < _MAX_TIMELINE:
                timeline.append({
                    "seq": seq, "time": event_time, "turn": data.get("turn"), "step": data.get("step"),
                    "type": "error" if is_error else "tool_result",
                    "title": ("Tool error: " if is_error else "Tool result: ") + name,
                    "text": _clip(text),
                    "callId": call_id, "durationMs": duration,
                })
            continue

    if not title:
        for entry in timeline:
            if entry.get("type") == "user" and entry.get("text"):
                title = _clip(str(entry["text"]).replace("\n", " "), 120)
                break
    if not title:
        title = Path(str(header.get("cwd") or "")).name or str(header.get("id"))

    if stop_reason == "":
        if turns == 0:
            status = "empty"
        elif any(entry.get("type") == "turn_start" for entry in timeline) and not any(
            entry.get("type") == "turn_end" for entry in timeline
        ):
            status = "running"
        else:
            status = "incomplete"

    end_time = last_time or file_mtime
    start_time = first_time or created_at or file_mtime
    duration_ms = max(0, end_time - start_time)
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens
    token_summary = {
        "input": input_tokens,
        "output": output_tokens,
        "cacheRead": cache_read_tokens,
        "cacheWrite": cache_write_tokens,
        "total": total_tokens,
    }
    errors = int(tool_errors)
    successful_tools = max(0, tool_calls - errors)
    tool_success_rate = (successful_tools / tool_calls) if tool_calls else None
    findings: List[str] = []
    if status == "aborted":
        findings.append("会话被中止，未正常完成。")
    elif status == "error":
        findings.append(f"会话以错误结束：{stop_reason or 'unknown'}。")
    if errors:
        findings.append(f"工具调用出现 {errors} 次错误，需检查失败后的恢复与验证。")
    if tool_calls == 0:
        findings.append("未记录到工具调用；该会话可能只包含对话。")
    if assistant_messages and assistant_text_entries == 0:
        findings.append("助手消息没有可展示的正文文本。")
    if turns and total_tokens:
        avg = total_tokens / max(1, turns)
        if avg >= 100_000:
            findings.append(f"平均每轮消耗约 {int(avg):,} tokens，上下文成本偏高。")
    if duration_ms >= 30 * 60 * 1000:
        findings.append("会话总时长超过 30 分钟。")
    if not structured_output and status == "completed":
        findings.append("正常完成但没有记录 structured_output 调用；报告可能不是结构化产出。")
    if not findings:
        findings.append("未发现明显的确定性异常；可继续做人工语义审阅。")

    top_tools = sorted(
        tool_stats.values(),
        key=lambda item: (-int(item.get("count", 0)), str(item.get("name"))),
    )[:12]
    timeline.sort(key=lambda entry: (int(entry.get("seq") or 0)))
    return {
        "id": str(header.get("id")),
        "source": "dsh",
        "path": str(path),
        "file": path.name,
        "title": title,
        "createdAt": created_at,
        "updatedAt": last_time or int(file_mtime),
        "fileMtime": int(file_mtime),
        "cwd": header.get("cwd") if isinstance(header.get("cwd"), str) else "",
        "parentSession": header.get("parentSession") if isinstance(header.get("parentSession"), str) else "",
        "origin": header.get("origin") if isinstance(header.get("origin"), str) else "",
        "delegationDepth": header.get("delegationDepth") if isinstance(header.get("delegationDepth"), int) else None,
        "agentPreset": preset,
        "provider": provider,
        "model": model,
        "reasoningEffort": reasoning_effort,
        "status": status,
        "stopReason": stop_reason,
        "durationMs": duration_ms,
        "turns": turns,
        "steps": steps,
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "toolCalls": tool_calls,
        "toolErrors": errors,
        "eventCount": len(events),
        "eventTypes": event_types,
        "tokens": token_summary,
        "toolBreakdown": top_tools,
        "skillOverlays": skill_overlays,
        "timeline": timeline,
        "warnings": warnings,
        "analysis": {
            "status": status,
            "stopReason": stop_reason,
            "toolSuccessRate": tool_success_rate,
            "tokensPerTurn": (total_tokens / turns) if turns else None,
            "durationPerTurnMs": (duration_ms / turns) if turns else None,
            "hasStructuredOutput": structured_output,
            "findings": findings,
        },
    }


def discover_session_files(root: Optional[Path] = None) -> Tuple[List[Path], List[str]]:
    """Find one supported DSH session file per session directory."""

    root = Path(root) if root is not None else sessions_root()
    warnings: List[str] = []
    if not root.exists():
        return [], [f"sessions directory does not exist: {root}"]
    if not root.is_dir():
        return [], [f"sessions root is not a directory: {root}"]

    files: List[Path] = []
    for current, _dirs, names in os.walk(root):
        candidates: List[Tuple[int, Path]] = []
        for name in names:
            match = SESSION_FILE_RE.match(name)
            if not match:
                continue
            version = int(match.group(1))
            candidates.append((version, Path(current) / name))
        if not candidates:
            continue
        supported = [item for item in candidates if item[0] == DSH_SESSION_VERSION]
        if not supported:
            versions = sorted({item[0] for item in candidates})
            warnings.append(f"ignored unsupported DSH session versions {versions} in {current}")
            continue
        supported.sort(key=lambda item: item[1].stat().st_mtime, reverse=True)
        files.append(supported[0][1])
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files, warnings
