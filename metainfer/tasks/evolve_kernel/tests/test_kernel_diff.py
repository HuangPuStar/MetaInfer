"""Unit tests for the kernel source/diff readers in server/_state_readers.py.

Covers ``read_kernel_source`` (resolve one library kernel by id) and
``read_kernel_diff`` (unified diff against the reference or a parent kernel),
including the non-raising failure paths the diff view depends on.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from metainfer.tasks.evolve_kernel.server._state_readers import (
    read_kernel_diff,
    read_kernel_source,
)

REF_CODE = "\n".join([
    "def kernel(x):",
    "    return x",
])

PARENT_CODE = "\n".join([
    "def kernel(x):",
    "    # parent tweak",
    "    return x",
])

CHILD_CODE = "\n".join([
    "def kernel(x):",
    "    # child tweak",
    "    return x * 2",
])


def _write_library(ws: Path, kernels):
    (ws / "kernel_library.json").write_text(
        json.dumps(kernels, indent=2), encoding="utf-8")


def _write_reference(ws: Path, code: str):
    ref_dir = ws / "reference"
    ref_dir.mkdir(parents=True, exist_ok=True)
    (ref_dir / "original_kernel.py").write_text(code, encoding="utf-8")


def _kernel(kid, code, parent_id=None, **meta):
    entry = {
        "id": kid,
        "code": code,
        "parent_id": parent_id,
        "exec_time_ms": meta.get("exec_time_ms", 1.0),
        "complexity_score": meta.get("complexity_score", 0.0),
        "combined_score": meta.get("combined_score", 7.0),
        "iteration_added": meta.get("iteration_added", 0),
    }
    return entry


# --------------------------------------------------------------------------- #
# read_kernel_source
# --------------------------------------------------------------------------- #


class TestReadKernelSource:
    def test_finds_kernel_by_id(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_library(ws, [
                _kernel("aaa", REF_CODE),
                _kernel("bbb", CHILD_CODE, parent_id="aaa",
                        exec_time_ms=2.5, iteration_added=7),
            ])
            src = read_kernel_source(ws, "bbb")
            assert src["exists"] is True
            assert src["id"] == "bbb"
            assert src["code"] == CHILD_CODE
            assert src["lines"] == len(CHILD_CODE.splitlines())
            assert src["meta"]["parent_id"] == "aaa"
            assert src["meta"]["exec_time_ms"] == 2.5
            assert src["meta"]["iteration_added"] == 7

    def test_matches_by_string_coercion(self):
        """ids may be written as non-str (e.g. int); lookup must coerce."""
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_library(ws, [{"id": 42, "code": REF_CODE}])
            src = read_kernel_source(ws, "42")
            assert src["exists"] is True
            assert src["code"] == REF_CODE

    def test_missing_kernel(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_library(ws, [_kernel("aaa", REF_CODE)])
            src = read_kernel_source(ws, "nope")
            assert src["exists"] is False
            assert src["code"] == ""
            assert src["meta"] == {}

    def test_no_library_file(self):
        with tempfile.TemporaryDirectory() as d:
            src = read_kernel_source(Path(d), "anything")
            assert src["exists"] is False


# --------------------------------------------------------------------------- #
# read_kernel_diff
# --------------------------------------------------------------------------- #


class TestReadKernelDiff:
    def test_diff_vs_reference(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [_kernel("child", CHILD_CODE)])
            diff = read_kernel_diff(ws, "child", base="reference")
            assert diff["exists"] is True
            assert diff["base"] == "reference"
            assert diff["base_label"] == "reference"
            assert diff["added"] == 2  # "# child tweak" and "return x * 2"
            assert diff["removed"] == 1  # "return x"
            assert "a/reference" in diff["diff"]
            assert "b/kernel child" in diff["diff"]

    def test_diff_vs_parent(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [
                _kernel("parent1234", PARENT_CODE),
                _kernel("child5678", CHILD_CODE, parent_id="parent1234"),
            ])
            diff = read_kernel_diff(ws, "child5678", base="parent")
            assert diff["exists"] is True
            assert diff["base_label"] == "kernel parent12"
            assert "a/kernel parent12" in diff["diff"]

    def test_root_kernel_has_no_parent(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [_kernel("root", REF_CODE)])
            diff = read_kernel_diff(ws, "root", base="parent")
            assert diff["exists"] is False
            assert diff["error"] == "kernel has no parent"

    def test_parent_evicted_from_library(self):
        """A parent no longer present (evicted) must not raise."""
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [
                _kernel("child5678", CHILD_CODE, parent_id="gone0000"),
            ])
            diff = read_kernel_diff(ws, "child5678", base="parent")
            assert diff["exists"] is False
            assert "no longer in the library" in diff["error"]

    def test_unknown_kernel(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [_kernel("aaa", REF_CODE)])
            diff = read_kernel_diff(ws, "ghost")
            assert diff["exists"] is False
            assert "unknown kernel" in diff["error"]

    def test_missing_reference_is_full_addition(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_library(ws, [_kernel("child", CHILD_CODE)])
            diff = read_kernel_diff(ws, "child", base="reference")
            assert diff["exists"] is True
            assert diff["removed"] == 0
            assert diff["added"] == len(CHILD_CODE.splitlines())

    def test_identical_code_yields_empty_body(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            _write_reference(ws, REF_CODE)
            _write_library(ws, [_kernel("same", REF_CODE)])
            diff = read_kernel_diff(ws, "same", base="reference")
            assert diff["exists"] is True
            assert diff["added"] == 0
            assert diff["removed"] == 0
            assert diff["diff"] == ""
