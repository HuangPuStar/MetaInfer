/** evalscope-correctness — task detail view.
 *
 * Renders the authoritative result (``state_dir/result.json``) served at
 * ``/api/evalscope-correctness/<taskId>/result``:
 *   - a headline completeness verdict (did EvalScope evaluate everything
 *     without truncation / errors / count mismatch?)
 *   - an optional quality-gate verdict (all configured minimums met?)
 *   - a per-dataset table: primary score, sample count, metric id,
 *     configured threshold, and completeness counts
 *   - concise failure guidance when a run is incomplete.
 *
 * The shell passes ``{ taskId, run, status, data }``. We ignore most shell
 * data and own our polling so the view is self-contained.
 */
import { html } from "htm/preact";
import { useCallback, useEffect, useState } from "preact/hooks";

const PLUGIN_TYPE = "evalscope-correctness";

function getResult(taskId) {
  return fetch(`/api/${PLUGIN_TYPE}/${encodeURIComponent(taskId)}/result`, {
    cache: "no-store",
  }).then(async (r) => {
    if (!r.ok) throw new Error(`result: ${r.status}`);
    return r.json();
  });
}

function pct(v) {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function VerdictChip({ ok }) {
  if (ok == null) return html`<span class="esc-chip esc-chip-pending">pending</span>`;
  return ok
    ? html`<span class="esc-chip esc-chip-ok">passed</span>`
    : html`<span class="esc-chip esc-chip-fail">not met</span>`;
}

function StatusChip({ complete }) {
  return complete
    ? html`<span class="esc-chip esc-chip-ok">complete</span>`
    : html`<span class="esc-chip esc-chip-fail">incomplete</span>`;
}

export default function EvalScopeDetail({ taskId, run }) {
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const r = await getResult(taskId);
      setResult(r);
      setErr(null);
    } catch (e) {
      // 404 = not ready yet (still configuring / running / errored preflight).
      setResult((prev) => prev); // keep last known result if we had one
      setErr(e.message);
    } finally {
      setReady(true);
    }
  }, [taskId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!taskId) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [taskId, refresh]);

  // Refetch immediately when the run transitions (started → running → done).
  useEffect(() => { refresh(); }, [run?.current_phase, run?.finished]);

  const phase = run?.current_phase || "idle";
  if (!ready) {
    return html`<div class="esc-muted">Loading evaluation…</div>`;
  }

  return html`
    <div class="esc-detail">
      <div class="esc-header">
        <span class="esc-phase esc-phase-${phase}">phase: ${phase}</span>
        ${result && result.complete
          ? html`<span class="esc-chip esc-chip-ok">evaluation complete</span>`
          : err && !result
            ? html`<span class="esc-chip esc-chip-pending">result not ready yet</span>`
            : html`<span class="esc-chip esc-chip-fail">incomplete</span>`}
      </div>

      ${result
        ? html`<${ResultBody} result=${result} />`
        : html`<div class="esc-muted">
            No result yet. The evaluation is ${phase === "idle" ? "pending" : phase}.${
              err ? ` (${err})` : ""
            }
          </div>`}
    </div>
  `;
}

function ResultBody({ result }) {
  const datasets = result.datasets || [];
  const q = result.quality || {};
  const reasons = result.complete_reasons || [];

  return html`
    <section class="esc-verdicts">
      <div class="esc-verdict esc-verdict-${result.complete ? "ok" : "fail"}">
        <h3>Execution completeness</h3>
        <p>${result.complete
          ? "Every requested dataset was fully evaluated with no truncation or errors."
          : "The evaluation is incomplete — see reasons below. Truncated samples are never counted toward a final score."}</p>
        <p class="esc-small">${datasets.length} dataset(s) · fingerprint <code>${(result.fingerprint || "").slice(0, 16)}…</code></p>
      </div>
      <div class="esc-verdict esc-verdict-${q.configured ? (q.passed ? "ok" : "fail") : "pending"}">
        <h3>Quality gate</h3>
        <p>${q.configured
          ? q.passed
            ? "All configured minimum scores were met."
            : "One or more datasets scored below its configured minimum."
          : "No minimum-score gates configured — results are reported only."}</p>
      </div>
    </section>

    ${reasons.length > 0 && html`
      <section class="esc-reasons">
        <h3>Why the run is incomplete</h3>
        <ul>${reasons.map((r, i) => html`<li key=${i}>${r}</li>`)}</ul>
        <p class="esc-small">Fix the underlying issue and resume the task. Datasets already fully evaluated under the same
        request fingerprint are reused automatically.</p>
      </section>
    `}

    <section class="esc-panel">
      <h3>Per-dataset results</h3>
      <table class="esc-table">
        <thead>
          <tr>
            <th>Dataset</th>
            <th>Status</th>
            <th>Metric</th>
            <th>Score</th>
            <th>Samples</th>
            <th>Gate</th>
          </tr>
        </thead>
        <tbody>
          ${datasets.map((d) => html`
            <tr key=${d.dataset} class=${d.complete ? "" : "esc-row-incomplete"}>
              <td><code>${d.dataset}</code></td>
              <td><${StatusChip} complete=${d.complete} /></td>
              <td class="esc-muted">${d.primary_metric || "—"}</td>
              <td><strong>${pct(d.score)}</strong>${d.score != null ? ` of ${d.num ?? "?"} samples` : ""}</td>
              <td>${d.num ?? "—"}<span class="esc-small"> (pred ${d.predicted ?? "—"})</span></td>
              <td>
                ${d.threshold == null
                  ? html`<span class="esc-muted">—</span>`
                  : html`${pct(d.threshold)} <${VerdictChip} ok=${d.threshold_met} />`}
              </td>
            </tr>
            ${!d.complete && (d.reasons || []).length > 0 && html`
              <tr key=${d.dataset + "-reasons"} class="esc-reason-row">
                <td colspan="6">
                  <ul>${d.reasons.map((r, i) => html`<li key=${i}>${d.dataset}: ${r}</li>`)}</ul>
                  ${d.raw_relative ? html`<span class="esc-small">raw artifacts: <code>${d.raw_relative}</code></span>` : ""}
                </td>
              </tr>
            `}
          `)}
        </tbody>
      </table>
    </section>
  `;
}
