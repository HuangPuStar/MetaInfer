"""The error catalog must classify real DKAO failures, not invented ones.

Two things are worth testing here. First the classifier: every rule is a claim
about production text, and one wrong rule sends an operator down the wrong path
(the whole reason this folder exists is that ``shm_open: Permission denied`` was
read as "the container's GPU stack is broken" for a week). Second the collector:
it must find both layouts a DKAO task lives in — a WebUI task under
``.metainfer/tasks/`` and a harness child under ``workspaces/*/children/**/state``
— because that is where most environment failures hide.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..error_catalog import collect_errors as ce


# ------------------------------------------------------------------ classifier

def test_shared_memory_denial_is_its_own_class():
    text = ("--probe failed (3): shm_open: Permission denied\n"
            "UserWarning: Can't initialize amdsmi - Error code: 32")
    assert ce.classify(text).id == "ENV-SHM-SANDBOX"


def test_the_shm_class_wins_over_the_probe_wrapper():
    """The wrapper is a retry budget, not a diagnosis: name the cause."""
    text = ("GPU probe failed after 3 attempt(s) (RuntimeError): ... failed (3): "
            "shm_open: Permission denied")
    assert ce.classify(text).id == "ENV-SHM-SANDBOX"


def test_the_probe_wrapper_is_used_when_no_cause_is_named():
    text = "GPU probe failed after 3 attempt(s) (RuntimeError): " \
           "python3 w8a8_bench.py exited"
    assert ce.classify(text).id == "ENV-PROBE-WRAPPER"


def test_a_full_dev_shm_is_not_called_confinement():
    """Only a denial is confinement; a full tmpfs must not be reported as one."""
    text = "failed (1): shm_open: No space left on device"
    assert ce.classify(text).id != "ENV-SHM-SANDBOX"


def test_real_production_strings_land_in_the_right_class():
    cases = {
        "worker_0-m16_wqkv_a-iter8 failed: killed (see events log tail)":
            "PROC-AGENT-KILLED",
        "exact correctness failed: {\"first_mismatch\": {\"abs_error\": 13.2}}":
            "KQ-CORRECTNESS",
        "child-generated kernel Graph/correctness validation failed for tp8_wq_b_m2":
            "KQ-CORRECTNESS",
        "performance regressed for m2_wqkv_a: final 12.3 us vs worker best 11.6 us":
            "KQ-PERF-REGRESSION",
        "bootstrap Agent changed files outside its HIP ownership: ['x.pyc']":
            "GEN-OWNERSHIP",
        "[Errno 2] No such file or directory: 'ccb'": "GEN-BINARY-MISSING",
        "Generate agent attempt 3 failed: nonzero exit 1": "GEN-AGENT-EJECT",
        "Kernel coordination failed after 3 attempts. Last failure: ...":
            "GEN-COORD-FAILED",
        "worker bootstrap has fewer than one successful GPU worker":
            "PROC-NO-WORKER",
        "workspace main already points to /x, not requested kernel repo /y":
            "GEN-CONFLICT",
        "tp_size must be 4 or 8, got 1": "GEN-SCHEMA",
        "staged API contract digest is not trusted": "GEN-CONTRACT",
        "GPU 0 did not pass the measurement gate (VRAM <=90% and HCU ==0) after 48 checks":
            "ENV-GATE-TIMEOUT",
        "no GPU lease became available after 48 checks": "ENV-NO-LEASE",
        "inline asm acceptance gate failed: proposal.json is missing isa_optimization":
            "KQ-INLINE-ASM",
        "RuntimeError: No HIP GPUs are available": "ENV-NO-DEVICE",
    }
    for text, expected in cases.items():
        got = ce.classify(text)
        assert got is not None, text
        assert got.id == expected, f"{text!r} → {got.id}, expected {expected}"


def test_harmless_text_is_not_filed():
    assert ce.classify("phase_start parallel_explore") is None
    assert ce.classify("") is None
    assert ce.classify("worker_bootstrap_success worker_1") is None


def test_pmc_skip_is_filed_but_is_marked_by_design():
    cls = ce.classify("worker_pmc_skipped worker_1 available false")
    assert cls.id == "MEAS-PMC-UNAVAILABLE"
    assert cls.status == "by design"


def test_every_class_points_at_a_doc_that_exists():
    docs = Path(ce.__file__).resolve().parent
    for cls in ce.CLASSES:
        assert (docs / cls.doc).is_file(), f"{cls.id} → missing {cls.doc}"
        assert cls.status in {"fixed", "by design", "environment", "open"}


# ------------------------------------------------------------------ extracting

def _task(path: Path, task_type: str = "dcu-kernel-auto-opt") -> Path:
    """A synthetic task state dir at exactly ``path``."""
    path.mkdir(parents=True, exist_ok=True)
    task_id = path.name if path.name != "state" else path.parent.name
    (path / "run.json").write_text(json.dumps({
        "task_id": task_id, "task_type": task_type, "final_status": "stopped",
        "last_outcome": "infra_fail", "last_update": 1790052837.0,
        "notes": ["GPU probe failed after 3 attempt(s) (RuntimeError): "
                  "w8a8_bench.py --probe failed (3): shm_open: Permission denied"],
    }), encoding="utf-8")
    (path / "timeline.jsonl").write_text("\n".join([
        json.dumps({"ts": 1790052830.0, "type": "phase_start",
                    "payload": {"phase": "generate_kernel_repo"}}),
        json.dumps({"ts": 1790052831.0, "type": "worker_iteration_failed",
                    "payload": {"error": "exact correctness failed: "
                                          "{\"first_mismatch\": {\"abs_error\": 10.25}}"}}),
        json.dumps({"ts": 1790052832.0, "type": "task_killed",
                    "payload": {"prior_pid": 1}}),
    ]) + "\n", encoding="utf-8")
    (path / "measurement_gate.jsonl").write_text(json.dumps({
        "ts": 1790052833.0, "event": "gate_blocked", "gpu": 2, "site": "benchmark",
        "vram_percent": 87.0, "util_percent": 12.5, "reasons": ["VRAM 87% > 90%?"],
    }) + "\n", encoding="utf-8")
    (path / "gpu_probe_failure.json").write_text(json.dumps({
        "ts": 1790052837.0, "attempts": 3, "attempts_performed": 1,
        "dev_shm_write": {"ok": False, "dir": "/dev/shm", "errno": 13,
                          "error": "Permission denied", "denied": True},
    }), encoding="utf-8")
    return path


def test_scan_task_reads_every_evidence_file(tmp_path):
    state = _task(tmp_path / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    workspace = tmp_path / "workspaces" / state.name
    (workspace / "workers" / "worker_0").mkdir(parents=True)
    (workspace / "workers" / "worker_0" / "failure.json").write_text(json.dumps({
        "worker_id": "worker_0", "stage": "bootstrap", "timestamp": 1790052839.0,
        "error": "worker_0 could not generate a valid initial HIP kernel after 3 attempts",
    }), encoding="utf-8")

    records = ce.scan_task(state, workspace)
    classes = {r.class_id for r in records}

    assert "ENV-SHM-SANDBOX" in classes          # run.json note + probe diagnostics
    assert "KQ-CORRECTNESS" in classes           # timeline
    assert "ENV-GATE-TIMEOUT" in classes         # measurement_gate.jsonl
    assert "GEN-NO-KERNEL" in classes            # worker failure.json
    assert all(r.task_id == state.name for r in records)
    # the diagnostics snapshot records that no retry was spent (deterministic)
    probe = [r for r in records if r.source == "gpu_probe_failure.json"][0]
    assert "denied" in probe.raw


def test_harmless_events_are_not_collected(tmp_path):
    records = ce.scan_task(_task(tmp_path / "dcu-kernel-auto-opt-web1"))
    assert not any(r.event == "phase_start" for r in records), (
        "a phase transition is not an error")


# ------------------------------------------------------------------ discovering

def test_both_task_layouts_are_found(tmp_path):
    nodes = tmp_path / "nodes" / "worker29"
    webui = _task(nodes / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    child = _task(nodes / "workspaces" / "parent1" / "children" / "iteration_001"
                  / "shape_a" / "state")

    found = {p.resolve() for p in ce._task_dirs(nodes)}

    assert webui.resolve() in found
    assert child.resolve() in found


def test_the_task_type_filter_keeps_other_tasks_out(tmp_path):
    nodes = tmp_path / "nodes" / "worker29"
    _task(nodes / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    _task(nodes / ".metainfer" / "tasks" / "some-other-task",
          task_type="harness-evolve")

    kept = ce._task_dirs(nodes, task_type="dcu-kernel-auto-opt")

    assert [p.name for p in kept] == ["dcu-kernel-auto-opt-web1"]


def test_pointing_at_a_node_dir_also_finds_harness_children(tmp_path):
    """``--root nodes/worker29`` must not silently drop the embedded runs.

    The collector used to glob ``*/.metainfer/tasks/*``, which needs the *parent*
    of the node directory: given a node dir it found the WebUI tasks and quietly
    missed every harness child — the half that carries most environment failures.
    """
    node = tmp_path / "nodes" / "worker29"
    webui = _task(node / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    child = _task(node / "workspaces" / "parent1" / "children" / "iteration_001"
                  / "shape_a" / "state")

    found = {p.resolve() for p in ce._task_dirs(node)}

    assert {webui.resolve(), child.resolve()} <= found


def test_pointing_at_the_nodes_dir_finds_both_layouts_too(tmp_path):
    nodes = tmp_path / "nodes"
    webui = _task(nodes / "worker29" / ".metainfer" / "tasks"
                  / "dcu-kernel-auto-opt-web1")
    child = _task(nodes / "worker29" / "workspaces" / "parent1" / "children"
                  / "iteration_001" / "shape_a" / "state")

    found = {p.resolve() for p in ce._task_dirs(nodes)}

    assert {webui.resolve(), child.resolve()} <= found


def test_a_harness_child_gets_a_readable_id(tmp_path):
    nodes = tmp_path / "nodes" / "worker29"
    child = _task(nodes / "workspaces" / "parent1" / "children" / "iteration_002"
                  / "hy3_tp8_o_proj_m16" / "state")
    assert ce._task_label(child) == "parent1:iteration_002/hy3_tp8_o_proj_m16"
    # the readable id is what lands in the records, not the useless "state"
    records = ce.scan_task(child)
    assert records and {r.task_id for r in records} == {
        "parent1:iteration_002/hy3_tp8_o_proj_m16"}
    # a WebUI task keeps its directory name
    assert ce._task_label(tmp_path / "dcu-kernel-auto-opt-x") == "dcu-kernel-auto-opt-x"


# ------------------------------------------------------------------ collection

def test_collect_counts_repeats_and_summarises(tmp_path):
    nodes = tmp_path / "nodes" / "worker29"
    state = _task(nodes / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    repeated = json.loads(
        (state / "timeline.jsonl").read_text(encoding="utf-8").splitlines()[1])
    repeated["ts"] = 1790052840.0
    with (state / "timeline.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(repeated) + "\n")

    collection = ce.collect([nodes])

    assert collection.scanned == 1
    correctness = [r for r in collection.records if r.class_id == "KQ-CORRECTNESS"]
    assert len(correctness) == 1
    assert correctness[0].occurrences == 2, "identical messages collapse but count"

    summary = ce.render_summary(collection)
    assert "KQ-CORRECTNESS" in summary and "ENV-SHM-SANDBOX" in summary
    assert "扫描任务数：**1**" in summary


def test_main_writes_both_artifacts(tmp_path):
    nodes = tmp_path / "nodes" / "worker29"
    _task(nodes / ".metainfer" / "tasks" / "dcu-kernel-auto-opt-web1")
    out = tmp_path / "catalog"

    assert ce.main(["--root", str(nodes), "--out", str(out), "--quiet"]) == 0

    rows = [json.loads(line) for line in
            (out / "samples.jsonl").read_text(encoding="utf-8").splitlines()]
    assert rows and {"class_id", "task_id", "source", "raw"} <= set(rows[0])
    assert "ENV-SHM-SANDBOX" in (out / "SUMMARY.md").read_text(encoding="utf-8")


def test_the_shipped_catalog_is_consistent():
    """The files in this folder must agree with the rules that produced them."""
    here = Path(ce.__file__).resolve().parent
    if not (here / "SUMMARY.md").is_file():
        return                      # catalog not generated yet: nothing to check
    summary = (here / "SUMMARY.md").read_text(encoding="utf-8")
    for cls in ce.CLASSES:
        assert cls.id in summary, f"{cls.id} missing from SUMMARY.md"
        assert (here / cls.doc).is_file()
    for name in ("README.md", "01-environment.md", "02-generate-and-agent.md",
                 "03-measurement-and-gate.md", "04-kernel-quality.md",
                 "05-process-and-infra.md"):
        assert (here / name).is_file(), f"{name} missing from the catalog"


# --------------------------------------------------- packed-layout conflicts

def test_packed_layout_conflict_is_its_own_class():
    """It is a merge-level packing mismatch, not a kernel that computes wrong.

    Ten ``KQ-CORRECTNESS`` rows used to swallow both df6fb501 and its hy3
    predecessor, which is exactly why the first fix was never revisited.
    """
    text = ce._first_text({
        "reason": (
            "members of one (N, K) family pack the weight differently; the "
            "frozen prepare_weight ABI has no M, so the merge cannot share "
            "one image"
        ),
        "conflicts": "1280x6144 (aaaa=..bbbb=..)",
    })
    assert ce.classify(text).id == "KQ-PACK-LAYOUT-CONFLICT"


def test_layout_conflict_event_is_collected_without_an_exception():
    event = {
        "type": "final_layout_conflict",
        "payload": {"reason": "members of one (N, K) family pack ..."},
    }
    assert ce._is_errorish(event["type"], event["payload"]) is True
