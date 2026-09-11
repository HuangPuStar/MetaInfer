# harness_default —— DKAO 可演化 harness 的种子目录

这是 AHE「组件可观测性」的第一步落地（M1 切片 1，纯新增、不改运行时行为）。

## 现状与用途

DKAO 的 harness（gates 阈值、prompts/菜单、planner、skills、工具集、中间件策略、记忆）
目前散在 Python 代码与静态文件里。AHE 只能演化"文件化、可版本化、可校验"的组件，
因此我们先把它们**播种成文件**，放在本目录：

```
harness_default/
├── manifest.yaml          # 组件清单（AHE Evolve 唯一可写空间的入口描述）
├── gates.yaml             # 验收/plateau/ISA 门的规范值（seed 阶段）
├── planner_catalog.yaml   # 优化方案选择机制：方案目录（★ 见 orchestrator/planner.py v0）
├── README.md              # 本文件
└── (后续切片加入)
    ├── systemprompt/      # prompts 模板（coordinator/bootstrap/worker/synthesis）
    ├── tools/             # cordis 组合与 per-role 工具白名单
    ├── middleware/        # resume/compaction/重试策略参数
    ├── skills/            # SKILL.md 种子
    └── memory/            # LongTermMEMORY（measured 事实）
```

## seed 阶段语义（重要）

- **wired: false**：运行时管线仍读 Python 常量（config.py:105、w8a8_pipeline.py:78-80 等），
  本目录文件**尚未被加载器接线**——因此默认行为零变化。
- 一致性由测试守卫：`tests/test_harness_io.py` 断言 gates.yaml 的值与 Python 常量相等，
  防止两份来源漂移；接线（renderer/loader）在后续切片落地，落地时删掉该守卫并让
  运行时以本目录为唯一来源。
- AHE 外循环（harness_evolve）将以本目录为种子，拷贝出可写 workspace（git 仓库），
  每轮评测 pin 一个 workspace 快照；Evolve Agent 只改 workspace。

## 读取方式

见 `orchestrator/harness_io.py`（harness_root 解析、load_manifest/load_gates、seed_workspace）。
可用环境变量 `METAINFER_HARNESS_ROOT` 覆盖根目录（默认本目录）。
