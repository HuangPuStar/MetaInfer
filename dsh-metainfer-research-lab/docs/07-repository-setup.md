# 07 · 仓库自动准备 / Repository preparation

## 用户流程（中文）

1. 在「新建项目」填写**本地绝对目录**或 **Git 仓库 URL**，点击「准备仓库」。无需事先手工 `git init` 或设置全局用户名/邮箱。
2. 已有 Git 就直接使用；未发现 Git 时，先显示系统包管理器的固定安装命令和说明，只有点击「同意并安装 Git」后才会安装。Windows 使用精确的 `Git.Git` / winget 源，自动接受包和源协议，可能出现系统权限提示。安装后重新验证 Git，再自动继续原路径。没有受支持管理器或权限时，界面提供官方安装链接供手动处理。
3. 普通目录自动初始化；没有历史的仓库仅补一个**本地空提交**作为实验基线，不会自动提交现有文件、暂存内容或推送 GitHub。希望实验使用现有文件时，请先自行提交，再重新准备。已有提交、工作树和 index 保留。
4. 远程 URL 克隆到 DSH 的受管缓存，再准备分支与基准提交。之后仍按「创建项目」→ planned 根节点 → 启动实验的流程使用。
5. 根节点提示词至少需要 10 个字符，例如「计算 99 乘以 100，并报告结果 9900」。报错会随当前界面语言显示简短解决办法，不直接显示底层 Git 英文日志。

**不会自动完成的授权：**私有库凭据、网络代理、受限目录权限或 Git 的不安全所有权信任。这些操作不能安全地代替用户授权。不要为绕过安全检查而全局设置 `safe.directory=*`。安装开始后，关闭向导只会停止界面等待，不承诺回滚系统包管理器；请先检查系统安装状态，再重试。

## User flow (English)

Enter an **absolute local directory** or **Git repository URL** and select **Prepare repository**. New directories are initialized; repositories without history receive a **local empty commit** for worktrees. Existing files, staged content and history are not committed, discarded or pushed automatically. Commit the files you want in experiments, then prepare again.

If Git is unavailable, review the fixed package-manager command and grant explicit consent. On Windows this accepts the Git package and winget source agreements and may show an OS permission prompt. Git is reverified after installation and preparation resumes for the original path. Unsupported managers or insufficient permissions fall back to official manual installation guidance. Private credentials, ownership trust and filesystem permissions still require the owner. Closing the wizard ignores late responses but does not guarantee cancellation or rollback of a system installation already started.

## API 与安全边界

所有路由继续使用 DSH Connection 的 owner 鉴权和 `{ok,data}` / `{ok,error:{code,message}}` 信封；不增加匿名安装接口。

| 接口 | 语义 |
|---|---|
| `GET /api/metainfer-research-lab/repo?path=…` | 只读校验，不克隆、初始化或提交 |
| `POST /api/metainfer-research-lab/repo`，`{ "path": "…" }` | 显式准备，返回真实根目录、分支、基准 commit 和 dirty 状态 |
| `GET /api/metainfer-research-lab/git` | 探测 Git 和可用的固定安装计划，不安装 |
| `POST /api/metainfer-research-lab/git/install`，`{ "confirmed": true }` | 严格布尔确认；拒绝字符串 `"true"` 等，不接受自定义安装命令；安装单飞、输出有界、上限 5 分钟并复验版本 |

服务层 `prepareRepo` 与 `createProject` 共用 GitEngine，创建时先检查研究参数再修改仓库。没有 `.git` 且位于另一仓库内部的目录不会悄悄绑定父仓库。不会改写 global identity、签名、默认分支或 safe.directory。macOS 只用已存在的 Homebrew；Linux 非 root 仅使用 `sudo -n`，不收集密码、不静默提权或下载执行脚本。

取消或切换输入会废弃旧请求的界面结果；后端已开始的准备动作可能完成，但只作用于原来明确选择的目录/受管缓存，不会把旧仓库绑定到新输入。

### 路径与缓存限制 / Paths and cache limits

- Windows Git 命令临时使用 `core.longpaths=true`，不写全局或仓库配置；工作根目录本身仍需短于 260 字符。超长时显示专用本地化建议：缩短目录；受管克隆则缩短 `DSH_HOME` 并重启 DSH。
- Git 的父进程仓库选择变量（包括 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`、对象目录和 namespace）在每个 Git 操作中隔离，不会把所选路径的操作重定向到其他仓库。
- 受管缓存按规范化 clone URL 的 SHA-256 保存在 `DSH_HOME/metainfer-research-lab/repos/`；重复准备可离线复用，不自动 fetch、reset 或清理历史缓存。只清理本次创建的 `.clone-*` 暂存目录。缓存根、`.git` junction/symlink、gitfile 及共享 `commondir` 均不能指向外部元数据。
- 准备单飞保证同一 Host 进程内的多个请求/engine 实例不会重复初始化或克隆；不是跨进程文件锁。不要让多个独立 Host 同时管理同一缓存。在 POSIX 上，外部进程恰在最终检查后创建的空目标目录存在 rename 竞争；已有非空目录和用户文件不会因此被替换。

On Windows, Git operations use an operation-scoped long-path override, but the working root must remain below 260 characters. Choose a shorter folder or `DSH_HOME` for a long clone cache. Ambient Git repository selectors are removed per operation. Managed caches reject external metadata, reuse clones without fetching/resetting, and clean only owned temporary clones. Single-flight coordination is process-local, not a cross-process lock; avoid sharing one cache between independent Hosts.

## 回归验证

在插件目录运行（需 Node 和已有依赖）：

```sh
node scripts/repository-selftest.mjs
node --test scripts/git-setup-selftest.mjs
node scripts/repository-client-selftest.mjs
MIRL_DEMO_REPO=/absolute/path/to/test-repo DSH_HOME=/absolute/path/to/test-home node scripts/selftest.mjs
node scripts/cluster-fleet-selftest.mjs
node scripts/placement-selftest.mjs
```

- repository 用真实 Git 和自有临时目录覆盖本地新目录/空远端、已有历史/坏 HEAD、幂等、索引/身份配置保留与 worktree。
- git-setup 用 mock 覆盖缺失检测、严格确认、固定安装参数、权限/取消/超时、并发与安装后复验；**不实际安装系统软件**。
- repository-client 用离线 React 状态桩和 HTTP handler 覆盖双语建议、准备/安装请求、输入保留、拒绝安装、改路径和卸载后的过期响应。
- 运行版更新、桌面GUI人工测试和公开Issue/PR是分开的验收步骤，离线测试通过不代表这些步骤已经完成。
