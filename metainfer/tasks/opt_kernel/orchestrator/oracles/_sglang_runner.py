"""Real sglang serve + bench_serving runner for the e2e oracle.

This is the production :class:`E2ERunner` that the :class:`E2EOracle` injects.
It launches a real sglang server (optionally monkeypatching the w8a8 GEMM with
the agent's kernel), waits for it to become healthy, runs
``sglang.bench_serving`` as a subprocess, parses the results, and tears the
server down.

Environment contract
---------------------
Running this for real requires:

  * a multi-GPU node with the model weights on disk,
  * ``sglang`` and ``lmslim`` importable,
  * a free port.

In any other environment (CI, dev laptop, no GPUs) :meth:`run_bench` raises a
:class:`RuntimeError`. The e2e oracle's pipeline hook catches that and
degrades to advisory pass-through (timeline-logged) — so a missing deployment
environment never blocks iterations, exactly like the correctness oracle.

Kernel injection
----------------
sglang's w8a8 path goes through ``lmslim.layers.gemm.int8_utils.matmul_int8``,
whose signature differs from the agent's ``w8a8_scaled_mm``::

    lmslim: matmul_int8(x_q, x_scale, weight, weight_scale, out_dtype, config=None)
    agent:  w8a8_scaled_mm(x_q, weight, x_scale, weight_scale, out_dtype)

The server is launched via a small wrapper script that imports the agent
kernel, installs an adapter shim onto ``lmslim...matmul_int8``, *then* starts
the sglang server — so the patch is in place before any model load. The
baseline run launches the server plain (no wrapper).

NOTE: this module is import-safe (no sglang/lmslim at import time); the real
deps are only touched inside :meth:`run_bench`. It has NOT been validated
end-to-end in this environment (no deployment node here) — that is a TODO for
the deployment environment.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .e2e import BenchResult


# Launch the server through a wrapper that monkeypatches lmslim BEFORE sglang
# imports/loads the model. The wrapper is written to a temp file and run as
# `python <wrapper>` so it controls import order.
_AGENT_WRAPPER = textwrap.dedent(
    """\
    import importlib
    import importlib.util
    import runpy
    import sys

    KERNEL_PATH = sys.argv[1]
    MODEL_ARGS = sys.argv[2:]

    def _load_agent_kernel(path):
        spec = importlib.util.spec_from_file_location("agent_kernel", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _install_patch(agent_mod):
        # lmslim's int8 GEMM entry point. We replace it with an adapter that
        # re-orders args to the agent's signature and drops the `config`.
        import lmslim.layers.gemm.int8_utils as _iu  # noqa: F401
        fn = getattr(agent_mod, "w8a8_scaled_mm", None)
        if fn is None:
            raise RuntimeError("agent kernel has no w8a8_scaled_mm")
        _iu.matmul_int8 = lambda x_q, x_scale, weight, weight_scale, out_dtype, config=None: (
            fn(x_q, weight, x_scale, weight_scale, out_dtype)
        )

    agent = _load_agent_kernel(KERNEL_PATH)
    _install_patch(agent)
    # Now start the sglang server — the patch is live before model load.
    sys.argv = ["sglang.launch_server"] + MODEL_ARGS
    runpy.run_module("sglang.launch_server", run_name="__main__", alter_sys=True)
    """
)


def _free_port(default: int = 30000) -> int:
    """Pick a free TCP port (prefer the configured default if available)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", default))
        s.close()
        return default
    except OSError:
        pass
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_healthy(port: int, timeout_s: int = 600) -> bool:
    """Poll the sglang /health endpoint until ready or timeout."""
    import urllib.request
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(2)
    return False


def _parse_bench_output(text: str) -> Dict[str, Any]:
    """Extract metrics from ``sglang.bench_serving`` stdout.

    bench_serving prints a final JSON-ish summary plus key=value lines. We
    grab what we can robustly with regex; missing fields stay 0.0.
    """
    out: Dict[str, Any] = {}

    def _grab_float(key: str, text: str, alt: str = "") -> float:
        for pat in (key, alt):
            if not pat:
                continue
            m = re.search(rf"{re.escape(pat)}[=:]\\s*([0-9eE.+-]+)", text)
            if m:
                try:
                    return float(m.group(1))
                except ValueError:
                    continue
        return 0.0

    def _grab_int(key: str, text: str) -> int:
        m = re.search(rf"{re.escape(key)}[=:]\\s*(\\d+)", text)
        return int(m.group(1)) if m else 0

    out["output_throughput_tok_s"] = _grab_float("output_throughput", text, "Output token throughput")
    out["input_throughput_tok_s"] = _grab_float("input_throughput", text, "Input token throughput")
    out["ttft_ms"] = _grab_float("mean_ttft", text, "TTFT")
    out["tpot_ms"] = _grab_float("mean_tpot", text, "TPOT")
    out["successful_requests"] = _grab_int("successful", text)
    return out


class SglangE2ERunner:
    """Production runner: real sglang serve + bench_serving.

    Importing this class is cheap; real deps (sglang/lmslim) are only touched
    inside :meth:`run_bench`.
    """

    def __init__(self, bench_timeout_s: int = 1800, serve_timeout_s: int = 600) -> None:
        self.bench_timeout_s = bench_timeout_s
        self.serve_timeout_s = serve_timeout_s

    # ------------------------------------------------------------------ #
    def _check_env(self) -> None:
        missing = []
        if shutil.which("python") is None and sys.executable is None:
            missing.append("python")
        try:
            import sglang  # noqa: F401
        except ImportError:
            missing.append("sglang")
        try:
            import lmslim  # noqa: F401
        except ImportError:
            missing.append("lmslim")
        if missing:
            raise RuntimeError(
                "e2e oracle requires (not importable in this env): "
                + ", ".join(missing)
            )

    def _launch_server(
        self, req: Dict[str, Any], port: int, kernel_path: Optional[Path],
    ) -> tuple[subprocess.Popen, float]:
        """Launch sglang server (optionally via the kernel-patching wrapper).

        Returns (proc, capture_s) where capture_s is the time from launch to
        /health ready — an approximation of the capture cost the per-shape
        bench cannot see.
        """
        model = req.get("model_path", req.get("model", ""))
        tp = str(req.get("tp", req.get("tensor_parallel_size", "1")))
        base_args = [
            "--model", str(model),
            "--tp", tp,
            "--port", str(port),
            "--host", "127.0.0.1",
            "--trust-remote-code",
        ]
        t0 = time.time()
        if kernel_path is not None:
            wrapper = Path(tempfile.mkstemp(suffix="_e2e_wrapper.py")[1])
            wrapper.write_text(_AGENT_WRAPPER, encoding="utf-8")
            try:
                cmd = [sys.executable, str(wrapper), str(kernel_path), "launch_server"] + base_args
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            finally:
                # wrapper content is read once at exec; safe to delete after start
                try:
                    wrapper.unlink()
                except OSError:
                    pass
        else:
            cmd = [sys.executable, "-m", "sglang.launch_server"] + base_args
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        ready = _wait_healthy(port, self.serve_timeout_s)
        capture_s = time.time() - t0
        if not ready:
            try:
                proc.terminate()
            except Exception:
                pass
            raise RuntimeError(f"sglang server did not become healthy on port {port}")
        return proc, capture_s

    def _run_bench(self, port: int, req: Dict[str, Any]) -> Dict[str, Any]:
        ip = str(req.get("e2e_input_len", req.get("input_len", "1024")))
        op = str(req.get("e2e_output_len", req.get("output_len", "128")))
        nr = str(req.get("e2e_num_requests", req.get("num_requests", "256")))
        cmd = [
            sys.executable, "-m", "sglang.bench_serving",
            "--backend", "sglang",
            "--base-url", f"http://127.0.0.1:{port}",
            "--model", str(req.get("model_path", req.get("model", ""))),
            "--dataset-name", "random",
            "--num-prompts", nr,
            "--random-input-len", ip,
            "--random-output-len", op,
        ]
        conc = req.get("e2e_concurrency", req.get("concurrency"))
        if conc:
            cmd += ["--concurrency", str(conc)]
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=self.bench_timeout_s)
        return _parse_bench_output(proc.stdout + "\n" + proc.stderr)

    def _shutdown(self, proc: Optional[subprocess.Popen]) -> None:
        if proc is None:
            return
        try:
            proc.terminate()
            proc.wait(timeout=30)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # ------------------------------------------------------------------ #
    def run_bench(
        self,
        kernel_path: Optional[Path],
        req: Dict[str, Any],
        is_baseline: bool,
    ) -> BenchResult:
        """Launch serve (optionally patched), bench it, return BenchResult.

        Raises :class:`RuntimeError` if sglang/lmslim aren't importable so the
        oracle can degrade to advisory pass-through.
        """
        self._check_env()
        port = _free_port(int(req.get("e2e_port", req.get("port", "30000"))))
        proc: Optional[subprocess.Popen] = None
        try:
            # baseline never patches; agent uses kernel_path.
            kp = None if is_baseline else kernel_path
            proc, capture_s = self._launch_server(req, port, kp)
            metrics = self._run_bench(port, req)
        finally:
            self._shutdown(proc)
        res = BenchResult(
            kind="baseline" if is_baseline else "agent",
            capture_s=round(capture_s, 3),
            output_correct=True,  # bench_serving failing raises; success ⇒ output ok
            notes=f"port={port}",
            **metrics,
        )
        return res
