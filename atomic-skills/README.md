# 原子技能库（通用性能优化行为纪律）

**55 个单点小技能 + 1 个外层大循环编排技能**。原子技能每个只覆盖一个易错点，
一条纪律管一件事；外层技能 [perf-loop-orchestrator](perf-loop-orchestrator/SKILL.md)
把原子技能组装成"用户定目标 → 三个 subagent 无限循环（正确性门 → Profiling 瓶颈分析 →
优化最显著瓶颈）→ 每轮一份性能分析报告 + 一套代码提交"的闭环。

与流程型技能库（7 阶段流程库）互补：流程库回答"现在处于哪个阶段"，
本库回答"无论在哪一步，这件事该怎么做才不出错、不走回头路"。

## 血统与适用范围

- 蒸馏自约 1 万条真实性能优化轨迹的行为统计、4 万余条失败证据与约 1200 条人工纠偏消息。
- 已**去领域化**：不含任何具体硬件、框架、部署方式或具体代码对象的指称，规则只以
  基线/测量/归因/验证/回滚/等待/汇报等通用概念表述。
- 因此适用面从计算内核优化扩展到任何"改东西、测东西、证明东西"的工程任务；
  代价是单条证据强度从"语料计数"降级为"经验规则"——它们是高频踩坑的结晶，不是定理。

## 使用方式

每个技能一个目录，`SKILL.md` 兼容 Claude 技能格式（YAML frontmatter：`name` + `description`）。

- 装到个人技能目录：把需要的技能文件夹复制到 `~/.claude/skills/` 下。
- 装到项目：复制到项目的 `.claude/skills/` 下。
- 任务书引用：把技能名写进委派命令的纪律段（与"只读边界/预期观察"并列）。

技能按需加载，不必全装；高频高损的先装（见下表加粗项）。

## 技能索引（10 类 55 个）

### 一、开局与边界（5）
| 技能 | 一句话 |
|---|---|
| **declare-scope-first** | 动手前声明只读区/资源禁区/写白名单，未声明的按只读处理 |
| read-standing-rules-first | 先完整读常设规则与任务书，冲突时问不自作主张 |
| **recon-before-action** | 接到任何指令第一步仍是侦察现状+只读取证 |
| probe-env-before-assume | 环境能力一律探测确认，被纠正后重推全部结论 |
| smoke-test-new-paths | 新 API/新库/陌生环境先最小冒烟再进主流程 |

### 二、目标与验收（3）
| 技能 | 一句话 |
|---|---|
| **pre-register-acceptance** | 开工前冻结量化门槛（含正确性门槛），事后不得重定义 |
| **correctness-before-speed** | 首次计时前先过正确性门；更快但错误是失败 |
| **bound-the-gain-first** | 动手前算收益上限（用实测可达锚点），上限低直接放弃 |

### 三、测量纪律（6）
| 技能 | 一句话 |
|---|---|
| **baseline-before-change** | 无基线不动手；坏基线先修基线 |
| check-before-rerun | 昂贵步骤重跑前先查输入变没变、找指纹旗标 |
| **comparable-numbers** | 数字必须同条件测、附条件快照；条件变了历史作废 |
| measure-realistic-conditions | 按真实使用形状测；防缓存预热等口径虚高；全场景正向 |
| median-over-singleton | ≥3 轮取中位数+高分位数；预热后计入；脚本内循环 |
| instrument-self-check | 可疑数值先怀疑测量工具；修探针优先于信数据 |

### 四、实验控制（6）
| 技能 | 一句话 |
|---|---|
| **single-variable-change** | 一轮只改一个变量；修复引入新错即回滚该修复 |
| falsifiable-hypothesis | 无预期方向/证伪条件的假设禁止进入实现 |
| sweep-collect-then-compare | 全部跑完统一列表比较；负结果入表；禁止手感切换 |
| **verify-what-you-test** | 工作区干净+产物更新+新路径真被执行，三重确认 |
| checkpoint-incrementally | 一步一验证一检查点；回滚前先保全现场 |
| cover-directions-and-boundaries | 用例覆盖双向+首尾边界；所有变体共用同一组用例 |

### 五、诊断定位（6）
| 技能 | 一句话 |
|---|---|
| **diagnose-before-fix** | 失败后先诊断定位机制；禁止逐字重跑/凭直觉改 |
| **triage-symptom-first** | 先分类现象（超时≠慢）；同类超时两次必换策略 |
| minimal-reproducer | 复杂 bug 抽最小复现+二分锁定触发边界 |
| probes-not-rereads | 第 3 次读同段代码无新信息→缺的是探针 |
| find-first-divergence | 报首错索引/期望/实际；二分找第一个坏节点 |
| **retry-budget** | 预先声明各类重试预算；同类失败第二次即复盘 |

### 六、正确性细节（10）
| 技能 | 一句话 |
|---|---|
| layered-verification | 单元→模块→端到端分层验证，拒绝巨石脚本 |
| tolerance-by-contract | 容差按精度契约推导；位级与近似不共用判定 |
| shape-stride-contract | 布局改动前写下形状/步长契约；参数化后重算公式 |
| mask-and-padding | 填充语义唯一定义；填充值不参与累加；比较时豁免 |
| nondeterminism-is-a-race | 同输入两次结果不同=并发/未初始化，不是容差 |
| branch-symbol-completeness | 分支符号全路径可解析；改分支先全局搜引用 |
| **fail-closed-comparators** | 解析失败按失败处理；比较器先负向自测 |
| config-coverage-before-done | 真实配置覆盖+结果集清点，不静默缺组 |
| **independent-verification** | 断言默认未证实；复核者≠产出者；重跑产物为证 |
| regression-sweep-after-fix | 修复后重跑已通过用例；补丁无效果即回滚 |

### 七、失败处置与止损（5）
| 技能 | 一句话 |
|---|---|
| **rollback-on-no-result** | 回滚触发是"无结果"不是"变差"；回滚后必补根因 |
| escalate-with-data | 空手不上报；以"已试矩阵+建议"求助 |
| pause-when-contradicted | 证据反向先停生成、回头分析；优先级覆盖立即切 |
| stop-at-diminishing-returns | 事前声明终止条件；噪声带内视为持平 |
| persist-until-root-cause | 未定位机制不收工；交回必附已排除项 |

### 八、沟通汇报（3）
| 技能 | 一句话 |
|---|---|
| **evidence-in-reports** | 汇报列产物绝对路径；回执原样摘录证据 |
| report-progress-proactively | 长任务主动周期报状态；被催即失败 |
| self-contained-delegation | 委派六要素自包含；写明预期观察可机械判定 |

### 九、工作流效率（10）
| 技能 | 一句话 |
|---|---|
| **bounded-waiting** | 一切等待挂探针+设期限；外部调用都带超时 |
| background-long-waits | >2 分钟等待后台化+状态文件；拉起等待确认合一 |
| memoize-invariant-checks | 固定输出检查一环境一次；静态文件未变不重读 |
| **write-once-run-many** | 内联逻辑第三次出现即抽成参数化脚本 |
| parameterized-entry-command | 环境装载/资源检查/执行合并为参数化入口 |
| log-status-summary | 同一日志 grep 超 10 次改读三段摘要命令 |
| persist-progress-state | 里程碑落盘；长任务断点续跑；先落盘再下一步 |
| clean-before-relaunch | 重拉前查旧进程/端口；清理幂等+退出确认 |
| lock-hygiene | 禁止嵌套获取同一把锁；排队时间单独记账 |
| budget-aware-parallelism | 并行臂按最坏情况估+硬超时+互斥输出边界 |

### 十、知识沉淀（1）
| 技能 | 一句话 |
|---|---|
| **record-negatives** | 被否定假设比成功更值得记录；踩坑编号入册，新任务先查册 |

（加粗 = 建议优先安装的高频高损项。）

## 外层大循环（1）

| 技能 | 一句话 |
|---|---|
| **perf-loop-orchestrator** | 永续大循环：用户定目标后永不提问、永不暂停、**永不自行终止**，无限循环三 subagent（正确性门 → Profiling 瓶颈排序 → 优化最显著瓶颈），每轮报告+提交+轨迹归档。确定性脚本层 `harness/loopctl.py` 托管 subagent（心跳/超时/杀灭/断点续跑）防卡死与上下文漂移；卡点走自主降级阶梯（绕过/WebSearch/换角度/跳过记录），达标/枯竭/预算警戒只触发换向与里程碑报告（方向生成器保证永有新方向），唯一出口是用户主动叫停 |

## 设计原则

1. **单点**：一个技能只管一个易错点；触发条件写在开头，规则全部祈使句。
2. **不写死阈值**：轮数/百分比/时长等数值由使用者按任务声明（"事先声明"本身是规则），
   因为具体数字是源语料的经验参数，跨域不保证成立。
3. **反模式信号**：每个技能列出"出现什么现象说明你正在违反"，供自检与回看。
4. **可入任务书**：技能写成可被引用的纪律条目，支持作为委派命令的约束段下发，
   而不是只驻留在系统提示里。
