/**
 * DSH 的子代理接口在两个发行版里形状不同：
 * - 桌面端（0.2.1 系列）从 `spec.request` 读取 parent/cwd/prompt/agentPreset/…
 * - CLI（0.2.2-rc.5 起）把同一批字段摊平在 spec 顶层，`spec.request` 已不再被读取。
 * 两边都发同一份字段（摊平 + 原样放在 request 里），各自忽略不认识的那一半，
 * 这样一棵代码树可以跑在任意一边，无需按版本分支。
 */
export function activationSpec({ request, ...rest }) {
  return { ...rest, ...request, request };
}

/** `ctx.subagents.startActivation` 的双形状版本，参数与旧写法一致。 */
export function startActivation(ctx, spec) {
  return ctx.subagents.startActivation(activationSpec(spec));
}
