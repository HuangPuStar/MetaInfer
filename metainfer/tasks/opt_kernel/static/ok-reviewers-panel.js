// Dual-reviewer panel for opt-kernel.
//
// Shows the two parallel reviewer outputs (correctness + performance)
// side by side, with markdown rendering. Falls back to the merged
// review.md if individual reviews aren't available.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { marked } from "marked";
import { getReviews } from "app/ok-runtime-api";

function ReviewerCard({ title, tag, tagClass, markdown, loading }) {
  let body;
  if (loading) {
    body = html`<p class="muted">loading…</p>`;
  } else if (!markdown) {
    body = html`<p class="muted">no review yet</p>`;
  } else {
    const html_ = marked.parse(markdown || "");
    body = html`<div class="review-md" dangerouslySetInnerHTML=${{ __html: html_ }}></div>`;
  }
  return html`
    <div class="reviewer-card">
      <h4>
        ${title}
        <span class="reviewer-tag ${tagClass}">${tag}</span>
      </h4>
      ${body}
    </div>
  `;
}

export function ReviewersPanel({ taskId, iteration }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (taskId == null || iteration == null) return;
    let alive = true;
    setData(null);
    setErr(null);
    getReviews(taskId, iteration)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [taskId, iteration]);

  if (iteration == null) {
    return html`
      <div class="panel">
        <h2>Reviews</h2>
        <p class="muted">Select an iteration to see reviewer output.</p>
      </div>
    `;
  }

  if (err) {
    return html`
      <div class="panel">
        <h2>Reviews — iteration ${iteration}</h2>
        <p style="color:var(--err)">failed to load reviews: ${String(err)}</p>
      </div>
    `;
  }

  const loading = !data;
  const hasReviews = data && data.has_reviews;
  const cr = data && data.correctness;

  return html`
    <div class="panel">
      <h2>Dual reviews — iteration ${iteration}</h2>
      ${cr ? html`
        <div class="correctness-banner ${cr.all_correct ? "pass" : "fail"}">
          ${cr.all_correct
            ? html`<strong>✓ 正确性裁决通过</strong> ${cr.n_pass}/${cr.n_pass + (cr.n_fail || 0)} 个 shape 全部正确`
            : html`<strong>✗ 正确性裁决未通过</strong> ${cr.n_pass}/${cr.n_pass + (cr.n_fail || 0)} 正确，${cr.n_fail} 个失败`}
        </div>
      ` : null}
      ${!hasReviews && !loading
        ? html`<p class="muted">No reviews yet. The D-phase runs two parallel
            reviewers (correctness + performance) after the C-step.</p>`
        : null}
      <div class="reviewers-grid">
        <${ReviewerCard}
          title="Reviewer A"
          tag="correctness"
          tagClass=""
          markdown=${data?.review_a}
          loading=${loading} />
        <${ReviewerCard}
          title="Reviewer B"
          tag="performance"
          tagClass="perf"
          markdown=${data?.review_b}
          loading=${loading} />
      </div>
      ${data?.review_merged
        ? html`<details style="margin-top:12px">
            <summary class="muted">Merged review.md (fed to next iteration)</summary>
            <div class="review-md" style="margin-top:8px"
              dangerouslySetInnerHTML=${{ __html: marked.parse(data.review_merged) }}></div>
          </details>`
        : null}
    </div>
  `;
}
