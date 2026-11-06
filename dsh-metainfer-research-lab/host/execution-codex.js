/**
 * Official Codex SDK driver.
 *
 * The SDK wraps the local `codex` CLI and exposes streamed thread/turn/item
 * events, structured output, usage, and resumable thread ids.
 */
import { Codex } from '@openai/codex-sdk';

function parseReport(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(text)) !== null) candidates.push(match[1].trim());
  candidates.push(text.trim());
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Not the final JSON block.
    }
  }
  return null;
}

/**
 * Run one Codex turn in a local worktree.
 * @param {object} options task, cwd, model, signal, event sink.
 * @returns {Promise<{threadId: string|null, finalResponse: string, report: object|null, usage: object|null}>}
 */
export async function runCodexExecution({
  cwd,
  prompt,
  outputSchema,
  model,
  reasoningEffort,
  codexPath,
  signal,
  onEvent,
  threadId,
}) {
  const codex = new Codex(codexPath ? { codexPathOverride: codexPath } : undefined);
  const threadOptions = {
    workingDirectory: cwd,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
  };
  const thread = threadId ? codex.resumeThread(threadId, threadOptions) : codex.startThread(threadOptions);
  const streamed = await thread.runStreamed(prompt, {
    ...(outputSchema ? { outputSchema } : {}),
    ...(signal ? { signal } : {}),
  });
  let finalResponse = '';
  let usage = null;
  for await (const event of streamed.events) {
    if (typeof onEvent === 'function') await onEvent(event);
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
      finalResponse = event.item.text || finalResponse;
    } else if (event?.type === 'turn.completed') {
      usage = event.usage ?? usage;
    } else if (event?.type === 'turn.failed' || event?.type === 'error') {
      throw new Error(event.error?.message || event.message || 'Codex turn failed');
    }
  }
  return {
    threadId: thread.id ?? null,
    finalResponse,
    report: parseReport(finalResponse),
    usage,
  };
}
