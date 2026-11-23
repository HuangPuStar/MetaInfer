# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from archsvg import D, INK, MUTED

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "架构图")
os.makedirs(OUT, exist_ok=True)


def fig1():
    d = D(1680, 1080)
    d.zone(300, 90, 960, 930, "DSH Host 进程（Node.js，单进程）", fill="#fbfdff", stroke="#bfdbfe", label_color="#1d4ed8")
    d.zone(40, 250, 240, 400, "用户侧", fill="#f8fafc", stroke="#cbd5e1", label_color="#475569")
    d.zone(1300, 90, 340, 930, "远程站点（pclab27 / pclab19）", fill="#fffbf7", stroke="#fed7aa", label_color="#c2410c")

    # interfaces
    d.box(340, 190, 220, 84, "HTTP 控制面", ["48 route() · 53 pair", "/api/metainfer-…"], fill="#f1f5f9", stroke="#64748b")
    d.box(600, 190, 240, 84, "Agent 工具", ["metainfer_lab", "97 个 ACTION_ENUM"], fill="#f1f5f9", stroke="#64748b")
    d.box(880, 190, 220, 84, "MCP 服务", ["13 工具（1 写 12 读）", "3080 /mcp"], fill="#f1f5f9", stroke="#64748b")

    # hub
    d.box(580, 330, 320, 92, "lab-service（ctx.metainferLab）", ["项目/DAG 用例 · 权限 · 事件等待 · 调度入口"], fill="#dbeafe", stroke="#2563eb", tcolor="#1e3a8a", bcolor="#1e40af")

    # control
    d.box(400, 500, 250, 86, "orchestrator + auto", ["advisor / scheduler 轮次", "auto 2s tick · 六道熔断"], fill="#eef2ff", stroke="#4f46e5")
    d.box(790, 500, 250, 86, "dispatch + admission", ["确定性选点 · broker 租约", "envelope 提交 node.claim"], fill="#eef2ff", stroke="#4f46e5")
    d.box(400, 640, 250, 78, "runtime（节点生命周期）", ["hostStart · finish · cleanup"], fill="#eef2ff", stroke="#4f46e5")

    # state
    d.box(1080, 300, 160, 230, "状态与证据", [], fill="#f5f3ff", stroke="#7c3aed")
    d.text(1096, 350, "kernel/executor", 12.5, "#5b21b6", "700")
    d.text(1096, 370, "单写者 CAS · 事件", 11, MUTED)
    d.text(1096, 405, "store", 12.5, "#5b21b6", "700")
    d.text(1096, 425, "DAG / runs / events", 11, MUTED)
    d.text(1096, 460, "git-engine", 12.5, "#5b21b6", "700")
    d.text(1096, 480, "worktree · commit · tag", 11, MUTED)

    # agents
    d.box(400, 770, 330, 170, "DSH Agent 会话", [], fill="#ecfdf5", stroke="#059669")
    d.pill(416, 820, 140, 30, "lab-controller", "#d1fae5", "#065f46", 11.5)
    d.pill(566, 820, 140, 30, "anchor 空壳", "#d1fae5", "#065f46", 11.5)
    d.pill(416, 862, 140, 30, "lab-worker", "#a7f3d0", "#065f46", 11.5)
    d.pill(566, 862, 140, 30, "lab-advisor…", "#a7f3d0", "#065f46", 11.5)
    d.text(416, 918, "13 个 preset；每个 attempt 独立会话树", 10.5, "#047857")

    # sandbox lane
    d.box(790, 740, 440, 200, "沙箱车道（Host 侧）", [], fill="#fff7ed", stroke="#ea580c", tcolor="#9a3412")
    d.text(808, 790, "sandbox-backend", 12.5, "#9a3412", "700")
    d.text(808, 810, "preflight / prepare / exec / collect", 11, "#7c2d12")
    d.text(808, 838, "sandbox-runtime", 12.5, "#9a3412", "700")
    d.text(808, 858, "binding · operation ledger · lane", 11, "#7c2d12")
    d.text(808, 886, "sandbox-worker", 12.5, "#9a3412", "700")
    d.text(808, 906, "metainfer_sandbox 工具边界", 11, "#7c2d12")

    # remote
    d.box(1320, 160, 300, 100, "SSH + bridge.py", ["ssh_exec / ssh_upload", "单请求 CLI，stdout 一个 JSON"], fill="#fff7ed", stroke="#ea580c")
    d.box(1320, 320, 300, 120, "opensandbox-cluster", ["Bun + Elysia + SQLite", "池/节点/绑定/租约/代理"], fill="#fef2f2", stroke="#dc2626", tcolor="#991b1b")
    d.box(1320, 500, 300, 120, "OpenSandbox node", ["FastAPI + execd", "127.0.0.1:18090"], fill="#f0fdfa", stroke="#0d9488", tcolor="#115e59")
    d.box(1320, 680, 300, 150, "Docker 容器 + DCU", ["dcu_adapter 白名单", "renderD128/129（pclab27）", "execd :44772"], fill="#f0fdfa", stroke="#0d9488", tcolor="#115e59")
    d.note(1320, 870, 300, "两块站点当前 gpuCapacity=0；GPU 调度被管理员暂停。profile：pclab19 / pclab27。", 11, title="现状")

    # browser
    d.box(56, 330, 210, 240, "浏览器 Web GUI", ["侧栏图标 + 全屏面板", "1.5s 轮询 /state", "2s 长轮询 /events/wait"], fill="#ffffff", stroke="#475569")
    d.text(56, 600, "53864（DSH Web）", 11, "#64748b")

    # arrows
    d.arrow([(266, 380), (340, 380)], 1, "#2563eb", note="HTTP + operator token", note_at=(303, 362), note_dy=-6)
    d.arrow([(380, 274), (380, 300), (620, 300), (620, 330)], 2, "#334155", note="路由分发", note_at=(500, 300), note_dy=20)
    d.arrow([(720, 274), (720, 330)], 3, "#334155", note="action=…", note_at=(736, 310), note_anchor="start", note_dy=0, badge_at=(720, 306))
    d.arrow([(990, 274), (990, 300), (850, 300), (850, 330)], 4, "#334155", note="13 工具", note_at=(905, 300), note_dy=20)
    d.arrow([(900, 380), (1080, 380)], 5, "#7c3aed", dashed=True, note="commitLocked(CAS)", note_at=(990, 380), note_dy=-12)
    d.arrow([(600, 422), (600, 460), (540, 460), (540, 500)], 6, "#4f46e5", note="step / tick", note_at=(616, 466), note_anchor="start", note_dy=0, badge_at=(600, 460))
    d.arrow([(650, 543), (790, 543)], 7, "#4f46e5", note="dispatch", note_at=(720, 527), note_dy=-6)
    d.arrow([(915, 586), (915, 640), (530, 640)], 8, "#4f46e5", note="runtime.start", note_at=(760, 628), note_dy=0, badge_at=(860, 640))
    d.arrow([(530, 718), (530, 770)], 9, "#059669", note="startActivation", note_at=(545, 752), note_anchor="start", note_dy=0, badge_at=(530, 744))
    d.arrow([(650, 660), (820, 660), (820, 740)], 10, "#ea580c", note="sandboxLane", note_at=(824, 700), note_anchor="start", note_dy=0)
    d.arrow([(1230, 770), (1280, 770), (1280, 210), (1320, 210)], 11, "#ea580c", note="RPC/回执", note_at=(1292, 600), note_anchor="start", note_dy=0, badge_at=(1280, 600))
    d.arrow([(1470, 260), (1470, 320)], 12, "#dc2626", note="POST /api/v2", note_at=(1470, 292), note_dy=-6)
    d.arrow([(1470, 440), (1470, 500)], 13, "#dc2626", note="POST /v1/sandboxes", note_at=(1470, 472), note_dy=-6)
    d.arrow([(1470, 620), (1470, 680)], 14, "#0d9488", note="adapter + Docker", note_at=(1470, 652), note_dy=-6)
    d.arrow([(1380, 830), (1380, 855), (1240, 855), (1240, 920)], 15, "#ea580c", dashed=True, note="exec/collect/release", note_at=(1300, 855), note_dy=-10)

    d.arrow([(368, 370), (368, 410), (266, 410)], 16, "#64748b", dashed=True, note="state/events", note_at=(320, 430), note_dy=0)
    d.label(40, 1050, "箭头 1–4 接入；5 状态提交；6–10 控制面；11–15 远端联动；16 回读", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig1-overview.svg"))


def fig2():
    d = D(1680, 1120)
    cols = [(150, "浏览器 Web GUI", "#f8fafc", "#475569"),
            (430, "HTTP 载体", "#f1f5f9", "#64748b"),
            (720, "lab-service", "#dbeafe", "#2563eb"),
            (1020, "kernel/executor", "#f5f3ff", "#7c3aed"),
            (1320, "store / 事件表", "#f5f3ff", "#7c3aed")]
    for x, name, fill, stroke in cols:
        d.box(x - 105, 110, 210, 70, name, [], fill=fill, stroke=stroke, align="middle")
        d.parts.append(f'<line x1="{x}" y1="180" x2="{x}" y2="1040" stroke="#cbd5e1" stroke-width="1.3" stroke-dasharray="5 6"/>')

    d.arrow([(150, 245), (430, 245)], 1, "#2563eb", note="POST /commands（operator token）", note_at=(290, 245), note_dy=-12)
    d.arrow([(430, 305), (720, 305)], 2, "#334155", note="command 分发（无 policy）", note_at=(575, 305), note_dy=-12)
    d.arrow([(720, 365), (1020, 365)], 3, "#4f46e5", note="service 方法 + load", note_at=(870, 365), note_dy=-12)
    d.arrow([(1020, 425), (1320, 425)], 4, "#7c3aed", note="executor.commitLocked", note_at=(1170, 425), note_dy=-12)
    d.arrow([(1320, 490), (1020, 490)], 5, "#7c3aed", dashed=True, note="events → saveNode → saveProject", note_at=(1170, 490), note_dy=-12)
    d.arrow([(1020, 555), (720, 555)], 6, "#7c3aed", dashed=True, note="ack: eventSeq / new rev", note_at=(870, 555), note_dy=-12)
    d.arrow([(720, 615), (430, 615)], 7, "#334155", dashed=True, note="result", note_at=(575, 615), note_dy=-12)
    d.arrow([(430, 675), (150, 675)], 8, "#334155", dashed=True, note="200 JSON + revision", note_at=(290, 675), note_dy=-12)
    d.arrow([(150, 760), (430, 760)], 9, "#2563eb", note="GET /events/wait?after=seq", note_at=(290, 760), note_dy=-12)
    d.arrow([(430, 820), (720, 820)], 10, "#334155", note="waitForEvents", note_at=(575, 820), note_dy=-12)
    d.arrow([(720, 880), (1320, 880)], 11, "#7c3aed", note="read events after seq", note_at=(1020, 880), note_dy=-12)
    d.arrow([(1320, 940), (720, 940)], 12, "#7c3aed", dashed=True, note="batch", note_at=(1020, 940), note_dy=-12)
    d.arrow([(720, 1000), (150, 1000)], 13, "#334155", dashed=True, note="events → UI 增量渲染", note_at=(435, 1000), note_dy=-12)

    d.note(1420, 230, 220, "operator token 是 Host 进程级 HMAC bearer；Host 重启即失效。它证明“这是本机操作员”，不是模型可伪造的 body 字段。", 10.5, title="鉴权要点")
    d.note(760, 700, 300, "写操作在 service 内先做业务校验，再进 kernel；事件、节点、项目三者在同一 commit 中落库，eventSeq 是提交确认点。", 10.5, title="为什么先事件后节点")
    d.label(40, 1090, "图 2 · 一次写命令到事件回读；13 个箭头", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig2-request.svg"))


def fig3():
    d = D(1680, 970)
    d.text(40, 110, "一轮研究闭环（慢路径）：谁在什么时候写入 DAG？", 17, INK, "700")
    a = d.box(40, 160, 220, 110, "触发", ["用户 Step", "或 auto 每 2s tick"], fill="#f8fafc", stroke="#475569")
    b = d.box(320, 160, 250, 110, "orchestrator.step", ["cycleLocks 单飞", "cycle/started"], fill="#eef2ff", stroke="#4f46e5")
    c = d.box(630, 160, 330, 120, "advisor snapshot", ["未评审 completed 叶", "+ 最近祖先 + ledger"], fill="#ecfdf5", stroke="#059669")
    e = d.box(1020, 160, 320, 120, "runRole('advisor') × N", ["多 reviewer 并发 · 各自 lens", "structured_output 提案"], fill="#ecfdf5", stroke="#059669")
    f = d.box(1400, 160, 240, 120, "applyAdvisorOutput", ["checkProposal", "父须 completed+commit"], fill="#ecfdf5", stroke="#059669")

    g = d.box(1370, 430, 250, 130, "planned 或 proposed", ["confirm 模式进队列", "不占资源、不阻塞"], fill="#fffbeb", stroke="#f59e0b")
    h = d.box(1080, 430, 240, 130, "approve + sealParent", ["父 commit + tag", "dshex-sealed/…"], fill="#fffbeb", stroke="#f59e0b")
    i = d.box(800, 430, 230, 130, "scheduler pass", ["starts[] 顺序建议", "不预留 GPU"], fill="#eef2ff", stroke="#4f46e5")
    j = d.box(530, 430, 230, 130, "runtime.start", ["无 lease 时自准入", "→ hostStart"], fill="#eef2ff", stroke="#4f46e5")
    k = d.box(260, 430, 230, 130, "hostFinish + commit", ["Host 提交 worktree", "report/head 同一 commit"], fill="#dbeafe", stroke="#2563eb")

    l = d.box(260, 680, 330, 120, "下一轮 review", ["node.review{decision,", "reviewedHeadCommit}"], fill="#ecfdf5", stroke="#059669")

    d.arrow([(260, 215), (320, 215)], 1, "#334155", note="Step/tick", note_at=(290, 215), note_dy=-12)
    d.arrow([(570, 215), (630, 215)], 2, "#334155", note="snapshot", note_at=(600, 215), note_dy=-12)
    d.arrow([(960, 215), (1020, 215)], 3, "#334155", note="并发审阅", note_at=(990, 215), note_dy=-12)
    d.arrow([(1340, 215), (1400, 215)], 4, "#334155", note="proposals", note_at=(1370, 215), note_dy=-12)
    d.arrow([(1520, 280), (1520, 360), (1495, 360), (1495, 430)], 5, "#334155", note="0–3 后继", note_at=(1520, 360), note_dy=-12)
    d.arrow([(1370, 495), (1320, 495)], 6, "#334155", note="approve", note_at=(1345, 495), note_dy=-12)
    d.arrow([(1080, 495), (1030, 495)], 7, "#334155", note="sealed", note_at=(1055, 495), note_dy=-12)
    d.arrow([(800, 495), (760, 495)], 8, "#334155", note="starts[]", note_at=(780, 495), note_dy=-12)
    d.arrow([(530, 495), (490, 495)], 9, "#334155", note="完成", note_at=(510, 495), note_dy=-12)
    d.arrow([(260, 740), (220, 740), (220, 300), (775, 300), (775, 280)], 11, "#059669", dashed=True, note="再提议", note_at=(600, 300), note_dy=-10)

    d.arrow([(375, 560), (375, 680)], 10, "#059669", note="下一轮 review", note_at=(391, 620), note_anchor="start", note_dy=0, badge_at=(375, 620))

    d.note(40, 840, 500, "auto 每 2s 先跑 dispatchOnce(maxStarts:4) 快路径；started>0 则本轮不调 LLM，本图不执行。", 11, title="本图是慢路径")
    d.note(580, 840, 500, "scheduler 的 starts[] 是顺序建议；applySchedulerOutput 直接调 runtime.start，后者无 lease 时走 hostAdmission 自准入。", 11, title="scheduler 不预留资源")
    d.note(1120, 840, 500, "confirm 模式下新提案进 proposed：不占资源、不参与调度、不阻塞；10min 超时后仍等人工，不会静默放行。", 11, title="人工确认窗口")
    d.label(40, 945, "图 3 · 慢路径（advisor + scheduler）；数字即执行顺序，10 为下一轮 review，11 为反馈边", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig3-cycle.svg"))


def fig4():
    d = D(1680, 1080)
    d.text(40, 80, "一次沙箱实验的 9 个写入点：从 prepare 到 verifiedClean", 17, INK, "700")
    s1 = d.box(40, 150, 480, 130, "① sandbox-backend.prepare", ["gpuCount 0–4 · machines=1", "preflight → binding + sourceFiles"], fill="#dbeafe", stroke="#2563eb")
    s2 = d.box(600, 150, 480, 130, "② Host：ledger + request 文件", ["intent → completed / unknown", "O_EXCL 0600 · canonical JSON"], fill="#dbeafe", stroke="#2563eb")
    s3 = d.box(1160, 150, 480, 130, "③ bridge.py acquire", ["cluster key → POST /v2", "sandbox_id · lease"], fill="#ffedd5", stroke="#ea580c")
    s4 = d.box(1160, 430, 480, 130, "④ opensandbox-cluster", ["reserve 事务 → 选节点", "POST /v1/sandboxes → providerId"], fill="#fce7f3", stroke="#db2777")
    s5 = d.box(600, 430, 480, 130, "⑤ node：adapter + Docker", ["validate_request → 白名单 GPU", "execd :44772 · 固定镜像"], fill="#dcfce7", stroke="#16a34a")
    s6 = d.box(40, 430, 480, 130, "⑥ bridge：ready + 上传源码", ["binding ready", "source 清单（path/size/hash）"], fill="#ffedd5", stroke="#ea580c")
    s7 = d.box(40, 710, 480, 130, "⑦ worker：exec / read / write", ["metainfer_sandbox 工具边界", "命令在容器 /workspace/project"], fill="#dbeafe", stroke="#2563eb")
    s8 = d.box(600, 710, 480, 130, "⑧ Host：collect", ["清单校验 · 禁止删源文件", "restoreWorktreeFiles"], fill="#dbeafe", stroke="#2563eb")
    s9 = d.box(1160, 710, 480, 130, "⑨ release + verifiedClean", ["DELETE → GET 404", "adapter 验证物理缺席"], fill="#fce7f3", stroke="#db2777")

    d.arrow([(520, 215), (600, 215)], 1, "#334155", note="capture", note_at=(560, 215), note_dy=-12)
    d.arrow([(1080, 215), (1160, 215)], 2, "#334155", note="SSH+bridge", note_at=(1120, 215), note_dy=-12)
    d.arrow([(1400, 280), (1400, 430)], 3, "#334155", note="POST v2", note_at=(1416, 355), note_anchor="start", note_dy=0, badge_at=(1400, 355))
    d.arrow([(1160, 495), (1080, 495)], 4, "#334155", note="创建", note_at=(1120, 495), note_dy=-12)
    d.arrow([(600, 495), (520, 495)], 5, "#334155", note="ready", note_at=(560, 495), note_dy=-12)
    d.arrow([(220, 560), (220, 710)], 6, "#334155", note="可执行", note_at=(236, 635), note_anchor="start", note_dy=0, badge_at=(220, 635))
    d.arrow([(520, 775), (600, 775)], 7, "#334155", note="完成", note_at=(560, 775), note_dy=-12)
    d.arrow([(1080, 775), (1160, 775)], 8, "#334155", note="collect", note_at=(1120, 775), note_dy=-12)
    d.arrow([(1640, 775), (1660, 775), (1660, 110), (280, 110), (280, 150)], 9, "#db2777", dashed=True, note="binding 清空 · 下一实验", note_at=(900, 110), note_dy=-10)

    d.note(40, 900, 500, "Host 从不直接 docker exec，也不持有节点管理 key：它只能上传请求、等 bridge.py 回一个 JSON，再按 binding.operationId 做 CAS。", 11, title="为什么 Host 不“直接操作”远端")
    d.note(580, 900, 500, "operation 只有 completed/unknown 两态；unknown 绝不自动重放，必须人工拿 evidence 对账或按 fileSha256 历史裁决。", 11, title="为什么 unknown 要永久阻塞")
    d.note(1120, 900, 500, "gpu 只传数量；具体 renderD 由 adapter 在锁内挑，创建前写 pending 标记，失败要人工确认——宁可拒绝也不重复分配。", 11, title="为什么 GPU 由 adapter 抢")
    d.label(40, 1050, "图 4 · prepare / acquire / upload / exec / collect / release；9 为下一实验的反馈边", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig4-sandbox.svg"))


def fig5():
    d = D(1680, 1080)
    d.text(40, 80, "写路径的三层闸门：从点击 Step 到 project.revision 递增", 17, INK, "700")
    s1 = d.box(40, 140, 760, 140, "① Web GUI 发命令", ["Step = project.step", "auto = auto.start / auto.stop"], fill="#f8fafc", stroke="#475569")
    s2 = d.box(880, 140, 760, 140, "② HTTP 命令总线", ["POST /commands · operator token", "39 个 type，if 链分派"], fill="#dbeafe", stroke="#2563eb")
    s3 = d.box(880, 340, 760, 140, "③ lab-service 业务校验", ["业务校验 → service.step", "actor = human:operator"], fill="#dbeafe", stroke="#2563eb")
    s4 = d.box(40, 340, 760, 140, "④ kernel 校验", ["schema / 业务不变量", "拒绝即 error，无副作用"], fill="#ede9fe", stroke="#7c3aed")
    s5 = d.box(40, 540, 760, 140, "⑤ kernel mutations", ["生成 events + 节点变更", "不直接写 store"], fill="#ede9fe", stroke="#7c3aed")
    s6 = d.box(880, 540, 760, 140, "⑥ executor.commitLocked", ["events → saveNode → saveProject", "CAS rev/basis · strictWrites"], fill="#ede9fe", stroke="#7c3aed")
    s7 = d.box(880, 740, 760, 140, "⑦ store 提交 + rev++", ["eventSeq 才是提交确认", "project.revision 单调递增"], fill="#ede9fe", stroke="#7c3aed")
    s8 = d.box(40, 740, 760, 140, "⑧ HTTP 返回 {rev}", ["UI 用 rev 做增量 /changes", "不在前端自行推演 DAG"], fill="#dbeafe", stroke="#2563eb")

    d.arrow([(800, 210), (880, 210)], 1, "#334155", note="POST", note_at=(840, 210), note_dy=-12)
    d.arrow([(1260, 280), (1260, 340)], 2, "#334155", note="route", note_at=(1276, 310), note_anchor="start", note_dy=0, badge_at=(1260, 310))
    d.arrow([(880, 410), (800, 410)], 3, "#334155", note="validate", note_at=(840, 410), note_dy=-12)
    d.arrow([(420, 480), (420, 540)], 4, "#334155", note="mutation", note_at=(436, 510), note_anchor="start", note_dy=0, badge_at=(420, 510))
    d.arrow([(800, 610), (880, 610)], 5, "#334155", note="commit", note_at=(840, 610), note_dy=-12)
    d.arrow([(1260, 680), (1260, 740)], 6, "#334155", note="write", note_at=(1276, 710), note_anchor="start", note_dy=0, badge_at=(1260, 710))
    d.arrow([(880, 810), (800, 810)], 7, "#334155", note="ack", note_at=(840, 810), note_dy=-12)
    d.arrow([(40, 810), (20, 810), (20, 210), (40, 210)], 8, "#2563eb", dashed=True, note="", badge_at=(20, 600))
    d.label(48, 122, "下一次 /changes?after=rev 轮询", 10.5, "#2563eb", "start")

    d.note(40, 890, 500, "HTTP、agent tool、MCP 都只是入口：真正的写必须过 kernel 的校验→mutation→commit，没有旁路 store 的写接口。", 11, title="为什么所有写都要过 kernel")
    d.note(580, 890, 500, "事件是审计与投影来源，节点/项目是投影；saveProject 最后写，project.revision 才能单调，客户端才能安全地做增量读。", 11, title="为什么事件先写、项目最后写")
    d.note(1120, 890, 500, "operator token 只证明“本机操作员”，不是模型安全边界；agent 的 97 action allowlist 由 policy 另算，二者不能互相替代。", 11, title="为什么 token 不等于授权")
    d.label(40, 1040, "图 5 · 写路径；8 为下一次增量轮询，不是同一次请求的一部分", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig5-write-path.svg"))


def fig6():
    d = D(1680, 1000)
    d.text(40, 80, "当前部署：本机 Host + 两个远端站点（线上 gpuCapacity 均为 0）", 17, INK, "700")
    d.zone(40, 120, 440, 720, "本机 Windows · DSH Host", "#eef2ff")
    d.box(70, 300, 340, 180, "DSH Host（单 Node 进程）", ["插件 dsh-metainfer-research-lab v0.11.0", "HTTP 53864 · MCP 3080", "tick 1s · lease pump 2s"], fill="#ffffff", stroke="#4f46e5")
    d.box(70, 520, 340, 120, "本机配置", ["~/.dsh/…/opensandbox*.json", "cluster.json：不存在"], fill="#f8fafc", stroke="#475569")
    d.note(70, 680, 340, "host/cluster.js（DSH 实例间整卡协调器）未启用；它与远端 opensandbox-cluster 是两套代码。", 10.5, title="别混淆两个 cluster")

    d.box(520, 390, 200, 120, "SSH 通道", ["ssh_exec / ssh_upload", "pclab2 经 pclab 跳板"], fill="#f8fafc", stroke="#475569")

    d.zone(780, 110, 860, 320, "pclab27 · 42.228.13.157:40908", "#fff7ed")
    d.pill(1420, 135, 190, 30, "gpuCapacity = 0", fill="#fee2e2", color="#b91c1c")
    d.box(810, 180, 190, 150, "opensandbox-cluster", [":18080 · Bun/Elysia", "pool pclab27-dcu-0-3"], fill="#fce7f3", stroke="#db2777")
    d.box(1040, 180, 180, 150, "OpenSandbox node", ["127.0.0.1:18090", "execd :44772"], fill="#dcfce7", stroke="#16a34a")
    d.box(1260, 180, 340, 150, "adapter + Docker", ["dcu_adapter 白名单 · 私有 data-root", "/data/opensandbox-cluster-metainfer-20261111"], fill="#dcfce7", stroke="#16a34a")

    d.zone(780, 520, 860, 320, "pclab19 · 10.211.12.19:22", "#fff7ed")
    d.pill(1420, 545, 190, 30, "gpuCapacity = 0", fill="#fee2e2", color="#b91c1c")
    d.box(810, 590, 190, 150, "opensandbox-cluster", [":18080 · 资源模式", "pool pclab2-node19-dcu-4-7"], fill="#fce7f3", stroke="#db2777")
    d.box(1040, 590, 180, 150, "OpenSandbox node", ["127.0.0.1:18090", "pclab19-safe-dcu"], fill="#dcfce7", stroke="#16a34a")
    d.box(1260, 590, 340, 150, "adapter + Docker", ["dcu_adapter 白名单 · 私有 data-root", "/mnt/newdata/…/metainfer-opensandbox-19"], fill="#dcfce7", stroke="#16a34a")

    d.arrow([(410, 390), (520, 400)], 1, "#334155", note="SSH", note_at=(465, 385), note_dy=-10)
    d.arrow([(720, 410), (760, 410), (760, 255), (810, 255)], 2, "#334155", note="SSH", note_at=(760, 330), note_anchor="start", note_dy=0, badge_at=(760, 330))
    d.arrow([(720, 450), (760, 450), (760, 665), (810, 665)], 3, "#334155", note="SSH", note_at=(760, 560), note_anchor="start", note_dy=0, badge_at=(760, 560))
    d.arrow([(1000, 255), (1040, 255)], 4, "#db2777", note="HTTP", note_at=(1020, 255), note_dy=-10)
    d.arrow([(1220, 255), (1260, 255)], 5, "#16a34a", note="adapter", note_at=(1240, 255), note_dy=-10)
    d.arrow([(1000, 665), (1040, 665)], 6, "#db2777", note="HTTP", note_at=(1020, 665), note_dy=-10)
    d.arrow([(1220, 665), (1260, 665)], 7, "#16a34a", note="adapter", note_at=(1240, 665), note_dy=-10)
    d.arrow([(240, 520), (240, 480)], 8, "#475569", note="读取", note_at=(256, 500), note_anchor="start", note_dy=0, badge_at=(240, 500))

    d.note(40, 870, 500, "Host 只通过 SSH 工具调 bridge.py；不直连 Docker，也不持有远端管理 key。", 11, title="控制面")
    d.note(580, 870, 500, "两站 cluster/node/unit 均在跑，但管理员把 GPU 容量置 0：当前只可跑 CPU 实验。", 11, title="当前容量")
    d.note(1120, 870, 500, "远端只跑沙箱与 cluster/node；DSH、preset、模型与 DAG 状态都在本机 Host。", 11, title="职责边界")
    d.label(40, 970, "图 6 · 部署拓扑；1–3 控制/创建，4–7 站点内代理，8 本机配置读取", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig6-deploy.svg"))


def fig7():
    d = D(1680, 920)
    d.text(40, 80, "节点状态机：6 个 status，review / deferred / merge 都不是 status", 17, INK, "700")
    d.box(60, 220, 220, 140, "proposed", ["acceptMode=confirm", "人工批准才进 planned"], fill="#f1f5f9", stroke="#64748b")
    d.box(360, 220, 240, 140, "planned", ["可被调度；也可 deferred", "不占 slot、不占 GPU"], fill="#dbeafe", stroke="#2563eb")
    d.box(700, 220, 240, 140, "running", ["hostStart 已换新 session", "claim + admission 保留"], fill="#ede9fe", stroke="#7c3aed")
    d.box(1040, 220, 240, 140, "completed", ["Host commit + report", "同一次提交写 headCommit"], fill="#dcfce7", stroke="#16a34a")
    d.box(1380, 220, 250, 140, "merge 节点（kind='merge'）", ["仍走 planned→running", "→completed；merge.state 另记"], fill="#dcfce7", stroke="#16a34a")
    d.box(360, 500, 240, 120, "cancelled", ["用户取消 / withdraw", "worktree 可回滚"], fill="#f1f5f9", stroke="#64748b")
    d.box(700, 500, 240, 120, "failed", ["失败 stage 保留", "可 retry 新 attempt"], fill="#fee2e2", stroke="#dc2626")
    d.box(1040, 500, 300, 140, "review（元数据，不是状态）", ["node.review{decision,", "reviewedHeadCommit, runId}"], fill="#ecfdf5", stroke="#059669")

    d.arrow([(280, 290), (360, 290)], 1, "#334155", note="approve/auto", note_at=(320, 270), note_dy=0, badge_at=(340, 290))
    d.arrow([(600, 290), (700, 290)], 2, "#334155", note="dispatch", note_at=(650, 290), note_dy=-12)
    d.arrow([(940, 290), (1040, 290)], 3, "#334155", note="hostFinish", note_at=(990, 290), note_dy=-12)
    d.arrow([(480, 360), (480, 500)], 4, "#64748b", note="cancel", note_at=(496, 430), note_anchor="start", note_dy=0, badge_at=(480, 430))
    d.arrow([(820, 360), (820, 500)], 5, "#dc2626", note="fail", note_at=(836, 430), note_anchor="start", note_dy=0, badge_at=(820, 430))
    d.arrow([(820, 620), (820, 680), (300, 680), (300, 150), (520, 150), (520, 220)], 6, "#dc2626", dashed=True, note="retry（新 attempt）", note_at=(560, 680), note_dy=-12)
    d.arrow([(1280, 290), (1380, 290)], 7, "#16a34a", note="autoJoin", note_at=(1330, 290), note_dy=-12)
    d.arrow([(1505, 220), (1505, 160), (820, 160), (820, 220)], 8, "#16a34a", dashed=True, note="同一 runtime 车道", note_at=(1160, 160), note_dy=-10)
    d.arrow([(1160, 360), (1160, 500)], 9, "#059669", note="下一轮 advisor", note_at=(1176, 430), note_anchor="start", note_dy=0, badge_at=(1160, 430))

    d.pill(360, 180, 240, 28, "deferred = priority.class", fill="#fef3c7", color="#92400e")

    d.note(40, 700, 600, "出现 HOST_EFFECTS_UNCONFIRMED / HOST_CLEANUP_UNCONFIRMED / sandbox_restart_held 时一律 hold；它们只能人工对账或 Host 重启对账后解除，代码不会自动越过。", 11, title="三道冷不确定闸（不是 status）")
    d.note(680, 700, 520, "merge 只是 kind='merge' 的节点：它照常走 planned→running→completed；merge.state 另记 pending/clean/conflict/committed，需人工 finish_merge 才提交。", 11, title="merge 为什么不算第七种状态")
    d.note(1240, 700, 380, "deferred 只是 priority.class：节点仍是 planned，不参与调度；改成 p0..p3 即可重新入队，不需要改 status。", 11, title="deferred 为什么不是状态")
    d.label(40, 890, "图 7 · 实线=状态迁移；虚线=retry / 复用同一 runtime；review、deferred、merge.state 均为元数据", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig7-state.svg"))


def fig8():
    d = D(1680, 980)
    d.text(40, 80, "GPU 调度：Host 只决定“跑不跑、要几张”，远端才决定“哪张卡”", 17, INK, "700")

    d.zone(40, 110, 1600, 180, "① DAG 调度层（Host）—— 决定哪个节点先跑、要不要 GPU", fill="#eff6ff", stroke="#bfdbfe")
    d.box(60, 150, 280, 110, "planned 节点", ["needs.gpu = N", "只是数量，不是卡号"], fill="#ffffff", stroke="#2563eb")
    d.box(380, 150, 280, 110, "确定性排序", ["class → CFS vruntime", "p0 预留 / 抢占"], fill="#ffffff", stroke="#2563eb")
    d.box(700, 150, 280, 110, "broker 租约", ["sandbox-admission", "只发逻辑许可"], fill="#ffffff", stroke="#2563eb")
    d.box(1020, 150, 300, 110, "hostBudget", ["项目 GPU 配额", "CAS 写 reservation"], fill="#ffffff", stroke="#2563eb")

    d.arrow([(340, 205), (380, 205)], 1, "#2563eb", note="排序", note_at=(360, 190), note_dy=0, badge_at=(360, 205))
    d.arrow([(660, 205), (700, 205)], 2, "#2563eb", note="申请", note_at=(680, 190), note_dy=0, badge_at=(680, 205))
    d.arrow([(980, 205), (1020, 205)], 3, "#2563eb", note="扣配额", note_at=(1000, 190), note_dy=0, badge_at=(1000, 205))
    d.arrow([(1170, 260), (1170, 305), (200, 305), (200, 370)], 4, "#2563eb", note="下发 gpuCount", note_at=(700, 305), note_dy=-10)

    d.zone(40, 330, 1600, 180, "② 沙箱资源层（opensandbox-cluster）—— 决定哪台节点有配额", fill="#fdf2f8", stroke="#fbcfe8")
    d.box(60, 370, 300, 110, "sandbox prepare", ["gpuCount 0..4", "machines = 1"], fill="#ffffff", stroke="#db2777")
    d.box(400, 370, 300, 110, "资源池 reserve", ["cpu / mem / disk / gpu", "十进制精确求和"], fill="#ffffff", stroke="#db2777")
    d.box(740, 370, 300, 110, "选节点", ["四维同时满足", "score 升序，平手 node id"], fill="#ffffff", stroke="#db2777")
    d.box(1080, 370, 360, 110, "binding", ["creating → active", "lease + attempt_id"], fill="#ffffff", stroke="#db2777")

    d.arrow([(360, 425), (400, 425)], 5, "#db2777", note="请求资源", note_at=(380, 405), note_dy=0, badge_at=(380, 425))
    d.arrow([(700, 425), (740, 425)], 6, "#db2777", note="过滤", note_at=(720, 405), note_dy=0, badge_at=(720, 425))
    d.arrow([(1040, 425), (1080, 425)], 7, "#db2777", note="预留", note_at=(1060, 405), note_dy=0, badge_at=(1060, 425))
    d.arrow([(1260, 480), (1260, 525), (200, 525), (200, 590)], 8, "#db2777", note="物理分配", note_at=(700, 525), note_dy=-10)

    d.zone(40, 550, 1600, 180, "③ 物理卡层（node adapter）—— 决定哪张 renderD", fill="#f0fdf4", stroke="#bbf7d0")
    d.box(60, 590, 300, 110, "adapter 锁", ["flock + 全量 inspect", "pending 标记"], fill="#ffffff", stroke="#16a34a")
    d.box(400, 590, 300, 110, "白名单映射", ["逻辑 GPU → renderD", "pclab27 只有 128/129"], fill="#ffffff", stroke="#16a34a")
    d.box(740, 590, 300, 110, "Docker 容器", ["/dev/kfd + renderD", "cap_drop ALL"], fill="#ffffff", stroke="#16a34a")
    d.box(1080, 590, 360, 110, "verifiedClean", ["inspect 无容器 + 404", "才允许 release"], fill="#ffffff", stroke="#16a34a")

    d.arrow([(360, 645), (400, 645)], 9, "#16a34a", note="选卡", note_at=(380, 625), note_dy=0, badge_at=(380, 645))
    d.arrow([(700, 645), (740, 645)], 10, "#16a34a", note="挂载", note_at=(720, 625), note_dy=0, badge_at=(720, 645))
    d.arrow([(1040, 645), (1080, 645)], 11, "#16a34a", note="验收", note_at=(1060, 625), note_dy=0, badge_at=(1060, 645))

    d.note(40, 770, 500, "host/cluster.js 是 DSH 实例之间的整卡协调器，只在 cluster.enabled 时使用；当前 ~/.dsh/metainfer-research-lab/cluster.json 不存在，未启用。", 11, title="另一个 cluster，不要混")
    d.note(580, 770, 500, "Host 只记“要几张卡”：needs.gpu=2 不等于指定第 2、3 号卡；物理卡由远端 adapter 在白名单内排他分配。", 11, title="数量 ≠ 卡号")
    d.note(1120, 770, 500, "两站 cluster 的 gpuCapacity 当前都是 0：gpuCount>0 会在第 ② 层直接 NO_CAPACITY；CPU 实验不受影响。", 11, title="当前真实容量")
    d.label(40, 950, "图 8 · GPU 调度三层；1–4 Host，5–8 cluster，9–11 adapter；编号是决策顺序，不是同一次网络请求", 12, "#475569", "start")
    d.save(os.path.join(OUT, "fig8-gpu.svg"))


if __name__ == "__main__":
    fig1()
    fig2()
    fig3()
    fig4()
    fig5()
    fig6()
    fig7()
    fig8()
