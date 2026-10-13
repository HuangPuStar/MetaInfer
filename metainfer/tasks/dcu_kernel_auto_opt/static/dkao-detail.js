import { html } from "htm/preact";
import { useCallback, useEffect, useState } from "preact/hooks";
// Shell-owned plumbing shared by every auto-refreshing panel:
//   pollWhileVisible — stop polling while the tab is hidden, and let a panel
//     that describes finished history switch itself off (the AHE page mounts
//     this view once per iteration, so a finished round used to keep pulling
//     megabytes that could not change);
//   fetchJsonCached — coalesce the same URL across mounts and skip unchanged
//     bodies, so a poll that changes nothing costs a header exchange.
import { fetchJsonCached, UNCHANGED } from "app/api";
import { usePollWhileVisible as pollWhileVisible } from "app/utils";

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `${url} returned HTTP ${response.status}`);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Embedding context
// ---------------------------------------------------------------------------
// This view renders a DKAO run. Usually that is a task of this type, resolved
// by task_id. The AHE page also embeds it, pointing at one question of one
// iteration: those runs are spawned by the HE orchestrator and are not in the
// task registry, so the caller passes their artifact directory instead and the
// routes accept it (see routes.py -> _ahe_child_entry). Such an embedded view
// is read-only: the round's workers belong to the HE orchestrator.
//
// Every component below takes `ctx = { taskId, stateDir, readOnly }` so both
// the standalone page and the embedded one share one code path.
//
// The state dir is a *query parameter*, so it must stay at the END of the
// URL: every endpoint below is `<base>/<endpoint>` and FastAPI routes on the
// path alone. Handing callers a base that already carries `?state_dir=…`
// turns `${base}/summary` into `…?state_dir=<dir>/summary`, i.e. the endpoint
// is appended to the query value -- no route matches and the embedded view
// 404s on every lane (the standalone page is unaffected, since it passes no
// state dir). ``apiUrl`` therefore builds the whole URL and always appends
// the query last; keep it the single place that knows this rule.
export function apiBase({ taskId }) {
  return `/api/dcu-kernel-auto-opt/${encodeURIComponent(taskId || "")}`;
}

export function apiUrl(ctx, endpoint = "") {
  const base = apiBase(ctx);
  const query = ctx && ctx.stateDir
    ? `state_dir=${encodeURIComponent(ctx.stateDir)}`
    : "";
  if (!query) return `${base}${endpoint}`;
  // `endpoint` may carry its own query string already (e.g.
  // "/iterations?view=lanes"), so choose the separator rather than assuming
  // there is no "?" yet.
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${base}${endpoint}${sep}${query}`;
}

// The variant that may be shown as "current" for one shape: **this machine's
// own hardware profile only**. A variant measured on the other board is not
// comparable (air boards have no HBM address hashing, so read-heavy operators
// are 1.06-1.70x off), so a task on this board must show 无 -- exactly as the
// page did before the profile split -- rather than another profile's number.
// Writes are guarded server-side (``require_profile``); this is the read side
// of the same rule. ``index`` is a ``Map(shape -> variant record)``.
export function currentProfileVariant(index, shape, hwProfileId) {
  const variant = index ? index.get(shape) : null;
  if (!variant || !variant.profile || !hwProfileId) return null;
  return variant.profile === hwProfileId ? variant : null;
}

// The variant library that belongs to **this task**: the board the task's
// numbers were measured on, falling back to this machine's board only when the
// task carries no record of its own.
//
// This is not the same question as "which board is this machine": the task list
// lets an operator open any task, including one from the other board, and that
// page must show *that* board's library.  Filtering by the machine's profile
// made every liquid task look empty here.
export function displayProfile(taskHwProfile, machineHwProfile) {
  return taskHwProfile || machineHwProfile || null;
}

// Whether this page may write into the variant library.  The write lands in
// *this machine's* profile, so it is only meaningful when the task's numbers
// came from this board; the server enforces the same rule (409) -- this is the
// visible half, so the button is not offered at all.
export function canPromote(taskHwProfile, machineHwProfile) {
  if (!machineHwProfile) return false;
  return taskHwProfile === machineHwProfile;
}

// The same rule for the skill library: fusion and publishing write into
// ``~/.dsh/skills`` (this machine's edition, mirrored to Claude) while the
// pending skill's numbers were measured on the task's board, so a write may only
// be offered when the two agree -- a liquid task's findings fused on the air
// machine would be read as air knowledge. The server refuses the same thing with
// a 409; this is the visible half, so the button is not offered at all.
export function canWriteSkills(taskHwProfile, machineHwProfile) {
  return canPromote(taskHwProfile, machineHwProfile);
}

// ``Map(shape -> variant record)`` for ONE board, built from the raw index the
// route returns.
//
// Filtering here -- not only at render time -- is what makes the button and the
// "当前" column agree with reality: the route lists *both* profiles' records for
// the same shape (air first, liquid later), so a Map built straight from that
// list keeps the **liquid** record for every shared shape. Every row then still
// read "当前: 无" after this board's variant was added, and the same rows kept
// offering "加入 variant" instead of "更新 variant".
export function profileVariantIndex(variants, hwProfileId) {
  const index = new Map();
  if (!hwProfileId) return index;
  for (const variant of variants || []) {
    if (!variant || !variant.shape) continue;
    if (variant.profile !== hwProfileId) continue;
    index.set(variant.shape, variant);
  }
  return index;
}

function ctxOf(props) {
  return {
    taskId: props.taskId,
    stateDir: props.stateDir || "",
    readOnly: Boolean(props.readOnly),
  };
}

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

function metric(value, digits = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function statusClass(status) {
  if (status === "passed" || status === "completed") return "success";
  if (status?.startsWith("bootstrap_")) {
    return ["bootstrap_failed", "bootstrap_orphaned"].includes(status)
      ? "failed"
      : status === "bootstrap_passed" ? "success" : "running";
  }
  if (
    status === "running"
    || status === "validating"
    || status === "retrying"
    || status === "agent_running"
    || status === "building"
    || status === "baseline"
    || status === "validating_candidate"
    || status === "recording_result"
    || status === "optimization_complete"
    || status === "skill_writing"
  ) {
    return "running";
  }
  if (
    status === "failed"
    || status === "orphaned"
    || status === "timed_out"
    || status === "skipped"
  ) return "failed";
  return "idle";
}

function bestRoundPerShape(lanes) {
  const best = new Map();
  for (const lane of lanes || []) {
    for (const experiment of lane.experiments || []) {
      if (experiment.correctness_passed === false) continue;
      const median = Number(experiment.metrics?.median_us);
      if (!Number.isFinite(median) || !experiment.shape_id) continue;
      const accepted = experiment.accepted === true;
      let current = best.get(experiment.shape_id);
      if (!current) {
        current = { accepted: false, iteration: 0, median_us: Infinity };
      }
      // Prefer accepted ("best") rounds; among those, the lowest median.
      // Before the first acceptance, fall back to the best tested round.
      const preferred = accepted && !current.accepted;
      const better = accepted === current.accepted && median < current.median_us;
      const laterWinner = accepted === current.accepted
        && median === current.median_us
        && Number(experiment.iteration) > current.iteration;
      if (preferred || better || laterWinner) {
        best.set(experiment.shape_id, {
          accepted,
          worker_id: lane.worker_id,
          iteration: experiment.iteration,
          median_us: median,
          metrics: experiment.metrics || {},
          speedup: experiment.speedup,
          baseline_us: experiment.baseline_us,
        });
      }
    }
  }
  return best;
}

function ExploreGpuGrid({ lanes }) {
  return html`
    <div class="dkao-explore-summary">
      <div class="dkao-explore-heading">
        <strong>Parallel explore · live GPU lanes</strong>
        <span>Agent → compile → correctness → benchmark → record → skill</span>
      </div>
      <div class="dkao-explore-grid">
        ${lanes.map((lane) => {
          const completed = Number(lane.completed_rounds || 0);
          const target = Number(lane.target_rounds || 0);
          const progress = target
            ? Math.min(100, Math.round(completed / target * 100))
            : 0;
          const lastOutput = lane.agent?.last_output_age_s;
          return html`
            <article class="dkao-explore-gpu ${lane.long_running ? "stale" : ""}">
              <header>
                <div>
                  <strong>GPU ${lane.gpu}</strong>
                  <small>${lane.worker_id}</small>
                </div>
                <span class="pill ${statusClass(lane.state)}">${lane.state}</span>
              </header>
              <p class="dkao-explore-step">${lane.step}</p>
              <dl>
                <dt>Shape</dt>
                <dd>${lane.current_shape || lane.assigned_shapes?.join(", ") || "—"}</dd>
                <dt>Round</dt>
                <dd>${completed} / ${target || "—"}</dd>
                <dt>Agent output</dt>
                <dd>${Number.isFinite(Number(lastOutput))
                  ? `${metric(lastOutput, 0)} s ago`
                  : "—"}</dd>
              </dl>
              <div class="dkao-explore-progress">
                <span style=${`width:${progress}%`}></span>
              </div>
              ${lane.long_running ? html`
                <small class="dkao-explore-warning">
                  No Agent output for over 3 minutes; the lane timeout guard is active.
                </small>
              ` : null}
              ${lane.agent?.error ? html`
                <small class="dkao-explore-warning">${lane.agent.error}</small>
              ` : null}
            </article>
          `;
        })}
      </div>
    </div>
  `;
}

function BootstrapResultCard({ attempt }) {
  const files = attempt.generated_files || [];
  const shapeEntries = Object.entries(attempt.metrics || {});
  const shapeMetrics = shapeEntries.map(([, item]) => item);
  const medians = shapeMetrics
    .map((item) => Number(item?.median_us))
    .filter((item) => Number.isFinite(item));
  const medianRange = medians.length
    ? `${Math.min(...medians).toFixed(3)}–${Math.max(...medians).toFixed(3)} µs`
    : "—";
  return html`
    <div class="dkao-iteration-card ${attempt.status === "passed" ? "accepted" : ""}">
      <div class="dkao-iteration-title">
        <strong>Bootstrap ${attempt.attempt}</strong>
        <span class="pill ${statusClass(attempt.status)}">${attempt.status}</span>
      </div>
      <dl>
        <dt>Elapsed</dt><dd>${metric(attempt.elapsed_s, 1)} s</dd>
        <dt>Last output</dt><dd>${metric(attempt.last_output_age_s, 1)} s ago</dd>
        <dt>Files</dt><dd>${files.length}</dd>
        <dt>Verified</dt><dd>${shapeMetrics.length} shapes</dd>
        <dt>Median</dt><dd>${medianRange}</dd>
        <dt>Code snapshot</dt>
        <dd>${attempt.artifact_dir || "—"}</dd>
      </dl>
      ${shapeEntries.map(([shapeId, metrics]) => html`
        <div class="dkao-bootstrap-shape-metrics">
          <strong>${shapeId}</strong>
          <dl>
            <dt>Correct</dt>
            <dd>
              <span class="pill ${metrics?.passed ? "success" : "failed"}">
                ${metrics?.passed ? "PASS" : "FAIL"}
              </span>
            </dd>
            <dt>Median</dt><dd>${metric(metrics?.median_us)} µs</dd>
            <dt>P90</dt><dd>${metric(metrics?.p90_us)} µs</dd>
            <dt>INT8 TOPS</dt>
            <dd>${metric(metrics?.logical_tops ?? metrics?.tflops, 3)}</dd>
            <dt>Algorithmic BW</dt>
            <dd>${metric(metrics?.algorithmic_bandwidth_gb_s ?? metrics?.bandwidth_gb_s, 1)} GB/s</dd>
          </dl>
        </div>
      `)}
      ${attempt.error ? html`<small>${attempt.error}</small>` : null}
    </div>
  `;
}

function IterationCard({ experiment }) {
  const metrics = experiment.metrics || {};
  return html`
    <div class="dkao-iteration-card ${experiment.accepted ? "accepted" : ""}">
      <div class="dkao-iteration-title">
        <strong>Round ${experiment.iteration}</strong>
        <span class="pill ${experiment.accepted ? "success" : "idle"}">
          ${experiment.accepted ? "best" : "tested"}
        </span>
      </div>
      <dl>
        <dt>Shape</dt><dd>${experiment.shape_id || "—"}</dd>
        <dt>Correct</dt>
        <dd>
          <span class="pill ${experiment.correctness_passed ? "success" : "failed"}">
            ${experiment.correctness_passed ? "PASS" : "FAIL"}
          </span>
        </dd>
        <dt>P90</dt><dd>${metric(metrics.p90_us)} µs</dd>
        <dt>INT8 TOPS</dt>
        <dd>${metric(metrics.logical_tops ?? metrics.tflops, 3)}</dd>
        <dt>Algorithmic BW</dt>
        <dd>${metric(metrics.algorithmic_bandwidth_gb_s ?? metrics.bandwidth_gb_s, 1)} GB/s</dd>
        <dt>Counter HBM BW</dt>
        <dd>${metric(experiment.pmc_evidence?.memory_traffic?.counter_derived_hbm_bandwidth_gb_s, 1)} GB/s</dd>
        <dt>Baseline</dt><dd>${metric(experiment.baseline_us)} µs</dd>
        <dt>Speedup</dt><dd>${metric(experiment.speedup, 3)}×</dd>
        <dt>Test Time</dt><dd>${metric(metrics.median_us)} µs</dd>
        <dt>Code snapshot</dt>
        <dd>${experiment.artifact_dir || "—"}</dd>
      </dl>
      ${experiment.failure_reason
        ? html`<small>${experiment.failure_reason}</small>` : null}
    </div>
  `;
}

function RunningIterationCard({ active }) {
  const activity = active.state === "profiling_current_best"
    ? "profiling"
    : active.state === "repairing_candidate"
      ? "repairing"
      : active.state === "validating_candidate"
        ? "validating"
        : "optimizing";
  return html`
    <div class="dkao-iteration-card running">
      <div class="dkao-iteration-title">
        <strong>Round ${active.iteration}</strong>
        <span class="pill running">${activity}</span>
      </div>
      <dl>
        <dt>Shape</dt><dd>${active.shape_id || "—"}</dd>
        <dt>Step</dt><dd>${active.step || "Agent optimizing kernel"}</dd>
        ${active.state === "repairing_candidate"
          ? html`<dt>Repair</dt><dd>${active.repair || 0}/${active.max_repairs || 4}</dd>`
          : null}
        <dt>Agent</dt><dd>${active.agent_status || "running"}</dd>
        <dt>Elapsed</dt><dd>${metric(active.elapsed_s, 1)} s</dd>
        <dt>Output</dt>
        <dd>${Number.isFinite(Number(active.last_output_age_s))
          ? `${metric(active.last_output_age_s, 1)} s ago`
          : "waiting"}</dd>
      </dl>
      <div class="dkao-running-pulse"><span></span></div>
    </div>
  `;
}

function PlanCard({ experiment }) {
  return html`
    <div class="dkao-plan-card ${experiment.manual_guidance ? "manual" : ""}">
      <div class="dkao-plan-title">
        <strong>Round ${experiment.iteration}</strong>
        ${experiment.manual_guidance
          ? html`<span class="pill active">manual</span>`
          : html`<span class="pill idle">agent</span>`}
      </div>
      <p>${experiment.hypothesis || "No optimization plan recorded."}</p>
      ${(experiment.changes || []).length
        ? html`<small>${experiment.changes.join(" · ")}</small>` : null}
    </div>
  `;
}

function BootstrapPlanCard({ attempt }) {
  const files = attempt.generated_files || [];
  return html`
    <div class="dkao-plan-card">
      <div class="dkao-plan-title">
        <strong>Bootstrap ${attempt.attempt}</strong>
        <span class="pill ${statusClass(attempt.status)}">${attempt.status}</span>
      </div>
      <p>${attempt.hypothesis}</p>
      ${files.length ? html`<small>${files.join(" · ")}</small>` : null}
      ${attempt.error ? html`<small>${attempt.error}</small>` : null}
    </div>
  `;
}

function GuidanceCard({ item }) {
  return html`
    <div class="dkao-plan-card guidance ${item.status}">
      <div class="dkao-plan-title">
        <strong>${item.status === "pending" ? "Next round" : `Round ${item.consumed_iteration}`}</strong>
        <span class="pill ${item.status === "pending" ? "running" : "success"}">
          ${item.status}
        </span>
      </div>
      <p>${item.text}</p>
      <small>Manual optimization guidance</small>
    </div>
  `;
}

function WorkerLane({ lane, ctx, onSaved }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim() || saving || !lane.assigned) return;
    setSaving(true);
    setMessage("");
    try {
      await postJson(
        apiUrl(ctx, `/workers/${encodeURIComponent(lane.worker_id)}/guidance`),
        { text: text.trim() },
      );
      setText("");
      setMessage("Queued for this worker's next round.");
      await onSaved();
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSaving(false);
    }
  };
  const restart = async () => {
    if (restarting || !["failed", "timed_out"].includes(lane.state)) return;
    if (!window.confirm(
      `Restart ${lane.worker_id} on GPU ${lane.gpu}? Other GPU workers will keep running.`,
    )) return;
    setRestarting(true);
    setMessage("");
    try {
      await postJson(
        apiUrl(ctx, `/workers/${encodeURIComponent(lane.worker_id)}/restart`),
        {},
      );
      setMessage(`Restarted on GPU ${lane.gpu}; sibling workers were not interrupted.`);
      await onSaved();
    } catch (err) {
      setMessage(String(err));
    } finally {
      setRestarting(false);
    }
  };
  const pending = (lane.guidance || []).filter((item) => item.status === "pending");
  const bootstrap = lane.bootstrap_attempts || [];
  const rounds = lane.experiments || [];
  const currentIteration = Number(lane.current_iteration || 0);
  const currentShape = lane.current_shape;
  const activeStates = new Set([
    "profiling_current_best",
    "agent_running",
    "validating_candidate",
    "repairing_candidate",
    "recording_result",
  ]);
  const currentRecorded = rounds.some((item) =>
    Number(item.iteration || 0) === currentIteration
      && item.shape_id === currentShape
  );
  const active = lane.active_iteration || (
    currentIteration > 0
      && activeStates.has(lane.state)
      && !currentRecorded
      ? {
          iteration: currentIteration,
          shape_id: currentShape,
          state: lane.state,
          step: lane.step,
          agent_name: lane.agent?.name,
          agent_status: lane.agent?.status,
          elapsed_s: lane.agent?.elapsed_s,
          last_output_age_s: lane.agent?.last_output_age_s,
          repair: lane.repair,
          max_repairs: lane.max_repairs,
        }
      : null
  );
  return html`
    <div class="dkao-worker-lane ${lane.assigned ? "" : "unassigned"}">
      <div class="dkao-worker-meta">
        <strong>${lane.worker_id}</strong>
        <span>GPU ${lane.gpu}</span>
        <span class="pill ${statusClass(lane.state)}">
          ${lane.state}
        </span>
        <small>${lane.assigned_shapes?.join(", ") || "No shapes assigned"}</small>
        ${!ctx.readOnly && ["failed", "timed_out"].includes(lane.state) ? html`
          <button
            class="btn dkao-restart-worker"
            type="button"
            disabled=${restarting}
            onClick=${restart}
          >${restarting ? "Restarting…" : "Restart worker"}</button>
        ` : null}
      </div>
      <div class="dkao-lane-section">
        <div class="dkao-lane-heading">
          <strong>Iteration results</strong>
          <span>
            ${bootstrap.length} bootstrap · ${rounds.length} completed
            ${active ? " · 1 optimizing" : ""}
          </span>
        </div>
        <div class="dkao-iteration-strip">
          ${bootstrap.map((item) => html`<${BootstrapResultCard} attempt=${item} />`)}
          ${rounds.map((item) => html`<${IterationCard} experiment=${item} />`)}
          ${active ? html`<${RunningIterationCard} active=${active} />` : null}
          ${!bootstrap.length && !rounds.length && !active
            ? html`<p class="muted">${lane.assigned ? "Waiting for iteration 1." : "Worker not assigned."}</p>`
            : null}
        </div>
      </div>
      <div class="dkao-lane-section dkao-plan-section">
        <div class="dkao-lane-heading">
          <strong>Optimization plans</strong>
          <span>${bootstrap.length + rounds.length} recorded · ${pending.length} pending</span>
        </div>
        <div class="dkao-plan-strip">
          ${bootstrap.map((item) => html`<${BootstrapPlanCard} attempt=${item} />`)}
          ${rounds.map((item) => html`<${PlanCard} experiment=${item} />`)}
          ${(lane.guidance || [])
            .filter((item) => item.status === "pending")
            .map((item) => html`<${GuidanceCard} item=${item} />`)}
          ${!bootstrap.length && !rounds.length && !(lane.guidance || []).length
            ? html`<p class="muted">No plan recorded.</p>` : null}
        </div>
        ${ctx.readOnly ? null : html`
        <form class="dkao-guidance-form" onSubmit=${submit}>
          <input
            value=${text}
            onInput=${(event) => setText(event.currentTarget.value)}
            placeholder="Guide this GPU worker in its next round…"
            maxlength="4000"
            disabled=${!lane.assigned || saving}
          />
          <button class="btn btn-primary" type="submit" disabled=${!text.trim() || !lane.assigned || saving}>
            ${saving ? "Saving…" : "Use next round"}
          </button>
        </form>`}
        ${message ? html`<small class="dkao-guidance-message">${message}</small>` : null}
      </div>
    </div>
  `;
}

function SkillFile({ skill, canPublish, canFuse, onPublish, onFuse, busy, pending }) {
  return html`
    <details class="dkao-skill-file">
      <summary>
        <span>
          <strong>${skill.name}</strong>
          <small>${skill.kind} · ${skill.source}</small>
        </span>
        ${canFuse ? html`
          <button
            class="btn"
            type="button"
            disabled=${busy === `fuse-${skill.name}`}
            onClick=${(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFuse(skill);
            }}
          >${busy === `fuse-${skill.name}` ? "Fusing…" : "融合到 Skill 库"}</button>
        ` : null}
        ${canPublish ? html`
          <button
            class="btn btn-primary"
            type="button"
            disabled=${busy === `publish-${skill.name}`}
            onClick=${(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPublish(skill);
            }}
          >${busy === `publish-${skill.name}` ? "Adding…" : "Add to existing"}</button>
        ` : (pending ? null : html`<span class="pill success">existing</span>`)}
      </summary>
      <pre>${skill.content}</pre>
    </details>
  `;
}

function SkillFuseStatus({ status, onRollback }) {
  if (!status || status.status === "idle") return null;
  if (status.status === "running") {
    return html`<div class="task-banner"><span class="spin"></span> 融合中…（主 agent 正在扫描 skill 库并决策）</div>`;
  }
  if (status.status === "error") {
    return html`<div class="task-banner task-banner-err">融合失败: ${status.error || "unknown error"}</div>`;
  }
  const synced = status.synced_to_ccb;
  return html`
    <div class="task-banner">
      融合完成：${status.action === "merge" ? `已融入 "${status.name}"` : `新增 skill "${status.name}"`}
      ${synced && (synced.added?.length || synced.updated?.length)
        ? ` · 已同步到 ccb 库${synced.added?.length ? `（新增 ${synced.added.length}）` : ""}${synced.updated?.length ? `（更新 ${synced.updated.length}）` : ""}`
        : ""}
      ${status.action === "merge" && onRollback ? html`
        <button class="btn" type="button"
          onClick=${() => onRollback(status.name)}>还原</button>
      ` : null}
      ${status.diff ? html`
        <details class="dkao-skill-diff"><summary>查看 diff</summary><pre>${status.diff}</pre></details>
      ` : null}
    </div>
  `;
}

function SkillLibrary({ ctx, onClose }) {
  const [library, setLibrary] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // Writes land in *this machine's* edition of the library, so the task's own
  // board must be the same one (``write_blocked_reason`` is the server's verdict
  // and outranks this comparison; the server also returns 409).
  const machineProfile = library?.hw_profile || "";
  const taskProfile = library?.task_hw_profile || "";
  const canWrite = Boolean(library) && !ctx.readOnly
    && !library.write_blocked_reason
    && canWriteSkills(taskProfile, machineProfile);
  const profileName = (id) => {
    if (!id) return "未知";
    const found = (library?.profiles || []).find((item) => item.id === id);
    if (!found) return id;
    if (found.cooled === "air") return "风冷";
    if (found.cooled === "liquid") return "液冷";
    return found.label || id;
  };
  const load = useCallback(async () => {
    try {
      setLibrary(await fetchJson(apiUrl(ctx, "/skills")));
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, [ctx.taskId, ctx.stateDir]);
  useEffect(() => { load(); }, [load]);
  // While a fusion job is running, poll the library so the status flips to
  // done/error without a manual refresh.
  useEffect(() => {
    if (!library || library.fuse_status?.status !== "running") return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [library, load]);
  const publish = async (skill) => {
    if (!window.confirm(`Add "${skill.name}" to the existing skill library (dsh, mirrored to Claude)?`)) return;
    setBusy(`publish-${skill.name}`);
    try {
      await postJson(
        apiUrl(ctx, `/skills/${encodeURIComponent(skill.name)}/publish`), {},
      );
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };
  const fuse = async (skill) => {
    if (!window.confirm(
      `Have the main agent fuse "${skill.name}" into the existing skill library?`
    )) return;
    setBusy(`fuse-${skill.name}`);
    try {
      await postJson(apiUrl(ctx, "/skills/fuse"),
                     { skill_name: skill.name });
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };
  const syncNow = async () => {
    setBusy("sync");
    try {
      await postJson(apiUrl(ctx, "/skills/sync"), {});
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };
  const rollback = async (name) => {
    if (!window.confirm(`Restore the last backup of skill "${name}"?`)) return;
    setBusy(`rollback-${name}`);
    try {
      await postJson(apiUrl(ctx, `/skills/${encodeURIComponent(name)}/rollback`),
                     {});
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy("");
    }
  };
  return html`
    <section class="panel dkao-skill-library">
      <div class="dkao-skill-library-title">
        <div>
          <h2>Skill library</h2>
          <p class="muted">dsh 库为权威，融合/发布后自动同步到 Claude (ccb) 库。</p>
        </div>
        ${ctx.readOnly ? null : html`
        <button class="btn" type="button" disabled=${busy === "sync"}
          onClick=${syncNow}>${busy === "sync" ? "Syncing…" : "同步 Skill 库"}</button>`}
        <button class="btn" type="button" onClick=${onClose}>Close</button>
      </div>
      ${error ? html`<div class="task-banner task-banner-err">${error}</div>` : null}
      ${ctx.readOnly ? html`
        <div class="task-banner dkao-readonly-banner">
          只读镜像 —— 该 DKAO 运行是 harness_evolve 的一轮考题，由 HE 编排器调度；
          本页不提供引导 / 重启 / 发布等写操作。
        </div>
      ` : null}
      ${library?.publish_disabled_reason ? html`
        <div class="task-banner task-banner-err">
          ${library.publish_disabled_reason}
          ${library.quarantined_count
            ? ` (${library.quarantined_count} pending files quarantined)` : ""}
        </div>
      ` : null}
      ${!ctx.readOnly && library && !canWrite ? html`
        <div class="task-banner task-banner-err">
          ${taskProfile
            ? `不可写入：此任务是【${profileName(taskProfile)}档】，本机是【${profileName(machineProfile)}档】 —— 融合/发布只会写进本机档的 skill 库，会把别档的数值当成这一档的知识。请在【${profileName(taskProfile)}档】的机器上操作。`
            : "不可写入：此任务没有档位记录（先跑一次 backfill_task_hw_profile）。"}
        </div>
      ` : null}
      <${SkillFuseStatus} status=${library?.fuse_status}
        onRollback=${ctx.readOnly ? null : rollback} />
      ${!library ? html`<p class="muted">Loading skills…</p>` : html`
        <div class="dkao-skill-columns">
          <div class="dkao-skill-column">
            <h3>Existing skills <span>${library.existing?.length || 0}</span></h3>
            <p class="muted">${library.existing_root}</p>
            <div class="dkao-skill-list">
              ${(library.existing || []).map((skill) => html`
                <${SkillFile} skill=${skill} canPublish=${false} />
              `)}
            </div>
          </div>
          <div class="dkao-skill-column pending">
            <h3>Pending skills <span>${library.pending?.length || 0}</span></h3>
            <p class="muted">Worker skills and the main-agent merged skill.</p>
            <div class="dkao-skill-list">
              ${(library.pending || []).map((skill) => html`
                <${SkillFile}
                  skill=${skill}
                  pending=${true}
                  canPublish=${canWrite}
                  canFuse=${canWrite}
                  busy=${busy}
                  onPublish=${publish}
                  onFuse=${fuse}
                />
              `)}
              ${!(library.pending || []).length
                ? html`<p class="muted">No pending skills.</p>` : null}
            </div>
          </div>
        </div>
      `}
    </section>
  `;
}

export default function DcuKernelAutoOptDetail(props) {
  const { taskId, data } = props;
  const ctx = ctxOf(props);
  const readOnly = ctx.readOnly;
  const [runtime, setRuntime] = useState({ summary: null, graph: null, lanes: [] });
  const [error, setError] = useState(null);
  const [showSkills, setShowSkills] = useState(false);
  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      // Poll the cheap change detector first.  fetchJsonCached returns
      // UNCHANGED when the body is byte-identical, so an unchanged signature
      // short-circuits the heavy payloads (/summary ~0.6 MB + /iterations
      // ~5.7 MB on a multi-worker task).  Before this gate the panel pulled
      // ~6 MB every 3 s, which is what made the page feel stuck.
      //
      // The gate and the server agree by construction: /iterations is tagged
      // with the very same signature, so "signature unchanged" and "the lane
      // payload is unchanged" are now the same statement -- and it covers the
      // round feeds (workers/*/runs/*/experiments.jsonl) that decide whether
      // the list is actually current.
      const signature = await fetchJsonCached(apiUrl(ctx, "/state-signature"));
      if (signature === UNCHANGED) return;
      const [summary, graph, iterations] = await Promise.all([
        fetchJsonCached(apiUrl(ctx, "/summary")),
        fetchJsonCached(apiUrl(ctx, "/state-graph")),
        // `view=lanes` drops the per-round fields no browser code reads
        // (candidate_isa and friends): 19.7 -> 6.0 MB on the heaviest task.
        // The server still serves the full body by default, so this is the
        // list view opting into a smaller cut, not a contract change.
        fetchJsonCached(apiUrl(ctx, "/iterations?view=lanes")),
      ]);
      // 304 for all three: nothing to re-render, and no state churn.
      if (summary === UNCHANGED && graph === UNCHANGED
          && iterations === UNCHANGED) {
        setError(null);
        return;
      }
      setRuntime((prev) => ({
        summary: summary === UNCHANGED ? prev.summary : summary,
        graph: graph === UNCHANGED ? prev.graph : graph,
        lanes: iterations === UNCHANGED ? prev.lanes
                                        : (iterations.workers || []),
      }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [ctx.taskId, ctx.stateDir]);

  useEffect(() => { refresh(); }, [refresh]);

  // A finished run is immutable history: keep the panel live only while the
  // run can still move, and never while the tab is in the background.
  const innerRun = runtime.summary && runtime.summary.run;
  pollWhileVisible(refresh, 3000, {
    enabled: !innerRun || !innerRun.finished,
  });

  // ---- variant library (加入 variant 按钮) ------------------------------ //
  const [variantBusy, setVariantBusy] = useState("");
  const [variantMsg, setVariantMsg] = useState("");
  const [variantIndex, setVariantIndex] = useState(null); // null = loading
  // Two different profiles are in play, and conflating them was a bug:
  //   * this machine's board (``hwProfileId``) -- where a write would land;
  //   * the board **this task** was measured on (``taskHwProfileId``) -- whose
  //     library this page must show.
  // Variants live per profile (variant/<profile>/…) because a median measured
  // on an air board is not comparable with one measured on a liquid board: air
  // boards lack HBM address hashing, so read-heavy operators are 40-87% slower
  // there.
  const [currentProfile, setCurrentProfile] = useState(null);
  const [taskProfile, setTaskProfile] = useState(null);
  const [variantProfiles, setVariantProfiles] = useState(null);
  const hwProfileId = currentProfile ? currentProfile.hw_profile : null;
  const taskHwProfileId = taskProfile ? taskProfile.task_hw_profile : null;
  // Which library the rows describe: the task's own board.
  const shownProfileId = displayProfile(taskHwProfileId, hwProfileId);
  const mayPromote = canPromote(taskHwProfileId, hwProfileId);
  const profileName = (id) => {
    if (!id) return "未知";
    if (id === "unmigrated") return "未分档";
    const p = variantProfiles ? variantProfiles.get(id) : null;
    if (!p) return id;
    if (p.cooled === "air") return "风冷";
    if (p.cooled === "liquid") return "液冷";
    return p.label || id;
  };
  // Display lookup: the task's own board -- see ``currentProfileVariant``.
  const variantFor = (shape) => currentProfileVariant(
    variantIndex, shape, shownProfileId
  );
  const loadVariants = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await fetchJsonCached(apiUrl(ctx, "/variants"));
      if (data === UNCHANGED) return;
      // Map shape -> variant record (incl. median_us/speedup/source/profile)
      // so the update flow can compare the existing variant against this task.
      // Only the shown board's records go in (see ``profileVariantIndex``): the
      // list holds both boards' records for the same shape.
      const machine = data.hw_profile ? data.hw_profile.hw_profile : null;
      const shown = displayProfile(
        data.task_hw_profile, machine
      );
      setVariantIndex(profileVariantIndex(data.variants, shown));
      setVariantProfiles(new Map((data.profiles || []).map((p) => [p.id, p])));
      setCurrentProfile(data.hw_profile || null);
      setTaskProfile({
        task_hw_profile: data.task_hw_profile || "",
        task_hw_profile_source: data.task_hw_profile_source || "",
      });
    } catch (err) { /* non-fatal */ }
  }, [ctx.taskId, ctx.stateDir]);
  useEffect(() => { loadVariants(); }, [loadVariants]);
  // The library changes only when a round promotes a kernel, so no reason to
  // ask every 3s; a minute keeps the "已有 variant" hint honest.
  pollWhileVisible(loadVariants, 60000);
  // "加入 variant" follows the liquid board's mechanism: this profile's existing
  // variant is replaced only by a **faster** candidate, and a slower one is not
  // added at all. The server enforces the same rule (``add_variant``'s
  // ``reject_slower_than_existing``); checking it here as well means the
  // operator gets the verdict immediately instead of after a round trip, and a
  // refusal reads as a decision rather than as an error.
  const addVariant = async (shape) => {
    if (!mayPromote) {
      // The write would land in this machine's profile while the numbers came
      // from the task's board (server-side 409 for the same reason).
      setVariantMsg(
        taskHwProfileId
          ? `未加入：此任务是【${profileName(taskHwProfileId)}档】，`
            + `本机是【${profileName(hwProfileId)}档】—— 它的数字不能写进本机档。`
          : "未加入：此任务没有档位记录，先跑一次 "
            + "`python3 -m metainfer.server.tools.backfill_task_hw_profile --apply`。"
      );
      return;
    }
    const existing = variantFor(shape);
    const candidate = bestRoundPerShape(runtime.lanes).get(shape) || {};
    const newUs = candidate.median_us;
    const oldUs = existing ? existing.median_us : null;
    const profileLabel = `${profileName(hwProfileId)}档`;
    if (existing && newUs != null && oldUs != null && newUs > oldUs) {
      setVariantMsg(
        `未加入：本次 ${metric(newUs)} µs 慢于本档已有 variant 的`
        + ` ${metric(oldUs)} µs —— ${profileLabel}保留更快的那一条。`
      );
      return;
    }
    if (existing) {
      const verdict = newUs == null || oldUs == null
        ? ""
        : newUs < oldUs ? "（本次更快）" : "（持平）";
      const ok = window.confirm(
        `该算子已有 variant：median ${oldUs ?? "?"} µs`
        + `（来源 ${existing.source || "?"}）。\n`
        + `本次候选：median ${newUs ?? "?"} µs ${verdict}。\n`
        + "用本次候选替换？旧文件会备份（.bak-*）。"
      );
      if (!ok) return;
    }
    setVariantBusy(shape);
    setVariantMsg("");
    try {
      const res = await postJson(apiUrl(ctx, "/variants"),
                                 { shape_id: shape });
      const meta = res.meta || {};
      const tp = meta.tp != null ? `tp${meta.tp}` : "tp?";
      setVariantMsg(
        `已加入 variant: ${meta.type} | ${meta.model} | ${tp} | ${meta.operator}`
        + `（${res.action === "updated" ? "更替本档更慢的那一条" : "新增"}）`
      );
      await loadVariants();
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      setVariantMsg(
        // The server refuses a slower candidate (the guard above may not see
        // it: the candidate number shown here is the lane's best round, the
        // server reads the accepted kernel's own manifest).
        /slower variant replacement/i.test(detail)
          ? `未加入：服务端判定本次候选不优于${profileLabel}已有 variant`
            + `（保留更快的那一条）。`
          : `加入 variant 失败: ${detail}`
      );
    } finally {
      setVariantBusy("");
    }
  };

  const report = runtime.summary?.report;
  const run = runtime.summary?.run;
  const stopped = run?.final_status === "stopped";
  const stopReason = (run?.notes || []).join(" · ") || "The optimizer stopped before completion.";
  const smokeOnly = report?.mode === "real-agent-dcu-smoke"
    || ["Real agents + DCU (smoke harness)", "Infrastructure smoke (not operator optimization)"]
      .includes(runtime.summary?.plan?.execution_mode);
  const repoPath = runtime.summary?.plan?.kernel_repo;
  const repoName = repoPath ? String(repoPath).split("/").pop() : null;
  // ---- kernel repo rename ------------------------------------------- //
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameMsg, setRenameMsg] = useState("");
  const renameRepo = async () => {
    if (!repoName) return;
    const target = window.prompt(
      "新的仓库名（kernel-repos/ 下的目录名）:", repoName
    );
    if (!target || target.trim() === "" || target.trim() === repoName) return;
    setRenameBusy(true);
    setRenameMsg("");
    try {
      const res = await postJson(apiUrl(ctx, "/rename-repo"), {
        new_name: target.trim(),
      });
      setRenameMsg(`已重命名: ${res.old_name} → ${res.new_name}`);
      await refresh();
    } catch (err) {
      setRenameMsg(`重命名失败: ${String(err)}`);
    } finally {
      setRenameBusy(false);
    }
  };
  const bestRounds = bestRoundPerShape(runtime.lanes);
  const shapeOrder = new Map(
    (runtime.summary?.plan?.shapes || []).map((item, index) => [item.id, index]),
  );
  const bestRoundEntries = Array.from(bestRounds.entries())
    .sort(([a], [b]) => (shapeOrder.get(a) ?? 1e9) - (shapeOrder.get(b) ?? 1e9));
  // Rounds whose speedup had to be recomputed against this board's baseline
  // (the run itself used another hardware profile's number). Shown as a
  // footnote rather than silently swapped numbers.
  const rebasedRows = bestRoundEntries.filter(
    ([, item]) => item.recorded_speedup != null
  );
  return html`
    <div class="dkao-detail">
      ${error ? html`<div class="task-banner task-banner-err">${error}</div>` : null}
      ${readOnly ? html`
        <div class="task-banner dkao-readonly-banner">
          只读镜像 —— 该 DKAO 运行是 harness_evolve 的一轮考题，由 HE 编排器调度；
          本页不提供引导 / 重启 / 发布等写操作。
        </div>
      ` : null}
      ${smokeOnly ? html`
        <div class="task-banner task-banner-err">
          Infrastructure smoke only: this task did not execute the selected
          operator. Its metrics and generated skills are not valid operator
          optimization results.
        </div>
      ` : null}
      ${stopped ? html`
        <div class="task-banner task-banner-err">
          <strong>Task stopped in ${run?.current_phase || "startup"}:</strong>
          ${stopReason}
        </div>
      ` : null}

      ${repoName ? html`
        <section class="panel dkao-repo-panel">
          <h2>
            Kernel repository
            <span class="muted"> — ${repoName}</span>
          </h2>
          ${readOnly ? null : html`
          <div class="dkao-repo-actions">
            <button
              class="btn"
              disabled=${renameBusy}
              onClick=${renameRepo}
            >${renameBusy ? "Renaming…" : "重命名仓库"}</button>
            ${renameMsg ? html`<span class="dkao-rename-msg">${renameMsg}</span>` : null}
          </div>`}
        </section>
      ` : null}

      <section class="panel dkao-profile-panel">
        <h2>
          执行画像
          <span class="muted">
            — ${runtime.summary?.execution_profile === "production"
              ? "production（优先级 100，排在 harness_evolve 之前；仍过 VRAM≤90%/HCU==0 闸门）"
              : "default（调控/占据模式按 gpu_mode 决定）"}
          </span>
        </h2>
        ${(() => {
          const lease = runtime.summary?.gpu_leases || {};
          const gpus = lease.gpus || [];
          const gate = runtime.summary?.gate || {};
          return html`
            ${gpus.length ? html`
              <div class="muted">
                已租设备：${gpus.map((g) => `GPU${g}`).join(", ")}
                · 模式 ${lease.mode || "-"}
                · 优先级 ${lease.priority ?? "-"}
                · holder <code>${lease.holder || "-"}</code>
              </div>
            ` : html`<div class="muted">尚未取得设备租约</div>`}
            ${gate.blocked ? html`
              <div class="muted">
                准入闸门：共 ${gate.checks} 次检查，其中 ${gate.blocked} 次因设备被占用而等待
                — 最近一次 ${gate.last_event || "-"}@${gate.last_site || "-"}
                GPU${gate.last_gpu ?? "-"}：${(gate.last_reasons || []).join("; ") || "-"}
              </div>
            ` : html`<div class="muted">准入闸门：暂无阻塞记录（VRAM≤90% 且 HCU==0）</div>`}
          `;
        })()}
      </section>

      <section class="panel dkao-state-panel">
        <h2>
          State machine
          <span class="muted"> — currently: </span>
          <span class="dkao-current-phase">
            ${(() => {
              const nodes = runtime.graph?.nodes || [];
              const cur = runtime.graph?.current;
              const node = nodes.find(n => n.id === cur);
              return node ? node.label : (cur || "starting");
            })()}
          </span>
        </h2>
        <${StateMachine} graph=${runtime.graph} />
        ${runtime.graph?.current === "parallel_explore" ? html`
          <${ExploreGpuGrid} lanes=${runtime.lanes} />
        ` : null}
      </section>

      <section class="panel dkao-iterations-panel">
        <h2>Iterations <span class="muted">four isolated worker lanes</span></h2>
        <div class="dkao-worker-lanes">
          ${runtime.lanes.map((lane) => html`
            <${WorkerLane} lane=${lane} ctx=${ctx} onSaved=${refresh} />
          `)}
        </div>
      </section>

      <section class="panel dkao-validation-panel">
        <h2>Final serial validation</h2>
        ${bestRoundEntries.length ? html`
          <h3 class="dkao-validation-subtitle">
            Best optimization round per shape
            <span>accepted “best” round from each worker lane</span>
          </h3>
          <p class="dkao-hw-note">
            本机硬件档：<span class="dkao-hw-chip ${hwProfileId === "air-k100ai" ? "air" : hwProfileId === "liquid-k500sm" ? "liquid" : "unknown"}">${profileName(hwProfileId)}</span>
            ${hwProfileId ? html`<span class="muted">（${hwProfileId}${currentProfile && currentProfile.machine ? " @ " + currentProfile.machine : ""}）</span>` : html`<span class="muted">（未识别：写入会被拒绝，见 wiki-metainfer/knowledge-packs.md §3）</span>`}
            ${shownProfileId && shownProfileId !== hwProfileId ? html`
              <br />此任务硬件档：<span class="dkao-hw-chip ${shownProfileId === "air-k100ai" ? "air" : shownProfileId === "liquid-k500sm" ? "liquid" : "unknown"}">${profileName(shownProfileId)}</span>
              <span class="muted">（${shownProfileId}；下面的 variant 与超基线数字都是这一档测的，**不可**与本机档比较，本机也不能把它的结果写进本机档）</span>
            ` : null}
            ${shownProfileId ? html`<span class="muted">　variant 按档存放，跨档数字不可比较</span>` : null}
          </p>
          <table class="iter-table">
            <thead>
              <tr><th>Shape</th><th>Worker</th><th>Best round</th><th>Performance</th><th>Speedup</th><th>INT8 TOPS</th><th>Algorithmic BW</th><th>Variant</th></tr>
            </thead>
            <tbody>
              ${bestRoundEntries.map(([shape, item]) => html`
                <tr>
                  <td>${shape}</td>
                  <td>${item.worker_id}</td>
                  <td class="perf-cell">${item.iteration ?? "—"}</td>
                  <td class="perf-cell">${metric(item.median_us)} µs</td>
                  <td>${metric(item.speedup, 3)}×${item.recorded_speedup != null
                    ? html`<span class="muted" title=${item.baseline_note || ""}> *</span>`
                    : null}</td>
                  <td>${metric(item.metrics.logical_tops ?? item.metrics.tflops, 3)}</td>
                  <td>${metric(item.metrics.algorithmic_bandwidth_gb_s ?? item.metrics.bandwidth_gb_s, 2)} GB/s</td>
                  <td>
                    ${readOnly ? null : !mayPromote ? html`
                      <div class="dkao-variant-status muted">
                        ${taskHwProfileId
                          ? `不可写入：此任务是【${profileName(taskHwProfileId)}档】，本机是【${profileName(hwProfileId)}档】`
                          : "不可写入：此任务没有档位记录（先跑一次 backfill_task_hw_profile）"}
                      </div>
                    ` : html`
                    <button class="btn" type="button"
                      disabled=${variantBusy === shape}
                      onClick=${() => addVariant(shape)}>
                      ${variantBusy === shape
                        ? "处理中…"
                        : variantFor(shape)
                          ? `更新 variant（${profileName(hwProfileId)}档）`
                          : `加入 variant（${profileName(hwProfileId)}档）`}
                    </button>`}
                    ${(() => {
                      const v = variantFor(shape);
                      if (!v) {
                        return html`<div class="dkao-variant-status muted">当前: 无</div>`;
                      }
                      const value = v.speedup != null
                        ? html`超基线 ${metric(v.speedup, 2)}x`
                        : v.median_us != null ? html`${metric(v.median_us)} µs` : "—";
                      return html`<div class="dkao-variant-status">当前: ${value}</div>`;
                    })()}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
          ${rebasedRows.length ? html`
            <p class="muted dkao-baseline-note">
              * 带 * 的 speedup 已按【本机档】baseline 重算（与 variant 同一把尺，
              所以"当前: 超基线"应与它一致）。本任务运行时用的判据是另一档的 baseline：
              ${rebasedRows.map(([shape, item]) => html`
                <span class="dkao-rebased">
                  ${shape} ${item.recorded_speedup != null ? metric(item.recorded_speedup, 3) : "—"}×
                  （${metric(item.recorded_baseline_us)} µs）
                </span>
              `)}
              —— 两档数字不可比较；历史报告文件未被改动。
            </p>
          ` : null}
          ${variantMsg ? html`<p class="muted dkao-variant-msg">${variantMsg}</p>` : null}
        ` : null}
        ${report ? html`
          <table class="iter-table">
            <thead>
              <tr><th>Shape</th><th>Worker</th><th>Performance</th><th>INT8 TOPS</th><th>Algorithmic BW</th><th>Result</th></tr>
            </thead>
            <tbody>
              ${Object.entries(report.final_validation || {}).map(([shape, item]) => html`
                <tr>
                  <td>${shape}</td>
                  <td>${item.worker_id || bestRounds.get(shape)?.worker_id || "—"}</td>
                  <td class="perf-cell">${metric(item.metrics?.median_us ?? item.median_us)} µs</td>
                  <td>${metric(item.metrics?.logical_tops ?? item.metrics?.tflops ?? item.logical_tops, 3)}</td>
                  <td>${metric(
                    item.metrics?.algorithmic_bandwidth_gb_s
                      ?? item.metrics?.bandwidth_gb_s
                      ?? item.algorithmic_bandwidth_gb_s,
                    2,
                  )} GB/s</td>
                  <td><span class="pill ${item.passed ? "success" : "failed"}">${item.passed ? "PASS" : "FAIL"}</span></td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`<p class="muted">Final validation has not started.</p>`}
      </section>

      <section class="panel dkao-events-panel">
        <h2>Event timeline</h2>
        <div class="dkao-events">
          ${(data?.timeline?.events || []).map((event) => html`
            <div><code>${event.type}</code><span>${JSON.stringify(event.payload || {})}</span></div>
          `)}
        </div>
      </section>

      <section class="panel dkao-skill-entry">
        <div>
          <h2>Optimization skill library</h2>
          <p class="muted">Inspect worker findings and the main-agent synthesis, then publish manually.</p>
        </div>
        <button class="btn btn-primary" type="button" onClick=${() => setShowSkills(true)}>
          View skill library
        </button>
        ${readOnly ? html`<p class="muted">以只读方式嵌入：不提供发布/同步操作。</p>` : null}
      </section>

      ${showSkills ? html`
        <${SkillLibrary} ctx=${ctx} onClose=${() => setShowSkills(false)} />
      ` : null}
    </div>
  `;
}
