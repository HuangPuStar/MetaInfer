"""Tests for orchestrator.repo_cleanup — 任务级候选仓库清理的安全边界。

重点验证"绝不误删"：
- 只匹配 ``ahe-{task_id}-it`` 精确前缀（task_id 互为前缀时不误伤）
- 池白名单（registered_pool.yaml 引用）一律保留
- 符号链接 / 非目录 / 越界路径一律跳过
- dry_run 不做任何修改
"""

from __future__ import annotations

import textwrap

import pytest

from ..orchestrator.repo_cleanup import (
    load_pool_keep_list,
    owned_repos,
    purge_task_kernel_repos,
    repo_name_prefix,
    resolve_ahe_repo_root,
)

TASK = "test-9-8-5-e10567a1"


def _mk_repo(root, name):
    d = root / name
    d.mkdir(parents=True)
    (d / "kernel.py").write_text("print('x')\n", encoding="utf-8")
    (d / "sub").mkdir()
    (d / "sub" / "blob.bin").write_bytes(b"0" * 32)
    return d


def _pool(root, names):
    lines = ["schema_version: 1", "instances:"]
    for n in names:
        lines.append(f"- id: {n}")
        lines.append(f"  source_report: {root}/{n}/final_report.json")
    (root / "registered_pool.yaml").write_text(
        "\n".join(lines) + "\n", encoding="utf-8")


def test_repo_name_prefix_uses_it_marker():
    assert repo_name_prefix(TASK) == f"ahe-{TASK}-it"


def test_resolve_ahe_repo_root_prefers_answer(tmp_path):
    custom = tmp_path / "custom-root"
    assert resolve_ahe_repo_root({"ahe_repo_root": str(custom)}) == custom.resolve()


def test_resolve_ahe_repo_root_defaults_when_absent():
    assert str(resolve_ahe_repo_root(None)).endswith("ahe-kernel-repos")


def test_prefix_protects_repo_when_task_id_is_prefix_of_another(tmp_path):
    """``ahe-<tid>-it`` 结尾的 '-it' 保证不误伤同前缀的其他任务。"""
    _mk_repo(tmp_path, f"ahe-{TASK}-it001-candidate-foo-aaaaaa")
    other = _mk_repo(tmp_path, f"ahe-{TASK}-extra-it001-candidate-bar-bbbbbb")

    deletable, _ = owned_repos(TASK, tmp_path, keep=set())
    names = {p.name for p in deletable}

    assert f"ahe-{TASK}-it001-candidate-foo-aaaaaa" in names
    assert other.name not in names, "task_id 同前缀的其他任务仓库被误列"


def test_unrelated_task_repos_untouched(tmp_path):
    _mk_repo(tmp_path, "ahe-other-task-it001-candidate-foo-aaaaaa")
    _mk_repo(tmp_path, "dsh-min-1iter-abff697d")  # 人工仓库
    deletable, _ = owned_repos(TASK, tmp_path, keep=set())
    assert deletable == []


def test_pool_whitelist_is_never_deleted(tmp_path):
    keep_name = f"ahe-{TASK}-it001-candidate-keepme-aaaaaa"
    drop_name = f"ahe-{TASK}-it002-candidate-dropme-bbbbbb"
    _mk_repo(tmp_path, keep_name)
    _mk_repo(tmp_path, drop_name)
    _pool(tmp_path, [keep_name])

    keep = load_pool_keep_list(tmp_path)
    assert keep_name in keep

    deletable, skipped = owned_repos(TASK, tmp_path, keep=keep)
    names = {p.name for p in deletable}
    assert names == {drop_name}
    assert any(keep_name in s for s in skipped)


def test_symlink_repos_are_skipped(tmp_path):
    real = _mk_repo(tmp_path, f"ahe-{TASK}-it003-candidate-real-cccccc")
    link = tmp_path / f"ahe-{TASK}-it004-candidate-link-dddddd"
    link.symlink_to(real)

    deletable, skipped = owned_repos(TASK, tmp_path, keep=set())
    names = {p.name for p in deletable}
    assert real.name in names
    assert link.name not in names
    assert any(link.name in s for s in skipped)


def test_dry_run_changes_nothing(tmp_path):
    name = f"ahe-{TASK}-it005-candidate-x-eeeeee"
    repo = _mk_repo(tmp_path, name)

    summary = purge_task_kernel_repos(TASK, tmp_path, keep=set(), dry_run=True)
    assert summary["dry_run"] is True
    assert summary["matched"] == 1
    assert summary["deleted"] == []
    assert summary["bytes"] > 0
    assert repo.exists(), "dry_run 不应删除任何东西"


def test_apply_removes_only_owned_repos(tmp_path):
    owned = _mk_repo(tmp_path, f"ahe-{TASK}-it006-candidate-x-ffffff")
    kept = _mk_repo(tmp_path, "ahe-other-it006-candidate-y-111111")

    summary = purge_task_kernel_repos(TASK, tmp_path, keep=set(), dry_run=False)
    assert len(summary["deleted"]) == 1
    assert not summary["failed"]
    assert not owned.exists()
    assert kept.exists(), "其他任务的仓库被误删"


def test_missing_repo_root_is_reported_not_raised(tmp_path):
    missing = tmp_path / "nope"
    summary = purge_task_kernel_repos(TASK, missing, dry_run=True)
    assert summary["matched"] == 0
    assert summary["skipped"]


def test_refuses_when_task_still_registered(tmp_path, monkeypatch):
    """任务仍在注册表 → 默认拒绝清理（force=False）。"""
    name = f"ahe-{TASK}-it010-candidate-live-aaaaaa"
    repo = _mk_repo(tmp_path, name)

    from ..orchestrator import repo_cleanup as rc
    monkeypatch.setattr(rc, "is_task_registered", lambda tid: True)

    summary = rc.purge_task_kernel_repos(TASK, tmp_path, keep=set(), dry_run=False)
    assert summary.get("refused") == "task_still_registered"
    assert summary["deleted"] == []
    assert repo.exists(), "注册中的任务仓库被误删"

    # force=True 时才允许
    summary2 = rc.purge_task_kernel_repos(
        TASK, tmp_path, keep=set(), dry_run=False, force=True)
    assert len(summary2["deleted"]) == 1
    assert not repo.exists()
