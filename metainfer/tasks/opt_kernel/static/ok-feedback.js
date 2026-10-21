// Operator feedback panel — lets a human submit direction-level guidance
// during a running opt-kernel task. Submitted opinions are persisted
// (state_dir/user_feedback.jsonl) and injected into EVERY subsequent
// planner prompt until the run ends ("持久指导").
//
// The panel shows a textarea + submit button, plus the thread of already
// submitted opinions (with submit time and which iteration it was sent at),
// polled every few seconds so other tabs' submissions show up too.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getFeedback, postFeedback } from "app/ok-runtime-api";

function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function FeedbackPanel({ taskId }) {
  const [entries, setEntries] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    if (!taskId) return;
    try {
      const d = await getFeedback(taskId);
      setEntries(d.entries || []);
    } catch (e) { /* swallow — poll retries */ }
  };

  useEffect(() => {
    load();
    if (!taskId) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [taskId]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    setErr(null);
    try {
      await postFeedback(taskId, t);
      setText("");
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
  };

  return html`
    <div class="panel feedback-panel">
      <h2>Operator feedback
        <span class="muted" style="font-size:12px;font-weight:normal">
          持久指导 · 注入到之后每轮 planner
        </span>
      </h2>
      <p class="muted" style="font-size:12px;margin:0 0 8px">
        提交的意见会作为常驻指令注入到<strong>之后每一轮</strong>规划者的
        prompt，直到任务结束。适合方向性建议（如"优先减小显存占用"、
        "关注大 batch 吞吐"）。
      </p>
      <div class="feedback-form">
        <textarea
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${onKeyDown}
          placeholder="向正在运行的优化任务提意见…（Ctrl/⌘+Enter 提交）"
          rows="3"></textarea>
        <button onClick=${submit} disabled=${sending || !text.trim()}>
          ${sending ? "提交中…" : "提交意见"}
        </button>
      </div>
      ${err ? html`<p style="color:var(--err);font-size:12px">${err}</p>` : null}

      <div class="feedback-thread">
        ${entries.length === 0
          ? html`<p class="muted" style="font-size:12px">尚无意见。</p>`
          : entries.map((e) => html`
            <div class="feedback-item" key=${e.id}>
              <div class="feedback-item-head">
                <span class="muted" style="font-size:11px">
                  ${fmtTs(e.ts)}
                  ${e.iteration_at_submit != null
                    ? html` · 提交于第 ${e.iteration_at_submit} 轮` : null}
                </span>
              </div>
              <div class="feedback-item-text">${e.text}</div>
            </div>
          `)}
      </div>
      ${entries.length > 0
        ? html`<p class="muted" style="font-size:11px;margin-top:8px">
            共 ${entries.length} 条意见 · orchestrator 在每轮 A_plan 读取全部并注入
          </p>`
        : null}
    </div>
  `;
}
