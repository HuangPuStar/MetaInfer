// Fetch helpers for opt-kernel's task-specific endpoints.
//
// All routes live under /api/opt-kernel/<id>/* (mounted by the shell
// from this task's server router). The shell api.js intentionally does
// NOT know about these — every task package owns its own runtime fetcher.

const TASK_BASE = (taskId) =>
  `/api/opt-kernel/${encodeURIComponent(taskId)}`;

export async function getIterations(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations`);
  if (!r.ok) throw new Error(`iterations: ${r.status}`);
  return r.json();
}

export async function getIteration(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}`);
  if (!r.ok) throw new Error(`iteration ${n}: ${r.status}`);
  return r.json();
}

export async function getRetrospective(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/retrospective`);
  if (!r.ok) throw new Error(`retro ${n}: ${r.status}`);
  return r.json();
}

export async function getReviews(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/reviews`);
  if (!r.ok) throw new Error(`reviews ${n}: ${r.status}`);
  return r.json();
}

export async function getProfile(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/iterations/${n}/profile`);
  if (!r.ok) throw new Error(`profile ${n}: ${r.status}`);
  return r.json();
}

export async function getCharts(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/charts`);
  if (!r.ok) throw new Error(`charts: ${r.status}`);
  return r.json();
}

export async function getStateGraph(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/state-graph`,
                        { cache: "no-store" });
  if (!r.ok) throw new Error(`state-graph: ${r.status}`);
  return r.json();
}

export async function getAhe(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/ahe`, { cache: "no-store" });
  if (!r.ok) throw new Error(`ahe: ${r.status}`);
  return r.json();
}

export async function getAheDetail(taskId, n) {
  const r = await fetch(`${TASK_BASE(taskId)}/ahe/detail/${n}`,
                        { cache: "no-store" });
  if (!r.ok) throw new Error(`ahe detail ${n}: ${r.status}`);
  return r.json();
}

export async function getFeedback(taskId) {
  const r = await fetch(`${TASK_BASE(taskId)}/feedback`,
                        { cache: "no-store" });
  if (!r.ok) throw new Error(`feedback: ${r.status}`);
  return r.json();
}

export async function postFeedback(taskId, text) {
  const r = await fetch(`${TASK_BASE(taskId)}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`post feedback: ${r.status}`);
  return r.json();
}
