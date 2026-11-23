/**
 * WeBots bridge — the only new moving part of the WeBots integration.
 *
 * One plugin process polls project agents and an optional server agent.
 * Project agents use projectChat; the server agent accepts project drafts and
 * creates projects only after a configured human confirms them.
 *
 * Why in-plugin instead of a standalone service: `projectChat` lives in this
 * service object. Reaching it over HTTP would need the browser-only operator
 * token (`host/http.js`), which is exactly what the security model forbids for
 * an external daemon.
 *
 * The module uses global fetch and the existing MetaInfer Host service.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertServerSender, createServerIntake } from './webots-server-intake.js';

/** WeBots speaks a stateless MCP dialect: no `initialize` handshake. */
export const WEBOTS_PROTOCOL_VERSION = '2026-07-28';
export const WEBOTS_DEFAULT_ENDPOINT = 'https://webots.hpxing.com.cn/mcp';

const META = {
  'io.modelcontextprotocol/protocolVersion': WEBOTS_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

let counter = 0;
const requestId = (prefix) => {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
};

/** Default location of the `projectId -> WeBots agent` table. */
export function defaultTablePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'metainfer-research-lab', 'webots-tokens.json');
}

/**
 * The table is a plain JSON file so a human can edit it during P0:
 *   { "bindings": [ { "projectId": "prj-…", "token": "…", "actorId": "agt_…", "roomId": "rm_…" } ] }
 * A bare array is accepted too.
 */
async function readBindings(filePath, optional) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.bindings) ? parsed.bindings : [];
}

export async function readTokenTable(filePath = defaultTablePath(), { optional = true } = {}) {
  return (await readBindings(filePath, optional)).map((entry, index) => {
    if (entry?.kind === 'server') {
      const { token, actorId, roomId, operatorIds } = entry;
      if (typeof token !== 'string' || !token.trim() || !/^agt_[a-f0-9]{32}$/.test(actorId)
        || !/^rm_[a-f0-9]{32}$/.test(roomId) || !Array.isArray(operatorIds)
        || !operatorIds.length || operatorIds.some((id) => !/^usr_[a-f0-9]{32}$/.test(id))) {
        throw new Error(`webots server binding #${index} needs token, agent, room and explicit human operator IDs (${filePath})`);
      }
      return { kind: 'server', token: token.trim(), actorId, roomId, operatorIds, label: entry.label || actorId };
    }
    const projectId = String(entry?.projectId ?? '').trim();
    const token = String(entry?.token ?? '').trim();
    if (!projectId || !token) {
      throw new Error(`webots token table entry #${index} needs both projectId and token (${filePath})`);
    }
    return {
      projectId,
      token,
      actorId: entry.actorId ? String(entry.actorId) : null,
      roomId: entry.roomId ? String(entry.roomId) : null,
      label: entry.label ? String(entry.label) : projectId,
      ...(entry.pendingRoom ? { pendingRoom: entry.pendingRoom } : {}),
    };
  });
}

/** One JSON-RPC call against the WeBots MCP endpoint. */
export async function webotsCall(token, name, args = {}, options = {}) {
  const endpoint = options.endpoint || WEBOTS_DEFAULT_ENDPOINT;
  const url = `${endpoint}?token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': WEBOTS_PROTOCOL_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'tools/call',
      params: { name, arguments: args, _meta: META },
    }),
    signal: options.signal ?? AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (payload?.error) {
    const error = new Error(payload.error.message || `${name} failed`);
    error.rpc = payload.error;
    throw error;
  }
  const text = payload?.result?.content?.[0]?.text ?? '';
  if (payload?.result?.isError) throw new Error(text || `${name} failed`);
  if (!response.ok) throw new Error(`${name} failed (HTTP ${response.status})`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Read a message body in UTF-8 chunks until eof. */
async function readBody(token, messageId, options) {
  let text = '';
  let cursor;
  for (let guard = 0; guard < 50; guard += 1) {
    const chunk = await webotsCall(token, 'network_message_read', { message_id: messageId, chunk_cursor: cursor }, options);
    text += chunk?.chunk ?? '';
    if (chunk?.eof || !chunk?.next_cursor) break;
    cursor = chunk.next_cursor;
  }
  return text;
}

/** `projectChat` resolves `{ messages, running, error? }`; take the last assistant turn. */
export function replyTextOf(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      const text = message.text ?? message.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return '';
}

/**
 * @param {object} params
 * @param {{projectChat: (projectId: string, text: string) => Promise<any>}} params.service
 * @param {object} [params.logger]
 * @param {string} [params.tablePath]
 * @param {number} [params.pollMs] 3000 by default: well inside the 60s online window.
 * @param {number} [params.maxPerTick]
 */
export function createWebotsBridge(params) {
  const {
    service,
    logger = { info() {}, warn() {}, error() {} },
    tablePath = defaultTablePath(),
    pollMs = 3000,
    maxPerTick = 3,
    endpoint,
  } = params || {};
  if (!service?.projectChat) throw new Error('createWebotsBridge needs service.projectChat');

  const state = {
    started: false,
    ticking: false,
    lastTickAt: null,
    lastError: null,
    handled: 0,
    failed: 0,
    bindings: 0,
  };
  let timer = null;
  let stopped = true;

  const call = (token, name, args, options) => webotsCall(token, name, args, { endpoint, ...options });
  const serverIntake = createServerIntake({
    service,
    provision: (projectId, name) => provisionProject({ projectId, name, tablePath, call, requireContact: true }),
  });

  async function handleOne(binding, item) {
    const deliveryId = item.delivery_id;
    const claim = await call(binding.token, 'network_delivery_claim', {
      request_id: requestId('claim'),
      delivery_id: deliveryId,
    });
    const claimId = claim?.claim_id;
    const attempt = claim?.attempt ?? 0;
    const messageId = claim?.message_id ?? item.message_id;

    // A project chat turn can outlive the 3-minute reminder window; keep the
    // claim fresh while the model works.
    const heartbeat = setInterval(() => {
      call(binding.token, 'network_delivery_report', {
        request_id: requestId('hb'),
        delivery_id: deliveryId,
        attempt,
        claim_id: claimId,
        status: 'thinking',
      }).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();

    try {
      if (binding.kind === 'server') assertServerSender(binding, item);
      const text = (await readBody(binding.token, messageId, { endpoint })).trim();
      if (!text) throw new Error('message body is empty');
      let reply;
      if (binding.kind === 'server') {
        reply = await serverIntake(binding, item, text);
      } else {
        const result = await service.projectChat(binding.projectId, text);
        if (result?.error) throw new Error(result.error);
        reply = replyTextOf(result) || '(项目 agent 没有返回文本)';
      }
      await call(binding.token, 'network_delivery_complete', {
        request_id: requestId('done'),
        delivery_id: deliveryId,
        attempt,
        claim_id: claimId,
        client_message_id: requestId('cm'),
        final_body: reply,
      });
      state.handled += 1;
      logger.info?.(`[webots-bridge] ${binding.label}: replied to ${deliveryId}`);
    } catch (error) {
      state.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[webots-bridge] ${binding.label}: delivery ${deliveryId} failed — ${message}`);
      await call(binding.token, 'network_delivery_fail', {
        request_id: requestId('fail'),
        delivery_id: deliveryId,
        attempt,
        claim_id: claimId,
        error: message.slice(0, 1000),
      }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function drain(binding) {
    const inbox = await call(binding.token, 'network_inbox_list', { state: 'all', limit: 10 });
    // A claim from a previous run (plugin reload, crash) would block this agent
    // forever: each agent may hold exactly one claim. Requeue it first.
    if (inbox?.claimed_delivery_id) {
      const stuck = (inbox.items || []).find((item) => item.delivery_id === inbox.claimed_delivery_id);
      if (stuck) {
        await call(binding.token, 'network_delivery_retry', {
          request_id: requestId('retry'),
          delivery_id: stuck.delivery_id,
          expected_attempt: stuck.attempt,
        }).catch(() => {});
      }
    }
    const pending = (inbox?.items || [])
      .filter((item) => item.state === 'pending')
      .slice(0, maxPerTick);
    for (const item of pending) await handleOne(binding, item);
  }

  async function tick() {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const bindings = await readTokenTable(tablePath);
      state.bindings = bindings.length;
      state.lastError = null;
      for (const binding of bindings) {
        if (binding.pendingRoom) continue;
        try {
          await drain(binding);
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          logger.warn?.(`[webots-bridge] ${binding.label}: polling failed — ${state.lastError}`);
        }
      }
      state.lastTickAt = Date.now();
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[webots-bridge] tick failed — ${state.lastError}`);
    } finally {
      state.ticking = false;
    }
  }

  return {
    start() {
      if (state.started) return;
      state.started = true;
      stopped = false;
      timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
      timer.unref?.();
      tick().catch(() => {});
      logger.info?.(`[webots-bridge] polling ${tablePath} every ${pollMs}ms`);
    },
    stop() {
      stopped = true;
      state.started = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    state,
  };
}

/**
 * CLI used for P0 verification without a DSH restart:
 *   node host/webots-bridge.js --smoke
 *   node host/webots-bridge.js --claim
 *   node host/webots-bridge.js --complete --delivery-id d --attempt 1 --claim-id c --reply-file r.txt
 *   node host/webots-bridge.js --fail --delivery-id d --attempt 1 --claim-id c --error "…"
 */
/** Where the one human credential used for provisioning lives. */
export function defaultHumanPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'metainfer-research-lab', 'webots-human.json');
}

/** Store credentials atomically so the live poller cannot read a partial table. */
export async function writeBinding(filePath, binding, { force = false } = {}) {
  const bindings = await readBindings(filePath, true);
  const sameBinding = (entry) => binding.kind === 'server'
    ? entry.kind === 'server' && entry.actorId === binding.actorId
    : entry.kind !== 'server' && entry.projectId === binding.projectId;
  const next = bindings.filter((entry) => !sameBinding(entry));
  if (!force && next.length !== bindings.length) throw new Error('WeBots binding already exists');
  next.push(binding);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ bindings: next }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, filePath);
  } finally {
    await rm(temp, { force: true });
  }
  return next.length;
}

export async function provisionProject({
  projectId, name, addHuman, roomTitle, force = false, requireContact = false,
  tablePath = defaultTablePath(), humanPath = defaultHumanPath(), call = webotsCall,
}) {
  const existing = (await readTokenTable(tablePath)).find((entry) => entry.projectId === projectId);
  if (existing && !existing.pendingRoom && !force) {
    if (requireContact && existing.actorId && existing.roomId) return existing;
    throw new Error(`token table already binds ${projectId}; pass --force to replace it`);
  }
  const human = JSON.parse(await readFile(humanPath, 'utf8'));
  if (!human?.token) throw new Error('human credential file has no token');
  const me = await call(human.token, 'network_me', {});
  if (me?.kind !== 'human') throw new Error('WeBots provisioning requires a human credential');

  const contact = addHuman ?? human.relatedActorId;
  if (requireContact && !contact) throw new Error('WeBots provisioning requires a configured project contact');
  let binding = existing?.pendingRoom ? existing : null;
  if (!binding) {
    const label = (name || `项目代理-${String(projectId).slice(-6)}`).slice(0, 96);
    const created = await call(human.token, 'network_agent_create', {
      request_id: force ? requestId('agent') : `metainfer-agent-${projectId}`,
      name: label,
      metadata: { projectId, provisioned_by: 'metainfer-bridge' },
    });
    if (!created?.actor_id || !created?.token) throw new Error('WeBots agent creation returned no identity or token');
    binding = {
      projectId, token: created.token, actorId: created.actor_id, label,
      pendingRoom: {
        title: (roomTitle || `${label} 的项目房间`).slice(0, 160),
        members: [...new Set([created.actor_id, contact].filter((id) => id && id !== me.actor_id))],
      },
    };
    // Retrying a room must not create a second agent or lose its one-time token.
    await writeBinding(tablePath, binding, { force });
  }
  const { pendingRoom, ...entry } = binding;
  if (requireContact && contact !== me.actor_id && !pendingRoom.members.includes(contact)) {
    throw new Error('pending project room does not include the configured contact');
  }
  const room = await call(human.token, 'network_room_create', {
    request_id: `metainfer-room-${binding.actorId}`,
    kind: 'group',
    ...pendingRoom,
  });
  const roomId = room?.room?.room_id || room?.room_id;
  if (!roomId) throw new Error('WeBots room creation returned no room ID');
  const count = await writeBinding(tablePath, { ...entry, roomId }, { force: true });
  return { projectId, actorId: entry.actorId, roomId, label: entry.label, ...pendingRoom, count };
}

async function main(argv) {
  const flag = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const tablePath = flag('table', defaultTablePath());
  const bindings = await readTokenTable(tablePath);

  if (argv.includes('--smoke')) {
    for (const binding of bindings) {
      const me = await webotsCall(binding.token, 'network_me', {});
      const inbox = await webotsCall(binding.token, 'network_inbox_list', { state: 'all', limit: 10 });
      console.log(JSON.stringify({
        label: binding.label,
        projectId: binding.projectId,
        actor_id: me.actor_id,
        name: me.name,
        kind: me.kind,
        pending_count: inbox.pending_count,
        claimed_delivery_id: inbox.claimed_delivery_id,
      }));
    }
    return;
  }

  if (argv.includes('--claim')) {
    for (const binding of bindings) {
      const inbox = await webotsCall(binding.token, 'network_inbox_list', { state: 'pending', limit: 5 });
      const item = (inbox.items || [])[0];
      if (!item) continue;
      const claim = await webotsCall(binding.token, 'network_delivery_claim', {
        request_id: requestId('claim'),
        delivery_id: item.delivery_id,
      });
      const text = await readBody(binding.token, claim.message_id);
      console.log(JSON.stringify({
        projectId: binding.projectId,
        deliveryId: claim.delivery_id,
        attempt: claim.attempt,
        claimId: claim.claim_id,
        messageId: claim.message_id,
        roomId: claim.room_id,
        text,
      }));
      return;
    }
    console.error('no pending delivery');
    process.exit(2);
  }

  if (argv.includes('--complete') || argv.includes('--fail')) {
    const deliveryId = flag('delivery-id');
    const claimId = flag('claim-id');
    const attempt = Number(flag('attempt', '0'));
    const binding = bindings[0];
    if (!deliveryId || !claimId || !binding) throw new Error('--delivery-id, --claim-id and a table entry are required');
    if (argv.includes('--complete')) {
      const reply = flag('reply') || (await readFile(flag('reply-file'), 'utf8'));
      const done = await webotsCall(binding.token, 'network_delivery_complete', {
        request_id: requestId('done'),
        delivery_id: deliveryId,
        attempt,
        claim_id: claimId,
        client_message_id: requestId('cm'),
        final_body: reply.trim(),
      });
      console.log(JSON.stringify({ state: done?.delivery?.state, result: done?.delivery?.result_message_id }));
      return;
    }
    const failed = await webotsCall(binding.token, 'network_delivery_fail', {
      request_id: requestId('fail'),
      delivery_id: deliveryId,
      attempt,
      claim_id: claimId,
      error: flag('error', 'bridge failure'),
    });
    console.log(JSON.stringify({ state: failed?.delivery?.state }));
    return;
  }

  if (argv.includes('--provision')) {
    const projectId = flag('project');
    if (!projectId) throw new Error('--project <prj-…> is required');
    const result = await provisionProject({
      projectId, tablePath, humanPath: flag('human-file', defaultHumanPath()),
      name: flag('name'), addHuman: flag('add-human'),
      roomTitle: flag('room-title'), force: argv.includes('--force'),
    });
    console.log(JSON.stringify({
      projectId,
      agent: { actorId: result.actorId, name: result.label },
      room: { roomId: result.roomId, title: result.title, members: result.members },
      table: { path: tablePath, bindings: result.count },
      note: 'the bridge picks this up within seconds once the plugin is running',
    }, null, 2));
    return;
  }

  console.log('usage: node host/webots-bridge.js --smoke|--claim|--complete|--fail|--provision [--table path]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
