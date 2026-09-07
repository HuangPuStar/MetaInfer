"""Runner: EvalScope install checks, Docker preflight, child env isolation."""

from __future__ import annotations

import json

import pytest

from metainfer.tasks.evalscope_correctness.orchestrator import runner as _runner
from metainfer.tasks.evalscope_correctness.orchestrator import config as _config
from metainfer.tasks.evalscope_correctness.orchestrator import evalscope_worker as _worker


def _version(v):
    # importlib.metadata.version("evalscope") is called with a package arg.
    return lambda _pkg: v


def test_evalscope_ok_within_range(monkeypatch):
    monkeypatch.setattr("importlib.metadata.version", _version("1.11.0"))
    assert _runner.check_evalscope_install().ok is True


def test_evalscope_missing(monkeypatch):
    def _missing(pkg):
        from importlib.metadata import PackageNotFoundError
        raise PackageNotFoundError(pkg)
    monkeypatch.setattr("importlib.metadata.version", _missing)
    pre = _runner.check_evalscope_install()
    assert pre.ok is False
    assert "install" in pre.error and "1.11" in pre.error


@pytest.mark.parametrize("v", ["1.9.3", "2.0.1"])
def test_evalscope_out_of_range(monkeypatch, v):
    monkeypatch.setattr("importlib.metadata.version", _version(v))
    pre = _runner.check_evalscope_install()
    assert pre.ok is False
    assert "range" in pre.error


def test_sandbox_requires_docker(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    pre = _runner.check_sandbox_available()
    assert pre.ok is False
    assert "Docker" in pre.error


def test_sandbox_ok_when_docker_present(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/docker")
    assert _runner.check_sandbox_available().ok is True


def test_preflight_gates_humaneval_on_docker(monkeypatch):
    monkeypatch.setattr("importlib.metadata.version", _version("1.11.0"))
    monkeypatch.setattr("shutil.which", lambda name: None)
    cfg = _config.parse_requirements({
        "api_url": "http://x:1/v1", "model": "Q",
        "benchmarks": ["humaneval"],
    })
    err = _runner.preflight_for(cfg)
    assert err is not None and "Docker" in err


def test_preflight_no_docker_needed_for_gsm8k(monkeypatch):
    monkeypatch.setattr("importlib.metadata.version", _version("1.11.0"))
    cfg = _config.parse_requirements({
        "api_url": "http://x:1/v1", "model": "Q", "benchmarks": ["gsm8k"],
    })
    assert _runner.preflight_for(cfg) is None


# --------------------------------------------------------------------------- #
# Worker task-config construction (secret stays in env, not in argv/stdin)
# --------------------------------------------------------------------------- #

def test_worker_builds_task_config(monkeypatch):
    monkeypatch.setenv("EVALSCOPE_API_KEY", "sk-secret-value")
    cfg = {
        "api_url": "http://x:1/v1", "model": "Q", "model_id": "",
        "datasets": ["gsm8k"], "temperature": 0.0, "seed": 42,
        "eval_batch_size": 2, "timeout_seconds": 300, "max_tokens": 8192,
        "limit": None, "dataset_cache_dir": "", "api_key_env_var": "EVALSCOPE_API_KEY",
        "work_dir": "/tmp/attempt-1", "needs_sandbox": False,
    }
    task = _worker._build_task_config(cfg)
    assert task["model"] == "Q"
    assert task["datasets"] == ["gsm8k"]
    assert task["eval_type"] == "openai_api"
    assert task["eval_batch_size"] == 2        # remote default (8) overridden
    assert task["no_timestamp"] is True
    assert task["generation_config"]["temperature"] == 0.0
    assert task["generation_config"]["max_tokens"] == 8192
    assert task["api_key"] == "sk-secret-value"   # injected from env
    assert "use_sandbox" not in task


def test_worker_enables_sandbox_for_humaneval(monkeypatch):
    monkeypatch.setenv("EVALSCOPE_API_KEY", "sk-secret-value")
    cfg = {
        "api_url": "http://x:1/v1", "model": "Q", "model_id": "",
        "datasets": ["humaneval"], "temperature": 0.0, "seed": 42,
        "eval_batch_size": 2, "timeout_seconds": 300, "max_tokens": 8192,
        "limit": None, "dataset_cache_dir": "",
        "api_key_env_var": "EVALSCOPE_API_KEY", "work_dir": "/tmp/a",
        "needs_sandbox": True,
    }
    assert _worker._build_task_config(cfg)["use_sandbox"] is True


def test_worker_uses_EMPTY_when_no_key(monkeypatch):
    monkeypatch.delenv("EVALSCOPE_API_KEY", raising=False)
    cfg = {
        "api_url": "http://x:1/v1", "model": "Q", "model_id": "",
        "datasets": ["gsm8k"], "temperature": 0.0, "seed": 42,
        "eval_batch_size": 1, "timeout_seconds": 300, "max_tokens": 8192,
        "limit": None, "dataset_cache_dir": "",
        "api_key_env_var": "EVALSCOPE_API_KEY", "work_dir": "/tmp/a",
        "needs_sandbox": False,
    }
    assert _worker._build_task_config(cfg)["api_key"] == "EMPTY"


# --------------------------------------------------------------------------- #
# run_dataset: secret in child env only, never argv / on-disk config
# --------------------------------------------------------------------------- #

class _FakePopen:
    """Captures argv + env; never actually runs EvalScope."""

    def __init__(self, argv, stdin=None, stdout=None, stderr=None, env=None,
                 start_new_session=False, text=False):
        import io
        self.argv = argv
        self.env = env
        self.stdin = io.StringIO()   # writable so run_dataset can send config
        self._start_new_session = start_new_session
        self.pid = 12345

    def wait(self, timeout=None):
        return 0


def test_run_dataset_puts_key_in_env_only(monkeypatch, tmp_path):
    cfg = _config.parse_requirements({
        "api_url": "http://x:1/v1", "model": "Q", "benchmarks": ["gsm8k"],
        "api_key_env_var": "EVALSCOPE_API_KEY",
    })
    monkeypatch.setenv("EVALSCOPE_API_KEY", "sk-topsecret")
    attempt_dir = tmp_path / "gsm8k" / "attempt-1"
    captured = {}

    def _fake_popen(*a, **kw):
        captured["argv"] = a[0]
        captured["env"] = dict(kw.get("env", {}))
        return _FakePopen(*a, **kw)

    monkeypatch.setattr(_runner.subprocess, "Popen", _fake_popen)

    result = _runner.run_dataset(
        cfg, cfg.targets[0], attempt_dir=attempt_dir,
        log_file=attempt_dir / "worker.log",
        active={},
        env_extra={"EVALSCOPE_API_KEY": "sk-topsecret"},
    )
    assert result.exit_code == 0
    # The secret appears in the child's environment…
    assert captured["env"]["EVALSCOPE_API_KEY"] == "sk-topsecret"
    # …but never on argv…
    assert "sk-topsecret" not in json.dumps(captured["argv"])
    # …and never in the on-disk child config we wrote as evidence.
    disk_cfg = json.loads((attempt_dir / "child_config.json").read_text())
    assert "sk-topsecret" not in json.dumps(disk_cfg)
    assert "api_key" not in disk_cfg
    assert disk_cfg["api_key_env_var"] == "EVALSCOPE_API_KEY"
