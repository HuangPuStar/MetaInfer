"""任务级 kernel 仓库清理（harness_evolve / AHE）。

背景
----
AHE 每轮为每道题物化一个独立的候选 kernel 仓库，命名规则见
``harness_evolve/orchestrator/adapters/eval.py``::

    child_id = _slug(f"ahe-{cfg.task_id}-it{iteration:03d}-candidate-{inst.id}-{suffix}")

因此 ``ahe-<task_id>-it<NNN>-...`` 的前缀可以**精确**定位"某任务拥有的仓库"。
一个跑满 N 轮的 AHE 任务会留下 约 4N 个仓库（4 = 一轮题数/卡数），
而 ``sys_shell`` 里原有的 ``_purge_owned_kernel_repo`` 只删**单个**仓库，
且 task_type 门禁写死为 ``dcu-kernel-auto-opt``，对 HE 完全不生效 —— 于是
任务删除后这些仓库永久残留。

安全设计（三层）
----------------
1. **前缀精确匹配**：只处理 ``ahe-{task_id}-it`` 开头的目录，天然不会碰到
   人工维护的 ``/root/zth_agent/kernel-repos`` 或别的任务的仓库。
2. **池白名单**：``registered_pool.yaml`` 中 ``source_report`` 引用的仓库
   一律保留 —— 即便前缀匹配上了也绝不删。
3. **路径校验**：跳过符号链接、跳过非本目录直接子项、解析后必须仍在 repo_root 内。

默认 ``dry_run=True``：只报告，不删除。
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_AHE_REPO_ROOT = Path("/root/zth_agent/ahe-kernel-repos")
_REGISTERED_POOL_NAME = "registered_pool.yaml"

# 匹配仓库名本身：形如 ``ahe-{task_id}-it{NNN}-candidate-...``
# （见 eval.py 的 ``_slug(f"ahe-{task_id}-it{iteration:03d}-candidate-...")``）。
#
# 只锚定名称模式、不要求前后是 '/' 或引号：池文件里同一个仓库既可能写成
# ``.../ahe-xxx-it001-.../final_report.json``（后面跟 '/'），也可能写成
# ``.../ahe-xxx-it001-...``（行尾）或 JSON 里的 ``"repo_path": ".../ahe-xxx-it001-..."``，
# 加边界锚点会漏掉其中一种。``-it<数字>`` 这个标记本身已足够特异：
# 它既不会命中仓库根目录 ``ahe-kernel-repos``，也不会命中 ``kernel-repos`` 下
# 人工维护的仓库（那些名字里没有 ahe- 前缀）。
_REPO_REF_RE = re.compile(r"(ahe-[A-Za-z0-9._-]*?-it\d+[A-Za-z0-9._-]*)")


def resolve_ahe_repo_root(answers: Optional[Dict[str, Any]] = None) -> Path:
    """与 eval.py 的解析保持一致：answers['ahe_repo_root'] 优先，否则默认值。"""
    raw = None
    if isinstance(answers, dict):
        raw = answers.get("ahe_repo_root")
    base = Path(str(raw or DEFAULT_AHE_REPO_ROOT)).expanduser()
    try:
        return base.resolve()
    except OSError:
        return base


def repo_name_prefix(task_id: str) -> str:
    """该任务拥有的仓库名前缀。结尾的 'it' 是关键：避免 task_id 互为前缀时误伤。"""
    return f"ahe-{task_id}-it"


def load_pool_keep_list(repo_root: Path) -> set[str]:
    """从 registered_pool.yaml 提取所有被引用的仓库目录名（白名单）。"""
    keep: set[str] = set()
    pool = repo_root / _REGISTERED_POOL_NAME
    if not pool.is_file():
        return keep
    try:
        text = pool.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return keep
    for name in _REPO_REF_RE.findall(text):
        name = name.strip()
        if name and name != _REGISTERED_POOL_NAME:
            keep.add(name)
    return keep


def is_task_registered(task_id: str) -> bool:
    """该 task_id 是否仍在 WebUI 注册表中（即任务尚未被删除）。

    注册表位置与 :mod:`metainfer.server.tasks` 一致：
    ``<node_dir>/.metainfer/registry.json``。任一节点目录命中即视为仍注册。
    """
    import json as _json
    root = _meta_root()
    if root is None:
        return False
    try:
        candidates = sorted(root.glob("nodes/*/.metainfer/registry.json"))
    except OSError:
        return False
    for reg in candidates:
        try:
            data = _json.loads(reg.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        for t in data.get("tasks", []) or []:
            if t.get("id") == task_id:
                return True
    return False


def _meta_root() -> Optional[Path]:
    """定位 MetaInfer 仓库根（含 nodes/ 的那一层）。"""
    # 本文件位于 <root>/metainfer/tasks/harness_evolve/orchestrator/repo_cleanup.py
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "metainfer").is_dir() and (parent / "nodes").is_dir():
            return parent
    return None


def owned_repos(
    task_id: str,
    repo_root: Path,
    keep: Optional[set[str]] = None,
) -> tuple[List[Path], List[str]]:
    """返回 (可删除仓库列表, 被保留的原因说明)。

    只做识别与安全检查，不产生任何副作用 —— 便于 dry-run 与测试。
    """
    keep = keep if keep is not None else load_pool_keep_list(repo_root)
    prefix = repo_name_prefix(task_id)
    deletable: List[Path] = []
    skipped: List[str] = []
    if not repo_root.is_dir():
        return deletable, [f"repo_root 不存在: {repo_root}"]
    try:
        entries = sorted(repo_root.iterdir())
    except OSError as exc:
        return deletable, [f"无法读取 repo_root: {exc}"]

    for p in entries:
        if not p.name.startswith(prefix):
            continue
        # 保护 1：池引用
        if p.name in keep:
            skipped.append(f"{p.name} (被 registered_pool.yaml 引用，保留)")
            continue
        # 保护 2：只删真实目录，不碰符号链接
        if p.is_symlink():
            skipped.append(f"{p.name} (符号链接，跳过)")
            continue
        if not p.is_dir():
            skipped.append(f"{p.name} (非目录，跳过)")
            continue
        # 保护 3：解析后必须仍在 repo_root 内
        try:
            resolved = p.resolve()
        except OSError:
            skipped.append(f"{p.name} (无法解析路径，跳过)")
            continue
        if resolved.parent != repo_root:
            skipped.append(f"{p.name} (解析后越出 repo_root，跳过)")
            continue
        deletable.append(p)
    return deletable, skipped


def purge_task_kernel_repos(
    task_id: str,
    repo_root: Path,
    keep: Optional[set[str]] = None,
    dry_run: bool = True,
    force: bool = False,
) -> Dict[str, Any]:
    """删除某 HE 任务拥有的候选 kernel 仓库。

    :param dry_run: True 时只统计，不做任何删除（默认）。
    :param force: 任务**仍在注册表**中时是否照删。默认 False —— 即"任务还没被
        删除就拒绝清理它的仓库"，避免误伤在跑/待恢复的实验。
    :returns: 摘要字典，含 matched/deleted/skipped/bytes 等。
    """
    deletable, skipped = owned_repos(task_id, repo_root, keep)

    # 保护 0（最重要）：任务仍在注册表 → 其仓库可能被在跑或待恢复的实验使用
    if not force and is_task_registered(task_id):
        return {
            "task_id": task_id,
            "repo_root": str(repo_root),
            "prefix": repo_name_prefix(task_id),
            "dry_run": dry_run,
            "matched": len(deletable),
            "deleted": [],
            "failed": [],
            "skipped": skipped + [
                f"任务 {task_id} 仍在注册表中（未被删除）；"
                "如确认要删，请加 --force / force=True"
            ],
            "bytes": 0,
            "bytes_human": "0B",
            "refused": "task_still_registered",
        }

    # 统计体积（删除前算，删后无从得知）
    bytes_total = 0
    sizes: Dict[str, int] = {}
    for p in deletable:
        sz = 0
        for sub in p.rglob("*"):
            try:
                if sub.is_file() and not sub.is_symlink():
                    sz += sub.stat().st_size
            except OSError:
                continue
        sizes[p.name] = sz
        bytes_total += sz

    deleted: List[str] = []
    failed: List[str] = []
    if not dry_run:
        for p in deletable:
            try:
                shutil.rmtree(p)
                deleted.append(p.name)
            except OSError as exc:
                failed.append(f"{p.name}: {exc}")

    return {
        "task_id": task_id,
        "repo_root": str(repo_root),
        "prefix": repo_name_prefix(task_id),
        "dry_run": dry_run,
        "matched": len(deletable),
        "deleted": deleted,
        "failed": failed,
        "skipped": skipped,
        "bytes": bytes_total,
        "bytes_human": _human(bytes_total),
    }


def _human(n: int) -> str:
    step = float(n)
    for unit in ("B", "K", "M", "G", "T"):
        if step < 1024 or unit == "T":
            return f"{step:.1f}{unit}"
        step /= 1024
    return f"{step:.1f}T"


def main(argv: Optional[List[str]] = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(
        description="清理某个 harness_evolve 任务拥有的候选 kernel 仓库（默认 dry-run）",
    )
    ap.add_argument("task_id", help="HE 任务的 task_id，例如 test-9-8-5-e10567a1")
    ap.add_argument("--repo-root", default=None,
                    help=f"AHE 仓库根，默认 {DEFAULT_AHE_REPO_ROOT}")
    ap.add_argument("--apply", action="store_true",
                    help="真正执行删除（不加此参数只做 dry-run）")
    ap.add_argument("--force", action="store_true",
                    help="任务仍在注册表中时也照删（危险，默认拒绝）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args(argv)

    repo_root = Path(args.repo_root).expanduser() if args.repo_root \
        else DEFAULT_AHE_REPO_ROOT
    summary = purge_task_kernel_repos(
        args.task_id, repo_root, dry_run=not args.apply, force=args.force,
    )

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0 if not summary["failed"] else 1

    if summary.get("refused"):
        print(f"[拒绝清理] task_id={summary['task_id']}")
        print(f"  {summary['skipped'][-1]}")
        return 2

    mode = "DRY-RUN（未删除任何东西）" if summary["dry_run"] else "已执行删除"
    print(f"[{mode}] task_id={summary['task_id']}")
    print(f"  repo_root : {summary['repo_root']}")
    print(f"  匹配前缀  : {summary['prefix']}")
    print(f"  命中仓库  : {summary['matched']} 个，合计 {summary['bytes_human']}")
    if summary["skipped"]:
        print(f"  受保护跳过: {len(summary['skipped'])} 个")
        for s in summary["skipped"][:10]:
            print(f"    - {s}")
    if summary["deleted"]:
        print(f"  已删除    : {len(summary['deleted'])} 个")
    if summary["failed"]:
        print(f"  删除失败  : {len(summary['failed'])} 个")
        for f in summary["failed"][:10]:
            print(f"    - {f}")
    if summary["dry_run"] and summary["matched"]:
        print("\n  确认无误后，加 --apply 执行删除。")
    return 0 if not summary["failed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
