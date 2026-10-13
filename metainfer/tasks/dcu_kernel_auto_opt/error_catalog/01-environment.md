# 01 · 环境类报错

这一层的报错**与候选内核无关**：它们说明这台机器/这个进程树现在没法起 GPU 栈。
判断口诀：**换一个 shell、换一张卡、换一个时间点，同一个命令会不会好**——
会好 → 环境类（本节）；不会 → 看 `04-kernel-quality.md`。

---

## ENV-SHM-SANDBOX

**无法写 `/dev/shm`（文件沙箱）** ｜ 状态：**已修（2026-09-22）** ｜ 真出现：快照内 5 次 + 2026-09-20~22 的 10 次（现场已被 purge，原文见 `README.md` 标本）

### 原文长什么样

```
... --probe failed (3): shm_open: Permission denied
UserWarning: Can't initialize amdsmi - Error code: 32
```

同族变体（同一个根因，不同 errno/不同阶段）：

| 变体原文 | 说明 |
|---|---|
| `shm_open: Permission denied` | 建/写 `/dev/shm/rocm_smi_card*` 被拒（最常见） |
| `shm_open: Invalid argument` | 早前"清理残留 shm"把活跃会合文件删掉后，名字对不上 |
| `fchmod: Bad file descriptor` | 同上：进程手里是已被 unlink 的死 inode |
| `No HIP GPUs are available` | 栈起不来之后的 torch 侧表现（见 `ENV-NO-DEVICE`） |
| `open hydm_... : Permission denied` | 同一沙箱对其它设备节点的拒绝 |

### 判定（30 秒）

```bash
python3 - <<'EOF'
import tempfile, os
try:
    fd, p = tempfile.mkstemp(prefix="chk-", dir="/dev/shm"); os.close(fd); os.unlink(p)
    print("unconfined: /dev/shm writable")
except OSError as e:
    print("CONFINED:", e.errno, e.strerror)
EOF
```
若这里报 `EACCES`，而 `--probe` 也随之失败 → 就是本类。另可看诊断文件
`<task_state>/gpu_probe_failure.json` 的 `dev_shm_write`（`{"ok": false, "errno": 13, "denied": true}`）。

### 根因

ROCm/amdsmi 起 GPU 栈靠 `/dev/shm` 里的会合文件（`rocm_smi_card*` 等）。
进程的文件沙箱（Landlock/bwrap 风格：只允许写自己的 workspace 与 `/tmp`）把 `/dev/shm` 变成**只读**，
`shm_open(O_CREAT)` 与"打开已有段写模式"都会 `EACCES`，于是设备永远出不来。
关键是**继承性**：WebUI（`serve.py`）是长命父进程，Landlock 域被子进程继承且**子进程无法解除**，
所以"启动 WebUI 的那个 shell"决定了后面每一个任务。

2026-09-22 那次就是这么来的：WebUI 是 09-21 15:31 在一个 `workspace-write` 会话里
`nohup` 重启的（见 `nodes/worker29/.metainfer/tasks/` 之外的会话记录），此后每个 WebUI 任务必死。
此前 08-20/08-21/08-23/09-09 的同族报错被误判为"容器 GPU 栈偶发抖动"——
对照实验当时是在**无沙箱**会话里做的（那个会话 09-20 21:49 起就是 `danger-full-access`），
所以"手动跑永远成功"。

### 处置

1. **从无文件沙箱的 shell 启动 WebUI / orchestrator**（本机：`/root/zth_agent/start_webui_8765.sh`）。
   DKAO 内部**没有**修复办法：受限进程无法自行解除沙箱。
2. 已经在跑的服务要**重启**才会脱离沙箱（子进程继承，改不了）。
3. 现在有**三道护栏**，坏环境不会再伪装成"容器坏了"：
   - 启动脚本在沙箱里**直接拒启**（`[start_webui] FATAL: this shell cannot write /dev/shm`）；
   - 服务启动时 `metainfer/server/envcheck.py` 打醒目告警，spawn 任务时把原因写进该任务 `orchestrator.log`；
   - `orchestrator/gpu_probe.py` 在第一次尝试前自检，命中时**不再空重试**，报错直接说
     *"restart it outside that sandbox"*，诊断里带 `dev_shm_write`。

### 相关代码 / 测试

`orchestrator/gpu_probe.py`（`shm_write_check` / `_shm_denied` / `run_gpu_probe`）、
`metainfer/server/envcheck.py`、`metainfer/server/app.py`、`metainfer/server/launcher.py`、
`tests/test_gpu_probe_resilience.py`、`metainfer/server/tests/test_envcheck.py`。

---

## ENV-NO-DEVICE

**`No HIP GPUs are available` / `visible_devices: 0`** ｜ 状态：设计行为 ｜ 真出现：1（另见上类变体）

### 判定 / 根因（两种）

1. **栈没起来**：真正的病因在上面几行（`shm_open` / amdsmi）→ 按 `ENV-SHM-SANDBOX` 处理。
2. **可见设备被双重过滤**：同一个**非零** index 同时设了 `HIP_VISIBLE_DEVICES` 与 `ROCR_VISIBLE_DEVICES`，
   会被过滤两次（device 1 消失，device 0 侥幸存活）。修法是**只用 `HIP_VISIBLE_DEVICES`**
   （`bind_worker_gpu`），别再加 `ROCR_*`。

### 处置

先看 `shm` 症状；没有则检查环境变量是否重复绑定，再确认卡是否真的透传进容器
（`hy-smi` / `/dev/kfd` / `/dev/dri/renderD*`）。

---

## ENV-PROBE-WRAPPER

**`GPU probe failed after N attempt(s) (RuntimeError): …`** ｜ 状态：已修（2026-09-22）

### 判定

这是 DKAO **自己的重试包装**，不是病因。**不要据此判断环境好坏**——真正的病因在冒号后面那一行
（`shm_open` / traceback / 模块缺失…）。修复前它还会把"权限类确定性失败"重试 3 次（白等 ~25s）；
现在 `gpu_probe.py` 只在"非沙箱类"的瞬时症状上重试，命中沙箱时直接失败并把
`attempts_performed` 记成 1（诊断里同时保留 `attempts` 预算值，便于区分"没试"和"试满"）。

---

## ENV-NO-LEASE

**`no GPU lease became available after N checks` / `no device passed the admission gate`** ｜ 状态：环境

### 判定 / 根因

`gpu_mode=scheduled`（或 `execution_profile=production`，它强制走 broker）时，卡来自共享 broker 队列：
只发"**过闸门且没人租**"的卡（`gpu_broker.py`，优先级 `PRIORITY_PRODUCTION` 高于 harness）。
默认 30s 一轮、最多 48 轮（`gpu_lease_wait_seconds` / `gpu_lease_max_waits`），拿不到就报本错；
生产模式措辞会明确写"共享卡会给出过期数字，所以不跳过闸门"。

### 处置

等卡空；或改用 `gpu_mode=occupy`（钉住自己的卡，不看队列）；或让占用方让出。
默认模式的 DKAO（`occupy`）**不会**报这个错——它直接钉卡，靠测量闸门（见 `03`）兜底。
