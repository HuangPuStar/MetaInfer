// Retrospective modal for evolve-kernel.
//
// Runs are driven by an LLM loop, and each iteration writes a short prose
// retrospective (what it tried, what it measured, what to do next). That is
// the one artifact a human can read to judge *why* a run is where it is, but
// until now the detail page never surfaced it. Rows in the Iteration Progress
// table open this modal; the backend returns a placeholder when an iteration
// has no retro file, so the modal is always informative.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { marked } from "marked";
import { getRetrospective } from "app/ok-runtime-api";

export function RetrospectiveModal({ taskId, iteration, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (taskId == null || iteration == null) return;
    let alive = true;
    setData(null);
    setErr(null);
    getRetrospective(taskId, iteration)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [taskId, iteration]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    if (iteration != null) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [iteration, onClose]);

  if (iteration == null) return null;

  let body;
  if (err) {
    body = html`<p style="color:var(--err)">failed to load retrospective: ${String(err)}</p>`;
  } else if (!data) {
    body = html`<p class="muted">loading…</p>`;
  } else {
    const rendered = marked.parse(data.markdown || "");
    body = html`<div class="retro-md" dangerouslySetInnerHTML=${{ __html: rendered }}></div>`;
  }

  return html`
    <div class="modal-overlay open" onClick=${(e) => {
      if (e.target === e.currentTarget) onClose && onClose();
    }}>
      <div class="modal">
        <div class="modal-header">
          <h3>
            Iteration ${iteration} retrospective
            ${data && !data.has_retrospective
              ? html`<span class="ok-badge yellow">no retro file</span>`
              : null}
          </h3>
          <button class="close" onClick=${onClose} title="close (Esc)">×</button>
        </div>
        <div class="modal-body">${body}</div>
      </div>
    </div>
  `;
}
