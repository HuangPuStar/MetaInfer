// Fetch helpers for harness_evolve's task-specific endpoints.
// Mounted by the shell at /api/harness-evolve/<id>/*.

const TASK_BASE = (taskId) =>
  `/api/harness-evolve/${encodeURIComponent(taskId)}`;

export async function getSummary(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/summary`);
  if (!r.ok) throw new Error(`summary: ${r.status}`);
  return r.json();
}

export async function getIterations(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations`);
  if (!r.ok) throw new Error(`iterations: ${r.status}`);
  return r.json();
}

export async function getStateGraph(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/state-graph`);
  if (!r.ok) throw new Error(`state-graph: ${r.status}`);
  return r.json();
}

export async function getChildren(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/children`);
  if (!r.ok) throw new Error(`children ${n}: ${r.status}`);
  return r.json();
}

export async function getDkaoChild(taskId, n, child) {
  const r = await fetch(`${TASK_BASE(taskId)}/dkao/${n}/${encodeURIComponent(child)}`);
  if (!r.ok) throw new Error(`dkao ${child}: ${r.status}`);
  return r.json();
}

// Continue the experiment toward a target round count (dynamic: call again
// while it runs to raise/lower the target).
export async function resumeExperiment(taskId, target = null, iterations = null,
                                      championIteration = null) {
  const body = {};
  if (target != null) body.target = Number(target);
  if (iterations != null) body.iterations = Number(iterations);
  if (championIteration != null) body.champion_iteration = Number(championIteration);
  const r = await fetch(`${TASK_BASE(taskId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `resume: ${r.status}`);
  return payload;
}

export async function getOverview(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/overview`);
  if (!r.ok) throw new Error(`overview ${n}: ${r.status}`);
  return r.text();
}

// Stop the run and leave it restartable: brings down the supervisor, the
// running DKAO children and the orchestrator, and records an operator stop so
// nothing restarts it automatically. Resume ("启动续跑至目标") clears that.
export async function stopExperiment(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/stop`, { method: "POST" });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `stop: ${r.status}`);
  return payload;
}

// Unattended mode: run to a target round with automatic incident handling.
export async function startAutopilot(taskId, target = null,
                                     championIteration = null,
                                     diagnose = true) {
  const body = { diagnose_agent: Boolean(diagnose) };
  if (target != null) body.target = Number(target);
  if (championIteration != null) body.champion_iteration = Number(championIteration);
  const r = await fetch(`${TASK_BASE(taskId)}/autopilot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `autopilot: ${r.status}`);
  return payload;
}

export async function getSupervisor(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/supervisor`);
  if (!r.ok) throw new Error(`supervisor: ${r.status}`);
  return r.json();
}

export async function stopSupervisor(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/supervisor/stop`, { method: "POST" });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `stop: ${r.status}`);
  return payload;
}

export async function getReview(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/review`);
  if (!r.ok) throw new Error(`review: ${r.status}`);
  return r.json();
}

// Read-only device cards for one iteration: which device each question was
// handed to, plus what that child's own DKAO admission gate says.
export async function getIterationGpu(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/gpu`);
  if (!r.ok) throw new Error(`gpu ${n}: ${r.status}`);
  return r.json();
}

// Human approval of a candidate harness (nothing reaches DKAO without it).
export async function getPromotion(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/promotion`);
  if (!r.ok) throw new Error(`promotion: ${r.status}`);
  return r.json();
}

export async function approvePromotion(taskId, by = "operator") {
  const r = await fetch(`${TASK_BASE(taskId)}/promotion/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `approve: ${r.status}`);
  return payload;
}

export async function denyPromotion(taskId, reason = "operator") {
  const r = await fetch(`${TASK_BASE(taskId)}/promotion/deny`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload.detail || `deny: ${r.status}`);
  return payload;
}
