// AHE (Agentic Harness Engineering) panel for opt-kernel.
//
// 展示 opt-kernel 在 ABCDEF 主循环之上跑的两个 advisory 闭环
// （见 docs/opt_kernel_ahe.md）：
//
//   * 可证伪预测 (P2)：每轮迭代 planner 声明结构化预测
//     （改动 / 目标指标 / 预期变化）；E 性能步骤后 orchestrator
//     对每个预测给出 已证实 / 已证伪 / 存疑 判定。本面板把
//     "预测 vs 实测"并列对照。
//   * 调试器 (P1)：调试器 agent 把每轮轨迹折叠成
//     analysis/detail/iter_NNN.md，并跨轮重写 analysis/overview.md。
//     本面板渲染跨轮总览，并允许展开各轮 detail。
//
// 数据全部只读（GET /ahe、GET /ahe/detail/{n}）；性能数字与
// 正式回退判定的权威源仍是 perf_report.json（SSOT）。

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { marked } from "marked";
import { getAhe, getAheDetail } from "app/ok-runtime-api";

const VERDICT_CLASS = {
  confirmed: "ahe-confirmed",
  falsified: "ahe-falsified",
  inconclusive: "ahe-inconclusive",
};
const VERDICT_LABEL = {
  confirmed: "已证实",
  falsified: "已证伪",
  inconclusive: "存疑",
};
const DIR_ARROW = { decrease: "↓", increase: "↑" };

function fmtPct(v) {
  if (v == null || v === "" || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtMetric(perf, key) {
  if (!perf || perf[key] == null) return "—";
  const v = perf[key];
  if (typeof v === "number") {
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + "G";
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(2) + "k";
    return v.toFixed(2);
  }
  return String(v);
}

function VerdictPill({ verdict }) {
  const cls = VERDICT_CLASS[verdict] || "ahe-inconclusive";
  const label = VERDICT_LABEL[verdict] || verdict || "—";
  return html`<span class="ahe-pill ${cls}">${label}</span>`;
}

function PredictionRow({ v, hasEval }) {
  const dir = DIR_ARROW[v.direction] || "";
  return html`
    <tr class="ahe-pred-row">
      <td class="ahe-id">${v.id || "—"}</td>
      <td class="ahe-metric">${v.target_metric || "—"} <span class="muted">${dir}</span></td>
      <td class="ahe-num">${fmtPct(v.expected_delta_pct)}</td>
      <td class="ahe-num">${hasEval ? fmtPct(v.actual_delta_pct) : html`<span class="muted">待评测</span>`}</td>
      <td class="ahe-verdict">${hasEval ? html`<${VerdictPill} verdict=${v.verdict} />` : html`<span class="muted">—</span>`}</td>
    </tr>
  `;
}

function IterationCard({ taskId, entry }) {
  const [showDetail, setShowDetail] = useState(false);
  const [detail, setDetail] = useState(null);
  const hasEval = entry.has_evaluation;
  const verdicts = entry.verdicts || [];
  const regressed = entry.regression && entry.regression.regressed;

  const loadDetail = () => {
    if (detail != null) return;
    getAheDetail(taskId, entry.iteration)
      .then((d) => setDetail(d))
      .catch(() => setDetail({ has_detail: false, markdown: "" }));
  };

  return html`
    <div class="ahe-card ${regressed ? "ahe-regressed" : ""}">
      <div class="ahe-card-head">
        <h3>第 ${entry.iteration} 轮</h3>
        ${regressed
          ? html`<span class="ahe-pill ahe-falsified">性能回退</span>`
          : null}
        ${entry.verdict_text
          ? html`<span class="ahe-verdict-text muted">${entry.verdict_text}</span>`
          : null}
      </div>

      ${entry.summary
        ? html`<p class="ahe-summary">${entry.summary}</p>`
        : null}

      ${entry.actual_perf || entry.baseline_perf
        ? html`<div class="ahe-perf-row">
            <span class="muted">基线:</span>
            <code>${fmtMetric(entry.baseline_perf, "ms_per_op")} ms</code>
            ${hasEval
              ? html`<span class="muted">→ 实测:</span>
                  <code>${fmtMetric(entry.actual_perf, "ms_per_op")} ms</code>`
              : html`<span class="muted">（等待 E 性能步骤）</span>`}
          </div>`
        : null}

      ${verdicts.length
        ? html`<table class="ahe-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>指标</th>
                <th>预测 Δ</th>
                <th>实测 Δ</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              ${verdicts.map((v) => html`<${PredictionRow} v=${v} hasEval=${hasEval} />`)}
            </tbody>
          </table>`
        : html`<p class="muted">本轮无结构化预测</p>`}

      ${verdicts.map((v) => html`
        <details class="ahe-change">
          <summary><code>${v.id || "?"}</code> 预测改动</summary>
          <div class="ahe-change-body">${v.change || v.reason || "—"}</div>
        </details>
      `)}

      <div class="ahe-detail-toggle">
        <button class="btn ghost ahe-detail-btn"
          onClick=${() => { setShowDetail(!showDetail); if (!showDetail) loadDetail(); }}>
          ${showDetail ? "收起" : "查看"}调试器分析
        </button>
      </div>
      ${showDetail
        ? (detail == null
            ? html`<p class="muted">加载中…</p>`
            : (detail.has_detail
                ? html`<div class="ahe-detail-md"
                    dangerouslySetInnerHTML=${{ __html: marked.parse(detail.markdown) }}></div>`
                : html`<p class="muted">第 ${entry.iteration} 轮暂无调试器分析</p>`))
        : null}
    </div>
  `;
}

export function AhePanel({ taskId, run }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    const fetchOnce = () => getAhe(taskId)
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e); });
    fetchOnce();
    const id = setInterval(fetchOnce, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [taskId]);

  if (err) {
    return html`
      <div class="panel">
        <h2>AHE — 可证伪预测与调试器</h2>
        <p style="color:var(--err)">加载失败：${String(err.message || err)}</p>
      </div>
    `;
  }
  if (!data) {
    return html`
      <div class="panel">
        <h2>AHE — 可证伪预测与调试器</h2>
        <p class="muted">加载中…</p>
      </div>
    `;
  }
  if (!data.available) {
    return html`
      <div class="panel ahe-panel">
        <h2>AHE — 可证伪预测与调试器</h2>
        <p class="muted">
          暂无 AHE 产物。planner 每轮写 <code>predictions.json</code>，调试器在每轮收尾后写
          <code>analysis/overview.md</code>——随着运行推进会在此显示。
        </p>
      </div>
    `;
  }

  const iters = [...(data.iterations || [])].sort((a, b) => b.iteration - a.iteration);

  return html`
    <div class="panel ahe-panel">
      <h2>AHE — 可证伪预测与调试器</h2>
      <p class="ahe-legend muted">
        每轮迭代 planner 声明可证伪预测；E 性能步骤后判定为
        <span class="ahe-pill ahe-confirmed">已证实</span>
        <span class="ahe-pill ahe-falsified">已证伪</span>
        <span class="ahe-pill ahe-inconclusive">存疑</span>。
        调试器把每轮轨迹折叠成下方跨轮总览。
      </p>

      ${data.overview_md
        ? html`<details class="ahe-overview" open>
            <summary><strong>跨轮调试器总览</strong></summary>
            <div class="ahe-overview-md"
              dangerouslySetInnerHTML=${{ __html: marked.parse(data.overview_md) }}></div>
          </details>`
        : html`<p class="muted">暂无调试器总览。</p>`}

      ${iters.length
        ? html`<div class="ahe-cards">
            ${iters.map((e) => html`<${IterationCard} taskId=${taskId} entry=${e} />`)}
          </div>`
        : null}
    </div>
  `;
}
