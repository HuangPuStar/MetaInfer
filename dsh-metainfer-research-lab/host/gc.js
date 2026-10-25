import { randomUUID } from 'node:crypto';

/**
 * GC (after-care) runner: after a deterministic termination, spawn one cheap
 * lab-gc agent to explain what happened and flag leftovers. It never participates
 * in killing or resource release — those happen in runtime.terminate().
 */
const GC_SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string' },
    leftovers: { type: 'array', items: { type: 'string' } },
    cleanupRequested: { type: 'boolean' },
    recommendation: {
      type: 'string',
      enum: ['retry', 'split_into_smaller_nodes', 'extend_timebox', 'abandon_branch', 'none'],
    },
    summary: { type: 'string' },
  },
  required: ['cause', 'leftovers', 'cleanupRequested', 'recommendation', 'summary'],
  additionalProperties: false,
};

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function gcPrompt(project, node, termination) {
  const payload = {
    project: { name: project.name, brief: project.brief },
    node: {
      id: node.id,
      title: node.title,
      prompt: node.prompt,
      timeboxMinutes: Math.round((node.timeboxMs ?? 0) / 60_000),
      needs: node.needs ?? {},
      worktreePath: node.git?.worktreePath,
      lastReport: node.report?.summary ?? node.reportText ?? null,
      error: node.error ?? null,
      followUps: node.followUps?.length ?? 0,
    },
    termination,
  };
  return [
    'You are the post-mortem and cleanup agent (GC) of MetaInfer Research Lab.',
    'The deterministic watchdog already killed this node\'s agent tree and processes; the Host has',
    'already released its resources. You never decide whether to kill anything. Read the report below,',
    'inspect the worktree read-only if useful, and produce a short postmortem.',
    '',
    'Rules:',
    '1. Explain the likely cause (task too large, wrong approach, tool hang, environment issue).',
    '2. Report leftovers from the Reaper report; if something still looks leaked, say exactly what.',
    '3. Recommend one of: retry / split_into_smaller_nodes / extend_timebox / abandon_branch / none.',
    '4. Keep it factual and short; submit via structured_output.',
    '',
    '# Report',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

/**
 * @param {{ctx: object, store: object, orchestrator: object}} deps
 */
export function createGcRunner({ ctx, store, orchestrator }) {
  const inFlight = new Set();
  const lifetime = new AbortController();

  async function run(projectId, nodeId, termination) {
    const key = `${projectId}__${nodeId}`;
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    try {
      const project = store.getProject(projectId);
      const node = store.getNode(projectId, nodeId);
      if (!project || !node) return null;
      const controller = await orchestrator.ensureController(project);
      const id = `run-${Math.random().toString(36).slice(2, 10)}`;
      const sessionId = `session-${randomUUID()}`;
      const record = {
        id,
        projectId,
        cycleId: null,
        role: 'gc',
        sessionId,
        model: null,
        status: 'running',
        inputSnapshot: { nodeId, termination },
        startedAt: Date.now(),
      };
      await store.saveRun(projectId, record);
      let result = null;
      let failure = null;
      let activation;
      try {
        activation = await ctx.subagents.startActivation({
          provider: 'spawn',
          label: `mirl-gc/${projectId}/${nodeId}`,
          delivery: 'caller',
          signal: lifetime.signal,
          childId: sessionId,
          request: {
            parent: controller,
            cwd: project.repo.path,
            prompt: [{ type: 'text', text: gcPrompt(project, node, termination) }],
            agentPreset: 'lab-gc',
            outputSchema: GC_SCHEMA,
          },
        });
        result = await Promise.race([
          activation.result,
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('gc run timed out')), 120_000);
            timer.unref?.();
          }),
        ]);
        if (result?.stopReason !== 'completed') failure = new Error(`gc stopped: ${result?.stopReason}`);
      } catch (error) {
        failure = error;
      } finally {
        if (activation) {
          try {
            await activation.dispose();
          } catch {
            // already settled
          }
        }
      }
      record.endedAt = Date.now();
      if (failure) {
        record.status = 'failed';
        record.error = failure instanceof Error ? failure.message : String(failure);
      } else {
        record.status = 'completed';
        record.output = result?.structured ?? null;
        if (!record.output) record.rawText = blocksText(result?.output);
      }
      await store.saveRun(projectId, record);
      const current = store.getNode(projectId, nodeId);
      if (current) {
        current.termination = { ...(current.termination ?? termination), gcRunId: id, gcPostmortem: record.output ?? null };
        await store.saveNode(projectId, current);
        const fresh = store.getProject(projectId);
        if (fresh) {
          await store.appendEvent(fresh, 'gc/finished', {
            runId: id,
            nodeId,
            data: { status: record.status, recommendation: record.output?.recommendation ?? null },
          });
          await store.saveProject(fresh);
        }
      }
      return record;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  }

  function dispose() {
    lifetime.abort();
  }

  return { run, dispose };
}
