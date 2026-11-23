# -*- coding: utf-8 -*-
"""机制.md 配图：每张图都给箭头编号，正文按编号解释每一步。"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from archsvg import D, INK, MUTED

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "机制图")
os.makedirs(OUT, exist_ok=True)

HOST = dict(fill="#eff6ff", stroke="#bfdbfe")
SITE = dict(fill="#fff7ed", stroke="#fed7aa")
BOX = dict(fill="#ffffff", stroke="#2563eb")
ORANGE = dict(fill="#ffffff", stroke="#ea580c")
GREEN = dict(fill="#ffffff", stroke="#16a34a")
RED = dict(fill="#ffffff", stroke="#dc2626")
PURPLE = dict(fill="#ffffff", stroke="#7c3aed")


def fig1():
    d = D(1680, 1000, "图 1 · 一次沙箱节点从排队到清理的完整链路")
    d.zone(40, 100, 620, 800, "Host 侧（DSH 插件进程）", **HOST)
    d.zone(960, 100, 680, 800, "远程站点（pclab27 / pclab19）", **SITE)

    d.box(80, 150, 540, 130, "DAG 调度器（只决定“跑不跑、先跑谁”）",
          ["确定性排序：class p0>p1>p2>p3，再按 CFS vruntime",
           "p0 有预留槽；p2/p3 才可能被抢占",
           "产出：planned → 申请准入（不发卡号）"], **HOST)
    d.box(80, 330, 540, 130, "两阶段准入（先租约、后扣项目额度）",
          ["broker='sandbox-admission' 发逻辑租约，绑定 project/node/profile/attempt",
           "hostBudget 用 CAS 写 reservation，失败则退回等待",
           "两者都过，才允许真正启动"], **HOST)
    d.box(80, 510, 540, 130, "请求文件（一次操作一个 UUID）",
          ["requests/<operationId>.json，O_EXCL 0600，canonical JSON",
           "内容：profile/bindingId/action + 该 action 的允许字段",
           "Host 先写“意图”再上传；同一 UUID 换参数会被拒绝"], **HOST)
    d.box(80, 690, 540, 130, "bridge.py（ssh 单请求 CLI，唯一入口）",
          ["Host 不执行 worker 代码，只 ssh 调这一条命令",
           "stdout 恰好一个 JSON；不回传 traceback/密钥",
           "任何“不确定”都记为 unknown，绝不自动重试"], **HOST)

    d.box(1000, 150, 600, 130, "① 校验身份与请求（bridge.validate）",
          ["profile 必须等于本站；operationId/bindingId 必须是规范 UUID",
           "按 action 限定字段集合（acquire/exec/write/read/collect/status/release）",
           "操作日志先落盘（inProgress），再允许产生副作用"], **ORANGE)
    d.box(1000, 330, 600, 130, "② 集群资源层（reserve + select）",
          ["资源池按 cpu/memory/disk/gpu 四维精确求和",
           "只选同一节点；score=max(used/cap)，平手按 node id",
           "租约 TTL + attempt；没容量就 NO_CAPACITY，让 Host 5s 后再试"], **ORANGE)
    d.box(1000, 510, 600, 130, "③ 节点 adapter + Docker（物理卡层）",
          ["adapter 用 flock 串行化，并 inspect 全量容器（含已停止的）",
           "只允许白名单 renderD；创建前写 pending 标记，确认后清除",
           "容器固定镜像 digest、设备 rw、端口只绑 127.0.0.1"], **ORANGE)
    d.box(1000, 690, 600, 130, "④ 容器内执行（execd :44772）",
          ["worker 的每条命令都走 execd，命令内容先上传再执行",
           "输出按 2 MiB 截断并标记 truncated；退出码是唯一成功依据",
           "文件读写用 dir_fd + O_NOFOLLOW 逐段校验"], **ORANGE)
    d.arrow([(350, 280), (350, 330)], 1, "#2563eb", note="申请准入", note_at=(460, 305), note_dy=0, badge_at=(350, 305))
    d.arrow([(350, 460), (350, 510)], 2, "#2563eb", note="写入意图", note_at=(460, 485), note_dy=0, badge_at=(350, 485))
    d.arrow([(620, 575), (820, 575), (820, 215), (1000, 215)], 3, "#ea580c", note="ssh_upload + bridge.py", note_at=(700, 558), note_dy=0, badge_at=(700, 575))
    d.arrow([(1300, 280), (1300, 330)], 4, "#ea580c", note="acquire", note_at=(1400, 305), note_dy=0, badge_at=(1300, 305))
    d.arrow([(1300, 460), (1300, 510)], 5, "#ea580c", note="拉起容器", note_at=(1400, 485), note_dy=0, badge_at=(1300, 485))
    d.arrow([(1300, 640), (1300, 690)], 6, "#ea580c", note="入沙箱执行", note_at=(1400, 665), note_dy=0, badge_at=(1300, 665))
    d.arrow([(1300, 820), (1300, 885), (660, 885), (660, 760)], 7, "#0d9488", dashed=True,
            note="release 回执：三证齐全才 verifiedClean", note_at=(980, 868), note_dy=0, badge_at=(700, 885))
    d.note(40, 900, 1560, "这张图把“谁负责什么”画成两栏：左栏是 Host 的控制面，右栏是远程的执行面。箭头 1–3 是 Host 内部与出站；4–6 是远程拉起；7 是清理回执。"
           " 当前两站点 gpuCapacity=0，CPU 节点照常走完整链路。", 11, title="读图提示")
    d.label(40, 985, "图 1 · 编号是步骤顺序；同一次 prepare 只会产生一个 operationId，后续 exec/read/write/collect/release 各自一个 UUID。", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig1-lifecycle.svg"))


def fig2():
    d = D(1680, 980, "图 2 · 三层调度：数量、配额、物理卡各管一段")
    d.zone(40, 100, 1600, 190, "① Host DAG 层：决定哪个节点先跑、要不要 GPU（needs.gpu=N 只是数量）", **HOST)
    d.box(60, 145, 360, 120, "planned 节点", ["needs.gpu=N，N=0..4", "只是“要几张”，不指定卡号"], **HOST)
    d.box(460, 145, 360, 120, "确定性排序", ["class 优先，CFS vruntime 次之", "source 权重 human=100/others=10"], **HOST)
    d.box(860, 145, 360, 120, "broker 租约", ["maxRunningNodes / 每资源配额", "同节点重复申请返回原租约或 contested"], **HOST)
    d.box(1260, 145, 360, 120, "hostBudget CAS", ["项目级 GPU 配额", "写 reservation，失败退回 planned"], **HOST)
    d.arrow([(420, 205), (460, 205)], 1, "#2563eb", note="排序", note_at=(440, 188), note_dy=0, badge_at=(440, 205))
    d.arrow([(820, 205), (860, 205)], 2, "#2563eb", note="申请", note_at=(840, 188), note_dy=0, badge_at=(840, 205))
    d.arrow([(1220, 205), (1260, 205)], 3, "#2563eb", note="扣额度", note_at=(1240, 188), note_dy=0, badge_at=(1240, 205))
    d.arrow([(1440, 265), (1440, 330), (220, 330), (220, 395)], 4, "#2563eb", note="下发 gpuCount", note_at=(800, 330), note_dy=-10)

    d.zone(40, 350, 1600, 190, "② 集群资源层：决定哪台节点有四维剩余量（同节点一次性预留）", **SITE)
    d.box(60, 395, 360, 120, "sandbox prepare", ["gpuCount 0..4，machines=1", "timebox 最多 2h（Host 侧上限）"], fill="#ffffff", stroke="#ea580c")
    d.box(460, 395, 360, 120, "四维容量求和", ["cpu / memory / disk / gpu", "十进制精确相加，不四舍五入"], fill="#ffffff", stroke="#ea580c")
    d.box(860, 395, 360, 120, "选节点", ["四维都满足才候选", "score=max(used/cap)，平手按 id"], fill="#ffffff", stroke="#ea580c")
    d.box(1260, 395, 360, 120, "binding + lease", ["creating → active，绑定 attempt", "NO_CAPACITY 时 Host 5s 后重试"], fill="#ffffff", stroke="#ea580c")
    d.arrow([(420, 455), (460, 455)], 5, "#ea580c", note="资源请求", note_at=(440, 438), note_dy=0, badge_at=(440, 455))
    d.arrow([(820, 455), (860, 455)], 6, "#ea580c", note="过滤", note_at=(840, 438), note_dy=0, badge_at=(840, 455))
    d.arrow([(1220, 455), (1260, 455)], 7, "#ea580c", note="预留", note_at=(1240, 438), note_dy=0, badge_at=(1240, 455))
    d.arrow([(1440, 515), (1440, 580), (220, 580), (220, 645)], 8, "#ea580c", note="物理分配", note_at=(800, 580), note_dy=-10)

    d.zone(40, 600, 1600, 190, "③ 节点物理卡层：决定哪张 renderD（只在本机白名单内排他）", **dict(fill="#f0fdf4", stroke="#bbf7d0"))
    d.box(60, 645, 360, 120, "adapter flock", ["线程锁 + 文件锁，串行化整个分配", "inspect 全量容器，含已停止的"], **GREEN)
    d.box(460, 645, 360, 120, "白名单映射", ["逻辑 GPU → renderD/card", "pclab27 只有 renderD128/129"], **GREEN)
    d.box(860, 645, 360, 120, "Docker 设备", ["/dev/kfd + 指定 renderD，rw", "privileged/volume/DeviceRequests 全禁"], **GREEN)
    d.box(1260, 645, 360, 120, "创建确认", ["pending 标记：崩溃/超时也不释放卡", "inspect 确认后才清标记"], **GREEN)
    d.arrow([(420, 705), (460, 705)], 9, "#16a34a", note="选卡", note_at=(440, 688), note_dy=0, badge_at=(440, 705))
    d.arrow([(820, 705), (860, 705)], 10, "#16a34a", note="挂载", note_at=(840, 688), note_dy=0, badge_at=(840, 705))
    d.arrow([(1220, 705), (1260, 705)], 11, "#16a34a", note="确认", note_at=(1240, 688), note_dy=0, badge_at=(1240, 705))

    d.note(40, 820, 500, "Host 只记“要几张卡”。needs.gpu=2 不等于指定第 2、3 号卡；卡号由远端 adapter 在白名单内排他分配，Host 无法越过。", 11, title="数量 ≠ 卡号")
    d.note(580, 820, 500, "两站集群当前 gpuCapacity=0：gpuCount>0 会在第 ② 层直接 NO_CAPACITY；CPU 节点不受影响，双机测试的 A/B 组大多如此。", 11, title="当前真实容量")
    d.note(1120, 820, 500, "cluster 用 lease TTL 管回收；释放后配额最多滞后约 420s 才清零（R6/#91）。这是“最终一致”，不是泄漏。", 11, title="已知滞后")
    d.label(40, 965, "图 2 · 1–4 Host 决策，5–8 集群预留，9–11 物理卡确认；编号是决策顺序，不是一次网络请求。", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig2-scheduling.svg"))


def fig3():
    d = D(1680, 960, "图 3 · 隔离边界：worker 能碰什么、碰不到什么")
    d.zone(40, 100, 560, 760, "Host 侧：只有“会话 + 工具边界”", **HOST)
    d.zone(800, 100, 840, 760, "一次性容器（每 binding 一个）：唯一的执行现场", **dict(fill="#f0fdf4", stroke="#bbf7d0"))

    d.box(80, 150, 480, 150, "worker 会话（lab-sandbox-worker-v2）",
          ["模型只收到节点 prompt + 宿主 prompt",
           "没有项目 API、没有 claim/delete 工具",
           "输出必须走 structured_output 报告"], **HOST)
    d.box(80, 350, 480, 170, "唯一工具 metainfer_sandbox",
          ["operation 只能是 exec/read/write",
           "参数只有 command/timeoutMs/path/contentBase64/maxBytes",
           "没有 target/cwd/binding 选择器；scope 由 Host 状态推导"], **HOST)
    d.box(80, 570, 480, 160, "Host 侧事实（模型改不了）",
          ["bindingId/attempt/sessionId 来自 store，不来自提示词",
           "exitCode/truncated 由 Host 账本记录",
           "报告 success 会被这些事实推翻（finish 归一化）"], **HOST)

    d.box(840, 150, 360, 140, "execd（:44772）", ["命令先上传为文件，再执行", "stdout/stderr 按 JSON 行回传", "2 MiB 封顶，截断单独标记"], **GREEN)
    d.box(1240, 150, 360, 140, "/workspace/project", ["唯一工作目录", "越界路径（..、.ssh、.env）一律拒绝", "write 校验 sha256 后落盘"], **GREEN)
    d.box(840, 330, 360, 140, "设备：/dev/kfd + renderD", ["只挂 Host 指定的那几张卡", "rw，但只在本容器可见", "其他 renderD/card 不可见"], **GREEN)
    d.box(1240, 330, 360, 140, "/tmp/metainfer-files-<op>", ["每条命令/文件操作的临时区", "只允许普通单链接文件", "操作结束即清理"], **GREEN)
    d.box(840, 510, 360, 140, "网络：bridge + loopback", ["集群控制面 127.0.0.1:18090", "execd 端口只绑 127.0.0.1", "无 host 网络、无 privileged"], **GREEN)
    d.box(1240, 510, 360, 140, "容器里没有", ["secrets/、docker.sock", "业务容器 fh-dev / dcu-vllm-2-3", "宿主机 /etc、/root、/proc/1 根"], **RED)

    d.arrow([(560, 435), (800, 435), (800, 220), (840, 220)], 1, "#0d9488", note="tool call", note_at=(700, 418), note_dy=0, badge_at=(700, 435))
    d.arrow([(1200, 220), (1240, 220)], 2, "#0d9488", note="执行", note_at=(1220, 204), note_dy=0, badge_at=(1220, 220))
    d.arrow([(1440, 290), (1440, 330)], 3, "#0d9488", note="write/read 校验", note_at=(1425, 310), note_anchor="end", note_dy=0, badge_at=(1440, 310))
    d.arrow([(1440, 510), (1440, 470)], 4, "#dc2626", dashed=True, note="不可见", note_at=(1500, 490), note_dy=0, badge_at=(1440, 490))
    d.note(40, 880, 1560, "容器只负责“算”，不负责“信”。业务容器与宿主 secrets 永远不在沙箱内；worker 只能通过一个被 Host 绑定的工具碰这个容器。"
           " 但要注意：这是“可信任务隔离”，不是对抗恶意代码的安全边界（见 §9）。", 11, title="一句话")
    d.label(40, 945, "图 3 · 1 工具调用 → 2 execd 执行 → 3 文件哈希校验 → 4 容器外资源不可见", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig3-isolation.svg"))


def fig4():
    d = D(1680, 940, "图 4 · 恶意抢占与越权：可以抢谁、谁必须人点头")
    d.zone(40, 100, 760, 720, "允许的抢占（范围很窄）", **HOST)
    d.zone(880, 100, 760, 720, "禁区与人工闸门", **dict(fill="#fef2f2", stroke="#fecaca"))

    d.box(80, 150, 320, 130, "候选：只 p2 / p3", ["PREEMPTION_MIN_RUN_MS=10*60_000", "开始时间不足 10 分钟不参与"], **HOST)
    d.box(440, 150, 320, 130, "前置：必须带抢占策略", ["envelope 拒绝无 policy 的 preempt", "非 running 节点不能被抢"], **HOST)
    d.box(80, 330, 320, 130, "确定性选 victim", ["按 class、startedAt、id 排序", "不随机、不按提示词"], **HOST)
    d.box(440, 330, 320, 130, "记录 + 24h 申诉", ["事件引用 causeId/by", "24h 内可走 /preemption/appeal"], **HOST)

    d.box(920, 150, 320, 130, "p0 / p1 不被抢", ["p0 有预留槽；p1 不在 victim 集合", "只 p2/p3 可被抢"], **RED)
    d.box(1280, 150, 320, 130, "merge / sandbox 不被抢", ["merge 节点直接排除", "sandbox 返回“not supported”"], **RED)
    d.box(920, 330, 320, 130, "cancel_running：claim gate L2", ["2 个已核实原子 + chief + 人类确认", "调用方自带的 humanConfirmed 会被剥掉"], **RED)
    d.box(1280, 330, 320, 130, "delete_project：L4", ["只允许人类发起", "prune_branch 还要 appeal"], **RED)
    d.box(920, 510, 320, 130, "跨项目操作直接拒绝", ["owner/scope 不匹配即 403/denied", "不能靠提示词换 projectId"], **RED)
    d.box(1280, 510, 320, 130, "节点进程失联", ["heartbeat 失败 → resource_lost/timeout", "只做清理，不做“继续执行”"], **RED)

    d.arrow([(240, 280), (240, 330)], 1, "#2563eb", note="过滤", note_at=(350, 305), note_dy=0, badge_at=(240, 305))
    d.arrow([(600, 280), (600, 330)], 2, "#2563eb", note="无 policy→拒绝", note_at=(700, 305), note_dy=0, badge_at=(600, 305))
    d.arrow([(400, 395), (440, 395)], 3, "#2563eb", note="执行抢占", note_at=(420, 378), note_dy=0, badge_at=(420, 395))
    d.arrow([(760, 215), (920, 215)], 4, "#dc2626", dashed=True, note="sandbox/merge→拒绝", note_at=(840, 198), note_dy=0, badge_at=(840, 215))
    d.arrow([(760, 395), (920, 395)], 5, "#dc2626", dashed=True, note="不可逆动作→人工", note_at=(840, 378), note_dy=0, badge_at=(840, 395))
    d.arrow([(1080, 460), (1080, 510)], 6, "#dc2626", note="scope 校验", note_at=(1180, 485), note_dy=0, badge_at=(1080, 485))
    d.note(40, 840, 1560, "常见误解是“Sandbox 就是防越权”。实际越权防线在 Host：不可逆动作要证据+人工，sandbox 只是执行位置；"
           " 抢占只针对普通 p2/p3，且必须留 10 分钟宽限与申诉入口。", 11, title="要点")
    d.label(40, 925, "图 4 · 1–3 允许的抢占；4–6 禁区/人工闸门；红色虚线表示“在设计上被挡住”的路径", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig4-preempt.svg"))


def fig5():
    d = D(1680, 940, "图 5 · Prompt 注入：为什么“模型被骗”≠“系统被改”")
    d.text(40, 100, "把不可信文本 → 模型 → 工具 → Host 事实 → 报告，五段各自设卡。", 14, MUTED)

    d.box(40, 140, 280, 150, "不受信内容", ["容器里的 README/注释", "命令输出里的假 JSON/假成功", "伪造的“沙箱错误”文本"], fill="#fef2f2", stroke="#f87171")
    d.box(380, 140, 280, 150, "worker 模型", ["只能看到节点 prompt + 宿主 prompt", "可以“相信”恶意文本，但只能调用受限工具"], **HOST)
    d.box(720, 140, 300, 150, "唯一工具 metainfer_sandbox", ["参数白名单，无 target/binding 选择器", "scope 由 Host 状态推导，不来自提示词"], **HOST)
    d.box(1080, 140, 280, 150, "Host 操作账本", ["每次 exec 记 exitCode/truncated", "unknown 操作永不复放"], **HOST)
    d.box(1420, 140, 220, 150, "finish 归一化", ["exec 失败→success=false", "缺报告→RUN_FAILED"], **HOST)

    d.arrow([(320, 215), (380, 215)], 1, "#334155", note="读到恶意文本", note_at=(350, 198), note_dy=0, badge_at=(350, 215))
    d.arrow([(660, 215), (720, 215)], 2, "#334155", note="发起工具调用", note_at=(690, 198), note_dy=0, badge_at=(690, 215))
    d.arrow([(1020, 215), (1080, 215)], 3, "#334155", note="Host 记账", note_at=(1050, 198), note_dy=0, badge_at=(1050, 215))
    d.arrow([(1360, 215), (1420, 215)], 4, "#334155", note="事实校验", note_at=(1390, 198), note_dy=0, badge_at=(1390, 215))

    d.box(380, 360, 300, 150, "路径防线", [".ssh/.aws/.env/id_rsa/*.pem 一律拒绝", "禁 ..、反斜杠、冒号、控制字符", "dir_fd + O_NOFOLLOW 逐段打开"], **PURPLE)
    d.box(720, 360, 300, 150, "数据/指令分离", ["命令输出是“数据”，不是指令", "2 MiB 截断显式标记，不算成功", "结构化报告只接受 schema 内字段"], **PURPLE)
    d.box(1060, 360, 300, 150, "秘密不进容器", ["secrets 只存远端根 0600 文件", "bridge 输出抹掉密钥/headers", "容器里没有集群 API key"], **PURPLE)

    d.arrow([(660, 360), (660, 290)], 5, "#7c3aed", dashed=True, note="越界→拒绝", note_at=(670, 330), note_anchor="start", note_dy=0, badge_at=(660, 330))
    d.arrow([(870, 360), (870, 290)], 6, "#7c3aed", dashed=True, note="伪造的“成功”", note_at=(880, 330), note_anchor="start", note_dy=0, badge_at=(870, 330))
    d.arrow([(1210, 360), (1210, 290)], 7, "#7c3aed", dashed=True, note="诱导泄露", note_at=(1220, 330), note_anchor="start", note_dy=0, badge_at=(1210, 330))

    d.box(40, 560, 780, 190, "Host 只信“可验证事实”", ["节点状态、binding、attempt、session 由 store 决定；模型文本只影响报告内容，不影响调度身份。",
                                              "release 要求三证：managed 404 + docker inspect 无容器 + inventory 为空；缺失就 hold。",
                                              "未知操作（超时/传输中断/创建不确定）永久阻塞重放，先人工对账。"], **HOST)
    d.box(860, 560, 780, 190, "真实边界（很重要）", ["沙箱是“可信任务隔离”，不是恶意多租户安全边界（README 明确 Trusted jobs only）。",
                                              "模型能读到的数据，理论上能写进自己的报告；防的是“借此改系统状态”，不是“防模型说错话”。",
                                              "容器逃逸类攻击不在本机制承诺内；生产需要更硬的运行时隔离。"], fill="#fff7ed", stroke="#ea580c")
    d.note(40, 790, 1600, "D 组测试的设计逻辑：用假成功、假错误、路径逃逸、诱导泄密等 10 种输入去打这套边界；结果 7 PASS / 2 NOTE / D8 截断正确报告，没有出现“文本改状态”。", 11, title="对应测试")
    d.label(40, 925, "图 5 · 1–4 正常链路；5–7 三道旁路防线；底部两块是“承诺”与“不承诺”的分界", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig5-prompt.svg"))


def fig6():
    d = D(1680, 960, "图 6 · 双机两代 adapter：同一份 bridge，不同的卡与身份")
    d.zone(40, 100, 760, 700, "pclab27（27）：2 卡、硬编码旧代", **dict(fill="#eff6ff", stroke="#bfdbfe"))
    d.zone(880, 100, 760, 700, "pclab19（19）：4 卡、target_config 新代", **dict(fill="#f0fdf4", stroke="#bbf7d0"))

    d.box(80, 150, 680, 130, "adapter：renderD128/129 + card1/2 硬编码", ["PATH_IDS 写死；OWNER=metainfer-pclab27", "无 target_config/identity label", "创建时按空闲逻辑号分配，flock+pending 一样"], **ORANGE)
    d.box(80, 320, 680, 130, "镜像与 catalog", ["image sha256:94a6bd36…", "catalog sha256 9a16f2a9…（单 profile）", "target.json 单行 363B"], **ORANGE)
    d.box(80, 490, 680, 130, "Host 校验", ["profile='pclab27'", "binding labels: owner/profile/target_id", "device 集合必须 ⊆ 白名单"], **ORANGE)

    d.box(920, 150, 680, 130, "adapter：target_config 驱动（4 卡）", ["Target/configure/load_target/runtime_guard", "renderD132–135；PATH_IDS 由 target 提供", "identity label 校验 profile+target_id"], **GREEN)
    d.box(920, 320, 680, 130, "镜像与 catalog", ["image sha256:2ad71988…", "catalog sha256 6eed8c85…（含 27 草案 + 19）", "target.json 424B 缩进"], **GREEN)
    d.box(920, 490, 680, 130, "Host 校验", ["profile='pclab19'", "同一 binding 只允许该站点卡号", "runtime_guard 重新 load_target"], **GREEN)

    d.box(560, 660, 560, 120, "共享：bridge.py sha256 5cfed6d8…", ["同一份 1034 行 CLI；按 profile 选 target", "Host 侧两份 targets 文件都做哈希钉死", "任一哈希不匹配→preflight 拒绝启动"], fill="#f5f3ff", stroke="#7c3aed")

    d.arrow([(760, 205), (900, 205)], 1, "#7c3aed", dashed=True, note="不合并", note_at=(830, 188), note_dy=0, badge_at=(830, 205))
    d.arrow([(760, 555), (560, 555), (560, 660)], 2, "#7c3aed", note="同一 CLI", note_at=(660, 640), note_dy=0, badge_at=(560, 610))
    d.arrow([(1120, 660), (1120, 620)], 3, "#7c3aed", note="同一 CLI", note_at=(1150, 640), note_anchor="start", note_dy=0, badge_at=(1120, 640))
    d.note(40, 820, 500, "两代 adapter 的差异是“历史真实”：27 是先部署的 2 卡版本，19 是后部署的 4 卡 target_config 版本。仓库按字节原样收录，不强行统一。", 11, title="为什么不合并")
    d.note(560, 820, 500, "两站 catalog 哈希不同：6eed8c85…（19 含 27 草案）与 9a16f2a9…（27 单 profile）。Host 启动时逐一校验，防止“串站”。", 11, title="为什么钉哈希")
    d.note(1080, 820, 500, "容器 label 同时带 profile 和 target_id，绑定 attempt/project/node；bridge 每次 inspect 都复核，卡号与身份对不上就拒绝。", 11, title="身份四重校验")
    d.label(40, 945, "图 6 · 1 两代不合并；2–3 共享 CLI；每个站点各自校验镜像/catalog/卡号", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig6-dual.svg"))


def fig7():
    d = D(1680, 900, "图 7 · 释放：为什么“删了容器”还不算干净")
    d.box(60, 150, 300, 130, "cleanupPending", ["binding 先标记“清理中”", "verifiedClean=false", "此后不再分配"], fill="#fff7ed", stroke="#ea580c")
    d.box(440, 150, 300, 130, "managed DELETE", ["调集群删 managed sandbox", "只接受 202/204/404"], fill="#fff7ed", stroke="#ea580c")
    d.box(820, 150, 300, 130, "90s 轮询", ["managed 状态", "docker inspect 指定容器", "binding 专属 inventory"], fill="#fff7ed", stroke="#ea580c")
    d.box(1200, 150, 420, 130, "三证同时成立？", ["managed=404；精确容器不存在；", "该 binding 无任何残留容器", "不确定创建还要求有精确容器证据"], fill="#fef2f2", stroke="#dc2626")

    d.box(1200, 360, 420, 130, "released + verifiedClean", ["写回 binding；释放才算完成", "Host：admission.release + 预算 finalize"], fill="#f0fdf4", stroke="#16a34a")
    d.box(820, 360, 300, 130, "cleanupPending 保留", ["不自动重试删除", "operation 记 unknown", "等人工对账"], fill="#fef2f2", stroke="#f87171")
    d.box(440, 360, 300, 130, "admission-blocked.json", ["阻断新 create", "pclab19 还会 PUT draining", "防止“未知创建”被当成空闲"], fill="#fef2f2", stroke="#f87171")
    d.box(60, 360, 300, 130, "operator 对账", ["按 README 核对容器/绑定", "决定继续 release 或保留证据"], fill="#fef2f2", stroke="#f87171")

    d.arrow([(360, 215), (440, 215)], 1, "#ea580c", note="删除", note_at=(400, 198), note_dy=0, badge_at=(400, 215))
    d.arrow([(740, 215), (820, 215)], 2, "#ea580c", note="轮询", note_at=(780, 198), note_dy=0, badge_at=(780, 215))
    d.arrow([(1120, 215), (1200, 215)], 3, "#dc2626", note="判定", note_at=(1160, 198), note_dy=0, badge_at=(1160, 215))
    d.arrow([(1410, 280), (1410, 360)], 4, "#16a34a", note="是", note_at=(1470, 320), note_dy=0, badge_at=(1410, 320))
    d.arrow([(1200, 425), (1120, 425)], 5, "#dc2626", dashed=True, note="否", note_at=(1160, 408), note_dy=0, badge_at=(1160, 425))
    d.arrow([(820, 425), (740, 425)], 6, "#dc2626", dashed=True, note="阻断", note_at=(780, 408), note_dy=0, badge_at=(780, 425))
    d.arrow([(440, 425), (360, 425)], 7, "#dc2626", dashed=True, note="人工", note_at=(400, 408), note_dy=0, badge_at=(400, 425))

    d.note(60, 560, 760, "为什么这么严：“租约过期”不等于“容器没了”。只有 managed 记录、Docker 精确容器、binding 专属 inventory 三处同时证明不存在，才敢把卡还给集群；否则宁可 hold，也不冒“双花同一张卡”的风险。", 11, title="为什么三步证明")
    d.note(860, 560, 760, "代价：人工介入不自动化；R5（unknown 操作全局阻塞准入）、R8（一次传输抖动导致 PREFLIGHT_BLOCKED 无法恢复）就是这套“宁停勿错”的副作用，已分别开 #90/#92。", 11, title="代价")
    d.label(40, 880, "图 7 · 1 删除 → 2 轮询 → 3 三证判定；4 成功；5–7 失败后的阻断与人工路径", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig7-release.svg"))


if __name__ == "__main__":
    fig1()
    fig2()
    fig3()
    fig4()
    fig5()
    fig6()
    fig7()
