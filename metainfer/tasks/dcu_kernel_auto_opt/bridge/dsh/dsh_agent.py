#!/usr/bin/env python3
"""MetaInfer -> DSH agent driver (ccb-compatible CLI).

SubAgentManager spawns sub-agents as a CLI process (``claude_bin``, default
``ccb``) with this contract:

    <bin> -p --output-format stream-json --input-format text --verbose \\
          --permission-mode <mode> --add-dir <workdir> [--add-dir <extra>...] \\
          [--model <m>] [--effort <e>] [--resume <sid> | --session-id <sid>] \\
          [extra_args...]

with the agent prompt piped on **stdin**.  The process must emit a
line-delimited stream-json event stream on **stdout** and exit 0 on success:

    {"type":"system",    "session_id": "<id>", ...}          (first)
    {"type":"assistant", "message": {"content": [{"type":"text","text": "..."}]}}
    {"type":"result",    "session_id": "<id>", "result": "<final text>",
     "usage": {...}}                                         (last)

This wrapper speaks that exact protocol but runs a **DeepSeek Harness agent**
through the Python SDK (``deepseek_harness``) instead of Claude Code.  The
orchestrator therefore needs zero code changes: point ``claude_bin`` at this
script (``METAINFER_CLAUDE_BIN`` or ``--claude-bin``) and both the coordinator
(main agent) and the kernel workers (sub-agents) run on DSH.

Environment:
    DSH_AGENT_PROVIDER      provider name for the DSH runtime
                            (default: deepseek-official — the only adapter
                            shipped by the dev-checkout runtime)
    DSH_AGENT_MODEL         model override (default deepseek/deepseek-flash,
                            the 4.1 Flash label deepseek-flash-4.1)
    DSH_AGENT_BASE_URL      model endpoint; falls back to DEEPSEEK_BASE_URL
                            (default: https://tokenhub.tencentmaas.com/plan/v3)
    TENCENT_API_KEY         preferred API key (matches ~/.dsh/settings.yaml)
    DEEPSEEK_API_KEY        fallback API key
    DSH_AGENT_CORDIS        custom cordis.yml for the SDK runtime
                            (default: dsh/cordis.yml next to this file)
    DSH_AGENT_SESSION_ROOT  session JSONL persistence root; stable across
                            resume chains (default: <cwd>/.dsh-sessions)
    DSH_AGENT_MAX_TOKENS    per-request output cap (default 65536)
    DSH_AGENT_DEBUG         set to 1 to keep the SDK runtime log lines
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Dev-checkout carrier: this host has no compiled ``deepseek-harness-runtime-bin``
# executable, so the SDK runtime is launched through the dev-only node carrier
# (see resolve_bundled_launch_args). Callers with the exe carrier installed can
# override with DSH_RUNTIME_MODE=exe.
os.environ.setdefault("DSH_RUNTIME_MODE", "node")

# --------------------------------------------------------------------------- #
# Host wiring (worker29: TokenHub DSV4-Flash via the local dsh CLI profile)
# --------------------------------------------------------------------------- #

# Provider name understood by the DSH runtime. The dev-checkout runtime only
# ships the llm-deepseek adapter (provider "deepseek-official"); the TokenHub
# endpoint is selected via DEEPSEEK_BASE_URL below, so the official adapter
# talks to the same gateway the local dsh CLI uses.
def default_provider() -> str:
    return (
        os.environ.get("DSH_AGENT_PROVIDER", "deepseek-official").strip()
        or "deepseek-official"
    )


def default_model() -> str:
    """Default DSH model id (the 4.1 Flash build) unless DSH_AGENT_MODEL pins
    another one. Matches orchestrator/config.py DSH_DEFAULT_MODEL_ID."""
    return (
        os.environ.get("DSH_AGENT_MODEL", "deepseek/deepseek-flash")
        .strip() or "deepseek/deepseek-flash"
    )


def default_base_url() -> str:
    env = os.environ.get("DEEPSEEK_BASE_URL")
    if env and env.strip():
        return env.strip()
    return (
        os.environ.get(
            "DSH_AGENT_BASE_URL",
            "https://tokenhub.tencentmaas.com/plan/v3",
        ).strip()
        or "https://tokenhub.tencentmaas.com/plan/v3"
    )


def _credentials_api_key() -> str:
    """Read the API key from the local dsh credentials file when the env
    variables are not set (e.g. when this wrapper runs standalone)."""
    try:
        import yaml

        path = Path(
            os.environ.get("DSH_CREDENTIALS", "~/.dsh/.credentials.yaml")
        ).expanduser()
        if not path.is_file():
            return ""
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for key in ("TENCENT_API_KEY", "DEEPSEEK_API_KEY"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    except Exception:  # noqa: BLE001 - credentials are best-effort
        pass
    return ""


def default_api_key() -> str:
    """Resolve the API key for the configured gateway.

    The TokenHub (tencent) gateway is authenticated by the TENCENT key. The
    DEEPSEEK key is also present in ~/.dsh/.credentials.yaml and is exported
    into the metainfer server env by start_webui.sh, but TokenHub rejects it;
    for that gateway the tencent credential therefore takes priority over the
    DEEPSEEK env fallback.
    """
    tencent_gateway = (
        "tencentmaas" in default_base_url().lower()
        or default_provider().strip().lower() == "tencent"
    )
    if tencent_gateway:
        value = os.environ.get("TENCENT_API_KEY")
        if value and value.strip():
            return value.strip()
        cred = _credentials_api_key()
        if cred:
            return cred
        value = os.environ.get("DEEPSEEK_API_KEY")
        if value and value.strip():
            return value.strip()
    else:
        for env in ("DEEPSEEK_API_KEY", "TENCENT_API_KEY"):
            value = os.environ.get(env)
            if value and value.strip():
                return value.strip()
        return _credentials_api_key()
    return ""


# --------------------------------------------------------------------------- #
# Model mapping (legacy Claude labels / form labels -> this host's DSH ids)
# --------------------------------------------------------------------------- #

#: Form labels produced by both MetaInfer task frontends (dcu-kernel-auto-opt's
#: agent_model field and harness-evolve's evolve_model field). Kept in sync with
#: orchestrator/config.py (DSH_MODEL_IDS) — the orchestrator resolves the label
#: itself, so this map only serves callers that hand the wrapper a bare label.
_MODEL_MAP = {
    "deepseek-flash-4.1": "deepseek/deepseek-flash",
    "deepseek-flash": "deepseek/deepseek-flash",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash-0731",
    "opus": "deepseek/deepseek-v4-flash-0731",
    "sonnet": "deepseek/deepseek-v4-flash-0731",
    "haiku": "deepseek/deepseek-v4-flash-0731",
}


def map_model(requested: Optional[str]) -> str:
    if not requested:
        return default_model()
    key = requested.strip().lower()
    if key in _MODEL_MAP:
        return _MODEL_MAP[key]
    if key.startswith("deepseek"):
        # Full model id (e.g. deepseek/deepseek-flash): pass through.
        return key
    # Unknown label: keep the caller's intent but stay on a known model id.
    return default_model()


# --------------------------------------------------------------------------- #
# stream-json event emission (SubAgentManager wire protocol)
# --------------------------------------------------------------------------- #

def emit(event: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_system(session_id: str, model: str) -> None:
    emit({
        "type": "system",
        "session_id": session_id,
        "model": model,
        "subagent_id": session_id,
        "cwd": os.getcwd(),
    })


def _resolve_dsh_bin() -> Optional[str]:
    """Locate the dsh CLI (npm global lives in /usr/local/bin)."""
    import shutil

    found = shutil.which("dsh")
    if found:
        return found
    for cand in ("/usr/local/bin/dsh", "/usr/bin/dsh"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def _with_dsh_bin_on_path() -> Dict[str, str]:
    """Env for the headless child with the dsh bin dir prepended to PATH."""
    env = dict(os.environ)
    dsh_bin = _resolve_dsh_bin()
    if dsh_bin:
        bindir = os.path.dirname(dsh_bin)
        path = env.get("PATH") or ""
        entries = [p for p in path.split(":") if p and p != bindir]
        env["PATH"] = ":".join([bindir] + entries + ["/usr/bin", "/bin"])
    return env


#: dsh-base tool rows -> the agent-facing tool names each one provides.
#: Used to build a profile patch that disables every row outside a whitelist.
_TOOL_ROWS: Dict[str, set] = {
    "tool-fs": {"read", "write", "edit", "multiedit", "notebookedit"},
    "tool-fs-search": {"glob", "grep", "search"},
    "tool-str-replace-editor": {"strreplace", "str_replace", "edit"},
    "tool-bash": {"bash", "bashoutput", "killshell", "run"},
    "tool-pwsh": {"powershell"},
    "tool-skill": {"skill"},
    "tool-web": {"webfetch", "websearch", "web"},
    "tool-todo": {"todowrite", "todoread", "todo"},
    "tool-jobs": {"joboutput", "jobkill", "joblist", "jobs"},
    "tool-workflow": {"workflow"},
    "tool-ralph": {"ralph"},
    "tool-goal": {"goalcreate", "goalupdate", "getgoal", "goal"},
    "tool-subagent": {"task", "subagent"},
    "tool-subagent-control": {"sendmessage", "interruptagent"},
    "tool-subagent-list-agents": {"listagents"},
    "tool-subagent-fork": {"subagentfork"},
    "tool-subagent-report": set(),
}


def _parse_tool_list(raw: Optional[str]) -> set:
    if not raw:
        return set()
    return {
        part.strip().lower().replace("-", "").replace("_", "")
        for part in raw.replace(" ", ",").split(",")
        if part.strip()
    }


def _tool_patch_file(args: Any) -> Optional[str]:
    """Write a dsh profile patch disabling tool rows outside the whitelist.

    Returns the patch path (caller deletes it) or None when no gating was
    requested. ``--tools`` is a whitelist; ``--disallowedTools`` additionally
    removes rows. Rows not listed in the dsh-base bundle are never targeted,
    so the patch stays valid across profiles.
    """
    allowed = _parse_tool_list(getattr(args, "tools", None))
    denied = _parse_tool_list(getattr(args, "disallowed_tools", None))
    if not allowed and not denied:
        return None
    lines = [
        "# generated by MetaInfer dsh_agent headless backend "
        "(tool gating from --tools/--disallowedTools)",
    ]
    disabled_any = False
    for row, tools in _TOOL_ROWS.items():
        if allowed:
            keep = bool(tools & allowed)
        else:
            keep = True
        if tools & denied:
            keep = False
        if not keep:
            lines.append(f"- id: {row}")
            lines.append("  disabled: true")
            disabled_any = True
    if not disabled_any:
        return None
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".patch.yml", prefix="dsh-tools-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def _headless_backend_main(args: Any, prompt: str) -> int:
    """Run one task through the local `dsh --profile headless` CLI.

    The full prompt is written to a temp brief file because prompts here can
    exceed the kernel argv limit (one DKAO brief is up to ~300 KB) and the
    headless app only accepts its task on argv. We ask the agent to Read the
    brief and follow it. A keepalive line is written to stdout while the
    sub-agent is still working so SubAgentManager's no-output watchdog never
    mistakes a long task for a stuck process; the final assistant text is
    emitted as the last message, matching the ccb stream-json contract.

    Model selection caveat: the ``dsh --profile headless`` app takes no
    ``--model`` flag, so it runs whatever the user's DSH settings document
    (``~/.dsh/settings.yaml`` -> ``agent-default-model``) selects — the host
    default, not ``--model``. Emit the requested model in the system event so
    the mismatch is visible instead of silent. The SDK backend below does honour
    ``--model``.
    """
    import subprocess
    import tempfile
    import threading
    import time

    dsh_bin = _resolve_dsh_bin()
    if not dsh_bin:
        sys.stderr.write(
            "dsh_agent: headless backend requires the `dsh` CLI on PATH\n"
        )
        return 1

    model = map_model(args.model)
    session_id = args.resume or args.session_id or f"session-{os.urandom(8).hex()}"

    fd, brief = tempfile.mkstemp(suffix=".md", prefix="dsh-task-brief-")
    tool_patch: Optional[str] = None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(prompt)
        task = (
            f"You are a coding sub-agent inside a kernel-optimization pipeline. "
            f"Read the complete task brief at {brief} with the Read tool and "
            "follow it to completion, autonomously, without asking the user. "
            "When the task is finished, output exactly the final result text "
            "and stop."
        )
        tool_patch = _tool_patch_file(args)
        cmd = [dsh_bin, "--profile", "headless"]
        if tool_patch:
            cmd += ["--patch", tool_patch]
        cmd.append(task)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_with_dsh_bin_on_path(),
        )
    except Exception as exc:  # noqa: BLE001
        if tool_patch:
            try:
                os.unlink(tool_patch)
            except OSError:
                pass
        sys.stderr.write(f"dsh_agent: failed to start headless run: {exc!r}\n")
        return 1

    out_lines: List[str] = []
    err_lines: List[str] = []

    def pump(pipe, sink: List[str]) -> None:
        assert pipe is not None
        for line in pipe:
            sink.append(line)

    t_out = threading.Thread(target=pump, args=(proc.stdout, out_lines), daemon=True)
    t_err = threading.Thread(target=pump, args=(proc.stderr, err_lines), daemon=True)
    t_out.start()
    t_err.start()

    emitted_system = False
    last_beat = time.time()
    beat_secs = float(os.environ.get("DSH_AGENT_BEAT_SECONDS", "45"))
    while proc.poll() is None:
        if not emitted_system:
            emit_system(session_id, model)
            emitted_system = True
        if time.time() - last_beat >= beat_secs:
            sys.stdout.write("# dsh-agent keepalive\n")
            sys.stdout.flush()
            last_beat = time.time()
        time.sleep(1)

    t_out.join(timeout=10)
    t_err.join(timeout=10)

    if not emitted_system:
        emit_system(session_id, model)

    def _cleanup_temps() -> None:
        for path in (brief, tool_patch):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    if proc.returncode != 0:
        tail = "".join(err_lines)[-2000:]
        sys.stderr.write(
            f"dsh_agent: headless run failed (rc={proc.returncode}): {tail}\n"
        )
        _cleanup_temps()
        return 1
    final_text = "".join(out_lines).strip()
    if not final_text:
        sys.stderr.write("dsh_agent: headless run produced no output\n")
        _cleanup_temps()
        return 1
    _cleanup_temps()
    emit({
        "type": "assistant",
        "session_id": session_id,
        "message": {"content": [{"type": "text", "text": final_text}]},
    })
    emit({
        "type": "result",
        "session_id": session_id,
        "result": final_text,
        "finish_reason": "completed",
        "usage": {},
    })
    return 0


def extract_text_blocks(content: Any) -> List[str]:
    """Pull text blocks from an assistant message content array."""
    if not isinstance(content, list):
        return []
    out: List[str] = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "text":
            text = blk.get("text")
            if isinstance(text, str):
                out.append(text)
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dsh_agent", add_help=False)
    p.add_argument("-p", action="store_true")
    p.add_argument("--output-format")
    p.add_argument("--input-format")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--permission-mode")
    p.add_argument("--add-dir", action="append", default=[])
    p.add_argument("--model")
    p.add_argument("--effort")
    p.add_argument("--resume")
    p.add_argument("--session-id")
    p.add_argument("--max-turns")
    # Tool gating (used by the HE evolve agent). The headless backend maps
    # these ccb-style tool lists onto a dsh profile patch that disables the
    # tool rows outside the whitelist.
    p.add_argument("--tools")
    p.add_argument("--disallowedTools", dest="disallowed_tools")
    # Anything else (claude-specific) is ignored.
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args, _unknown = build_parser().parse_known_args(argv)

    prompt = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    if not prompt:
        sys.stderr.write("dsh_agent: empty prompt on stdin\n")
        return 1

    # Backend selection. ``headless`` runs the local `dsh --profile headless`
    # CLI (one autonomous agent task, prints the final result); ``sdk`` uses
    # the deepseek-harness python SDK + node carrier below. ``auto`` prefers
    # headless when the dsh CLI is on PATH (the SDK node carrier needs a
    # repo-built runtime closure that may be absent on worker hosts).
    backend = os.environ.get("DSH_AGENT_BACKEND", "auto").strip().lower()
    if backend == "auto":
        backend = "headless" if _resolve_dsh_bin() else "sdk"
    if backend == "headless":
        return _headless_backend_main(args, prompt)
    if backend != "sdk":
        sys.stderr.write(
            f"dsh_agent: unknown DSH_AGENT_BACKEND {backend!r} "
            "(use sdk | headless | auto)\n"
        )
        return 1

    try:
        from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig
    except ImportError as exc:  # pragma: no cover - environment check
        sys.stderr.write(
            "dsh_agent: deepseek_harness SDK not installed "
            f"({exc}); run: pip install deepseek-harness-sdk\n"
        )
        return 1

    model = map_model(args.model)
    # Session continuity: --resume continues an existing DSH conversation;
    # --session-id pins the id on the first turn so the orchestrator can
    # resume by it later. Both map to the SDK's per-session id.
    requested_session = args.resume or args.session_id
    session_id = requested_session or f"session-{os.urandom(8).hex()}"

    add_dirs = [str(Path(d).resolve()) for d in args.add_dir if d]
    # Stable session persistence: prefer env, else the last --add-dir (the
    # orchestrator passes workspace_dir after the per-agent workdir), else cwd.
    session_root = os.environ.get("DSH_AGENT_SESSION_ROOT")
    if not session_root and add_dirs:
        session_root = str(Path(add_dirs[-1]) / ".dsh-sessions")
    if not session_root:
        session_root = str(Path.cwd() / ".dsh-sessions")

    cordis = os.environ.get("DSH_AGENT_CORDIS")
    if not cordis:
        cordis = str(Path(__file__).resolve().parent / "cordis.yml")

    max_tokens = int(os.environ.get("DSH_AGENT_MAX_TOKENS", "65536"))
    api_key = default_api_key()
    if not api_key:
        sys.stderr.write(
            "dsh_agent: no API key found (set TENCENT_API_KEY or "
            "DEEPSEEK_API_KEY)\n"
        )
        return 1

    def run_agent(sid: str):
        config = DeepSeekHarnessConfig(
            provider=default_provider(),
            model=model,
            max_tokens=max_tokens,
            cwd=os.getcwd(),
            session_root=session_root,
            cordis=cordis,
            # API key / base url are injected explicitly; the runtime also
            # inherits them from the process environment by default.
            base_url=default_base_url(),
            api_key=api_key,
            env={
                "DSH_SESSION_ROOT": session_root,
                "DSH_CWD": os.getcwd(),
            },
            request_timeout_seconds=3600.0,
            shutdown_timeout_seconds=15.0,
        )

        def on_notification(notification: Any) -> None:
            # Stream assistant text live so the SubAgentManager stuck-watchdog
            # sees fresh stdout and the WebUI log stays readable.
            try:
                if getattr(notification, "method", None) != "session.event":
                    return
                payload = notification.payload or {}
                if payload.get("sessionId") != sid:
                    return
                event = payload.get("event")
                if not isinstance(event, dict):
                    return
                if event.get("type") != "assistant/message":
                    return
                data = event.get("data") or {}
                message = data.get("message")
                content = message.get("content") if isinstance(message, dict) else data.get("content")
                blocks = extract_text_blocks(content)
                if blocks:
                    emit({
                        "type": "assistant",
                        "session_id": sid,
                        "message": {"content": [{"type": "text", "text": b} for b in blocks]},
                    })
            except Exception:  # pragma: no cover - observability must not kill the run
                pass

        try:
            result = DeepSeekHarness(config).run(
                prompt,
                session_id=sid,
                on_notification=on_notification,
            )
            return result, None
        except Exception as exc:  # pragma: no cover - surfaced to the orchestrator
            return None, exc

    # Resume is best-effort: large prior sessions can fail to reload in the
    # runtime (turn/end reason "error" with an empty response). Fall back to a
    # fresh session so every iteration still produces real agent work; the
    # prompt MetaInfer passes is self-contained and includes continuation
    # context, so the fresh run remains effective.
    result, exc = run_agent(session_id)
    if result is not None and result.finish_reason not in (None, "completed", "max-tokens"):
        sys.stderr.write(
            f"dsh_agent: session {session_id} resume failed "
            f"(finish_reason={result.finish_reason!r}); retrying as a fresh session\n"
        )
        session_id = f"session-{os.urandom(8).hex()}"
        result, exc = run_agent(session_id)
    if exc is not None:
        sys.stderr.write(f"dsh_agent: DSH run failed: {exc!r}\n")
        return 1
    if result.finish_reason not in (None, "completed", "max-tokens"):
        sys.stderr.write(
            f"dsh_agent: DSH run finished with reason {result.finish_reason!r}\n"
        )
        return 1

    # Emit the system event only after the successful run so the stream's
    # first session_id is the id the orchestrator should resume from later.
    emit_system(result.session_id, model)
    final_text = result.final_response or ""
    emit({
        "type": "result",
        "session_id": result.session_id,
        "result": final_text,
        "finish_reason": result.finish_reason,
        "usage": {},  # optional; token-budget accounting skips when absent
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
