// harness_evolve task detail body (AHE experiment viewer).
// Rendered by the task-detail shell when detail_view_module === "app/he-detail".
// Read-only: fetches /api/harness-evolve/<id>/* and renders summary + per
// iteration benchmark / diff / change evaluation / overview / rollback.

import { html } from "htm/preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { approvePromotion, denyPromotion, getChildren, getDkaoChild, getIterationGpu, getIterations, getPromotion, getReview, getStateGraph, getSummary, getSupervisor, resumeExperiment, startAutopilot, stopExperiment, stopSupervisor } from "app/he-api";
// Shared polling hook: a hidden tab must not keep hammering the server, and a
// round is only polled while it can still change (see usePollWhileVisible).
import { usePollWhileVisible as pollWhileVisible } from "app/utils";
// The DKAO task page itself, reused as a read-only mirror of one question.
// Reused rather than reimplemented so the two views cannot drift: the same
// component renders a child here and renders a standalone DKAO task.
import DcuKernelAutoOptDetail from "app/dkao-detail";

const withTimeout = (p, ms = 8000) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);

// Latency formatting for the round table, which has no local helper of its own.
const fmtUs = (v) => (v == null ? "-" : (v.toFixed ? v.toFixed(2) : String(v)));

// The variant comparison's verdict (FLOW.md §3), not the round's PASS/FAIL.
// A tie is deliberately not a win: the performance gate counts only a strict
// win (outside the 2% noise band), so "平" is a distinct, visible outcome.
function GateVerdictBadge({ verdict }) {
  const cls = { WIN: "ok", LOSS: "bad", NO_SIGNAL: "warn" }[verdict] || "warn";
  const label = { WIN: "赢", LOSS: "输", NO_SIGNAL: "平·不算赢" }[verdict]
    || verdict || "-";
  return html`<span class="badge ${cls}">${label}</span>`;
}

// Where the number a question must beat came from. "variant" = the experiment's
// own variant table, which round 1 seeds from the pool's best_known before any
// kernel is measured here — say which, so "已记录的 variant" is never read as
// "measured by this run" when it was not.
const VARIANT_SOURCE_LABEL = {
  best_known: "池子 best_known",
  baseline: "固定 Triton baseline（尚无 variant，退到基线）",
};

function variantSourceLabel(gate) {
  if (!gate) return "-";
  if (gate.variant_source && gate.variant_source !== "variant") {
    return VARIANT_SOURCE_LABEL[gate.variant_source] || gate.variant_source;
  }
  return String(gate.kernel_source || "").startsWith("pool:")
    ? "本实验 variant（由池子 best_known 播种）"
    : "本实验已记录的 variant";
}

// The round's gate line: which stage this round is, which gate it owed, and what
// that gate concluded. Read from the round's own gate document, never inferred.
function RoundGateLine({ iter }) {
  const stage = iter && iter.stage && iter.stage.stage;
  const gate = (iter && (iter.generalization_gate || iter.performance_gate))
    || null;
  if (!stage) {
    return html`<div class="sub">
      本轮无 <code>stage.json</code>：legacy / suite 路径，未按固定协议判性能门
    </div>`;
  }
  const KIND = { baseline: "基线轮（不判门）", performance: "性能门",
                 generalization: "泛化门" };
  const cls = !gate ? "run"
    : (gate.status === "PASS" ? "ok"
       : (gate.status === "INCOMPLETE" ? "warn" : "bad"));
  return html`<div class="sub">
    stage <strong>${stage}</strong> · ${KIND[stage] || stage}
    ${gate
      ? html` · 结论 <span class="badge ${cls}">${gate.status}</span>
          <small>${(gate.wins || []).length}/${(gate.operators || []).length} 赢（需 ${gate.wins_needed}）</small>
          ${(gate.below_floor || []).length
            ? html`<small> · 低于地板：${gate.below_floor.join(", ")}</small>` : null}
          ${(gate.unmeasured || []).length
            ? html`<small> · 未测到：${gate.unmeasured.join(", ")}</small>` : null}`
      : html` · 尚未判门<small>（第 1 轮只量基线，不判门）</small>`}
  </div>`;
}

// One question's real gate cell: the variant it must beat, plus the verdict when
// the round has been judged. The pool criterion (tau_family * baseline) is NOT
// the variant-round gate, so it is only ever shown as a labelled annotation.
function QuestionGateCell({ gate, poolRef }) {
  if (!gate) return html`-`;
  const poolLine = (poolRef && poolRef.target_us != null) ? html`
    <div><small class="sub">
      池子口径参考 ≤${fmtUs(poolRef.target_us)} µs
      （τ ${fmtUs(poolRef.tau_family)} × baseline；本协议不判门）
    </small></div>` : null;
  if (gate.protocol === "legacy") {
    // Rounds before 2026-09-15 really were judged this way: say so plainly.
    const need = (poolRef && poolRef.baseline_us && poolRef.target_us)
      ? (poolRef.baseline_us / poolRef.target_us) : null;
    return html`<span title="legacy 路径判据：median ≤ tau_family × baseline（不比 variant）">
      <div>≤${fmtUs(gate.target_us)} µs</div>
      <small class="sub">legacy 判据${need ? ` · ≥${need.toFixed(2)}× baseline` : ""}</small>
    </span>`;
  }
  const judged = gate.judged;
  const src = variantSourceLabel(gate);
  const title = `性能门对手 = 该算子当前 variant ${fmtUs(gate.variant_us)} µs（来源：${src}）`
    + ` · 赢 = 严格快 ${gate.noise_percent}% 以上（平局不算赢）`
    + ` · 地板 = variant 的 ${Math.round((gate.floor_percent || 0.8) * 100)}%`
    + (judged ? ` · 本轮实测 ${fmtUs(judged.candidate_median_us)} µs` : "")
    + (poolRef && poolRef.target_us != null
       ? ` · 池子口径 τ×baseline = ${fmtUs(poolRef.target_us)} µs（本协议不判门）` : "");
  return html`<span title=${title}>
    <div>≤${fmtUs(gate.variant_us)} µs <small class="sub">variant</small></div>
    ${judged
      ? html`<${GateVerdictBadge} verdict=${judged.verdict} />
             <small class="sub">${judged.delta_percent > 0 ? "+" : ""}${fmtUs(judged.delta_percent)}%</small>`
      : html`<small class="sub">${gate.stage === "baseline"
            ? "第 1 轮不判门 · 本轮定下的对手"
            : "本轮尚未判门"}</small>`}
    ${poolLine}
  </span>`;
}

// Outer-loop AHE step machine (Prepare -> Evaluate -> ... -> Finished).
// Uses the same classes as the DKAO page (.dkao-state-*) for identical looks.
function StateMachine({ graph }) {
  const nodes = graph?.nodes || [];
  if (!nodes.length) return html`<p class="muted">Waiting for the control plane.</p>`;
  return html`
    <div class="dkao-state-machine">
      ${nodes.map((node, index) => html`
        <div class="dkao-state-step ${graph.current === node.id ? "active" : ""} ${node.is_terminal ? "terminal" : ""}">
          <span class="dkao-state-index">${index + 1}</span>
          <span>${node.label}</span>
        </div>
        ${index < nodes.length - 1 ? html`<span class="dkao-state-arrow">→</span>` : null}
      `)}
    </div>
  `;
}

// Inner DKAO phases (each question IS one DKAO task running its own loop).
const DKAO_PHASE_LABEL = {
  idle: "…",
  prepare: "Prepare",
  generate_kernel_repo: "Generate kernel repo",
  baseline: "Baseline",
  parallel_explore: "Parallel explore",
  skill_synthesis: "Skill synthesis",
  serial_validate: "Serial validate",
  report: "Report",
  finished: "Finished",
};

function DkaoPhaseChip({ child }) {
  if (!child) return html`<span class="badge warn">no child yet</span>`;
  const phase = child.current_phase || "idle";
  if (child.finished) {
    const cls = child.final_status === "success" ? "ok" : "bad";
    return html`<span class="badge ${cls}">finished${child.final_status ? ` · ${child.final_status}` : ""}</span>`;
  }
  return html`<span class="badge run">${DKAO_PHASE_LABEL[phase] || phase}</span>`;
}

function StateBadge({ state }) {
  const s = state || "";
  const bad = /fail|error|reject|killed|timeout/.test(s);
  const done = /pass|accept|success|complete|finish|done|publish/.test(s);
  const cls = bad ? "bad" : done ? "ok" : "run";
  return html`<span class="badge ${cls}">${s || "-"}</span>`;
}

// Per-question inner DKAO view (renders the same way the DKAO detail page
// does: the 8-step DKAO state machine + worker lanes + agents + log).
function ChildDkaoView({ payload }) {
  if (!payload) return html`<p class="muted">Loading DKAO child…</p>`;
  const run = payload.run || {};
  return html`
    <div class="he-child-dkao">
      <div class="he-card">
        <h4>DKAO child — ${payload.child}</h4>
        <div class="sub">
          phase: <strong>${DKAO_PHASE_LABEL[run.current_phase] || run.current_phase}</strong>
          · iteration ${run.current_iteration ?? "-"}
          ${run.finished ? html` · <${StateBadge} state=${run.final_status || "finished"} />` : ""}
          · repo: <span class="mono">${payload.repo_path || "-"}</span>
        </div>
      </div>
      <${StateMachine} graph=${payload.graph} />
      <div class="he-section">
        <h4>Workers</h4>
        ${payload.workers && payload.workers.length ? html`
          <table class="he-tbl">
            <thead><tr><th>worker</th><th>state</th><th>iteration</th><th>shape</th><th>GPU</th><th>rounds</th><th>best median us</th></tr></thead>
            <tbody>
              ${payload.workers.map((w) => html`
                <tr>
                  <td class="mono">${w.worker_id}</td>
                  <td><${StateBadge} state=${w.state} /></td>
                  <td>${w.iteration ?? "-"}</td>
                  <td class="mono">${w.shape_id || "-"}</td>
                  <td>${w.physical_gpu ?? "-"}</td>
                  <td>${w.rounds ?? 0}</td>
                  <td>${w.best_median_us != null ? w.best_median_us : "-"}</td>
                </tr>`)}
            </tbody>
          </table>` : html`<p class="muted">no worker lanes yet</p>`}
        ${(() => {
          const rounds = (payload.workers || [])
            .flatMap((w) => (w.experiments || []).map((e) => ({ worker: w.worker_id, ...e })))
            .sort((a, b) => (a.iteration || 0) - (b.iteration || 0));
          if (!rounds.length) return null;
          return html`
            <h4>Optimization rounds <small>(accepted median per attempt, speedup vs the frozen Triton baseline)</small></h4>
            <table class="he-tbl">
              <thead><tr><th>worker</th><th>iter</th><th>median us</th><th>p90 us</th><th>baseline us</th><th>speedup</th><th>accepted</th></tr></thead>
              <tbody>
                ${rounds.map((e) => html`
                  <tr>
                    <td class="mono">${e.worker}</td>
                    <td>${e.iteration ?? "-"}</td>
                    <td>${e.median_us != null ? e.median_us.toFixed ? e.median_us.toFixed(2) : e.median_us : "—"}</td>
                    <td>${e.p90_us != null ? (e.p90_us.toFixed ? e.p90_us.toFixed(2) : e.p90_us) : "—"}</td>
                    <td>${e.baseline_us != null ? (e.baseline_us.toFixed ? e.baseline_us.toFixed(2) : e.baseline_us) : "—"}</td>
                    <td>${e.speedup != null ? (typeof e.speedup === "number" ? `${e.speedup.toFixed(2)}×` : e.speedup) : "-"}</td>
                    <td>${e.accepted ? html`<span class="badge ok">accept</span>` : html`<span class="badge bad">reject</span>`}</td>
                  </tr>`)}
              </tbody>
            </table>`;
        })()}
      </div>
      <div class="he-section">
        <h4>Agents</h4>
        ${payload.agents && payload.agents.length ? html`
          <table class="he-tbl">
            <thead><tr><th>agent</th><th>role</th><th>status</th><th>iter</th><th>median us</th><th>speedup vs baseline</th></tr></thead>
            <tbody>
              ${payload.agents.map((a) => html`
                <tr>
                  <td class="mono">${a.name || "-"}</td>
                  <td>${a.role || "-"}</td>
                  <td><${StateBadge} state=${a.status} /></td>
                  <td>${a.iteration != null ? a.iteration : "-"}</td>
                  <td>${a.median_us != null ? (a.median_us.toFixed ? a.median_us.toFixed(2) : a.median_us) : "-"}</td>
                  <td>${a.speedup != null
                        ? html`<span title=${`baseline ${a.baseline_us}us`}>${typeof a.speedup === "number" ? a.speedup.toFixed(2) + "×" : a.speedup}${a.accepted ? "" : " (rejected)"}</span>`
                        : "-"}</td>
                </tr>`)}
            </tbody>
          </table>` : html`<p class="muted">no agents yet</p>`}
      </div>
      ${payload.log_tail ? html`<details class="he-iter"><summary>child orchestrator log</summary>
        <pre class="he-pre">${payload.log_tail}</pre></details>` : null}
    </div>`;
}

function VerdictBadge({ verdict }) {
  const cls = { EFFECTIVE: "ok", PARTIALLY_EFFECTIVE: "warn", MIXED: "warn",
                INEFFECTIVE: "bad", HARMFUL: "bad", BASELINE: "ok",
                PROMOTE: "ok", PROMOTE_UNEXPLAINED: "ok",
                CONFIRM_REQUIRED: "warn", NO_SIGNAL: "warn", SPECIALIZE: "warn",
                REJECT: "bad", REJECT_OVERFIT: "bad" }[verdict] || "warn";
  return html`<span class="badge ${cls}">${verdict || "-"}</span>`;
}

function ScoreTable({ scores }) {
  if (!scores || !scores.length) return null;
  return html`
    <table class="he-tbl">
      <thead><tr><th>iteration</th><th>pass</th><th>total</th><th>rate</th></tr></thead>
      <tbody>
        ${scores.map((s) => html`
          <tr><td>${s.iteration}</td><td>${s.n_pass}</td><td>${s.n_total}</td>
          <td>${(100 * (s.pass_rate || 0)).toFixed(1)}%</td></tr>`)}
      </tbody>
    </table>`;
}

// --------------------------------------------------------------------------- //
// Live DKAO mirror: one iteration's questions, rendered by the DKAO page itself
// --------------------------------------------------------------------------- //
// Each question of an iteration is a real DKAO run. Those runs are spawned by
// the HE orchestrator's CLI and are absent from the task registry, so the
// embedded view is addressed by the child's artifact directory instead of a
// task id -- hence the `stateDir` prop, which the DKAO routes accept read-only.
// The switcher follows the still-running question by default, because that is
// the one the operator opened the iteration to watch.
function LiveDkaoMirror({ taskId, iter, initialQuestion = null }) {
  const num = useMemo(() => {
    const m = (iter.name || "").match(/(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  }, [iter.name]);

  const [children, setChildren] = useState(null);
  const [sel, setSel] = useState(initialQuestion);
  const [err, setErr] = useState(null);
  //: How many DKAO pages this round shows at once. "grid" is the default: a
  //: round is four questions on four cards, and comparing them is the point —
  //: one-at-a-time behind tabs hid three quarters of the round. Each cell is the
  //: same read-only DKAO page, pointed at that question's own state dir.
  const [layout, setLayout] = useState("grid");

  useEffect(() => {
    if (!taskId || !num) return;
    let alive = true;
    withTimeout(getChildren(taskId, num))
      .then((c) => { if (alive) { setChildren(c || {}); setErr(null); } })
      .catch((e) => { if (alive) { setChildren({}); setErr(String(e)); } });
    return () => { alive = false; };
  }, [taskId, num]);

  const ids = useMemo(() => Object.keys(children || {}).sort(), [children]);
  // Follow whichever question is still running; fall back to the first, and
  // never let a stale selection survive a refresh that dropped it.
  const selected = useMemo(() => {
    if (sel && ids.includes(sel)) return sel;
    const running = ids.find((id) => children[id] && !children[id].finished);
    return running || ids[0] || null;
  }, [ids, sel, children]);

  if (!num) return null;
  if (children && !ids.length) {
    return html`<div class="he-section">
      <h4>DKAO 实时视图 — ${iter.name}</h4>
      <p class="muted">这一轮还没有派发 DKAO 子任务（或产物已被清理）。</p>
    </div>`;
  }
  const child = selected ? children[selected] : null;
  const childSummary = (c) => html`
    <span class="muted">
      · phase ${c.current_phase || "-"}
      · iter ${c.current_iteration ?? "-"}
      ${c.rounds ? html` · ${c.rounds} rounds` : null}
      ${c.best_median_us != null ? html` · best ≈${Number(c.best_median_us).toFixed(2)} µs` : null}
    </span>`;
  const mirror = (id, c) => html`
    <${DcuKernelAutoOptDetail} taskId=${id} stateDir=${c.child_state_dir}
      readOnly=${true} />`;
  const statusBadge = (c) => (c.finished
    ? html`<span class="badge ${c.final_status === "success" ? "ok" : "bad"}">${c.final_status || "finished"}</span>`
    : html`<span class="badge run">${c.current_phase || "…"} #${c.current_iteration ?? "-"}</span>`);
  const layouts = [
    ["grid", "四宫格（四个同时看）"],
    ["stack", "单列堆叠（四个都展开）"],
    ["single", "只看一个（切换）"],
  ];

  return html`
    <div class="he-section he-live-dkao">
      <h4>DKAO 实时视图 — ${iter.name}
        <small>（该轮每道考题的 DKAO 页面，只读；可同时看四个）</small></h4>
      <div class="he-subrow he-live-layout">
        <label>布局</label>
        ${layouts.map(([key, label]) => html`
          <button type="button" class=${layout === key ? "he-btn active" : "he-btn"}
            onClick=${() => setLayout(key)}>${label}</button>`)}
        <span class="sub">四个子任务是各自独立的 DKAO 运行（一卡一题），所以四个页面互不影响</span>
      </div>
      <div class="he-subrow he-live-tabs">
        ${ids.map((id) => {
          const c = children[id] || {};
          const cls = selected === id ? "he-live-tab active" : "he-live-tab";
          return html`
            <button type="button" class=${cls}
              title=${layout === "single" ? "只看这一题" : "高亮这一题（四个都还在显示）"}
              onClick=${() => setSel(id)}>
              <span class="mono">${id}</span>
              <small>${statusBadge(c)}</small>
            </button>`;
        })}
      </div>
      ${!children ? html`<p class="muted">Loading DKAO children…</p>` : null}
      ${err ? html`<p class="muted">无法读取子任务列表：${err}</p>` : null}
      ${layout === "single"
        ? (child && child.child_state_dir ? html`
            <div class="he-live-host">
              <span class="muted">子任务数据目录</span>
              <span class="mono">${child.child_state_dir}</span>
              ${childSummary(child)}
            </div>
            ${mirror(selected, child)}`
          : html`<p class="muted">这一轮没有可显示的子任务。</p>`)
        : html`
          <div class=${layout === "grid" ? "he-live-grid" : "he-live-stack"}>
            ${ids.map((id) => {
              const c = children[id] || {};
              if (!c.child_state_dir) return null;
              return html`
                <section class="he-live-cell ${selected === id ? "selected" : ""}">
                  <header class="he-live-cell-head">
                    <button type="button" class="he-live-cell-title"
                      title="高亮这一题" onClick=${() => setSel(id)}>
                      <span class="mono">${id}</span>
                    </button>
                    ${statusBadge(c)}
                    ${childSummary(c)}
                    <span class="he-live-cell-grow"></span>
                    <button type="button" class="he-btn"
                      title="切换到单题视图，只看这一题"
                      onClick=${() => { setSel(id); setLayout("single"); }}>只看这一题</button>
                  </header>
                  <div class="he-live-cell-body">${mirror(id, c)}</div>
                </section>`;
            })}
          </div>`}
    </div>`;
}

function IterBlock({ iter, taskId }) {
  const results = (iter.benchmark && iter.benchmark.results) || {};
  const rows = Object.entries(results);
  return html`
    <details class="he-iter">
      <summary>${iter.name}</summary>
      <div class="he-panel">
        ${iter.decision ? html`
          <div class="he-card">
            <h4>System decision</h4>
            <${VerdictBadge} verdict=${iter.decision.verdict} />
            <div>${iter.decision.reason || ""}</div>
            <small>performance: ${iter.decision.performance_gate?.status || "-"}
            · mechanism: ${iter.decision.mechanism_gate?.status || "-"}
            · generalization: ${iter.decision.generalization_gate?.status || "-"}
            · held-out: ${iter.decision.heldout_gate?.status || "-"}</small>
            ${iter.decision.generalization_gate?.status === "FAIL" ? html`
              <div class="badge bad">非本族探针退化 → 判为过拟合（探针不计入 pass rate，但阻止晋级）</div>` : null}
            <small class="sub">
              决策配对 ${(iter.decision.paired_ids || []).length} 题
              ${(iter.decision.probe_ids || []).length
                ? `· 探针 ${(iter.decision.probe_ids || []).join(", ")} 不计入判定` : ""}
            </small>
          </div>` : null}
        ${iter.rollback ? html`<div class="badge bad">auto-rollback: ${iter.rollback.reason}</div>` : null}
        ${iter.mechanism_evidence ? html`
          <div class="he-card">
            <h4>Mechanism gate
              <small>（机制是否真的被执行）</small></h4>
            ${iter.decision && iter.decision.mechanism_gate
              ? html`<${VerdictBadge} verdict=${iter.decision.mechanism_gate.status} />` : null}
            <table class="he-tbl">
              <thead><tr><th>change</th><th>grade</th><th>kind</th><th>evidence</th></tr></thead>
              <tbody>
                ${((iter.mechanism_evidence.detail || {}).changes || []).map((c) => html`
                  <tr>
                    <td class="mono">${c.id}</td>
                    <td>${(() => {
                      const cls = { hit: "ok", partial: "ok",
                                    unobserved: "warn", contradicted: "bad" }[c.grade] || "warn";
                      return html`<span class="badge ${cls}">${c.grade}</span>`;
                    })()}</td>
                    <td>${c.kind || "-"}</td>
                    <td>${c.reason || ""}</td>
                  </tr>`)}
              </tbody>
            </table>
            <small class="sub">
              planner: ${String((iter.mechanism_evidence.evidence || {}).planner_enabled)}
              · plan ids observed: ${((iter.mechanism_evidence.evidence || {}).plan_ids || []).join(", ") || "—"}
              · harness revisions loaded: ${((iter.mechanism_evidence.evidence || {}).observed_harness_revisions || []).join(", ") || "—"}
            </small>
          </div>` : null}
        ${iter.promotion && (iter.promotion.results || []).length ? html`
          <div class="he-card">
            <h4>Kernel promotion → DKAO variants
              <small>（阈值 ${iter.promotion.min_improvement_percent}% · 写前备份）</small></h4>
            <table class="he-tbl">
              <thead><tr><th>shape</th><th>action</th><th>variant median → new</th><th>improvement</th><th>reason</th></tr></thead>
              <tbody>
                ${iter.promotion.results.map((p) => html`
                  <tr>
                    <td class="mono">${p.shape}</td>
                    <td>${(() => {
                      const cls = { added: "ok", updated: "ok", "would-add": "ok",
                                    "would-update": "ok" }[p.action]
                        || (p.action === "rejected" ? "bad" : "warn");
                      return html`<span class="badge ${cls}">${p.action}</span>`;
                    })()}</td>
                    <td>${p.old_median_us != null ? (p.old_median_us.toFixed ? p.old_median_us.toFixed(2) : p.old_median_us) : "—"}
                        → ${p.new_median_us != null ? (p.new_median_us.toFixed ? p.new_median_us.toFixed(2) : p.new_median_us) : "—"}</td>
                    <td>${p.improvement_percent != null ? `${p.improvement_percent.toFixed(2)}%` : "-"}
                        ${p.speedup != null ? html`<small class="sub">(${typeof p.speedup === "number" ? p.speedup.toFixed(2) + "× baseline" : p.speedup})</small>` : null}</td>
                    <td>${p.reason || ""} ${p.backup ? html`<small class="sub">backup: ${p.backup}</small>` : null}</td>
                  </tr>`)}
              </tbody>
            </table>
          </div>` : null}
        ${rows.length ? html`
          <table class="he-tbl">
            <thead><tr><th>instance</th><th>role</th><th>passed</th><th>median/p90 us</th><th>child/repo</th><th>reason</th></tr></thead>
            <tbody>
              ${rows.map(([id, r]) => html`
                <tr><td>${id}</td>
                <td>${(() => {
                  const purpose = (iter.purposes || {})[id];
                  if (!purpose) return html`<span class="sub">—</span>`;
                  const cls = purpose === "probe" ? "warn" : "ok";
                  return html`<span class="badge ${cls}"
                    title=${purpose === "probe" ? "泛化探针：不计入决策" : "参与决策"}>${purpose}</span>`;
                })()}</td>
                <td>${r.passed ? html`<span class="badge ok">pass</span>`
                                : html`<span class="badge bad">fail</span>`}</td>
                <td>${r.median_us != null ? r.median_us : "-"} / ${r.p90_us != null ? r.p90_us : "-"}</td>
                <td><div>${r.child_task_id || "-"}</div><small>${r.repo_path || ""}</small></td>
                <td>${r.reason || ""}</td></tr>`)}
            </tbody>
          </table>` : html`<p>no benchmark results yet</p>`}
        <${LiveDkaoMirror} taskId=${taskId} iter=${iter} />
        ${iter.diff ? html`
          <p>flipped: ${(iter.diff.flipped || []).join(", ") || "-"}
          · regressed: ${(iter.diff.regressed || []).join(", ") || "-"}</p>` : null}
        ${iter.change_evaluation ? html`
          <h5>Change attribution (previous loop)</h5>
          <table class="he-tbl">
            <thead><tr><th>change</th><th>hit</th><th>verdict</th></tr></thead>
            <tbody>
              ${(iter.change_evaluation.change_evaluations || []).map((c) => html`
                <tr><td>${c.change_id}: ${(c.description || "").slice(0, 60)}</td>
                <td>${c.hit_rate}</td><td>${html`<${VerdictBadge} verdict=${c.verdict} />`}</td></tr>`)}
            </tbody>
          </table>` : null}
        ${iter.overview ? html`<details><summary>analysis overview</summary>
          <pre class="he-pre">${iter.overview}</pre></details>` : null}
      </div>
    </details>`;
}


// Human decision on a candidate harness. Nothing is written to DKAO until the
// operator approves, so this panel is the gate: it shows the candidate, the
// evidence of both gates, and the current production version.
// A run that left the fixed protocol (FLOW.md §1–§4) judges neither gate, so it
// looks exactly like a run that is merely quiet. The orchestrator writes
// protocol.json + a timeline event when that happens; this puts it on screen.
function ProtocolBanner({ protocol }) {
  if (!protocol || protocol.mode !== "legacy") return null;
  return html`
    <div class="he-section" style="border-color:#c98a00;background:rgba(201,138,0,.08)">
      <h4>⚠ 本任务未按固定协议运行 <small>（legacy / suite 路径）</small></h4>
      <div class="sub">
        原因：${protocol.reason || "unknown"}。
        这条路径不固化泛化考卷、不判性能门/泛化门、不按 4 的倍数取题，
        因此它的轮次**不会产出可接入 DKAO 的 harness**。
        新任务请配置实测池文件（问卷池 Question pool），协议见 <code>FLOW.md</code>。
      </div>
    </div>
  `;
}

// Four cards, one glance: this round's DKAO children as four columns.
// The drill-down below still shows one child in full (read-only DKAO mirror);
// this answers the other question — "what is each card doing right now?" —
// without switching tabs. Every number is the child's own evidence: phase and
// iteration come from its run.json, the median from its accepted rounds, the
// gate line from its measurement_gate.jsonl, and the card membership from HE's
// layout record for the round (never from the card a probe happened to use).
function FourCardOverview({ data, onSelect, selected }) {
  const cards = (data && data.cards) || [];
  const gpuCount = (data && data.gpu_count) || 4;
  if (!cards.length) return null;
  const fmt = (v) => (v == null ? "-" : (v.toFixed ? v.toFixed(2) : v));
  const byGpu = new Map(cards.map((c) => [Number(c.gpu), c]));
  const now = Date.now() / 1000;
  const quiet = (q) => {
    const ts = Number(q.last_update || 0);
    if (!ts || q.finished) return null;
    return Math.max(0, Math.round(now - ts));
  };
  const statusChip = (q) => {
    if (q.finished) {
      const ok = q.final_status === "success" || q.final_status === "ok";
      return html`<span class="badge ${ok ? "ok" : "bad"}">已结束${q.final_status ? ` · ${q.final_status}` : ""}</span>`;
    }
    const a = q.gate_audit || {};
    if (a.last_event === "gate_blocked" && a.last_usable === false) {
      return html`<span class="badge warn">等卡（闸门未放行）</span>`;
    }
    const secs = quiet(q);
    if (secs != null && secs > 900) {
      return html`<span class="badge warn">静默 ${Math.round(secs / 60)}min</span>`;
    }
    return html`<span class="badge ok">运行中</span>`;
  };
  const sourceLabel = (src) => (
    src === "layout" ? "本轮布局"
      : src === "assignment" ? "题面绑定"
        : src === "predicted" ? "预测（无记录）" : "子任务门禁");
  const cells = [];
  for (let gpu = 0; gpu < gpuCount; gpu += 1) cells.push(gpu);
  return html`
    <div class="he-section">
      <h4>四卡一览 <small>（第 ${data && data.iteration} 轮 · 一卡一题 · 数字都来自子任务自己的记录）</small></h4>
      <div class="he-four-cards">
        ${cells.map((gpu) => {
          const card = byGpu.get(gpu);
          const questions = (card && card.questions) || [];
          return html`
            <article class="he-card-col ${questions.length ? "" : "idle"}">
              <header>
                <strong>GPU${gpu}</strong>
                <small class="muted">${questions.length ? `${questions.length} 题` : "本轮未派题"}</small>
              </header>
              ${questions.length === 0
                ? html`<div class="muted he-card-empty">空闲</div>`
                : questions.map((q) => {
                    const a = q.gate_audit || {};
                    const g = q.gate || {};
                    const secs = quiet(q);
                    // The bar is the round's real gate: the operator's current
                    // variant (legacy rounds kept the family τ×baseline target,
                    // which is what judged them).
                    const target = g.target_us;
                    const onTarget = (q.best_median_us != null && target != null)
                      ? q.best_median_us <= target : null;
                    return html`
                      <div class="he-card-q ${selected === q.question ? "selected" : ""}">
                        <div class="he-card-q-head">
                          <button type="button" class="he-card-q-name"
                            title="在下面打开这个子任务的完整 DKAO 视图"
                            onClick=${() => onSelect && onSelect(q.question)}>
                            ${q.question}
                          </button>
                          ${statusChip(q)}
                        </div>
                        <dl class="he-card-metrics">
                          <dt>阶段</dt>
                          <dd>${DKAO_PHASE_LABEL[q.current_phase] || q.current_phase || "idle"}</dd>
                          <dt>轮次</dt>
                          <dd>iter ${q.current_iteration ?? "-"} · ${q.rounds || 0} 次测量</dd>
                          <dt>当前</dt>
                          <dd>${q.best_median_us != null
                                ? html`<span class="mono">${fmt(q.best_median_us)} µs</span>
                                    ${target != null
                                      ? html`<small class="muted" title=${g.protocol === "legacy"
                                          ? "legacy 路径判据：tau_family × baseline"
                                          : "本轮性能门的对手：该算子当前的 variant"}>
                                          / 必须打败 ≤ ${fmt(target)}${onTarget === null ? "" : (onTarget ? " ✓" : " ✗")}</small>`
                                      : null}`
                                : html`<span class="muted">尚未测出</span>`}</dd>
                          <dt>闸门</dt>
                          <dd>${a.checks == null || a.checks === 0
                                ? html`<span class="muted">暂无记录</span>`
                                : html`${a.blocked ? html`<span class="badge warn">等待 ${a.blocked} 次</span>` : html`<span class="badge ok">已通过</span>`}
                                    ${secs != null ? html`<small class="muted"> · ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}min`} 前更新</small>` : null}`}</dd>
                          <dt>来源</dt>
                          <dd><small class="muted">${sourceLabel(q.gpu_source)}</small></dd>
                        </dl>
                      </div>`;
                  })}
            </article>`;
        })}
      </div>
    </div>
  `;
}

function PromotionPanel({ promo, busy, onApprove, onDeny }) {
  if (!promo) return null;
  const pending = promo.pending;
  const promoted = promo.promoted;
  const table = promo.variant_table || {};
  const gateLine = (gate, need) => {
    if (!gate) return html`<span class="muted">—</span>`;
    const wins = (gate.wins || []).length;
    const ops = (gate.operators || []).length;
    const ok = gate.status === "PASS";
    return html`<span class="badge ${ok ? "ok" : "warn"}">${gate.status}</span>
      <small>${wins}/${ops} win（需 ${need}）</small>`;
  };
  return html`
    <div class="he-section">
      <h4>Harness promotion <small>（接入 DKAO 需要人工批准）</small></h4>
      ${pending ? html`
        <div class="he-card">
          <div class="sub">
            候选版本 <strong>${pending.version}</strong>
            · 来自第 ${pending.iteration} 轮
            · revision <span class="mono">${(pending.revision || "-").slice(0, 12)}</span>
          </div>
          <table class="he-tbl">
            <tbody>
              <tr><td>性能门</td><td>${gateLine(pending.performance_gate, 3)}</td></tr>
              <tr><td>泛化门</td><td>${gateLine(pending.generalization_gate, 2)}</td></tr>
              <tr><td>机制门（宽松，仅记录）</td>
                  <td><span class="badge">${(pending.mechanism_gate && pending.mechanism_gate.status) || "NOT_RECORDED"}</span></td></tr>
            </tbody>
          </table>
          <div style="margin-top:8px">
            <button type="button" class="he-btn" disabled=${busy}
              onClick=${onApprove}>批准并接入 DKAO</button>
            <button type="button" class="he-btn" disabled=${busy}
              onClick=${onDeny} style="margin-left:8px">拒绝（丢弃候选、继续迭代）</button>
          </div>
        </div>` : html`
        <div class="sub">当前没有待批准候选。</div>`}
      <div class="sub" style="margin-top:6px">
        生产版本：<strong>${(promoted && promoted.version) || "h-1（种子）"}</strong>
        ${promoted && promoted.approved_at ? html` · 于 ${new Date(promoted.approved_at * 1000).toLocaleString()}` : null}
        · variant 表：${table.operators || 0} 个算子 / 版本 ${table.harness_version || "未发布"}
      </div>
    </div>
  `;
}

// One iteration's device cards, read-only: HE no longer leases cards — each
// question is a DKAO child and the child's own admission gate decides when the
// device it was handed to is clean enough to time a kernel. Folded twice on
// purpose: the section folds (default collapsed) and so does every card and
// every per-question detail, so a 4-card round stays one scan line until asked.
function GpuCardsPanel({ data, num }) {
  const cards = (data && data.cards) || [];
  const nQuestions = cards.reduce((acc, c) => acc + ((c.questions || []).length), 0);
  const fmt = (v) => (v == null ? "-" : (v.toFixed ? v.toFixed(2) : v));
  return html`
    <details class="panel he-gpu-panel">
      <summary>
        <span>GPU 设备</span>
        <small class="muted">
          — 第 ${num} 轮 · ${cards.length} 张卡上有 ${nQuestions} 个 DKAO 子任务
          · 本任务不持有租约，卡由 DKAO 的准入闸门管理
        </small>
      </summary>
      ${!cards.length
        ? html`<div class="muted he-gpu-empty">本轮尚未派发任何 DKAO 子任务（无设备卡片）</div>`
        : html`<div class="he-gpu-grid">
            ${cards.map((card) => html`
              <details class="he-gpu-card">
                <summary>
                  <strong>GPU${card.gpu}</strong>
                  <small class="muted">
                    ${(card.questions || []).map((q) => q.question).join(", ") || "空闲"}
                    · ${(card.questions || []).length} 个问题
                  </small>
                </summary>
                ${(card.questions || []).map((q) => {
                  const a = q.gate_audit || {};
                  const g = q.gate || {};
                  const p = q.pool_reference || {};
                  const req = q.requirements;
                  // Where this card membership came from, most authoritative
                  // first: HE's layout record for the round, the device HE
                  // pinned in the child's requirements, the child's own gate —
                  // and only as a last resort the index % 4 prediction.
                  const predicted = q.gpu_source === "predicted";
                  const SOURCE_LABEL = {
                    layout: "该卡来自本轮布局记录（HE 派题时选定）",
                    assignment: "该卡来自子任务 requirements 的绑定",
                    gate_pass: "该卡来自子任务自己的门禁记录",
                    gate_blocked: "该卡来自子任务自己的门禁记录（最近一次被阻塞）",
                    predicted: "布局预测：index % 4，尚未有门禁记录",
                  };
                  // A gate_ok row also carries reasons — they describe the
                  // candidates that failed, not this device — so the wording
                  // keys off the verdict, never off a non-empty reasons list.
                  const blockedRow = a.last_event === "gate_blocked";
                  const passing = (a.last_passing || []).map((c) => `GPU${c}`);
                  const busy = (a.last_candidates || [])
                    .filter((c) => !(a.last_passing || []).includes(c))
                    .map((c) => `GPU${c}`);
                  const gateLine = a.checks === 0 || a.checks == null
                    ? `准入闸门：暂无记录（VRAM≤90% 且 HCU==0）`
                    : blockedRow
                      ? `准入闸门：共 ${a.checks} 次检查，其中 ${a.blocked ?? 0} 次因设备被占用而等待 — 最近一次 ${a.last_event}@${a.last_site || "-"} GPU${a.last_gpu ?? "-"}：${(a.last_reasons || []).join("; ") || "-"}`
                      : `准入闸门：共 ${a.checks} 次检查，最近一次检查通过`
                        + (passing.length ? `（可用卡：${passing.join("、")}`
                            + (busy.length ? `；检查时 ${busy.join("、")} 被占用` : "") + `）` : "");
                  return html`
                    <details class="he-gpu-q">
                      <summary>
                        <span class="mono">${q.question}</span>
                        <small class="muted">
                          · ${DKAO_PHASE_LABEL[q.current_phase] || q.current_phase || "idle"}
                          · ${SOURCE_LABEL[q.gpu_source] || "该卡来源未知"}
                          · iter ${q.current_iteration ?? "-"}
                          · ${q.rounds || 0} rounds
                          · best ${q.best_median_us != null ? `${fmt(q.best_median_us)} us` : "-"}
                          ${q.finished ? ` · 已结束${q.final_status ? `（${q.final_status}）` : ""}` : ""}
                        </small>
                      </summary>
                      <div class="muted he-gpu-gate">
                        <div>${gateLine}</div>
                        <div>
                          ${a.probe_device != null && a.device != null && a.probe_device !== a.device
                            ? `探针曾在 GPU${a.probe_device} 上通过（与本题所在卡无关）；` : ""}
                          ${g.protocol === "legacy"
                            ? html`legacy 判据：baseline ${p.baseline_us != null ? `${fmt(p.baseline_us)} us` : "-"}
                                · tau ${p.tau_family != null ? fmt(p.tau_family) : "-"}
                                · target ≤ ${g.target_us != null ? `${fmt(g.target_us)} us` : "-"}`
                            : html`性能门对手（variant）：${g.variant_us != null ? `${fmt(g.variant_us)} us` : "-"}
                                <small>（${variantSourceLabel(g)}）</small>
                                ${g.judged
                                  ? html` · 本轮实测 ${fmt(g.judged.candidate_median_us)} us
                                          <${GateVerdictBadge} verdict=${g.judged.verdict} />`
                                  : null}`}
                          ${p.target_us != null
                            ? html`<small> · 池子口径 τ×baseline = ${fmt(p.target_us)} us（本协议不判门）</small>`
                            : null}
                          ${a.waited_seconds && (blockedRow || a.checks == null)
                            ? ` · 累计等待 ${Math.round(a.waited_seconds / 60)} min` : ""}
                        </div>
                      </div>
                      ${(a.blocked_reasons || []).length ? html`
                        <details class="he-gpu-sub">
                          <summary>阻塞历史（最近 ${(a.blocked_reasons || []).length} 次）</summary>
                          <table class="he-tbl">
                            <thead><tr><th>when</th><th>站点</th><th>GPU</th><th>第几次</th><th>原因</th></tr></thead>
                            <tbody>
                              ${(a.blocked_reasons || []).map((b) => html`<tr>
                                <td>${b.ts ? new Date(b.ts * 1000).toLocaleTimeString() : "-"}</td>
                                <td>${b.site || "-"}</td>
                                <td>${b.gpu ?? "-"}</td>
                                <td>${b.attempt ?? "-"}</td>
                                <td>${(b.reasons || []).join("; ") || "-"}</td>
                              </tr>`)}
                            </tbody>
                          </table>
                        </details>` : null}
                      ${req ? html`
                        <details class="he-gpu-sub">
                          <summary>子任务 requirements</summary>
                          <pre class="he-pre">${JSON.stringify(req, null, 2)}</pre>
                        </details>` : null}
                      ${q.child_state_dir ? html`
                        <details class="he-gpu-sub">
                          <summary>child_state_dir</summary>
                          <div class="mono">${q.child_state_dir}</div>
                        </details>` : null}
                    </details>`;
                })}
              </details>`)}
          </div>`}
    </details>`;
}

// --------------------------------------------------------------------------- //
// Round picker for the DKAO blocks
// --------------------------------------------------------------------------- //
// Each round is an independent DKAO launch, so which round you look at is a
// real switch. Default is "follow the newest round"; picking an older round
// pins it (and the 5s polling stops, because history does not move).
function RoundControls({ roundN, latestNum, roundNums, selIterN, setSelIterN,
                         ids, selChild, childrenMap, onSelectChild, onRefresh }) {
  return html`
    <div class="he-subrow">
      <label for="he-iter-select">轮次：</label>
      <select id="he-iter-select" class="he-select" value=${String(roundN)}
        onChange=${(e) => setSelIterN(Number(e.target.value) || null)}>
        ${roundNums.length
          ? roundNums.map((n) => html`
            <option value=${String(n)} selected=${n === roundN}>
              iteration ${n}${n === latestNum ? "（最新）" : ""}
            </option>`)
          : html`<option value=${String(latestNum)} selected=${true}>iteration ${latestNum}</option>`}
      </select>
      <button type="button" class="he-btn" disabled=${selIterN == null}
        onClick=${() => setSelIterN(null)}>跟随最新</button>
      ${ids && ids.length ? html`
        <label for="he-child-select">HE 发起的 DKAO 任务：</label>
        <select id="he-child-select" class="he-select" value=${selChild || ""}
          onChange=${(e) => onSelectChild(e.target.value)}>
          ${ids.map((id) => html`
            <option value=${id} selected=${selChild === id}>
              ${id} — ${DKAO_PHASE_LABEL[childrenMap[id] && childrenMap[id].current_phase] || (childrenMap[id] && childrenMap[id].current_phase) || "…"}
            </option>`)}
        </select>
        <button type="button" class="he-btn"
          onClick=${() => selChild && onRefresh(selChild)}>refresh</button>` : null}
    </div>
    ${selIterN == null ? null : html`<div class="badge warn">
      正在查看历史轮次 iteration ${roundN}（本块与上面的 Live questions 都停在这一轮，不再自动刷新）</div>`}
  `;
}

export default function HeDetailView({ taskId, run, status, data }) {
  const [summary, setSummary] = useState(null);
  const [iters, setIters] = useState([]);
  const [graph, setGraph] = useState(null);
  const [children, setChildren] = useState(null);
  const [selChild, setSelChild] = useState(null);
  const [dkao, setDkao] = useState(null);
  const [resumeMsg, setResumeMsg] = useState(null);
  const [sup, setSup] = useState(null);
  const [review, setReview] = useState(null);
  const [iterGpu, setIterGpu] = useState(null);
  const [targetIters, setTargetIters] = useState(null);
  const [baseIter, setBaseIter] = useState("");        // "" = auto (best_ever)
  const [promo, setPromo] = useState(null);
  const [promoBusy, setPromoBusy] = useState(false);
  //: Which round's DKAO children the drill-down shows. Rounds are independent
  //: DKAO launches, so this is a real switch, not a filter: picking round 5
  //: re-reads that round's children (each has its own state dir).
  //: ``null`` = follow the newest round until the operator picks one.
  const [selIterN, setSelIterN] = useState(null);

  const latestNum = useMemo(() => {
    if (!iters.length) return 0;
    const m = (iters[iters.length - 1].name || "").match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }, [iters]);

  // Every round the run has artifacts for, oldest first.
  const roundNums = useMemo(
    () => iters
      .map((it) => {
        const m = (it.name || "").match(/(\d+)$/);
        return m ? Number(m[1]) : 0;
      })
      .filter((n) => n > 0),
    [iters],
  );
  // The round actually on screen. Following means "the newest one", and the
  // selection is clamped to what exists so a stale choice cannot outlive its
  // round (Reset, or a fresh run).
  const roundN = useMemo(() => {
    if (!selIterN) return latestNum;
    if (!roundNums.length || roundNums.includes(selIterN)) return selIterN;
    return latestNum;
  }, [selIterN, latestNum, roundNums]);
  const following = roundN === latestNum;

  const refresh = useCallback(async () => {
    if (!taskId) return;
    const [s, its, g] = await Promise.all([
      withTimeout(getSummary(taskId)).catch((e) => { console.warn("he summary:", e); return null; }),
      withTimeout(getIterations(taskId)).catch((e) => { console.warn("he iterations:", e); return []; }),
      withTimeout(getStateGraph(taskId)).catch((e) => { console.warn("he graph:", e); return null; }),
    ]);
    setSummary(s || null);
    setIters(its || []);
    setGraph(g || null);
  }, [taskId]);

  const refreshPromotion = useCallback(async () => {
    if (!taskId) return;
    const p = await withTimeout(getPromotion(taskId))
      .catch((e) => { console.warn("he promotion:", e); return null; });
    if (p) setPromo(p);
  }, [taskId]);

  const approvePromo = useCallback(async () => {
    if (!taskId || promoBusy) return;
    setPromoBusy(true);
    try {
      const r = await approvePromotion(taskId, "webui");
      setResumeMsg(r && r.ok ? `已批准并接入：${r.result && r.result.version}`
                             : "批准被拒绝（见日志）");
    } catch (e) {
      setResumeMsg(`批准失败：${e.message}`);
    } finally {
      setPromoBusy(false);
      refreshPromotion();
      refresh();
    }
  }, [taskId, promoBusy, refreshPromotion, refresh]);

  const denyPromo = useCallback(async () => {
    if (!taskId || promoBusy) return;
    setPromoBusy(true);
    try {
      const r = await denyPromotion(taskId, "webui");
      setResumeMsg(r && r.ok ? "已拒绝该候选，可继续迭代" : "拒绝失败（见日志）");
    } catch (e) {
      setResumeMsg(`拒绝失败：${e.message}`);
    } finally {
      setPromoBusy(false);
      refreshPromotion();
    }
  }, [taskId, promoBusy, refreshPromotion]);

  const refreshChildren = useCallback(async () => {
    if (!taskId) return;
    if (roundN < 1) { setChildren(null); return; }
    const c = await withTimeout(getChildren(taskId, roundN))
      .catch((e) => { console.warn("he children:", e); return null; });
    if (c) setChildren(c);
  }, [taskId, roundN]);

  useEffect(() => { refresh(); }, [refresh]);
  pollWhileVisible(refresh, 6000);
  useEffect(() => { refreshChildren(); }, [refreshChildren]);
  pollWhileVisible(refreshPromotion, 10000);
  // Only the newest round is still moving, and only until its children are
  // done: a round the operator pinned (or a round whose questions have all
  // finished) is history and is fetched once, on selection. This also removes
  // the duplicate: the drill-down below keeps its own children view, and both
  // used to poll the same URL.
  const roundMoves = useMemo(() => {
    const kids = Object.values(children || {});
    return kids.length === 0 || kids.some((c) => !c.finished);
  }, [children]);
  pollWhileVisible(refreshChildren, 5000, {
    enabled: Boolean(taskId) && following && latestNum >= 1 && roundMoves,
  });

  const best = summary && summary.best_ever;
  const lastIter = iters.length ? iters[iters.length - 1] : null;
  // Benchmark results belong to the round on screen, exactly like its children
  // do: the two blocks below must never describe different rounds.
  const selIterObj = useMemo(
    () => iters.find((it) => {
      const m = (it.name || "").match(/(\d+)$/);
      return m && Number(m[1]) === roundN;
    }) || null,
    [iters, roundN],
  );
  const results = (selIterObj && selIterObj.benchmark
                   && selIterObj.benchmark.results) || {};
  // Show every live DKAO child even before its benchmark row exists: child
  // run.json phases appear as soon as evaluation spawns the subtasks, while
  // benchmark results only materialize after a child finishes.
  const childrenMap = children || {};
  const liveIds = [...new Set([...Object.keys(results), ...Object.keys(childrenMap)])];
  const liveKey = liveIds.join("|");
  const liveRows = liveIds.map((id) => ({
    id,
    r: results[id] || null,
    child: childrenMap[id] || null,
  }));

  const loadChild = useCallback(async (id) => {
    if (!id || roundN < 1) return;
    setSelChild(id);
    const p = await withTimeout(getDkaoChild(taskId, roundN, id))
      .catch((e) => { console.warn("he dkao child:", e); return null; });
    setDkao(p || null);
  }, [taskId, roundN]);

  // Default to a still-running child so the DKAO drill-down has content.
  useEffect(() => {
    if (!liveIds.length || (selChild && liveIds.includes(selChild))) return;
    const running = liveIds.find((id) => childrenMap[id] && !childrenMap[id].finished);
    loadChild(running || liveIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey, selChild]);
  // Same rule as the child list: poll only while the shown round is the newest
  // one and the question it shows can still move. ``loadChild`` also sets the
  // selection, so the interval refreshes the payload in place.
  pollWhileVisible(() => loadChild(selChild), 5000, {
    enabled: Boolean(taskId) && roundN >= 1 && following && Boolean(selChild)
      && Boolean(children && children[selChild] && !children[selChild].finished),
  });

  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const tick = async () => {
      const payload = await withTimeout(getSupervisor(taskId))
        .catch(() => null);
      if (!stop && payload) setSup(payload);
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => { stop = true; clearInterval(id); };
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const tick = async () => {
      const payload = await withTimeout(getReview(taskId)).catch(() => null);
      if (!stop && payload) setReview(payload);
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [taskId]);

  // Read-only device cards of the selected iteration (HE holds no lease).
  useEffect(() => {
    if (!taskId || latestNum < 1) { setIterGpu(null); return; }
    let stop = false;
    const tick = async () => {
      const payload = await withTimeout(getIterationGpu(taskId, latestNum))
        .catch(() => null);
      if (!stop && payload) setIterGpu(payload);
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { stop = true; clearInterval(id); };
  }, [taskId, latestNum]);

  const startAuto = async () => {
    if (!taskId) return;
    const want = Math.max(1, Math.min(50,
      Number(targetIters) || (iters.length + 1)));
    setResumeMsg("starting unattended mode…");
    try {
      const out = await startAutopilot(taskId, want,
        baseIter === "" ? null : Number(baseIter), true);
      setResumeMsg(`自动模式已启动（supervisor pid ${out.supervisor_pid}，目标 ${out.target} 轮）`);
      refresh();
    } catch (e) {
      setResumeMsg(`自动模式启动失败：${e.message}`);
    }
  };
  const stopAuto = async () => {
    if (!taskId) return;
    try {
      await stopSupervisor(taskId);
      setResumeMsg("已请求停止自动模式");
      const payload = await getSupervisor(taskId).catch(() => null);
      if (payload) setSup(payload);
    } catch (e) {
      setResumeMsg(`停止失败：${e.message}`);
    }
  };

  const applyTarget = async () => {
    if (!taskId) return;
    const want = Math.max(1, Math.min(50, Number(targetIters) || (iters.length + 1)));
    setResumeMsg("applying…");
    try {
      const out = await resumeExperiment(taskId, want, null,
                                        baseIter === "" ? null : Number(baseIter));
      if (out.running) {
        setResumeMsg(`目标已更新为 ${out.target} 轮（当前运行中，下一轮生效）`);
      } else {
        setResumeMsg(`已启动续跑（pid ${out.pid}），目标 ${out.target ?? want} 轮`);
      }
      refresh();
    } catch (e) {
      setResumeMsg(`操作失败：${e.message}`);
    }
  };
  const isFinished = Boolean(graph && graph.current === "finished");
  const [stopBusy, setStopBusy] = useState(false);
  // The orchestrator process is what "running" means here; a stopped run keeps
  // its artifacts and its phase, so the graph alone cannot tell them apart.
  // The shell's view comes from orchestrator.pid, which runs started before
  // that file existed never wrote -- so trust HE's own answer too, or Stop
  // would be hidden on a run that is very much alive.
  const isRunning = Boolean((status && status.running) || (summary && summary.running));

  const stopRun = async () => {
    if (!taskId || stopBusy) return;
    setStopBusy(true);
    setResumeMsg("正在停止…");
    try {
      const out = await stopExperiment(taskId);
      setResumeMsg(out.message + (out.stopped_children && out.stopped_children.length
        ? `（同时停掉 ${out.stopped_children.length} 个 DKAO 子任务）` : ""));
      refresh();
      refreshPromotion();
    } catch (e) {
      setResumeMsg(`停止失败：${e.message}`);
    } finally {
      setStopBusy(false);
    }
  };

  return html`
    <div class="he-detail">
      <${ProtocolBanner} protocol=${summary && summary.protocol} />
      <${PromotionPanel} promo=${promo} busy=${promoBusy}
        onApprove=${approvePromo} onDeny=${denyPromo} />
      ${(summary && summary.operator_stop && !isRunning) ? html`
        <div class="he-section" style="border-color:#b7791f;background:rgba(183,121,31,.08)">
          <h4>⏸ 已被 operator 停止 <small>（暂停，不是结束）</small></h4>
          <div class="sub">
            停在 iteration ${summary.operator_stop.iteration ?? "-"}（phase ${summary.operator_stop.phase || "-"}）·
            <strong>不会被 janitor / supervisor 自动拉起</strong>；本轮没判完，所以这一轮的成绩不计入 variant。
            继续跑：点左边的「续跑到该轮次上限」（会先清掉停止标记，该轮重跑、抽到的是同一批题）。
            操作说明见 <code>FLOW.md §9</code>。
          </div>
        </div>` : null}
      <${StateMachine} graph=${graph} />
      <div class="he-subrow">
        <label for="he-target-iters" title="与新建任务表单里的 Rounds 是同一个值：1 轮 = 1 次迭代（第 1 轮为基线轮）。改大即允许任务继续跑；不会改动已经跑完的轮次。">轮次上限 Rounds</label>
        <input id="he-target-iters" class="he-select" type="number" min="1" max="50"
          style="max-width:90px" value=${targetIters ?? (iters.length + 1)}
          onChange=${(e) => setTargetIters(e.target.value)} />
        <button type="button" class="he-btn" onClick=${applyTarget}>
          ${isRunning ? "更新上限（下一轮生效）" : "续跑到该轮次上限"}
        </button>
        ${isRunning ? html`
          <button type="button" class="he-btn he-btn-stop" disabled=${stopBusy}
            onClick=${stopRun}
            title="暂停本轮：停 supervisor + 正在跑的 DKAO 子任务 + HE 编排器，写 operator-stop 标记（之后不会被 janitor/supervisor 自动拉起）；产物全部保留，用左边的「续跑到该轮次上限」接着跑。注意：直接 kill 进程或 shell 的 Kill 按钮都不等于暂停。">
            ${stopBusy ? "正在停止…" : "停止任务（暂停）"}
          </button>
          <span class="sub"
            title="详见 FLOW.md §9「停止与续跑」">停止=暂停：产物保留、不会被自动重启；之后点左边的「续跑到该轮次上限」继续</span>` : null}
        <label for="he-base-iter">比较基线</label>
        <select id="he-base-iter" class="he-select" style="max-width:220px"
          value=${baseIter} onChange=${(e) => setBaseIter(e.target.value)}>
          <option value="" selected=${baseIter === ""}>auto（当前冠军）</option>
          ${iters.map((it) => {
            const m = (it.name || "").match(/(\d+)$/);
            const num = m ? Number(m[1]) : null;
            return num ? html`<option value=${String(num)} selected=${baseIter === String(num)}>
              iteration ${num}（第 ${num} 轮结果）
            </option>` : null;
          })}
        </select>
        <span class="sub">已完成 ${iters.length} 轮${graph && graph.current === "finished" ? "（已停止）" : "（运行中）"} · 运行中可随时改，下一轮生效</span>
        ${resumeMsg ? html`<span class="sub">${resumeMsg}</span>` : null}
        ${isFinished
          ? html`<span class="sub">复用已评测的冠军，只评测新一版 harness（不重跑历史迭代）</span>`
          : null}
      </div>
      <div class="he-subrow">
        <button type="button" class="he-btn" onClick=${startAuto}>启动自动模式（跑到目标 · 事故自愈）</button>
        <button type="button" class="he-btn" disabled=${!(sup && sup.running)} onClick=${stopAuto}>停止自动模式</button>
        <span class="sub">
          自动模式：${sup && sup.running ? `运行中（pid ${sup.pid}）` : ((sup && sup.state && sup.state.status) || "未启动")}
          ${sup && sup.incidents && sup.incidents.length ? ` · 事故 ${sup.incidents.length}` : ""}
          ${sup && sup.has_report ? " · 诊断报告已生成" : ""}
        </span>
      </div>
      <${FourCardOverview} data=${iterGpu} selected=${selChild}
        onSelect=${(id) => setSelChild(id)} />
      <${GpuCardsPanel} data=${iterGpu} num=${latestNum} />
      ${review && review.review ? html`
        <div class="he-section">
          <h4>跨轮复核 <small>（每代 harness 成绩 · 冠军代 · best-known）</small></h4>
          <div class="he-subrow">
            <span class="badge ok">冠军代 iteration ${review.review.champion_iteration}</span>
            <span class="sub">variant 策略：${review.review.variant_policy}
              ${(review.review.final_promotion || {}).promoted
                ? ` · 收尾晋升：${(review.review.final_promotion.promoted || []).join(", ")}` : ""}
              ${review.regressions && review.regressions.length
                ? ` · ⚠ 退步 ${review.regressions.length} 次` : ""}
            </span>
          </div>
          <table class="he-tbl">
            <thead><tr><th>gen</th><th>verdict</th><th>pass</th><th>medians (us)</th></tr></thead>
            <tbody>
              ${(review.review.generations || []).map((g) => html`
                <tr>
                  <td>${g.iteration}${g.champion ? " ⭐" : ""}${g.rejected ? " ✗" : ""}</td>
                  <td>${g.verdict || "-"}</td>
                  <td>${g.pass_count}</td>
                  <td class="mono">${Object.entries(g.medians || {}).map(([k, v]) =>
                    `${k.split("_").slice(-3).join("_")}=${v == null ? "-" : Number(v).toFixed(1)}`).join("  ")}</td>
                </tr>`)}
            </tbody>
          </table>
          ${review.regressions && review.regressions.length ? html`
            <details>
              <summary>退步记录（kernel 低于历史最优）</summary>
              <table class="he-tbl">
                <thead><tr><th>iteration</th><th>shape</th><th>median</th><th>best</th><th>delta</th></tr></thead>
                <tbody>
                  ${review.regressions.slice(-8).reverse().map((r) => html`
                    <tr><td>${r.iteration}</td><td class="mono">${r.shape}</td>
                    <td>${r.median_us}</td><td>${r.best_median_us} (gen ${r.best_iteration})</td>
                    <td>+${r.delta_percent}%</td></tr>`)}
                </tbody>
              </table>
            </details>` : null}
        </div>` : null}
      ${sup && sup.incidents && sup.incidents.length ? html`
        <div class="he-section">
          <h4>Incidents <small>（supervisor 自动处置记录）</small></h4>
          <table class="he-tbl">
            <thead><tr><th>when</th><th>category</th><th>action</th><th>detail</th></tr></thead>
            <tbody>
              ${sup.incidents.slice(-8).reverse().map((i) => html`
                <tr>
                  <td>${new Date((i.ts || 0) * 1000).toLocaleTimeString()}</td>
                  <td>${i.category || "-"}</td>
                  <td>${i.action || "-"}</td>
                  <td>${i.reason || (i.evidence || []).join("; ") || ""}
                    ${i.seconds ? html`<small class="sub">wait ${Math.round(i.seconds / 60)}m</small>` : null}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>` : null}
      <div class="he-cards">
        <div class="he-card"><h4>Best ever</h4>
          <div class="big">${best ? `${(100 * best.pass_rate).toFixed(1)}%` : "-"}</div>
          ${best ? html`<div class="sub">iteration ${best.iteration}</div>` : null}
        </div>
        <div class="he-card"><h4>Iterations</h4>
          <div class="big">${iters.length}</div></div>
        <div class="he-card"><h4>Mode</h4>
          <div>${(summary && summary.config_snapshot && summary.config_snapshot.execution_mode) || "-"}</div>
        </div>
      </div>
      ${liveRows.length ? html`
        <div class="he-section">
          <h4>Live questions — iteration ${roundN}
            <small>（每行 = 一个真实 DKAO 子任务）</small></h4>
          <${RoundGateLine} iter=${selIterObj} />
          <table class="he-tbl">
            <thead><tr>
              <th>question</th>
              <th>DKAO child phase</th>
              <th title="DKAO 子任务自己的验收（status=success 且数值正确）。这不是性能门——性能门是下一列与 variant 的对比。">子任务验收</th>
              <th>median(best) us</th>
              <th title="本轮真正判门的对手：该算子当前的 variant。赢 = 严格快 2% 以上（平局不算赢）；任一题低于 variant 的 80% 整轮不过。">必须打败（variant）</th>
              <th>rounds</th>
            </tr></thead>
            <tbody>
              ${liveRows.map(({ id, r, child }) => html`
                <tr>
                  <td class="mono">${id}</td>
                  <td><${DkaoPhaseChip} child=${child} /></td>
                  <td>
                    ${!r ? html`<span class="badge run">running</span>`
                      : r.passed ? html`<span class="badge ok">pass</span>`
                      : r.status === "exception" || r.status === "missing_report" || r.status === "partial_worker_result"
                        ? html`<span class="badge bad">${r.status}</span>`
                        : html`<span class="badge warn">${r.status || "pending"}</span>`}
                  </td>
                  <td>${(r && r.median_us != null) ? r.median_us
                        : (child && child.best_median_us != null) ? `≈${child.best_median_us}` : "-"}</td>
                  <td><${QuestionGateCell}
                        gate=${child && child.gate}
                        poolRef=${child && child.pool_reference} /></td>
                  <td>${(r && r.rounds_used != null) ? r.rounds_used : (child ? (child.rounds || 0) : 0)}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        <div class="he-section">
          <h4>DKAO task drill-down
            <small>（选轮次后看那一轮的 DKAO 子任务；只读）</small></h4>
          <${RoundControls}
            roundN=${roundN} latestNum=${latestNum} roundNums=${roundNums}
            selIterN=${selIterN} setSelIterN=${setSelIterN}
            ids=${liveIds} selChild=${selChild} childrenMap=${childrenMap}
            onSelectChild=${loadChild} onRefresh=${loadChild} />
          <${ChildDkaoView} payload=${dkao} />
        </div>` : html`
        <div class="he-section">
          <h4>DKAO task drill-down
            <small>（选轮次后看那一轮的 DKAO 子任务；只读）</small></h4>
          <${RoundControls}
            roundN=${roundN} latestNum=${latestNum} roundNums=${roundNums}
            selIterN=${selIterN} setSelIterN=${setSelIterN}
            ids=${null} selChild=${null} childrenMap=${{}}
            onSelectChild=${loadChild} onRefresh=${loadChild} />
          <p class="muted">这一轮没有派发 DKAO 子任务（或产物已被清理）。</p>
        </div>`}
      <div class="he-section">
        <h4>Pass rate per iteration</h4>
        ${summary && html`<${ScoreTable} scores=${summary.scores} />`}
      </div>
      <div class="he-section">
        <h4>Iterations</h4>
        ${iters.length ? iters.map((it) => html`<${IterBlock} iter=${it} taskId=${taskId} />`)
                        : html`<p class="muted">no iterations yet (task not started / dry artifacts absent)</p>`}
        ${summary && summary.report ? html`<details><summary>report.md</summary>
          <pre class="he-pre">${summary.report}</pre></details>` : null}
      </div>
    </div>`;
}
