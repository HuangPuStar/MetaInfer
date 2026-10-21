// Profile panel for opt-kernel.
//
// Shows the perf oracle's structured output: headline metrics, per-shape
// results table, kernel stats (from rocprof --stats), hardware counters,
// and artifact download links.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getProfile } from "app/ok-runtime-api";

function MetricTile({ label, value, unit, cls }) {
  return html`
    <div class="metric-tile">
      <div class="metric-label">${label}</div>
      <div class="metric-value ${cls || ""}">${value}${unit ? html`<span style="font-size:11px;color:#8b949e;margin-left:2px">${unit}</span>` : null}</div>
    </div>
  `;
}

function ShapeResultsTable({ results }) {
  if (!results || results.length === 0) return null;
  const rows = results.map((r, i) => {
    const shape = r.shape || {};
    const shapeStr = Object.entries(shape)
      .filter(([k]) => k !== "path")
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const path = shape.path || "";
    const speedup = r.speedup || 0;
    const speedupCls = speedup >= 1 ? "fast" : speedup > 0 ? "slow" : "";
    return html`
      <tr key=${i}>
        <td>${shapeStr}${path ? html`<br/><span class="muted" style="font-size:11px">${path}</span>` : null}</td>
        <td>${r.correct === false ? html`<span style="color:#f85149">✗</span>` : html`<span style="color:#3fb950">✓</span>`}</td>
        <td>${(r.kernel_us || 0).toFixed(2)}</td>
        <td>${(r.baseline_us || 0).toFixed(2)}</td>
        <td class="speedup-cell ${speedupCls}">${speedup > 0 ? `${speedup.toFixed(2)}×` : "—"}</td>
        <td>${(r.gflops || 0).toFixed(1)}</td>
        <td>${(r.bandwidth_gb_s || 0).toFixed(1)}</td>
      </tr>
    `;
  });
  return html`
    <table class="shape-results-table">
      <thead>
        <tr>
          <th>Shape</th>
          <th>✓</th>
          <th>Kernel (µs)</th>
          <th>Baseline (µs)</th>
          <th>Speedup</th>
          <th>GFLOPS</th>
          <th>BW (GB/s)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function KernelStatsTable({ kernels }) {
  if (!kernels || kernels.length === 0) return null;
  const rows = kernels.slice(0, 20).map((k, i) => html`
    <tr key=${i}>
      <td>${k.kernel || k.Name || "—"}</td>
      <td>${k.calls || k.Calls || "—"}</td>
      <td>${k.total_ns ? (k.total_ns / 1000).toFixed(2) : "—"}</td>
      <td>${k.avg_ns ? (k.avg_ns / 1000).toFixed(3) : "—"}</td>
      <td>${k.percentage ? `${k.percentage.toFixed(1)}%` : "—"}</td>
    </tr>
  `);
  return html`
    <table class="kernel-stats-table">
      <thead>
        <tr>
          <th>Kernel</th>
          <th>Calls</th>
          <th>Total (µs)</th>
          <th>Avg (µs)</th>
          <th>%</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function CountersGrid({ counters }) {
  if (!counters || Object.keys(counters).length === 0) return null;
  const entries = Object.entries(counters).slice(0, 12);
  return html`
    <div class="profile-metrics">
      ${entries.map(([k, v]) => html`
        <div class="metric-tile" key=${k}>
          <div class="metric-label">${k}</div>
          <div class="metric-value">${typeof v === "number" ? v.toFixed(2) : String(v)}</div>
        </div>
      `)}
    </div>
  `;
}

function ArtifactsList({ artifacts }) {
  if (!artifacts || artifacts.length === 0) return null;
  return html`
    <div class="profile-artifacts">
      ${artifacts.map((a, i) => {
        const kind = a.kind || "unknown";
        const collected = a.collected !== false;
        const path = a.path || "";
        return html`
          <span key=${i} class="artifact-badge ${collected ? "collected" : "missing"}"
            title=${path || a.error || ""}>
            ${kind}${collected ? "" : " (missing)"}
          </span>
        `;
      })}
    </div>
  `;
}

export function ProfilePanel({ taskId, iteration }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (taskId == null || iteration == null) return;
    let alive = true;
    setData(null);
    setErr(null);
    getProfile(taskId, iteration)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [taskId, iteration]);

  if (iteration == null) {
    return html`
      <div class="panel">
        <h2>Profile</h2>
        <p class="muted">Select an iteration to see perf profile data.</p>
      </div>
    `;
  }

  if (err) {
    return html`
      <div class="panel">
        <h2>Profile — iteration ${iteration}</h2>
        <p style="color:var(--err)">failed to load profile: ${String(err)}</p>
      </div>
    `;
  }

  if (!data) {
    return html`
      <div class="panel">
        <h2>Profile — iteration ${iteration}</h2>
        <p class="muted">loading…</p>
      </div>
    `;
  }

  if (!data.has_profile) {
    return html`
      <div class="panel">
        <h2>Profile — iteration ${iteration}</h2>
        <p class="muted">No profile data yet. The E-phase perf oracle runs
          rocprof and writes perf_report.json after the kernel passes
          correctness.</p>
      </div>
    `;
  }

  const report = data.perf_report || {};
  const hw = report.hardware || {};
  const primary = report.primary || {};
  const results = report.results || [];
  const regression = report.regression || {};
  const artifacts = data.artifacts || [];

  // The perf oracle writes both flat top-level fields (the headline metrics
  // the operator cares about) and a structured `primary` (one shape's
  // detail). Prefer the flat fields — they are exactly what the oracle
  // measured — and fall back to `primary` for older reports.
  const num = (v) => (v == null || isNaN(+v) ? null : +v);
  const msPerOp = num(report.ms_per_op);
  const tokensPerSec = num(report.tokens_per_sec);
  const gflops = num(report.gflops) ?? num(primary.gflops) ?? 0;
  const bandwidth = num(report.bandwidth_gb_s) ?? num(primary.bandwidth_gb_s) ?? 0;
  const speedup = num(report.speedup) ?? num(primary.speedup) ?? 0;
  const kernelUs = num(primary.kernel_us);
  const baselineUs = num(primary.baseline_us);
  const speedupCls = speedup > 0 ? (speedup >= 1 ? "good" : "bad") : "";
  const fmt = (v, d = 2) => (v == null ? "—" : v.toFixed(d));

  return html`
    <div class="panel">
      <h2>Profile — iteration ${iteration}</h2>

      <div class="profile-panel">
        ${hw.arch ? html`
          <div class="profile-section">
            <h4>Hardware</h4>
            <div class="profile-metrics">
              <${MetricTile} label="Arch" value=${hw.arch || "—"} />
              <${MetricTile} label="CU" value=${hw.cu || "—"} />
              <${MetricTile} label="Wavefront" value=${hw.wavefront || "—"} />
              <${MetricTile} label="Matrix" value=${hw.matrix_instructions || "—"} />
            </div>
          </div>
        ` : null}

        <div class="profile-section">
          <h4>Headline metrics ${primary.shape ? html`<span class="muted" style="font-weight:normal">(${primary.shape.path || "primary"})</span>` : null}</h4>
          <div class="profile-metrics">
            <${MetricTile} label="ms / op" value=${fmt(msPerOp, 3)} unit="ms" />
            <${MetricTile} label="tokens / sec" value=${fmt(tokensPerSec, 1)} />
            <${MetricTile} label="Speedup" value=${speedup > 0 ? `${speedup.toFixed(2)}×` : "—"} cls=${speedupCls} />
            <${MetricTile} label="GFLOPS" value=${fmt(gflops, 1)} />
            <${MetricTile} label="Bandwidth" value=${fmt(bandwidth, 1)} unit="GB/s" />
            <${MetricTile} label="Kernel time" value=${fmt(kernelUs, 2)} unit="µs" />
            <${MetricTile} label="Baseline" value=${fmt(baselineUs, 2)} unit="µs" />
          </div>
          ${report.notes ? html`<p class="muted" style="font-size:11px;margin-top:6px">${report.notes}</p>` : null}
          ${regression.regressed === true
            ? html`<p style="color:#f85149;font-size:12px">⚠ 回归: ${regression.drop ? `${(regression.drop * 100).toFixed(0)}% 变慢` : "较上一轮变慢"} ${regression.note ? html`<span class="muted">(${regression.note})</span>` : null}</p>`
            : regression.regressed === false
              ? html`<p style="color:#3fb950;font-size:12px">✓ 较上一轮未回归 ${regression.note && regression.note !== "no previous baseline" ? html`<span class="muted">(${regression.note})</span>` : null}</p>`
              : null}
        </div>

        ${results.length > 0 ? html`
          <div class="profile-section">
            <h4>Per-shape results</h4>
            <${ShapeResultsTable} results=${results} />
          </div>
        ` : null}

        ${data.kernel_stats && data.kernel_stats.length > 0 ? html`
          <div class="profile-section">
            <h4>Kernel stats (rocprof --stats)</h4>
            <${KernelStatsTable} kernels=${data.kernel_stats} />
          </div>
        ` : null}

        ${data.counters && Object.keys(data.counters).length > 0 ? html`
          <div class="profile-section">
            <h4>Hardware counters</h4>
            <${CountersGrid} counters=${data.counters} />
          </div>
        ` : null}

        ${artifacts.length > 0 ? html`
          <div class="profile-section">
            <h4>Profile artifacts</h4>
            <${ArtifactsList} artifacts=${artifacts} />
            ${data.hip_trace_path ? html`
              <p class="muted" style="font-size:11px;margin-top:6px">
                HIP trace: ${data.hip_trace_path} (open in
                <a href="https://ui.perfetto.dev/" target="_blank" rel="noopener">Perfetto UI</a>)
              </p>
            ` : null}
          </div>
        ` : null}
      </div>
    </div>
  `;
}
