/**
 * Child half of the B27 restart probe. Run in a fresh Node process against the
 * file domain the parent wrote; it must restore keys, resolve an appeal and
 * execute the irreversible action without the parent's in-memory registry.
 */
import { openStore } from '../../host/store.js';
import { createKernel } from '../../host/kernel/instance.js';
import { createLabService } from '../../host/lab-service.js';
import { registerAgentTool } from '../../host/agent-tool.js';
import { isIssuedActorKey } from '../../host/kernel/actors.js';
import { actorForSession } from '../../host/kernel/policy.js';
import { storeContext } from './memory-domain.mjs';
import { createJsonFileDomain } from './json-file-domain.mjs';

const [file, projectId, humanKey, expertKey, confirmerKey] = process.argv.slice(2);
const store = await openStore(storeContext(createJsonFileDomain(file)));
const result = {
  restoredHuman: isIssuedActorKey(humanKey),
  restoredExpert: isIssuedActorKey(expertKey),
  restoredConfirmer: isIssuedActorKey(confirmerKey),
  forged: isIssuedActorKey('ak_host_forged-after-process-restart'),
  sameId: actorForSession({ sessionId: 'b27-restart-human', session: { id: 'b27-restart-human' } }).actorKey === humanKey,
  deleted: false,
  code: null,
};
if (!result.restoredHuman || !result.restoredExpert || !result.restoredConfirmer || result.forged || !result.sameId) {
  console.log(JSON.stringify(result));
  process.exit(1);
}
const kernel = createKernel({ store });
kernel.load(projectId);
const service = createLabService({
  ctx: { effect: () => {}, get: () => null, logger: { info() {}, warn() {} } },
  store, kernel, git: null, runtime: { cancel: async () => ({ cancelled: true }) },
  transcript: null, orchestrator: null, auto: null, cluster: null, clusterAdmin: null,
});
const toolCtx = { tools: { register(definition) { toolCtx.tool = definition; return () => {}; } } };
registerAgentTool(toolCtx, service);
const humanExec = { agent: { session: { id: 'b27-restart-human' } } };
const expertExec = { agent: { session: { id: 'b27-restart-expert' } } };
const confirmerExec = { agent: { session: { id: 'b27-restart-confirmer' } } };
const appeal = await service.submitIntent(projectId, {
  kind: 'note', target: { projectId },
  claim: { action: 'appeal', targetAction: 'delete_project', reason: 'process restart probe' },
}, expertExec);
const resolved = await service.resolveAppeal(projectId, appeal.intent?.id, {
  resolution: 'upheld', reason: 'fresh-process confirmer',
}, confirmerExec);
const deleted = JSON.parse((await toolCtx.tool.execute({ action: 'delete_project', projectId, removeWorktrees: false }, humanExec)).result);
result.deleted = deleted.deleted === true;
result.code = deleted.error?.code ?? (resolved.ok ? null : resolved.error?.code ?? 'resolve_failed');
result.resolved = resolved.ok === true;
result.projectGone = !store.getProject(projectId);
console.log(JSON.stringify(result));
process.exit(result.deleted && result.projectGone ? 0 : 1);
