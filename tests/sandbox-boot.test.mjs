import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { getSandboxTarget } from '../host/sandbox-targets.js';
import { memoryDomain } from '../scripts/lib/memory-domain.mjs';
const PRESET = 'lab-sandbox-worker-v2';
async function fixture({ missingPreset = false, seed = false, seedLocal = false, forbidActivationResolve = false, resolveHook } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mirl-sandbox-boot-')), oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers = [], resolved = [], tools = [], domain = memoryDomain(); let service, agentCalls = 0, modelCalls = 0, activating = true;
  const never = () => { agentCalls++; throw Error('unexpected Agent/process invocation'); };
  if (seed) {
    const t = getSandboxTarget('pclab19'); await mkdir(path.join(home, 'metainfer-research-lab'));
    await writeFile(path.join(home, 'metainfer-research-lab/opensandbox.json'), JSON.stringify({ sshAlias: t.sshAlias, remoteRoot: t.remoteRoot, python: t.python }));
    const config = { resourcePools: { gpu: 4 }, maxRunningNodes: 1,
      execution: { profiles: { remote: { driver: 'dsh', sandboxProfile: 'pclab19' } } } };
    await domain.table('projects').put('p', { id: 'p', name: 'inert', revision: 1, mode: 'manual', config, repo: { path: home, worktreeRoot: path.join(home, 'wt') } });
    await domain.table('nodes').put('p__n', { id: 'n', projectId: 'p', rev: 1, status: 'planned', kind: 'experiment', currentAttempt: 0,
      needs: { gpu: 1 }, timeboxMs: 60000, execution: { profile: 'remote', driver: 'dsh', sandboxProfile: 'pclab19' },
      git: { worktreePath: path.join(home, 'wt/n'), branch: 'inert' }, timestamps: { createdAt: Date.now() }, attempts: [] });
    if (seedLocal) await domain.table('nodes').put('p__local',{id:'local',projectId:'p',rev:1,status:'planned',kind:'experiment',currentAttempt:0,attempts:[],sessionId:'inert-local',execution:{profile:'dsh',driver:'dsh'},needs:{},timeboxMs:60000,git:{worktreePath:'X:/inert-never',branch:'inert'},timestamps:{createdAt:1}});
  }
  const ctx = { config: {}, logger: { info() {}, warn() {}, error() {} },
    storageDomain: { get: () => undefined, open: async () => domain }, subprocess: { spawn: never },
    agents: { create: never, get: () => null }, subagents: { startActivation: never },
    agentPresets: { async resolve(id) { if (resolveHook) await resolveHook(id); if (activating && forbidActivationResolve) throw Error('registry settlement inside owner activation is forbidden'); resolved.push(id); if (missingPreset && id === PRESET) throw Error('not registered'); return { id }; }, list: async () => [], mount: async () => {} },
    agentDefaultModel: { currentSelection: () => { modelCalls++; return { provider: 'inert', model: 'inert' }; } }, llm: {}, sessionQuery: { readSurface: async () => ({ events: [] }) }, sessions: {},
    tools: { register(tool) { tools.push(tool); return () => {}; }, get() { return undefined; } },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }), fetch: { register: () => () => {} } },
    on: () => () => {}, get: () => null,
    provide(key, value) { if (key === 'metainferLab') service = value; },
    effect(fn) { const result = fn(); if (typeof result === 'function') disposers.push(result); return result; } };
  async function close() { for (const fn of disposers.reverse()) await fn();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true }); }
  try { await apply(ctx, { kernel: { strictWrites: 'throw' } }); activating = false; }
  catch (error) { await close(); throw error; }
  return { service, tools, resolved, domain, get agentCalls() { return agentCalls; }, get modelCalls() { return modelCalls; }, close };
}
test('missing sandbox preset fails on admission before model/SSH/Agent, not during owner activation', async () => {
  const f = await fixture({ missingPreset: true, seed: true, forbidActivationResolve: true });
  try { assert.equal(f.resolved.length, 0); await assert.rejects(() => f.service.startNode('p','n'), /lab-sandbox-worker-v2/);
    assert.equal(f.modelCalls,0); assert.equal(f.agentCalls,0); assert.equal(f.domain.table('nodes').get('p__n').currentAttempt,0);
  } finally { await f.close(); }
});
test('actual index registers bound sandbox tool without settling registry inside owner activation', async () => {
  const f = await fixture({ forbidActivationResolve: true }); try {
    assert.equal(f.resolved.length,0); assert.equal(f.tools.filter(x => x.name === 'metainfer_sandbox').length,1);
    assert.equal(f.agentCalls,0);
  } finally { await f.close(); }
});
test('actual index manual start claims admission but missing SSH holds before any Agent/Git', async () => {
  const f = await fixture({ seed: true }); try {
    const result = await f.service.startNode('p', 'n');
    assert.equal(result.startOutcome.status, 'held'); assert.equal(result.startOutcome.retryable, false);
    const node = f.domain.table('nodes').get('p__n');
    assert.equal(node.status, 'planned'); assert.equal(node.currentAttempt, 0);
    assert.ok(node.sandboxGate); assert.ok(node.admission); assert.equal(node.sandbox, undefined);
    assert.equal(f.agentCalls, 0);
  } finally { await f.close(); }
});

test('actual index mixed project cannot bypass a blocked sandbox Host slot through manual local start',async()=>{
 const f=await fixture({seed:true,seedLocal:true});try{
   await f.service.startNode('p','n');assert.equal(f.agentCalls,0);
   assert.ok(f.domain.table('nodes').get('p__local'), 'local record seeded before kernel load');
   let result,error;try{result=await f.service.startNode('p','local');}catch(e){error=e;}
   assert.equal(f.modelCalls,0,'shared Host admission must precede even local model selection');
   assert.equal(f.agentCalls,0,'a held sandbox admission must consume the same Host slot before any local model/Agent/Git invocation');
   assert.ok(result?.startOutcome?.status==='held'||result?.startOutcome?.status==='queued'||(error&&/admission|budget|quota|capacity/i.test(String(error.message))),'the local start must be denied before execution');
 }finally{await f.close();}
});

test('dispose while registry settlement awaits never starts an old Host after settlement returns',async()=>{
 let enter,release;const entered=new Promise(r=>{enter=r}),gate=new Promise(r=>{release=r});let once=true;
 const f=await fixture({seed:true,seedLocal:true,resolveHook:async()=>{if(once){once=false;enter();await gate;}}});
 const starting=f.service.startNode('p','local');await entered;await f.close();release();
 await assert.rejects(starting,e=>e.code==='HOST_ACTIVATION_PENDING');assert.equal(f.modelCalls,0);assert.equal(f.agentCalls,0);
});
