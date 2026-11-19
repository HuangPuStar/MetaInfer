/**
 * Agent-facing text for the profiling trace viewer (issue #94).
 *
 * The viewer never invents an analysis: every option in the side panel turns the
 * selected kernel into a short, self-contained prompt that is dispatched to the
 * project Copilot (analysis) or materialised as a DAG node (fusion / targeted
 * optimisation). Prompts stay under the project-chat limit so the same text can
 * be posted through `project.chat`.
 */

/** Keep a hard ceiling under `CHAT_LIMIT` (8000) in host/lab-service.js. */
export const PROMPT_LIMIT = 7600;
export const NODE_PROMPT_LIMIT = 7600;

const ACTION_DEFS = Object.freeze([
  { id: 'bound', kind: 'chat', labelZh: '是否 compute bound / memory bound', labelEn: 'Compute or memory bound?' },
  { id: 'implementation', kind: 'chat', labelZh: '解释这个 kernel 的执行实现', labelEn: 'Explain the kernel implementation' },
  { id: 'code-path', kind: 'chat', labelZh: '为什么选中了这个 kernel（分支条件）', labelEn: 'Why was this kernel selected?' },
  { id: 'call-context', kind: 'chat', labelZh: '展示完整代码调用上下文', labelEn: 'Show the full call context' },
  { id: 'shapes', kind: 'chat', labelZh: '解释本次调用的输入输出形状', labelEn: 'Explain input/output shapes' },
  { id: 'fusion', kind: 'node', labelZh: '分析与相邻 kernel 的 fusion 可能性并建节点', labelEn: 'Fusion analysis + create a DAG node' },
  { id: 'optimize', kind: 'node', labelZh: '为该 kernel 创建定向优化任务节点', labelEn: 'Create a targeted optimisation node' },
  { id: 'explain', kind: 'chat', labelZh: '解释这个 kernel 在干什么', labelEn: 'What does this kernel do?' },
  { id: 'ask', kind: 'chat', labelZh: '针对该 kernel 自由提问', labelEn: 'Ask about this kernel' },
]);

export const PROFILE_ACTIONS = Object.freeze(ACTION_DEFS.map((entry) => Object.freeze({ ...entry })));

function fmtUs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(3)} s`;
  if (number >= 1000) return `${(number / 1000).toFixed(3)} ms`;
  return `${number.toFixed(1)} us`;
}

function fmtShape(dims) {
  if (!Array.isArray(dims) || dims.length === 0) return 'n/a';
  const rows = dims.map((dims_) => (Array.isArray(dims_) ? `[${dims_.join('x')}]` : String(dims_)));
  return `[${rows.join(', ')}]`;
}

function stackLines(stack) {
  if (!Array.isArray(stack) || stack.length === 0) return ['(no CPU stack was captured; enable with_stack=True when exporting the trace)'];
  const rows = stack.slice(-10).reverse();
  return rows.map((entry, index) => {
    const where = entry.source ? ` @ ${entry.source}` : '';
    return `${index === 0 ? '  ← launch chain:' : '            '} ${entry.name}${where}`;
  });
}

/**
 * Compact, deterministic kernel context. Every action embeds this block, so the
 * agent never has to guess which span the user double-clicked.
 */
export function kernelContextBlock(detail) {
  if (!detail?.kernel) return '';
  const kernel = detail.kernel;
  const aggregate = detail.aggregate ?? {};
  const inputs = detail.inputs ?? null;
  const neighbours = detail.neighbours ?? { prev: [], next: [] };
  const lines = [
    '### Profiling span context (torch.profiler chrome trace)',
    `- kernel: ${kernel.name}`,
    `- family: ${kernel.family}`,
    `- device/stream: GPU ${kernel.device} / stream ${kernel.stream}`,
    `- this launch: ${fmtUs(kernel.dur)} at ts=${Math.round(kernel.ts)}`,
    `- aggregate: count=${aggregate.count ?? 'n/a'}, total=${fmtUs(aggregate.sumUs)}, avg=${fmtUs(aggregate.avgUs)}, p50=${fmtUs(aggregate.p50Us)}, p99=${fmtUs(aggregate.p99Us)}, max=${fmtUs(aggregate.maxUs)}, share=${aggregate.shareOfKernelTime === undefined ? 'n/a' : `${(aggregate.shareOfKernelTime * 100).toFixed(2)}%`}`,
    `- launch config: grid=${kernel.grid ? `[${kernel.grid.join('x')}]` : 'n/a'}, block=${kernel.block ? `[${kernel.block.join('x')}]` : 'n/a'}, registers/thread=${kernel.registers ?? 'n/a'}, shared memory=${kernel.sharedMemory ?? 'n/a'} B, occupancy=${kernel.occupancy ?? 'n/a'}%`,
    `- inputs: ${fmtShape(inputs?.dims)}`,
    `- input dtypes: ${Array.isArray(detail.dtypes) && detail.dtypes.length > 0 ? detail.dtypes.join(', ') : 'n/a'}`,
    `- launch op: ${detail.launchOp?.name ?? 'n/a'}${detail.source ? ` (source: ${detail.source})` : ''}`,
    ...stackLines(detail.stack),
    `- previous kernels on this stream: ${neighbours.prev?.length ? neighbours.prev.map((row) => `${row.shortName} (${fmtUs(row.dur)}, gap ${fmtUs(row.gapUs)})`).join(' | ') : 'none'}`,
    `- next kernels on this stream: ${neighbours.next?.length ? neighbours.next.map((row) => `${row.shortName} (${fmtUs(row.dur)}, gap ${fmtUs(row.gapUs)})`).join(' | ') : 'none'}`,
  ];
  return lines.join('\n');
}

const INSTRUCTIONS = Object.freeze({
  bound: [
    '请判断这个 torch kernel 在本配置下更接近 compute bound 还是 memory bound，并说明判断依据。',
    '要求：',
    '1) 按 grid/block、寄存器/线程、共享内存、occupancy 与输入形状估算算术强度（FLOPs/Byte）；',
    '2) 指出关键瓶颈（访存带宽、指令吞吐、warp 并行度、同步、bank conflict 等）；',
    '3) 给出可验证的判断方法（例如用 nsight/ncu 的具体 section，或做一次对照实验）；',
    '4) 若结论依赖缺失信息，明确列出需要补充的 profiling 指标，不要编造数值。',
  ].join('\n'),
  implementation: [
    '请解释这个 kernel 的执行实现：模板参数/特化含义、tiling 与向量化方式、内存访问路径、同步与调度策略。',
    '如果这是 PyTorch 内置 kernel（如 vectorized_elementwise_kernel、ampere_sgemm_*、triton 生成的 kernel），请说明其源码位置与主要实现逻辑，并引用 ATen/cuBLAS/Triton 的对应实现位置。',
  ].join('\n'),
  'code-path': [
    '请分析本次调用为什么选中了这个 kernel：从 Python 入口到 dispatch 的完整路径，以及决定分支的条件。',
    '重点：dtype/shape/device/layout 触发的 dispatch key、是否走了 fallback、是否因为 contiguous/stride 条件选择该特化 kernel。给出可复核的代码位置（ATen dispatch 代码或算子实现）。',
  ].join('\n'),
  'call-context': [
    '请根据堆栈还原并展示该 kernel 的完整代码调用上下文：从用户 Python 代码到 kernel launch 的每一层（Python → ATen/autograd → CUDA launcher → kernel）。',
    '输出一个按缩进排列的调用链，并在每一层标注其作用；如堆栈信息不足，请说明缺少哪一层并给出补充采集方法（with_stack=True / with_modules=True）。',
  ].join('\n'),
  shapes: [
    '请解释这次调用的输入输出形状：逐参数说明 shape、dtype、以及推导出的元素数量与字节数；',
    '判断是否 contiguous、是否存在隐式拷贝/广播，并估算该 kernel 的全局内存读写量。若输出形状未记录，请根据算子语义推导并标注为推断。',
  ].join('\n'),
  explain: [
    '请用简洁的语言解释这个 kernel 在做什么：数学语义、在模型中的典型位置、输入输出含义。',
    '然后补充 2-3 条阅读这个 kernel 时值得注意的实现细节。',
  ].join('\n'),
  fusion: [
    '请分析这个 kernel 与相邻 kernel 做 fusion 的可行性，目标是形成一个值得立项的新研究方向。',
    '要求：',
    '1) 逐个评估与前后相邻 kernel 的融合机会（数据依赖、shape 是否对齐、是否 elementwise 相邻、是否能省去一次 global memory 往返）；',
    '2) 估算收益（节省的带宽/launch 开销）与风险（寄存器压力、occupancy、数值差异）；',
    '3) 给出一个最小可验证实验（用 Triton 或 CUDA 写 fused kernel 的骨架 + 验证脚本思路）；',
    '4) 最后给出结论：是否值得作为新的研究方向立项。',
  ].join('\n'),
  optimize: [
    '请为这个 kernel 制定一个定向优化任务，输出可直接执行的实验方案。',
    '要求：',
    '1) 给出 2-3 个候选优化方向（tiling/向量化/共享内存/异步拷贝/occupancy 调整/换用 cuBLAS 或 Triton 实现等），并排序；',
    '2) 每个方向给出预期收益、风险与验证指标（吞吐、带宽利用率、occupancy、端到端时延）；',
    '3) 给出具体改动位置与最小 benchmark 方案（输入 shape、测量方式、重复次数）。',
  ].join('\n'),
});

function clip(text, limit) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 20)}\n…[truncated for length]`;
}

/**
 * Build the prompt for one action. `question` is only used by `ask`; other
 * actions ignore it so a stale textarea cannot leak into a fixed prompt.
 */
export function buildActionPrompt(detail, actionId, options = {}) {
  const action = PROFILE_ACTIONS.find((entry) => entry.id === actionId);
  if (!action) {
    throw Object.assign(new Error(`unknown profiler action: ${actionId}`), { code: 'bad_request' });
  }
  const context = kernelContextBlock(detail);
  const question = typeof options.question === 'string' ? options.question.trim() : '';
  if (actionId === 'ask') {
    if (question === '') {
      throw Object.assign(new Error('a question is required for the ask action'), { code: 'bad_request' });
    }
    const prompt = [
      `用户针对这次 profiling 中的 kernel 提问：${question}`,
      '',
      '请结合下面的 kernel 上下文回答；需要更多 profiling 数据时明确说明要采集什么。',
      '',
      context,
    ].join('\n');
    return clip(prompt, PROMPT_LIMIT);
  }
  return clip([INSTRUCTIONS[actionId] ?? '', '', context].join('\n'), PROMPT_LIMIT);
}

/** Titles for the side-panel buttons (the Client renders labels from its locale). */
export function actionCatalog() {
  return PROFILE_ACTIONS.map((entry) => ({ id: entry.id, kind: entry.kind, labelZh: entry.labelZh, labelEn: entry.labelEn }));
}

const NODE_TITLES = Object.freeze({
  fusion: (detail) => `Kernel fusion 研究：${detail.kernel.family}`,
  optimize: (detail) => `定向优化：${detail.kernel.family}`,
});

/**
 * A DAG node prompt: the action instruction plus the span context plus the
 * workspace expectations of this lab (repo worktree, measurable verification).
 */
export function buildNodeTask(detail, actionId) {
  if (actionId !== 'fusion' && actionId !== 'optimize') {
    throw Object.assign(new Error(`action ${actionId} does not create a node`), { code: 'bad_request' });
  }
  const instruction = INSTRUCTIONS[actionId];
  const context = kernelContextBlock(detail);
  const closing = [
    '',
    '工作方式：',
    '- 在项目仓库中创建实验分支与脚本，用真实 GPU 测量（若当前无 GPU，用 CPU/torch profiler 仿真并标注局限）；',
    '- 结论必须附可复现命令与测量数据；无法验证的假设要显式标注；',
    '- 完成后给出结论、收益数据与是否建议进入下一步。',
  ].join('\n');
  const prompt = clip([instruction, '', context, closing].join('\n'), NODE_PROMPT_LIMIT);
  const title = clip(NODE_TITLES[actionId](detail), 120);
  return { title, prompt };
}

/** Deterministic ordering for the UI; also asserted by the selftest. */
export function actionMatches(id) {
  return PROFILE_ACTIONS.some((entry) => entry.id === id);
}
