/**
 * Transcript reader: converts one node session's model-visible surface into flat
 * rows for the UI drawer. Reads through `ctx.sessionQuery.readSurface`, which is
 * live-preferred and works for ended sessions too.
 */
import { LabError } from './git-engine.js';

function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * @param {{ctx: object, store: object}} deps
 */
export function createTranscriptReader({ ctx, store }) {
  /**
   * @param {string} projectId
   * @param {string} nodeId
   * @param {number|string|undefined} afterSeq
   * @returns {Promise<{rows: object[], nextSeq: number, running: boolean, unavailable?: boolean}>}
   */
  async function read(projectId, nodeId, afterSeq) {
    const node = store.getNode(projectId, nodeId);
    if (!node) throw new LabError('node_not_found', `unknown node: ${nodeId}`, 404);
    const after = Number.isFinite(Number(afterSeq)) ? Math.max(0, Math.trunc(Number(afterSeq))) : 0;
    if (!node.sessionId) return { rows: [], nextSeq: after, running: false };

    let snapshot;
    try {
      snapshot = await ctx.sessionQuery.readSurface(node.sessionId);
    } catch {
      return { rows: [], nextSeq: after, running: node.status === 'running', unavailable: true };
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    const rows = [];
    for (const event of events) {
      const seq = event?.seq;
      if (!Number.isFinite(seq) || seq <= after) continue;
      const at = event?.time;
      const data = event?.data ?? {};
      if (event.type === 'user/message') {
        const text = textOf(data.content);
        if (text) rows.push({ seq, at, kind: 'user', text });
      } else if (event.type === 'assistant/message') {
        const content = data.message?.content ?? [];
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            rows.push({ seq, at, kind: 'assistant', text: block.text });
          } else if (block?.type === 'reasoning' && block.text) {
            rows.push({ seq, at, kind: 'reasoning', text: block.text });
          } else if (block?.type === 'tool-call') {
            rows.push({ seq, at, kind: 'tool', name: block.name, args: block.arguments });
          }
        }
      } else if (event.type === 'tool/result') {
        rows.push({
          seq,
          at,
          kind: 'tool-result',
          name: data.message?.toolCallId ? undefined : undefined,
          text: textOf(data.message?.content),
          error: Boolean(data.message?.isError),
        });
      }
    }
    rows.sort((a, b) => a.seq - b.seq || (a.at ?? 0) - (b.at ?? 0));
    const lastSeq = rows.length > 0 ? Math.max(...rows.map((row) => row.seq)) : after;
    const captured = Number.isFinite(snapshot?.capturedThroughSeq)
      ? Math.max(lastSeq, snapshot.capturedThroughSeq)
      : lastSeq;
    return { rows, nextSeq: captured, running: node.status === 'running' };
  }

  return { read };
}
