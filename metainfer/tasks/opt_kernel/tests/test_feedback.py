"""Tests for the operator feedback channel (persistent guidance)."""

from __future__ import annotations

from pathlib import Path

import pytest

from metainfer.tasks.opt_kernel.orchestrator import feedback


def test_append_and_read(tmp_path: Path):
    fb = feedback.append_feedback(tmp_path, "优先减小显存", iteration_at_submit=1)
    assert fb["text"] == "优先减小显存"
    assert fb["iteration_at_submit"] == 1
    assert fb["id"]

    entries = feedback.read_feedback(tmp_path)
    assert len(entries) == 1
    assert entries[0]["text"] == "优先减小显存"


def test_read_empty_when_no_file(tmp_path: Path):
    assert feedback.read_feedback(tmp_path) == []


def test_append_multiple_preserves_order(tmp_path: Path):
    feedback.append_feedback(tmp_path, "first", 1)
    feedback.append_feedback(tmp_path, "second", 2)
    feedback.append_feedback(tmp_path, "third", 3)
    entries = feedback.read_feedback(tmp_path)
    assert [e["text"] for e in entries] == ["first", "second", "third"]
    assert [e["iteration_at_submit"] for e in entries] == [1, 2, 3]


def test_append_rejects_empty(tmp_path: Path):
    with pytest.raises(ValueError):
        feedback.append_feedback(tmp_path, "   ")
    assert feedback.read_feedback(tmp_path) == []


def test_feedback_text_for_prompt_none_when_empty(tmp_path: Path):
    assert feedback.feedback_text_for_prompt(tmp_path) is None


def test_feedback_text_for_prompt_joins_all(tmp_path: Path):
    feedback.append_feedback(tmp_path, "use triton", 1)
    feedback.append_feedback(tmp_path, "favor large-batch throughput", 2)
    block = feedback.feedback_text_for_prompt(tmp_path)
    assert block is not None
    assert "use triton" in block
    assert "favor large-batch throughput" in block
    # both entries appear, numbered, with iteration tags
    assert "[submitted at iter 1]" in block
    assert "[submitted at iter 2]" in block


def test_feedback_persistent_all_entries_each_call(tmp_path: Path):
    """持久指导 design: every call returns ALL entries (no consumption cursor)."""
    feedback.append_feedback(tmp_path, "opinion A", 1)
    block1 = feedback.feedback_text_for_prompt(tmp_path)
    assert "opinion A" in block1
    # second call still returns it (persistent, not consumed)
    block2 = feedback.feedback_text_for_prompt(tmp_path)
    assert "opinion A" in block2
    feedback.append_feedback(tmp_path, "opinion B", 2)
    block3 = feedback.feedback_text_for_prompt(tmp_path)
    assert "opinion A" in block3 and "opinion B" in block3
