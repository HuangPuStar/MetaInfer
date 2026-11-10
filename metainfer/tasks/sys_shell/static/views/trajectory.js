// DSH trajectory browser: read-only view over DSH v4 session files.
// The backend is metainfer/trajectory; this view never writes source sessions.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

const API_ROOT = "/api/sys-shell/trajectories";
const LIST_PAGE_SIZE = 50;
const LIST_TIMEOUT_MS = 20_000;

async function getJson(url, options = {}) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: options.signal });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch (_) { /* keep status text */ }
    throw new Error(message);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.detail || message;
    } catch (_) { /* keep status text */ }
    throw new Error(message);
  }
  return response.json();
}

function emptyAnnotation(sessionId) {
  return {
    sessionId,
    outcome: "unreviewed",
    failureCategory: "",
    tags: [],
    notes: "",
    reviewer: "",
    updatedAt: null,
  };
}

function fmtInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(number));
}

function fmtMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
  return `${(value / 3_600_000).toFixed(1)} h`;
}

function fmtTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  try {
    return new Date(number).toLocaleString();
  } catch (_) {
    return "—";
  }
}

function fmtPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${Math.round(number * 100)}%`;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 22 ? `${text.slice(0, 21)}…` : text;
}

function statusClass(status) {
  if (status === "completed") return "ok";
  if (status === "running") return "active";
  if (status === "aborted" || status === "error") return "err";
  return "idle";
}

function MetaRow({ label, value, mono }) {
  const display = value === 0 || value === "0" ? "0" : (value || "—");
  return html`
    <div class="traj-meta-row">
      <span class="traj-meta-label">${label}</span>
      <span class=${`traj-meta-value ${mono ? "mono" : ""}`}>${display}</span>
    </div>
  `;
}

function MetricCard({ label, value, hint }) {
  return html`
    <div class="traj-metric">
      <span class="traj-metric-label">${label}</span>
      <strong>${value}</strong>
      ${hint ? html`<span class="traj-metric-hint">${hint}</span>` : null}
    </div>
  `;
}

function SessionList({ sessions, selectedId, onSelect, loading, error = "", projectId = "" }) {
  if (loading && sessions.length === 0) {
    return html`<div class="traj-list-empty">Loading sessions…</div>`;
  }
  if (error && sessions.length === 0) {
    return html`<div class="traj-list-empty">Session list unavailable. Retry above.</div>`;
  }
  if (sessions.length === 0) {
    return html`<div class="traj-list-empty">${projectId ? "No DSH sessions found for this project." : "No DSH sessions found."}</div>`;
  }
  return html`
    <div class="traj-list">
      ${sessions.map((session) => html`
        <button key=${session.id}
            class=${`traj-item ${session.id === selectedId ? "active" : ""}`}
            onClick=${() => onSelect(session.id)}>
          <div class="traj-item-head">
            <span class=${`traj-status ${statusClass(session.status)}`}>${session.status}</span>
            ${session.annotation?.outcome && session.annotation.outcome !== "unreviewed"
              ? html`<span class=${`traj-verdict ${session.annotation.outcome}`}>${session.annotation.outcome}</span>`
              : null}
            <span class="traj-item-time">${fmtTime(session.updatedAt)}</span>
          </div>
          <div class="traj-item-title">${session.title || "(untitled)"}</div>
          <div class="traj-item-sub">${session.context?.label || session.agentPreset || "no preset"} · ${session.model || "unknown model"}</div>
          <div class="traj-item-metrics">
            <span>${fmtInt(session.turns)} turns</span>
            <span>${fmtInt(session.toolCalls)} tools</span>
            <span class=${session.toolErrors ? "bad" : ""}>${fmtInt(session.toolErrors)} errors</span>
            <span>${fmtInt(session.tokens?.total)} tok</span>
          </div>
        </button>
      `)}
    </div>
  `;
}

function Timeline({ detail }) {
  const entries = detail.timeline || [];
  if (entries.length === 0) return html`<div class="traj-list-empty">No timeline records.</div>`;
  return html`
    <div class="traj-timeline">
      ${entries.map((entry, index) => html`
        <div key=${`${entry.seq}-${index}`} class=${`traj-event type-${entry.type}`}>
          <div class="traj-event-rail">
            <span class="traj-event-dot"></span>
            <span class="traj-event-seq">#${entry.seq}</span>
          </div>
          <div class="traj-event-body">
            <div class="traj-event-head">
              <span class="traj-event-title">${entry.title || entry.type}</span>
              ${entry.turn !== null && entry.turn !== undefined
                ? html`<span class="traj-tag">turn ${entry.turn}${entry.step ? ` · step ${entry.step}` : ""}</span>`
                : null}
              <span class="traj-event-time">${fmtTime(entry.time)}</span>
              ${entry.durationMs !== null && entry.durationMs !== undefined
                ? html`<span class="traj-tag">${fmtMs(entry.durationMs)}</span>`
                : null}
            </div>
            ${entry.text ? html`<pre class="traj-event-text">${entry.text}</pre>` : null}
          </div>
        </div>
      `)}
    </div>
  `;
}

function Tools({ detail }) {
  const tools = detail.toolBreakdown || [];
  if (tools.length === 0) return html`<div class="traj-list-empty">No tool calls.</div>`;
  return html`
    <table class="traj-table">
      <thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Duration</th></tr></thead>
      <tbody>
        ${tools.map((tool) => html`
          <tr key=${tool.name}>
            <td class="mono">${tool.name}</td>
            <td>${fmtInt(tool.count)}</td>
            <td class=${tool.errors ? "bad" : ""}>${fmtInt(tool.errors)}</td>
            <td>${fmtMs(tool.durationMs)}</td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

function Analysis({ detail }) {
  const analysis = detail.analysis || {};
  return html`
    <div class="traj-analysis">
      <div class="traj-findings">
        <h4>Deterministic observations</h4>
        ${(analysis.findings || []).map((finding, index) => html`
          <div key=${index} class="traj-finding">${finding}</div>
        `)}
      </div>
      <div class="traj-metrics">
        <${MetricCard} label="Tool success" value=${fmtPct(analysis.toolSuccessRate)} />
        <${MetricCard} label="Tokens / turn" value=${fmtInt(analysis.tokensPerTurn)} />
        <${MetricCard} label="Time / turn" value=${fmtMs(analysis.durationPerTurnMs)} />
        <${MetricCard} label="Structured output"
          value=${analysis.hasStructuredOutput ? "yes" : "no"} />
      </div>
      <div class="traj-section">
        <h4>Token usage</h4>
        <div class="traj-kv-grid">
          <span>Input</span><b>${fmtInt(detail.tokens?.input)}</b>
          <span>Output</span><b>${fmtInt(detail.tokens?.output)}</b>
          <span>Cache read</span><b>${fmtInt(detail.tokens?.cacheRead)}</b>
          <span>Cache write</span><b>${fmtInt(detail.tokens?.cacheWrite)}</b>
          <span>Total</span><b>${fmtInt(detail.tokens?.total)}</b>
        </div>
      </div>
    </div>
  `;
}

function Curation({ annotation, onChange, onSave, saving, error, saved }) {
  const value = annotation || emptyAnnotation("");
  const set = (field, next) => onChange({ ...value, [field]: next });
  const updated = value.updatedAt ? fmtTime(value.updatedAt) : "not saved yet";
  return html`
    <form class="traj-curation" onSubmit=${(event) => { event.preventDefault(); onSave(); }}>
      <div class="traj-curation-head">
        <div>
          <h4>Human curation</h4>
          <p class="traj-hint">Labels are stored per session and drive later regression sets.</p>
        </div>
        <span class="traj-hint">${updated}</span>
      </div>
      <div class="traj-curation-grid">
        <label>
          <span>Outcome</span>
          <select value=${value.outcome} onChange=${(event) => set("outcome", event.target.value)}>
            <option value="unreviewed">unreviewed</option>
            <option value="pass">pass</option>
            <option value="fail">fail</option>
            <option value="uncertain">uncertain</option>
          </select>
        </label>
        <label>
          <span>Failure category</span>
          <input value=${value.failureCategory}
              placeholder="e.g. missing_verification"
              onInput=${(event) => set("failureCategory", event.target.value)} />
        </label>
        <label>
          <span>Reviewer</span>
          <input value=${value.reviewer} placeholder="name"
              onInput=${(event) => set("reviewer", event.target.value)} />
        </label>
        <label>
          <span>Tags</span>
          <input value=${(value.tags || []).join(", ")} placeholder="comma, separated"
              onInput=${(event) => set("tags", event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean))} />
        </label>
      </div>
      <label>
        <span>Notes / evidence</span>
        <textarea rows="7" value=${value.notes}
            placeholder="What went wrong or right? Which record/step is the evidence?"
            onInput=${(event) => set("notes", event.target.value)}></textarea>
      </label>
      <div class="traj-curation-actions">
        <button class="btn primary" type="submit" disabled=${saving}>${saving ? "Saving…" : "Save curation"}</button>
        ${saved ? html`<span class="traj-saved">Saved</span>` : null}
        ${error ? html`<span class="traj-error-text">${error}</span>` : null}
      </div>
    </form>
  `;
}

function Meta({ detail }) {
  return html`
    <div class="traj-meta">
      <${MetaRow} label="Session" value=${detail.id} mono />
      <${MetaRow} label="Context" value=${detail.context?.label} />
      <${MetaRow} label="Project / node" value=${[detail.context?.projectId, detail.context?.nodeId].filter(Boolean).join(" / ")} />
      <${MetaRow} label="MetaInfer task" value=${detail.context?.taskId} />
      <${MetaRow} label="Applied skill releases"
        value=${(detail.skillOverlays || []).map((item) => item.releaseId).join(", ")} />
      <${MetaRow} label="Source file" value=${detail.path} mono />
      <${MetaRow} label="Working dir" value=${detail.cwd} mono />
      <${MetaRow} label="Parent session" value=${detail.parentSession} mono />
      <${MetaRow} label="Origin" value=${detail.origin || "root"} />
      <${MetaRow} label="Delegation depth" value=${String(detail.delegationDepth ?? 0)} />
      <${MetaRow} label="Preset" value=${detail.agentPreset} />
      <${MetaRow} label="Provider / model" value=${[detail.provider, detail.model].filter(Boolean).join(" / ")} />
      <${MetaRow} label="Reasoning effort" value=${detail.reasoningEffort} />
      <${MetaRow} label="Created" value=${fmtTime(detail.createdAt)} />
      <${MetaRow} label="Updated" value=${fmtTime(detail.updatedAt)} />
      <${MetaRow} label="Events" value=${fmtInt(detail.eventCount)} />
      <${MetaRow} label="Status / reason" value=${`${detail.status}${detail.stopReason ? ` / ${detail.stopReason}` : ""}`} />
      ${(detail.eventTypes && Object.keys(detail.eventTypes).length > 0) ? html`
        <div class="traj-section">
          <h4>Event types</h4>
          <div class="traj-event-types">
            ${Object.entries(detail.eventTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => html`
              <span key=${type} class="traj-tag">${type} · ${fmtInt(count)}</span>
            `)}
          </div>
        </div>
      ` : null}
      ${(detail.warnings || []).length > 0 ? html`
        <div class="traj-section">
          <h4>Parse warnings</h4>
          ${detail.warnings.map((warning, index) => html`<div key=${index} class="traj-warning">${warning}</div>`)}
        </div>
      ` : null}
    </div>
  `;
}

function Detail({
  detail, loading, error, tab, onTab,
  annotation, setAnnotation, onSaveAnnotation, annotationSaving, annotationError, annotationSaved,
}) {
  if (loading) return html`<div class="traj-detail-empty">Loading trajectory…</div>`;
  if (error) return html`<div class="traj-detail-empty err">${error}</div>`;
  if (!detail) return html`<div class="traj-detail-empty">Select a session on the left.</div>`;
  const tabs = [
    ["analysis", "Analysis"],
    ["curation", "Curation"],
    ["timeline", "Timeline"],
    ["tools", "Tools"],
    ["meta", "Metadata"],
  ];
  return html`
    <div class="traj-detail">
      <div class="traj-detail-head">
        <div>
          <h2>${detail.title || "(untitled)"}</h2>
          <div class="traj-detail-sub">
            <span class=${`traj-status ${statusClass(detail.status)}`}>${detail.status}</span>
            <span class="mono">${shortId(detail.id)}</span>
            <span>${detail.agentPreset || "no preset"}</span>
            <span>${detail.model || "unknown model"}</span>
            ${detail.context?.label ? html`<span class="traj-tag">${detail.context.label}</span>` : null}
          </div>
        </div>
        <div class="traj-detail-time">
          <span>${fmtTime(detail.updatedAt)}</span>
          <span>${fmtMs(detail.durationMs)}</span>
        </div>
      </div>

      <div class="traj-metrics">
        <${MetricCard} label="Turns" value=${fmtInt(detail.turns)} hint=${`${fmtInt(detail.steps)} steps`} />
        <${MetricCard} label="Tool calls" value=${fmtInt(detail.toolCalls)} hint=${`${fmtInt(detail.toolErrors)} errors`} />
        <${MetricCard} label="Tokens" value=${fmtInt(detail.tokens?.total)} hint=${`${fmtInt(detail.assistantMessages)} assistant msgs`} />
        <${MetricCard} label="Duration" value=${fmtMs(detail.durationMs)} hint=${fmtTime(detail.createdAt)} />
      </div>

      <div class="traj-tabs">
        ${tabs.map(([id, label]) => html`
          <button key=${id} class=${`traj-tab ${tab === id ? "active" : ""}`} onClick=${() => onTab(id)}>${label}</button>
        `)}
      </div>
      <div class="traj-tab-body">
        ${tab === "analysis" ? html`<${Analysis} detail=${detail} />` : null}
        ${tab === "curation" ? html`<${Curation}
          annotation=${annotation}
          onChange=${setAnnotation}
          onSave=${onSaveAnnotation}
          saving=${annotationSaving}
          error=${annotationError}
          saved=${annotationSaved} />` : null}
        ${tab === "timeline" ? html`<${Timeline} detail=${detail} />` : null}
        ${tab === "tools" ? html`<${Tools} detail=${detail} />` : null}
        ${tab === "meta" ? html`<${Meta} detail=${detail} />` : null}
      </div>
    </div>
  `;
}

function Library({ onClose, onOpenSession }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [includeUncertain, setIncludeUncertain] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [proposalDataset, setProposalDataset] = useState(null);
  const [proposalRole, setProposalRole] = useState("advisor");
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalCreating, setProposalCreating] = useState(false);
  const [createdProposal, setCreatedProposal] = useState(null);
  const [evaluatingId, setEvaluatingId] = useState("");
  const [createdEvaluation, setCreatedEvaluation] = useState(null);
  const [reviewingProposal, setReviewingProposal] = useState(null);
  const [reviewStatus, setReviewStatus] = useState("reviewed");
  const [reviewReviewer, setReviewReviewer] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [rubricEvaluating, setRubricEvaluating] = useState(false);
  const [createdSkill, setCreatedSkill] = useState(null);
  const [skillEvaluateId, setSkillEvaluateId] = useState("");
  const [createdSkillEvaluation, setCreatedSkillEvaluation] = useState(null);
  const [skillRegressingId, setSkillRegressingId] = useState("");
  const [createdSkillRegression, setCreatedSkillRegression] = useState(null);
  const [releaseTarget, setReleaseTarget] = useState(null);
  const [releaseReviewer, setReleaseReviewer] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [createdRelease, setCreatedRelease] = useState(null);
  const [releaseSaving, setReleaseSaving] = useState(false);
  const [activatingReleaseId, setActivatingReleaseId] = useState("");
  const [rollingBackSkillId, setRollingBackSkillId] = useState("");
  const [runtimeApplyingId, setRuntimeApplyingId] = useState("");
  const [runtimeRollingBackId, setRuntimeRollingBackId] = useState("");
  const [runtimePromotingId, setRuntimePromotingId] = useState("");
  const [canaryData, setCanaryData] = useState(null);
  const [labApplyingId, setLabApplyingId] = useState("");
  const [labPromotingId, setLabPromotingId] = useState("");
  const [labRollingBackId, setLabRollingBackId] = useState("");
  const [canaryReadiness, setCanaryReadiness] = useState(null);
  const [canaryError, setCanaryError] = useState("");
  const [regressionDetail, setRegressionDetail] = useState(null);
  const [regressionDetailError, setRegressionDetailError] = useState("");

  const load = () => {
    setError("");
    getJson(`${API_ROOT}/curation`)
      .then((data) => setSummary(data))
      .catch((reason) => setError(String(reason.message || reason)));
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (event) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const dataset = await postJson(`${API_ROOT}/datasets`, {
        name,
        includeUncertain,
      });
      setCreated(dataset);
      setName("");
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setCreating(false);
    }
  };

  const evaluateDataset = async (dataset) => {
    setEvaluatingId(dataset.id);
    setError("");
    setCreatedEvaluation(null);
    try {
      const report = await postJson(
        `${API_ROOT}/datasets/${encodeURIComponent(dataset.id)}/evaluations`,
        { rule: "baseline_v1" },
      );
      setCreatedEvaluation(report);
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setEvaluatingId("");
    }
  };

  const openRegression = (regressionId) => {
    setRegressionDetailError("");
    setRegressionDetail(null);
    getJson(`${API_ROOT}/regressions/${encodeURIComponent(regressionId)}`)
      .then((report) => setRegressionDetail(report))
      .catch((reason) => setRegressionDetailError(String(reason.message || reason)));
  };

  const applyRuntime = async (skillId, releaseId, canaryPercent) => {
    setRuntimeApplyingId(releaseId);
    setError("");
    try {
      await postJson(
        `${API_ROOT}/skills/${encodeURIComponent(skillId)}/releases/${encodeURIComponent(releaseId)}/apply-runtime`,
        { canaryPercent },
      );
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setRuntimeApplyingId("");
    }
  };

  const applyLab = async (skillId, releaseId, canaryPercent) => {
    setLabApplyingId(releaseId);
    setError("");
    try {
      await postJson(
        `${API_ROOT}/skills/${encodeURIComponent(skillId)}/releases/${encodeURIComponent(releaseId)}/apply-lab`,
        { canaryPercent },
      );
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setLabApplyingId("");
    }
  };

  const promoteLab = async (skillId) => {
    setLabPromotingId(skillId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/promote-lab`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setLabPromotingId("");
    }
  };

  const rollbackLab = async (skillId) => {
    setLabRollingBackId(skillId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/rollback-lab`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setLabRollingBackId("");
    }
  };

  const loadLabCanary = (skillId) => {
    setLabCanaryError("");
    setLabCanaryData(null);
    setLabCanaryReadiness(null);
    Promise.all([
      getJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/lab-canary`),
      getJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/lab-promotion-readiness`),
    ])
      .then(([data, readiness]) => {
        setLabCanaryData(data);
        setLabCanaryReadiness(readiness);
      })
      .catch((reason) => setLabCanaryError(String(reason.message || reason)));
  };

  const loadCanary = (skillId) => {
    setCanaryError("");
    setCanaryData(null);
    setCanaryReadiness(null);
    Promise.all([
      getJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/canary`),
      getJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/promotion-readiness`),
    ])
      .then(([data, readiness]) => {
        setCanaryData(data);
        setCanaryReadiness(readiness);
      })
      .catch((reason) => setCanaryError(String(reason.message || reason)));
  };

  const promoteRuntime = async (skillId) => {
    setRuntimePromotingId(skillId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/promote-runtime`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setRuntimePromotingId("");
    }
  };

  const rollbackRuntime = async (skillId) => {
    setRuntimeRollingBackId(skillId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/rollback-runtime`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setRuntimeRollingBackId("");
    }
  };

  const activateRelease = async (skillId, releaseId) => {
    setActivatingReleaseId(releaseId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/releases/${encodeURIComponent(releaseId)}/activate`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setActivatingReleaseId("");
    }
  };

  const rollbackSkill = async (skillId) => {
    setRollingBackSkillId(skillId);
    setError("");
    try {
      await postJson(`${API_ROOT}/skills/${encodeURIComponent(skillId)}/rollback`, {});
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setRollingBackSkillId("");
    }
  };

  const releaseSkill = async (event) => {
    event.preventDefault();
    if (!releaseTarget) return;
    setReleaseSaving(true);
    setError("");
    try {
      const release = await postJson(
        `${API_ROOT}/skills/${encodeURIComponent(releaseTarget.id)}/versions/${releaseTarget.latestVersion}/release`,
        { reviewer: releaseReviewer, note: releaseNote },
      );
      setCreatedRelease(release);
      setReleaseTarget(null);
      setReleaseNote("");
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setReleaseSaving(false);
    }
  };

  const runAgentRegression = async (skill) => {
    setSkillRegressingId(skill.id);
    setError("");
    setCreatedSkillRegression(null);
    try {
      const payload = await postJson(
        `${API_ROOT}/skills/${encodeURIComponent(skill.id)}/versions/${skill.latestVersion}/regression`,
        { maxItems: 3 },
      );
      setCreatedSkillRegression(payload.report || null);
      setCreatedSkill(payload.skill || skill);
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setSkillRegressingId("");
    }
  };

  const evaluateSkill = async (skill) => {
    setSkillEvaluateId(skill.id);
    setError("");
    setCreatedSkillEvaluation(null);
    try {
      const package_ = await postJson(
        `${API_ROOT}/skills/${encodeURIComponent(skill.id)}/versions/${skill.latestVersion}/evaluate`,
        {},
      );
      const latest = (package_.versions || []).find((item) => item.version === skill.latestVersion);
      setCreatedSkillEvaluation(latest?.evaluation || null);
      setCreatedSkill(package_);
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setSkillEvaluateId("");
    }
  };

  const createSkill = async (proposal) => {
    setError("");
    try {
      const skill = await postJson(
        `${API_ROOT}/proposals/${encodeURIComponent(proposal.id)}/skill`,
        { name: proposal.title },
      );
      setCreatedSkill(skill);
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    }
  };

  const runRubricEvaluation = async () => {
    if (!reviewingProposal?.datasetId) return;
    setRubricEvaluating(true);
    setError("");
    try {
      const report = await postJson(
        `${API_ROOT}/datasets/${encodeURIComponent(reviewingProposal.datasetId)}/evaluations`,
        { rule: "proposal_v1" },
      );
      setCreatedEvaluation(report);
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setRubricEvaluating(false);
    }
  };

  const reviewProposal = async (event) => {
    event.preventDefault();
    if (!reviewingProposal) return;
    setReviewSaving(true);
    setError("");
    try {
      const updated = await postJson(
        `${API_ROOT}/proposals/${encodeURIComponent(reviewingProposal.id)}/review`,
        { status: reviewStatus, reviewer: reviewReviewer, note: reviewNote },
      );
      setCreatedProposal(updated);
      setReviewingProposal(null);
      setReviewNote("");
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setReviewSaving(false);
    }
  };

  const createProposal = async (event) => {
    event.preventDefault();
    if (!proposalDataset) return;
    setProposalCreating(true);
    setError("");
    try {
      const proposal = await postJson(
        `${API_ROOT}/datasets/${encodeURIComponent(proposalDataset.id)}/proposals`,
        { role: proposalRole, title: proposalTitle },
      );
      setCreatedProposal(proposal);
      setProposalTitle("");
      load();
    } catch (reason) {
      setError(String(reason.message || reason));
    } finally {
      setProposalCreating(false);
    }
  };

  return html`
    <div class="traj-library-backdrop" onClick=${onClose}>
      <div class="traj-library" onClick=${(event) => event.stopPropagation()}>
        <div class="traj-library-head">
          <div>
            <h2>Trajectory library</h2>
            <p class="traj-hint">Human labels and frozen evidence for evaluation and skill proposals.</p>
          </div>
          <button class="btn ghost" onClick=${onClose}>Close</button>
        </div>
        ${error ? html`<div class="traj-page-error">${error}</div>` : null}
        ${summary === null
          ? html`<div class="traj-list-empty">Loading curation summary…</div>`
          : html`
            <div class="traj-library-metrics">
              <${MetricCard} label="Reviewed" value=${fmtInt(summary.reviewed)}
                hint=${`of ${fmtInt(summary.totalSessions)} sessions`} />
              <${MetricCard} label="Pass" value=${fmtInt(summary.outcomes?.pass)} />
              <${MetricCard} label="Fail" value=${fmtInt(summary.outcomes?.fail)} />
              <${MetricCard} label="Uncertain" value=${fmtInt(summary.outcomes?.uncertain)} />
            </div>

            <div class="traj-library-grid">
              <section class="traj-section">
                <h4>Failure patterns</h4>
                ${(summary.failurePatterns || []).length === 0
                  ? html`<div class="traj-list-empty">No failure categories yet.</div>`
                  : html`<table class="traj-table">
                      <thead><tr><th>Category</th><th>Count</th><th>Evidence</th></tr></thead>
                      <tbody>
                        ${summary.failurePatterns.map((pattern) => html`
                          <tr key=${pattern.failureCategory}>
                            <td class="mono">${pattern.failureCategory}</td>
                            <td>${fmtInt(pattern.count)}</td>
                            <td>
                              ${pattern.sessionIds.slice(0, 3).map((id) => html`
                                <button key=${id} class="traj-link" onClick=${() => onOpenSession(id)}>${shortId(id)}</button>
                              `)}
                            </td>
                          </tr>
                        `)}
                      </tbody>
                    </table>`}
              </section>

              <section class="traj-section">
                <h4>Freeze a curated dataset</h4>
                <form class="traj-dataset-form" onSubmit=${create}>
                  <label>
                    <span>Dataset name</span>
                    <input value=${name} placeholder="e.g. verification-gap-v1"
                        onInput=${(event) => setName(event.target.value)} />
                  </label>
                  <label class="traj-checkbox">
                    <input type="checkbox" checked=${includeUncertain}
                        onChange=${(event) => setIncludeUncertain(event.target.checked)} />
                    <span>Include uncertain labels</span>
                  </label>
                  <button class="btn primary" type="submit" disabled=${creating || summary.reviewed === 0}>
                    ${creating ? "Freezing…" : "Freeze dataset"}
                  </button>
                  <p class="traj-hint">Datasets store compact evidence: identity, metrics, findings and labels.</p>
                </form>
                ${created ? html`
                  <div class="traj-created">
                    <span>Created <b>${created.name}</b> (${fmtInt(created.items?.length)} items)</span>
                    <a class="traj-link" href=${`${API_ROOT}/datasets/${created.id}/export`}>Download JSON</a>
                  </div>
                ` : null}
              </section>
            </div>

            <section class="traj-section">
              <h4>Datasets</h4>
              ${(summary.datasets || []).length === 0
                ? html`<div class="traj-list-empty">No frozen datasets yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Name</th><th>Items</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      ${summary.datasets.map((dataset) => html`
                        <tr key=${dataset.id}>
                          <td>${dataset.name}</td>
                          <td>${fmtInt(dataset.count)}</td>
                          <td>${fmtTime(dataset.createdAt)}</td>
                          <td>
                            <button class="traj-link" onClick=${() => {
                              setProposalDataset(dataset);
                              setProposalTitle(`Improve expert skill from ${dataset.name}`);
                              setCreatedProposal(null);
                            }}>proposal</button>
                            <button class="traj-link" onClick=${() => evaluateDataset(dataset)}>
                              ${evaluatingId === dataset.id ? "evaluating…" : "evaluate"}
                            </button>
                            <a class="traj-link" href=${`${API_ROOT}/datasets/${dataset.id}/export`}>export</a>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            ${proposalDataset ? html`
              <section class="traj-section">
                <h4>Create skill proposal · ${proposalDataset.name}</h4>
                <form class="traj-dataset-form" onSubmit=${createProposal}>
                  <div class="traj-proposal-fields">
                    <label>
                      <span>Expert role</span>
                      <select value=${proposalRole} onChange=${(event) => setProposalRole(event.target.value)}>
                        <option value="advisor">advisor</option>
                        <option value="reviewer">reviewer</option>
                        <option value="worker">worker</option>
                        <option value="scheduler">scheduler</option>
                        <option value="custom">custom</option>
                      </select>
                    </label>
                    <label>
                      <span>Proposal title</span>
                      <input value=${proposalTitle} placeholder="e.g. advisor verification gate v1"
                          onInput=${(event) => setProposalTitle(event.target.value)} />
                    </label>
                  </div>
                  <div class="traj-curation-actions">
                    <button class="btn primary" type="submit" disabled=${proposalCreating}>
                      ${proposalCreating ? "Generating…" : "Generate draft"}
                    </button>
                    <button class="btn ghost" type="button" onClick=${() => setProposalDataset(null)}>Cancel</button>
                  </div>
                  <p class="traj-hint">Generated from failed labels and their deterministic evidence. It is a draft, not an applied skill.</p>
                </form>
                ${createdProposal ? html`
                  <div class="traj-created">
                    <span><b>${createdProposal.title}</b> · ${createdProposal.status}</span>
                    <a class="traj-link" href=${`${API_ROOT}/proposals/${createdProposal.id}/export`}>Download Markdown</a>
                  </div>
                  <pre class="traj-proposal-preview">${createdProposal.markdown}</pre>
                ` : null}
              </section>
            ` : null}

            ${createdEvaluation ? html`
              <section class="traj-section">
                <h4>Dataset evaluation · ${createdEvaluation.datasetName}</h4>
                <div class="traj-eval-metrics">
                  <${MetricCard} label="Accuracy" value=${fmtPct(createdEvaluation.metrics?.accuracy)} />
                  <${MetricCard} label="Precision" value=${fmtPct(createdEvaluation.metrics?.precision)} />
                  <${MetricCard} label="Recall" value=${fmtPct(createdEvaluation.metrics?.recall)} />
                  <${MetricCard} label="F1" value=${fmtPct(createdEvaluation.metrics?.f1)} />
                </div>
                <p class="traj-hint">
                  Rule: ${createdEvaluation.rule}; compared against ${fmtInt(createdEvaluation.metrics?.labeled)} human labels.
                </p>
                ${(createdEvaluation.metrics?.mismatches || []).length > 0 ? html`
                  <table class="traj-table">
                    <thead><tr><th>Mismatch</th><th>Human</th><th>Predicted</th><th>Reason</th></tr></thead>
                    <tbody>
                      ${createdEvaluation.metrics.mismatches.map((item) => html`
                        <tr key=${item.sessionId}>
                          <td><button class="traj-link" onClick=${() => onOpenSession(item.sessionId)}>${shortId(item.sessionId)}</button></td>
                          <td>${item.humanOutcome}</td>
                          <td>${item.predictedOutcome}</td>
                          <td class="mono">${item.reason}</td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                ` : html`<p class="traj-hint">No mismatches on this dataset.</p>`}
                <div class="traj-curation-actions">
                  <a class="traj-link" href=${`${API_ROOT}/evaluations/${createdEvaluation.id}/export`}>Download evaluation JSON</a>
                </div>
              </section>
            ` : null}

            <section class="traj-section">
              <h4>Evaluations</h4>
              ${(summary.evaluations || []).length === 0
                ? html`<div class="traj-list-empty">No evaluations yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Dataset</th><th>Rule</th><th>Accuracy</th><th>F1</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      ${summary.evaluations.map((evaluation) => html`
                        <tr key=${evaluation.id}>
                          <td>${evaluation.datasetName}</td>
                          <td class="mono">${evaluation.rule}</td>
                          <td>${fmtPct(evaluation.accuracy)}</td>
                          <td>${fmtPct(evaluation.f1)}</td>
                          <td>${fmtTime(evaluation.createdAt)}</td>
                          <td><a class="traj-link" href=${`${API_ROOT}/evaluations/${evaluation.id}/export`}>export</a></td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            <section class="traj-section">
              <h4>Skill proposals</h4>
              ${(summary.proposals || []).length === 0
                ? html`<div class="traj-list-empty">No skill proposals yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Title</th><th>Role</th><th>Status</th><th>Evidence</th><th></th></tr></thead>
                    <tbody>
                      ${summary.proposals.map((proposal) => html`
                        <tr key=${proposal.id}>
                          <td>${proposal.title}</td>
                          <td>${proposal.role}</td>
                          <td>${proposal.status}</td>
                          <td>${fmtInt(proposal.failCount)} failures</td>
                          <td>
                            ${proposal.status === "approved_for_regression" ? html`
                              <button class="traj-link" onClick=${() => createSkill(proposal)}>skill</button>
                            ` : null}
                            <button class="traj-link" onClick=${() => {
                              setReviewingProposal(proposal);
                              setReviewStatus(proposal.status === "reviewed" ? "approved_for_regression" : "reviewed");
                              setReviewReviewer("");
                              setReviewNote("");
                            }}>review</button>
                            <a class="traj-link" href=${`${API_ROOT}/proposals/${proposal.id}/export`}>download</a>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            ${reviewingProposal ? html`
              <section class="traj-section">
                <h4>Review proposal · ${reviewingProposal.title}</h4>
                <form class="traj-dataset-form" onSubmit=${reviewProposal}>
                  <div class="traj-proposal-fields">
                    <label>
                      <span>Decision</span>
                      <select value=${reviewStatus} onChange=${(event) => setReviewStatus(event.target.value)}>
                        <option value="reviewed">reviewed</option>
                        <option value="approved_for_regression">approved_for_regression</option>
                        <option value="rejected">rejected</option>
                      </select>
                    </label>
                    <label>
                      <span>Reviewer</span>
                      <input value=${reviewReviewer} placeholder="name"
                          onInput=${(event) => setReviewReviewer(event.target.value)} />
                    </label>
                  </div>
                  <label>
                    <span>Review note</span>
                    <textarea rows="4" value=${reviewNote}
                        placeholder="What evidence did you check? Why approve or reject?"
                        onInput=${(event) => setReviewNote(event.target.value)}></textarea>
                  </label>
                  <div class="traj-curation-actions">
                    <button class="btn primary" type="submit" disabled=${reviewSaving}>
                      ${reviewSaving ? "Saving…" : "Save review"}
                    </button>
                    <button class="btn ghost" type="button" onClick=${runRubricEvaluation} disabled=${rubricEvaluating}>
                      ${rubricEvaluating ? "Evaluating…" : "Run proposal_v1 rubric"}
                    </button>
                    <button class="btn ghost" type="button" onClick=${() => setReviewingProposal(null)}>Cancel</button>
                  </div>
                  <p class="traj-hint">
                    approved_for_regression requires a proposal_v1 rubric evaluation for this proposal's dataset.
                    It does not publish a skill.
                  </p>
                </form>
              </section>
            ` : null}

            <section class="traj-section">
              <h4>Expert skills</h4>
              ${createdSkill ? html`
                <div class="traj-created">
                  <span>Created <b>${createdSkill.name}</b> · candidate v${createdSkill.versions?.[0]?.version}</span>
                  <a class="traj-link" href=${`${API_ROOT}/skills/${createdSkill.id}/export`}>download skill</a>
                </div>
              ` : null}
              ${createdSkillEvaluation ? html`
                <div class="traj-created">
                  <span>Rubric evaluation: accuracy ${fmtPct(createdSkillEvaluation.accuracy)} · F1 ${fmtPct(createdSkillEvaluation.f1)}</span>
                </div>
              ` : null}
              ${createdSkillRegression ? html`
                <div class="traj-created">
                  <span>Agent regression: accuracy ${fmtPct(createdSkillRegression.metrics?.accuracy)} · F1 ${fmtPct(createdSkillRegression.metrics?.f1)} · ${fmtInt(createdSkillRegression.metrics?.labeled)} labels</span>
                  <a class="traj-link" href=${`${API_ROOT}/regressions/${createdSkillRegression.id}/export`}>download regression</a>
                </div>
              ` : null}
              ${createdRelease ? html`
                <div class="traj-created">
                  <span>Release manifest <b>${createdRelease.id}</b> · ${createdRelease.status} · applied: no</span>
                  <a class="traj-link" href=${`${API_ROOT}/releases/${createdRelease.id}/export`}>download manifest</a>
                </div>
              ` : null}
              <p class="traj-hint">Agent regression runs DSH headless as a judge; it uses the DSH profile's model and may take minutes.</p>
              ${(summary.skills || []).length === 0
                ? html`<div class="traj-list-empty">No skill packages yet. Approve a proposal for regression first.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Skill</th><th>Role</th><th>Latest</th><th>Active</th><th>Status</th><th>Applied</th><th></th></tr></thead>
                    <tbody>
                      ${summary.skills.map((skill) => html`
                        <tr key=${skill.id}>
                          <td>${skill.name}</td>
                          <td>${skill.role}</td>
                          <td>v${skill.latestVersion ?? "—"}</td>
                          <td>${skill.activeVersion ? `v${skill.activeVersion}` : "—"}</td>
                          <td>${skill.latestStatus || "—"}</td>
                          <td>${skill.runtimeApplied
                            ? "runtime"
                            : (skill.canaryPercent ? `canary ${skill.canaryPercent}%` : (skill.applied ? "registry" : "no"))}
                            ${skill.labApplied ? " + lab" : (skill.labCanaryPercent ? ` + lab canary ${skill.labCanaryPercent}%` : "")}</td>
                          <td>
                            <button class="traj-link" onClick=${() => evaluateSkill(skill)}>
                              ${skillEvaluateId === skill.id ? "evaluating…" : "evaluate rubric"}
                            </button>
                            <button class="traj-link" onClick=${() => runAgentRegression(skill)}>
                              ${skillRegressingId === skill.id ? "regressing…" : "agent regression"}
                            </button>
                            ${skill.latestStatus === "agent_regressed" ? html`
                              <button class="traj-link" onClick=${() => {
                                setReleaseTarget(skill);
                                setReleaseReviewer("");
                                setReleaseNote("");
                                setCreatedRelease(null);
                              }}>release manifest</button>
                            ` : null}
                            ${skill.activeVersion ? html`
                              <button class="traj-link" onClick=${() => rollbackSkill(skill.id)}>
                                ${rollingBackSkillId === skill.id ? "rolling back…" : "rollback registry"}
                              </button>
                            ` : null}
                            <a class="traj-link" href=${`${API_ROOT}/skills/${skill.id}/export`}>export</a>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            <section class="traj-section">
              <h4>Agent regressions</h4>
              ${(summary.regressions || []).length === 0
                ? html`<div class="traj-list-empty">No agent-level regressions yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Skill</th><th>Version</th><th>Accuracy</th><th>F1</th><th>Labels</th><th>Created</th><th></th></tr></thead>
                    <tbody>
                      ${summary.regressions.map((regression) => html`
                        <tr key=${regression.id}>
                          <td>${regression.skillName}</td>
                          <td>v${regression.skillVersion}</td>
                          <td>${fmtPct(regression.accuracy)}</td>
                          <td>${fmtPct(regression.f1)}</td>
                          <td>${fmtInt(regression.labeled)}</td>
                          <td>${fmtTime(regression.createdAt)}</td>
                          <td>
                            <button class="traj-link" onClick=${() => openRegression(regression.id)}>detail</button>
                            <a class="traj-link" href=${`${API_ROOT}/regressions/${regression.id}/export`}>export</a>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            ${releaseTarget ? html`
              <section class="traj-section">
                <h4>Release manifest · ${releaseTarget.name}</h4>
                <form class="traj-dataset-form" onSubmit=${releaseSkill}>
                  <label>
                    <span>Reviewer</span>
                    <input value=${releaseReviewer} placeholder="name"
                        onInput=${(event) => setReleaseReviewer(event.target.value)} />
                  </label>
                  <label>
                    <span>Release note</span>
                    <textarea rows="4" value=${releaseNote}
                        placeholder="Why is this version ready for deployment review?"
                        onInput=${(event) => setReleaseNote(event.target.value)}></textarea>
                  </label>
                  <div class="traj-curation-actions">
                    <button class="btn primary" type="submit" disabled=${releaseSaving}>
                      ${releaseSaving ? "Packaging…" : "Create release manifest"}
                    </button>
                    <button class="btn ghost" type="button" onClick=${() => setReleaseTarget(null)}>Cancel</button>
                  </div>
                  <p class="traj-hint">
                    This creates a release_ready manifest only. It does not modify a DSH preset or mark the skill applied.
                  </p>
                </form>
              </section>
            ` : null}

            <section class="traj-section">
              <h4>Release manifests</h4>
              <p class="traj-hint">
                Registry activation is metadata only. Runtime apply adds the skill as a prompt overlay for
                matching MetaInfer DSH task agents; canary 10% is deterministic by task id, and promote 100%
                removes the sampling. "apply lab" writes the separate DSH Lab advisor/scheduler prompt overlay.
              </p>
              ${(summary.releases || []).length === 0
                ? html`<div class="traj-list-empty">No release manifests yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Skill</th><th>Version</th><th>Status</th><th>Reviewer</th><th>Applied</th><th></th></tr></thead>
                    <tbody>
                      ${summary.releases.map((release) => html`
                        <tr key=${release.id}>
                          <td>${release.skillName}</td>
                          <td>v${release.skillVersion}</td>
                          <td>${release.status}</td>
                          <td>${release.reviewer}</td>
                          <td>${release.applied ? "yes" : "no"}</td>
                          <td>
                            ${release.status === "release_ready" ? html`
                              <button class="traj-link" onClick=${() => activateRelease(release.skillId, release.id)}>
                                ${activatingReleaseId === release.id ? "activating…" : "activate registry"}
                              </button>
                            ` : null}
                            ${release.status === "active_registry" ? html`
                              <button class="traj-link" onClick=${() => applyRuntime(release.skillId, release.id, 10)}>
                                ${runtimeApplyingId === release.id ? "applying…" : "canary 10%"}
                              </button>
                              <button class="traj-link" onClick=${() => applyRuntime(release.skillId, release.id, 100)}>
                                apply 100%
                              </button>
                            ` : null}
                            ${release.status === "canary" ? html`
                              <button class="traj-link" onClick=${() => promoteRuntime(release.skillId)}>
                                ${runtimePromotingId === release.skillId ? "promoting…" : "promote 100%"}
                              </button>
                            ` : null}
                            ${release.status === "runtime_applied" || release.status === "canary" ? html`
                              <button class="traj-link" onClick=${() => loadCanary(release.skillId)}>canary evidence</button>
                              <button class="traj-link" onClick=${() => rollbackRuntime(release.skillId)}>
                                ${runtimeRollingBackId === release.skillId ? "rolling back…" : "rollback runtime"}
                              </button>
                            ` : null}
                            ${release.status === "active_registry" ? html`
                              <button class="traj-link" onClick=${() => applyLab(release.skillId, release.id, 10)}>
                                ${labApplyingId === release.id ? "applying lab…" : "lab canary 10%"}
                              </button>
                              <button class="traj-link" onClick=${() => applyLab(release.skillId, release.id, 100)}>
                                lab 100%
                              </button>
                            ` : null}
                            ${release.labCanaryPercent && !release.labApplied ? html`
                              <button class="traj-link" onClick=${() => promoteLab(release.skillId)}>
                                ${labPromotingId === release.skillId ? "promoting lab…" : "promote lab 100%"}
                              </button>
                            ` : null}
                            ${release.labCanaryPercent ? html`
                              <button class="traj-link" onClick=${() => loadLabCanary(release.skillId)}>lab evidence</button>
                            ` : null}
                            ${release.labApplied || release.labCanaryPercent ? html`
                              <button class="traj-link" onClick=${() => rollbackLab(release.skillId)}>
                                ${labRollingBackId === release.skillId ? "rolling back lab…" : "rollback lab"}
                              </button>
                            ` : null}
                            <a class="traj-link" href=${`${API_ROOT}/releases/${release.id}/export`}>export</a>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>

            ${regressionDetail || regressionDetailError ? html`
              <section class="traj-section">
                <h4>Regression detail</h4>
                ${regressionDetailError ? html`<div class="traj-page-error">${regressionDetailError}</div>` : null}
                ${regressionDetail ? html`
                  <div class="traj-created">
                    <span>${regressionDetail.skillName} v${regressionDetail.skillVersion} · accuracy ${fmtPct(regressionDetail.metrics?.accuracy)} · F1 ${fmtPct(regressionDetail.metrics?.f1)}</span>
                    <a class="traj-link" href=${`${API_ROOT}/regressions/${regressionDetail.id}/export`}>export</a>
                  </div>
                  <table class="traj-table">
                    <thead><tr><th>Session</th><th>Human</th><th>Judge</th><th>Reason / error</th></tr></thead>
                    <tbody>
                      ${(regressionDetail.items || []).map((item) => html`
                        <tr key=${item.sessionId}>
                          <td class="mono">${shortId(item.sessionId)}</td>
                          <td>${item.humanOutcome}</td>
                          <td>${item.predictedOutcome || "error"}</td>
                          <td>${item.error || item.reason || "—"}</td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                  <div class="traj-curation-actions">
                    <button class="btn ghost" onClick=${() => setRegressionDetail(null)}>Close detail</button>
                  </div>
                ` : null}
              </section>
            ` : null}

            ${canaryData || canaryError ? html`
              <section class="traj-section">
                <h4>Canary evidence</h4>
                ${canaryError ? html`<div class="traj-page-error">${canaryError}</div>` : null}
                ${canaryData ? html`
                  ${(canaryData.releases || []).map((release) => html`
                    <div key=${release.releaseId} class="traj-created">
                      <span class="mono">${release.releaseId}</span>
                      <span>${release.status} · ${fmtInt(release.canaryPercent)}%</span>
                      <span>pass ${fmtInt(release.outcomes?.pass)} · fail ${fmtInt(release.outcomes?.fail)} · uncertain ${fmtInt(release.outcomes?.uncertain)} · unreviewed ${fmtInt(release.outcomes?.unreviewed)}</span>
                    </div>
                  `)}
                  ${canaryReadiness ? html`
                    <div class="traj-created">
                      <span class=${canaryReadiness.ready ? "ok" : "err"}>
                        promotion ${canaryReadiness.ready ? "ready" : "blocked"}
                      </span>
                      <span>labeled ${fmtInt(canaryReadiness.labeled)} / ${fmtInt(canaryReadiness.minLabeled)} · failure rate ${fmtPct(canaryReadiness.failureRate)}</span>
                      <span>${(canaryReadiness.reasons || []).join("; ")}</span>
                    </div>
                  ` : null}
                  <button class="btn ghost" onClick=${() => { setCanaryData(null); setCanaryReadiness(null); }}>Close evidence</button>
                ` : null}
              </section>
            ` : null}

            ${labCanaryData || labCanaryError ? html`
              <section class="traj-section">
                <h4>Lab canary evidence</h4>
                ${labCanaryError ? html`<div class="traj-page-error">${labCanaryError}</div>` : null}
                ${labCanaryData ? html`
                  ${(labCanaryData.releases || []).map((release) => html`
                    <div key=${release.releaseId} class="traj-created">
                      <span class="mono">${release.releaseId}</span>
                      <span>${fmtInt(release.canaryPercent)}% · applied ${release.applied ? "yes" : "no"}</span>
                      <span>pass ${fmtInt(release.outcomes?.pass)} · fail ${fmtInt(release.outcomes?.fail)} · uncertain ${fmtInt(release.outcomes?.uncertain)} · unreviewed ${fmtInt(release.outcomes?.unreviewed)}</span>
                    </div>
                  `)}
                  ${labCanaryReadiness ? html`
                    <div class="traj-created">
                      <span class=${labCanaryReadiness.ready ? "ok" : "err"}>
                        Lab promotion ${labCanaryReadiness.ready ? "ready" : "blocked"}
                      </span>
                      <span>labeled ${fmtInt(labCanaryReadiness.labeled)} / ${fmtInt(labCanaryReadiness.minLabeled)} · failure rate ${fmtPct(labCanaryReadiness.failureRate)}</span>
                      <span>${(labCanaryReadiness.reasons || []).join("; ")}</span>
                    </div>
                  ` : null}
                  <button class="btn ghost" onClick=${() => { setLabCanaryData(null); setLabCanaryReadiness(null); }}>Close lab evidence</button>
                ` : null}
              </section>
            ` : null}

            <section class="traj-section">
              <h4>Reviewed sessions</h4>
              ${(summary.sessions || []).length === 0
                ? html`<div class="traj-list-empty">No reviewed sessions yet.</div>`
                : html`<table class="traj-table">
                    <thead><tr><th>Session</th><th>Outcome</th><th>Failure category</th><th>Preset</th></tr></thead>
                    <tbody>
                      ${summary.sessions.slice(0, 100).map((session) => html`
                        <tr key=${session.sessionId}>
                          <td><button class="traj-link" onClick=${() => onOpenSession(session.sessionId)}>${session.title || shortId(session.sessionId)}</button></td>
                          <td class=${session.annotation?.outcome === "fail" ? "bad" : ""}>${session.annotation?.outcome}</td>
                          <td>${session.annotation?.failureCategory || "—"}</td>
                          <td>${session.agentPreset || "—"}</td>
                        </tr>
                      `)}
                    </tbody>
                  </table>`}
            </section>
          `}
      </div>
    </div>
  `;
}

export function TrajectoryView({ onClose, initialQuery = "", projectId = "", projectName = "", repoPath = "" }) {
  const [health, setHealth] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listElapsedMs, setListElapsedMs] = useState(0);
  const [listError, setListError] = useState("");
  const [query, setQuery] = useState(initialQuery || "");
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [tab, setTab] = useState("analysis");
  const [annotation, setAnnotation] = useState(null);
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState("");
  const [annotationSaved, setAnnotationSaved] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [configRoot, setConfigRoot] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJson(`${API_ROOT}/health`)
      .then((data) => {
        if (cancelled) return;
        setHealth(data);
        setConfigRoot(data.root || "");
      })
      .catch((error) => { if (!cancelled) setListError(String(error.message || error)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const startedAt = Date.now();
    setListLoading(true);
    setListElapsedMs(0);
    setListError("");
    const progress = setInterval(() => {
      if (!cancelled) setListElapsedMs(Date.now() - startedAt);
    }, 500);
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
      clearInterval(progress);
      if (cancelled) return;
      setListError(`Still scanning after ${Math.round(LIST_TIMEOUT_MS / 1000)}s. The session index is incomplete; retry or narrow the search.`);
      setListLoading(false);
    }, LIST_TIMEOUT_MS);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
      if (query.trim()) params.set("q", query.trim());
      if (projectId) params.set("projectId", projectId);
      if (repoPath) params.set("repoPath", repoPath);
      const suffix = `?${params.toString()}`;
      getJson(`${API_ROOT}${suffix}`, { signal: controller.signal })
        .then((data) => {
          if (cancelled || timedOut) return;
          clearTimeout(deadline);
          clearInterval(progress);
          setSessions(data.sessions || []);
          setVisibleCount(Number(data.count ?? (data.sessions || []).length));
          setListError("");
          setListLoading(false);
          setSelectedId((current) => {
            if (current && (data.sessions || []).some((item) => item.id === current)) return current;
            return data.sessions?.[0]?.id || null;
          });
        })
        .catch((error) => {
          if (cancelled) return;
          if (timedOut || error?.name === "AbortError") {
            if (!timedOut) {
              setListError(`Still scanning after ${Math.round(LIST_TIMEOUT_MS / 1000)}s. The session index is incomplete; retry or narrow the search.`);
            }
          } else {
            setListError(String(error.message || error));
          }
          setListLoading(false);
          clearInterval(progress);
        });
    }, 200);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      clearInterval(progress);
    };
  }, [query, reloadTick, projectId, repoPath]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setAnnotation(null);
      return undefined;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError("");
    setAnnotation(null);
    setAnnotationError("");
    setAnnotationSaved(false);
    getJson(`${API_ROOT}/${encodeURIComponent(selectedId)}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setAnnotation({
          ...emptyAnnotation(selectedId),
          ...(data.annotation || {}),
        });
        setDetailLoading(false);
        setTab("analysis");
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailError(String(error.message || error));
        setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  const saveAnnotation = async () => {
    if (!selectedId || !annotation) return;
    setAnnotationSaving(true);
    setAnnotationError("");
    setAnnotationSaved(false);
    try {
      const saved = await postJson(
        `${API_ROOT}/${encodeURIComponent(selectedId)}/annotation`,
        annotation,
      );
      setAnnotation({ ...emptyAnnotation(selectedId), ...saved });
      setAnnotationSaved(true);
      setReloadTick((value) => value + 1);
    } catch (error) {
      setAnnotationError(String(error.message || error));
    } finally {
      setAnnotationSaving(false);
    }
  };

  const saveConfig = async (event) => {
    event.preventDefault();
    setConfigSaving(true);
    setConfigError("");
    try {
      const nextHealth = await postJson(`${API_ROOT}/config`, { root: configRoot });
      setHealth(nextHealth);
      setShowConfig(false);
      setReloadTick((value) => value + 1);
    } catch (error) {
      setConfigError(String(error.message || error));
    } finally {
      setConfigSaving(false);
    }
  };

  return html`
    <div class="traj-page">
      <div class="traj-page-head">
        <div>
          <h2>Trajectories</h2>
          <div class="traj-page-sub">
            <span>DSH only</span>
            ${projectId ? html`<span class="traj-project">project: ${projectName || projectId}</span>` : null}
            ${health ? html`<span class="mono">${health.root}</span>` : null}
            ${health ? html`<span class="traj-source">source: ${health.rootSource}</span>` : null}
            ${health ? html`<span class=${health.zstdAvailable ? "ok" : "err"}>
              ${health.zstdAvailable ? "zstd ready" : "zstd unavailable"}
            </span>` : null}
            ${health ? html`<span>${fmtInt(projectId ? visibleCount : health.sessionFiles)} sessions</span>` : null}
          </div>
        </div>
        <div class="traj-page-actions">
          <button class="btn ghost" onClick=${() => setShowLibrary(true)}>Library</button>
          <button class="btn ghost" onClick=${() => {
            setConfigRoot(health?.root || "");
            setConfigError("");
            setShowConfig((value) => !value);
          }}>Source</button>
          <button class="btn ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
      ${showConfig ? html`
        <form class="traj-config-bar" onSubmit=${saveConfig}>
          <label class="traj-config-field">
            <span>DSH sessions root</span>
            <input value=${configRoot} placeholder="/home/user/.dsh/sessions"
                onInput=${(event) => setConfigRoot(event.target.value)} />
          </label>
          <button class="btn primary" type="submit" disabled=${configSaving}>
            ${configSaving ? "Saving…" : "Save source"}
          </button>
          <button class="btn ghost" type="button" onClick=${() => setShowConfig(false)}>Cancel</button>
          <span class="traj-hint">
            ${health?.rootSource === "env"
              ? "DSH_SESSIONS_DIR is set; the environment override wins over this saved value."
              : "Saved under the platform node metadata directory."}
          </span>
          ${configError ? html`<span class="traj-error-text">${configError}</span>` : null}
        </form>
      ` : null}
      ${listLoading ? html`
        <div class="traj-page-progress" role="status" aria-live="polite">
          <div class="traj-progress-head">
            <span>Loading sessions… ${sessions.length} of ${health?.sessionFiles ?? "?"} files</span>
            <span class="traj-progress-elapsed">${Math.ceil(listElapsedMs / 1000)}s</span>
          </div>
          <div class="traj-progress-track" aria-hidden="true"><span class="traj-progress-fill"></span></div>
          <span class="traj-hint">Reading the session index (requesting up to ${LIST_PAGE_SIZE}); this page gives up after ${Math.round(LIST_TIMEOUT_MS / 1000)}s.</span>
        </div>
      ` : null}
      ${listError ? html`
        <div class="traj-page-error" role="alert">
          <span>${listError}</span>
          <button class="btn ghost" type="button" onClick=${() => setReloadTick((value) => value + 1)}>Retry</button>
        </div>
      ` : null}
      <div class="traj-body">
        <aside class="traj-sidebar">
          <input class="traj-search" type="search" placeholder="Search id, title, task, project, skill release, preset, model…"
              value=${query} onInput=${(event) => setQuery(event.target.value)} />
          <div class="traj-sidebar-count">
            ${sessions.length} shown${health ? ` / ${fmtInt(health.sessionFiles)} files` : ""}
          </div>
          <${SessionList} sessions=${sessions} selectedId=${selectedId} projectId=${projectId}
              onSelect=${setSelectedId} loading=${listLoading} error=${listError} />
        </aside>
        <section class="traj-main">
          <${Detail} detail=${detail} loading=${detailLoading} error=${detailError}
              tab=${tab} onTab=${setTab}
              annotation=${annotation} setAnnotation=${setAnnotation}
              onSaveAnnotation=${saveAnnotation}
              annotationSaving=${annotationSaving}
              annotationError=${annotationError}
              annotationSaved=${annotationSaved} />
        </section>
      </div>
      ${showLibrary ? html`
        <${Library} onClose=${() => setShowLibrary(false)}
          onOpenSession=${(id) => { setSelectedId(id); setShowLibrary(false); }} />
      ` : null}
    </div>
  `;
}
