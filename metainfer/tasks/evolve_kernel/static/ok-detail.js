// evolve-kernel task detail body.
//
// Renders the 8-phase kernel optimization flow:
//   Bootstrap: A(BGen Correctness Harness)→B(Review)→C(Gen Perf Harness)→D(Review)
//   Loop:      E(Select)→F(Optimize)→G(Verify)→H(Measure)⟲
//
// Composed of: state graph, kernel library, harness status, iteration metrics.

import { html } from "htm/preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { StateGraph } from "app/ok-state-graph";
import { KernelLibrary } from "app/ok-kernel-library";
import { AgentsPanel } from "app/agents-panel";
import { Timeline } from "app/timeline";
import {
  getIterations, getCharts, getStateGraph,
  getKernelLibrary, getCorrectnessHarness, getPerfHarness,
  getReferenceKernel, getKernelDiff,
} from "app/ok-runtime-api";

const withTimeout = (p, ms = 8000) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);

function useRuntimeData(taskId) {
  const [data, setData] = useState({
    iterations: [], charts: null, graph: null,
    library: null, correctnessHarness: null, perfHarness: null,
    refKernel: null,
  });
  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const [it, ch, g, lib, chs, phs, ref] = await Promise.all([
        withTimeout(getIterations(taskId)).catch(() => []),
        withTimeout(getCharts(taskId)).catch(() => null),
        withTimeout(getStateGraph(taskId)).catch(() => null),
        withTimeout(getKernelLibrary(taskId)).catch(() => null),
        withTimeout(getCorrectnessHarness(taskId)).catch(() => null),
        withTimeout(getPerfHarness(taskId)).catch(() => null),
        withTimeout(getReferenceKernel(taskId)).catch(() => null),
      ]);
      setData({
        iterations: it || [], charts: ch, graph: g,
        library: lib, correctnessHarness: chs, perfHarness: phs,
        refKernel: ref,
      });
    } catch (e) {
      console.warn("evolve-kernel runtime fetch error:", e);
    }
  }, [taskId]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!taskId) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [taskId, refresh]);
  return { ...data, refresh };
}

// ---- Helper: flow indicator showing the active phase ----

function FlowIndicator({ graph }) {
  if (!graph) return null;
  const cur = graph.current;
  if (cur === "idle" || cur === "finished") {
    return html`<div class="ok-flow-indicator">
      <span class="muted">Status:</span>
      <span class="ok-phase-label">${cur === "finished" ? "Finished" : "Idle (waiting)"}</span>
    </div>`;
  }

  const phases = [
    "A_gen_correctness_harness", "B_review_correctness_harness",
    "C_gen_perf_harness", "D_review_perf_harness",
    "E_select_kernel", "F_optimize", "G_verify_correctness", "H_measure_perf",
  ];
  const labels = {
    "A_gen_correctness_harness": "A: Gen Correctness Harness",
    "B_review_correctness_harness": "B: Review Correctness Harness",
    "C_gen_perf_harness": "C: Gen Perf Harness",
    "D_review_perf_harness": "D: Review Perf Harness",
    "E_select_kernel": "E: Select Kernel",
    "F_optimize": "F: Optimize",
    "G_verify_correctness": "G: Verify Correctness",
    "H_measure_perf": "H: Measure Perf",
  };
  const curIdx = phases.indexOf(cur);

  return html`<div class="ok-flow-indicator">
    <span class="muted">Active:</span>
    ${phases.map((p, i) => html`
      <span key=${p} class=${"ok-phase-label" + (p === cur ? " active" : "")}
        style=${{ opacity: i > curIdx ? 0.3 : 1.0 }}>
        ${labels[p]}
      </span>
      ${i < phases.length - 1 ? html`<span class="ok-phase-divider" key=${'d' + i}>→</span>` : null}
    `)}
  </div>`;
}

// ---- Metric cards ----

function MetricCards({ library, iterations }) {
  const last = iterations && iterations.length > 0 ? iterations[iterations.length - 1] : null;
  const perf = last && last.perf ? last.perf : {};
  const bestKernel = library && library.kernels && library.kernels.length > 0 ? library.kernels[0] : null;

  return html`<div class="ok-meta-grid">
    <div class="ok-meta-card">
      <div class="ok-meta-value">${library ? library.size : 0}</div>
      <div class="ok-meta-label">Kernels in Library</div>
    </div>
    <div class="ok-meta-card">
      <div class="ok-meta-value">${bestKernel && bestKernel.exec_time_ms ? bestKernel.exec_time_ms.toFixed(3) + " ms" : "—"}</div>
      <div class="ok-meta-label">Best Exec Time</div>
    </div>
    <div class="ok-meta-card">
      <div class="ok-meta-value">${perf.speedup ? perf.speedup.toFixed(2) + "×" : "—"}</div>
      <div class="ok-meta-label">Last Speedup</div>
    </div>
    <div class="ok-meta-card">
      <div class="ok-meta-value">${iterations ? iterations.length : 0}</div>
      <div class="ok-meta-label">Optimization Iterations</div>
    </div>
  </div>`;
}

// ---- Harness status badges ----

function HarnessStatus({ harness, label }) {
  if (!harness) {
    return html`<span class="ok-harness-status pending">${label}: pending</span>`;
  }
  if (harness.exists) {
    return html`<span class="ok-harness-status pass">${label}: ready (${harness.lines} lines)</span>`;
  }
  return html`<span class="ok-harness-status fail">${label}: not generated</span>`;
}

// ---- Kernel source / diff inspector ----

// Line-numbered source rendering: the raw string in a <pre> gives no way to
// cite a line, so emit one <div> per line with a gutter number.
function SourceLines({ code }) {
  const lines = (code || "").split("\n");
  return html`<div class="ok-source">
    ${lines.map((ln, i) => html`
      <div class="ok-source-row" key=${i}>
        <span class="ok-source-num">${i + 1}</span>
        <span class="ok-source-line">${ln}</span>
      </div>
    `)}
  </div>`;
}

// Unified-diff rendering: classify each line by prefix so additions and
// deletions stand out; hunk headers (@@) get their own muted styling.
function DiffLines({ diff }) {
  const lines = (diff || "").split("\n");
  if (!lines.some((l) => l.length > 0)) {
    return html`<div class="ok-diff empty muted">No differences.</div>`;
  }
  return html`<div class="ok-diff">
    ${lines.map((ln, i) => {
      let cls = "ok-diff-ctx";
      if (ln.startsWith("+++") || ln.startsWith("---")) cls = "ok-diff-meta";
      else if (ln.startsWith("@@")) cls = "ok-diff-hunk";
      else if (ln.startsWith("+")) cls = "ok-diff-add";
      else if (ln.startsWith("-")) cls = "ok-diff-del";
      return html`<div class=${"ok-diff-row " + cls} key=${i}>${ln || " "}</div>`;
    })}
  </div>`;
}

const DIFF_MODES = [
  { key: "source", label: "Source" },
  { key: "reference", label: "Diff vs reference" },
  { key: "parent", label: "Diff vs parent" },
];

function KernelInspector({ taskId, kernel, onClose }) {
  const [mode, setMode] = useState("source");
  const [diff, setDiff] = useState(null);
  const [diffErr, setDiffErr] = useState(null);

  useEffect(() => {
    if (mode === "source" || !taskId || !kernel) return;
    let cancelled = false;
    setDiff(null);
    setDiffErr(null);
    withTimeout(getKernelDiff(taskId, kernel.id, mode))
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch((e) => { if (!cancelled) setDiffErr(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [taskId, kernel && kernel.id, mode]);

  const code = kernel.code || kernel.code_preview || "";
  const parentId = kernel.parent_id ? String(kernel.parent_id).slice(0, 8) : null;

  return html`<section class="panel ok-panel-full">
    <h2>Kernel: ${String(kernel.id).slice(0, 8)}…
      <button class="btn btn-sm" style="float:right;" onClick=${onClose}>× close</button>
    </h2>
    <div class="ok-inspector-toolbar">
      <div class="ok-inspector-modes">
        ${DIFF_MODES.map((m) => html`
          <button key=${m.key}
            class=${"btn btn-sm" + (mode === m.key ? " active" : "")}
            disabled=${m.key === "parent" && !parentId}
            title=${m.key === "parent" && !parentId ? "kernel has no parent" : ""}
            onClick=${() => setMode(m.key)}>${m.label}</button>
        `)}
      </div>
      ${mode !== "source" && diff && diff.exists ? html`
        <span class="ok-diff-stat">
          <span class="ok-diff-stat-add">+${diff.added}</span>
          <span class="ok-diff-stat-del">−${diff.removed}</span>
          <span class="muted">vs ${diff.base_label}</span>
        </span>
      ` : null}
    </div>

    ${mode === "source"
      ? html`<${SourceLines} code=${code} />`
      : diffErr
        ? html`<div class="ok-diff empty error">Failed to load diff: ${diffErr}</div>`
        : !diff
          ? html`<div class="ok-diff empty muted">Loading diff…</div>`
          : !diff.exists
            ? html`<div class="ok-diff empty muted">${diff.error || "No diff available."}</div>`
            : html`<${DiffLines} diff=${diff.diff} />`}
  </section>`;
}

// ---- Main view ----

export default function OptKernelDetailView({
  taskId,
  run,
  status,
  data,
}) {
  const [selectedKernel, setSelectedKernel] = useState(null);
  const [showHarness, setShowHarness] = useState(null); // "correctness" | "perf" | null
  const { timeline, agents, loadState, lastErr } = data;
  const rt = useRuntimeData(taskId);

  if (loadState === "error" && lastErr) {
    return html`
      <div class="task-banner task-banner-err">
        <strong>Refresh failed:</strong> ${lastErr}
        <span class="muted">(auto-retry)</span>
      </div>
    `;
  }

  return html`
    <${FlowIndicator} graph=${rt.graph} />

    <${MetricCards} library=${rt.library} iterations=${rt.iterations} />

    <div class="ok-grid">
      <section class="panel">
        <h2>State Machine</h2>
        <${StateGraph} graph=${rt.graph} />
      </section>

      <section class="panel">
        <h2>Kernel Library
          <span class="muted" style="font-size:0.75rem;margin-left:0.5rem;">(click for code)</span>
        </h2>
        <${KernelLibrary}
          library=${rt.library}
          selectedKernelId=${selectedKernel && selectedKernel.id}
          onSelectKernel=${(k) => setSelectedKernel(k)} />
      </section>
    </div>

    ${selectedKernel ? html`
      <${KernelInspector}
        taskId=${taskId}
        kernel=${selectedKernel}
        onClose=${() => setSelectedKernel(null)} />
    ` : null}

    <div class="ok-grid">
      <section class="panel">
        <h2>Harnesses</h2>
        <div style="display:flex;gap:0.75rem;margin-bottom:0.75rem;">
          <${HarnessStatus} harness=${rt.correctnessHarness} label="Correctness" />
          <${HarnessStatus} harness=${rt.perfHarness} label="Performance" />
        </div>
        <div style="display:flex;gap:0.5rem;">
          <button class="btn btn-sm" onClick=${() => setShowHarness(showHarness === "correctness" ? null : "correctness")}
            disabled=${!rt.correctnessHarness || !rt.correctnessHarness.exists}>
            ${showHarness === "correctness" ? "Hide" : "Show"} Correctness Harness
          </button>
          <button class="btn btn-sm" onClick=${() => setShowHarness(showHarness === "perf" ? null : "perf")}
            disabled=${!rt.perfHarness || !rt.perfHarness.exists}>
            ${showHarness === "perf" ? "Hide" : "Show"} Perf Harness
          </button>
        </div>

        ${showHarness === "correctness" && rt.correctnessHarness && rt.correctnessHarness.exists ? html`
          <div class="ok-code-preview" style="margin-top:0.75rem;">${rt.correctnessHarness.code}</div>
        ` : null}
        ${showHarness === "perf" && rt.perfHarness && rt.perfHarness.exists ? html`
          <div class="ok-code-preview" style="margin-top:0.75rem;">${rt.perfHarness.code}</div>
        ` : null}
      </section>

      <section class="panel">
        <h2>Live Sub-agents</h2>
        <${AgentsPanel} agents=${agents} />
      </section>
    </div>

    <section class="panel timeline-panel ok-panel-full">
      <h2>Event Timeline</h2>
      <${Timeline} events=${timeline.events} />
    </section>
  `;
}
