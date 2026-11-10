/**
 * Opaque actor identity, minted only by the Host.
 *
 * Display names are for humans, logs and intent ids; they are not an
 * authorization primitive. Every actor created at a session/human/system
 * registration boundary carries an `actorKey`: an opaque, immutable value that
 * encodes no case, Unicode or namespace semantics. Authorization compares keys
 * for exact equality; the display `actor.id` is never folded, trimmed or
 * suffix-stripped.
 *
 * The key is **Host-issued**: it is minted here with `crypto.randomUUID()` and
 * kept in a registry backed by the v2 store, keyed by the registration object
 * (or, for session-id-only calls, by that registration id). The in-process
 * registry is a cache: `openStore` restores every issued key after a restart.
 * Callers cannot supply or choose a key. Any `actorKey` appearing on a session, session header/meta or
 * function input is treated as an injection attempt and throws a distinct
 * `ActorKeyError` code instead of being silently ignored:
 *
 *   - caller_supplied_actor_key: a caller tried to choose an identity;
 *   - actor_key_shared: a key already bound to another registration;
 *   - actor_key_rebind: a registration that already has a key tried to rotate it.
 *
 * `actorKeyFor` is retained only for pre-key legacy records/tests. Its values
 * are not registered and therefore cannot authorize anything; the migration
 * path strips unregistered keys so they fall back to exact-byte legacy ids.
 */
import { createHash, randomUUID } from 'node:crypto';

const KEY_PREFIX = 'ak_host_';

/** @typedef {{code: string, message: string}} ActorKeyFailure */
export class ActorKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActorKeyError';
    this.code = code;
  }
}

/** key -> registration token (object session or string registration id). */
const registry = new Map();
/** session object -> key. The registration boundary is the object identity. */
let bySessionObject = new WeakMap();
/** string registration id -> key. */
const byRegistrationId = new Map();
/** stable DSH session id -> key (survives a process restart). */
const bySessionId = new Map();
/** key -> durable record (session id, issuedAt, first bound project). */
const records = new Map();
/** Persistence adapter, installed by the v2 store at open time. */
let keyStore = null;
/** In-flight adapter writes, so a clean shutdown/restart probe can flush them. */
const pendingWrites = new Set();

function rememberKey(key, record) {
  registry.set(key, record?.registrationId ?? key);
  if (record) records.set(key, { ...record });
  // session-object keys are looked up by the Host session id, not by the
  // synthetic `session:<id>` token; a bare `sessionId` registration must not
  // silently inherit a session object's key (claims-selftest B27 pin probe).
  if (typeof record?.registrationId === 'string' && record.registrationId && record.registrationKind !== 'session') {
    byRegistrationId.set(record.registrationId, key);
  }
  if (record?.registrationKind === 'session' && typeof record?.sessionId === 'string' && record.sessionId) bySessionId.set(record.sessionId, key);
}

function persistRecord(record) {
  if (!keyStore || typeof keyStore.save !== 'function') return;
  try {
    const write = keyStore.save(record);
    if (write && typeof write.then === 'function') {
      pendingWrites.add(write);
      write.catch(() => {}).finally(() => pendingWrites.delete(write));
    }
  } catch {
    // A failed registry write must not turn an authentication attempt into a
    // crash. The in-process registry still authorizes; the next restart fails
    // closed rather than accepting an unpersisted key.
  }
}

function keyForRegistration(token) {
  return typeof token === 'string' ? (byRegistrationId.get(token) ?? null) : (bySessionObject.get(token) ?? null);
}

function sessionIdOf(input) {
  if (typeof input?.sessionId === 'string' && input.sessionId) return input.sessionId;
  const id = input?.session?.id;
  return typeof id === 'string' && id ? id : null;
}

function bindKey(token, key, record) {
  if (typeof token === 'string') byRegistrationId.set(token, key);
  else bySessionObject.set(token, key);
  registry.set(key, record?.registrationId ?? (typeof token === 'string' ? token : key));
  if (record) records.set(key, { ...record });
  if (record?.registrationKind === 'session' && typeof record?.sessionId === 'string' && record.sessionId) bySessionId.set(record.sessionId, key);
}

function registrationToken(input) {
  if (input && input.session && typeof input.session === 'object') return input.session;
  const id = typeof input?.registrationId === 'string' && input.registrationId
    ? input.registrationId
    : (typeof input?.sessionId === 'string' && input.sessionId ? `session:${input.sessionId}` : 'session:anonymous');
  return id;
}

function suppliedKeys(input) {
  const session = input?.session && typeof input.session === 'object' ? input.session : null;
  const headerMeta = session?.header?.meta && typeof session.header.meta === 'object' ? session.header.meta : null;
  return [
    input?.actorKey,
    session?.actorKey,
    input?.meta?.actorKey,
    headerMeta?.actorKey,
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Reject any caller-supplied identity, with a code that distinguishes an
 * injection from a collision and from a mid-flight re-key.
 * @param {object} input
 * @param {unknown} token
 */
function rejectSuppliedKeys(input, token) {
  const supplied = suppliedKeys(input);
  if (supplied.length === 0) return;
  const existing = keyForRegistration(token) ?? (sessionIdOf(input) ? bySessionId.get(sessionIdOf(input)) : null);
  const registrationId = typeof token === 'string' ? token : `session:${sessionIdOf(input) ?? 'anonymous'}`;
  for (const key of supplied) {
    const owner = registry.get(key);
    if (owner !== undefined && owner !== registrationId) {
      throw new ActorKeyError('actor_key_shared', 'actorKey is already bound to another session registration; keys cannot be shared');
    }
    if (existing && existing !== key) {
      throw new ActorKeyError('actor_key_rebind', 'this session registration already has an actorKey and cannot be re-keyed');
    }
  }
  throw new ActorKeyError('caller_supplied_actor_key', 'actorKey is Host-issued; caller-supplied identity fields are rejected');
}

/** @param {unknown} actor @returns {string|null} */
export function actorKeyOf(actor) {
  return actor && typeof actor === 'object' && typeof actor.actorKey === 'string' && actor.actorKey.length > 0
    ? actor.actorKey
    : null;
}

/**
 * Deterministic legacy hash, retained for pre-key migration tests only. These
 * values are deliberately NOT registered, so they are not credentials.
 * @param {unknown} id
 * @returns {string}
 */
export function actorKeyFor(id) {
  const exact = typeof id === 'string' ? id : String(id ?? '');
  return `ak_legacy_${createHash('sha256').update(Buffer.from(exact, 'utf16le')).digest('base64url').slice(0, 32)}`;
}

/** True for a key this Host minted and has not forgotten (including restored keys). */
export function isIssuedActorKey(key) {
  return typeof key === 'string' && registry.has(key);
}

/**
 * Mint (or return) the Host key for an already-registered identity. Used by the
 * executor for trusted inline system actors; never accepts a key from input.
 * @param {{kind?: string, id: string}} actor
 */
export function ensureActorKey(actor) {
  if (!actor || typeof actor !== 'object' || typeof actor.id !== 'string' || !actor.id) {
    throw new ActorKeyError('invalid_actor', 'actor.id is required to mint an actorKey');
  }
  const supplied = actorKeyOf(actor);
  if (supplied) {
    if (!registry.has(supplied)) {
      throw new ActorKeyError('caller_supplied_actor_key', 'actorKey is not in the Host registry; caller-supplied keys cannot authorize');
    }
    return supplied;
  }
  const token = `inline:${typeof actor.kind === 'string' ? actor.kind : 'actor'}:${actor.id}`;
  const existing = byRegistrationId.get(token);
  if (existing) return existing;
  const key = `${KEY_PREFIX}${randomUUID()}`;
  const record = { key, registrationId: token, registrationKind: 'inline', sessionId: null, projectId: null, issuedAt: Date.now() };
  bindKey(token, key, record);
  persistRecord(record);
  return key;
}

/**
 * Preserve a Host-issued key; strip anything else. Legacy records therefore
 * fall back to exact-byte ids rather than carrying a forged credential.
 * @param {{kind?: string, id?: string, actorKey?: string}} actor
 * @returns {object}
 */
export function withActorKey(actor) {
  if (!actor || typeof actor !== 'object') return actor;
  const copy = { ...actor };
  const key = actorKeyOf(actor);
  if (key && registry.has(key)) return copy;
  delete copy.actorKey;
  return copy;
}

/**
 * True when an actor has a usable identity (opaque key or a non-empty legacy
 * id). Authorization paths use this to fail closed on malformed records.
 * @param {object} actor
 * @returns {boolean}
 */
export function hasActorIdentity(actor) {
  return Boolean(actorKeyOf(actor) || (actor && typeof actor === 'object' && typeof actor.id === 'string' && actor.id.length > 0));
}

/**
 * Exact identity comparison. Issued keys compare only by key. Two records that
 * predate keys fall back to exact-byte id equality (no trim/case-fold/suffix
 * removal). Mixing a keyed actor with an unkeyed legacy record fails closed.
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function sameActor(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKey = actorKeyOf(left);
  const rightKey = actorKeyOf(right);
  if (leftKey && rightKey) return leftKey === rightKey && registry.has(leftKey) && registry.has(rightKey);
  if (!leftKey && !rightKey) {
    return typeof left.id === 'string' && typeof right.id === 'string' && left.id === right.id;
  }
  return false;
}

/**
 * Strip every unregistered actorKey from persisted intent records on load.
 * A pre-existing forged key on a legacy resolver row is therefore unkeyed and
 * can never satisfy an irreversible human-confirmation gate.
 * @param {object} project
 * @returns {object}
 */
export function migrateProjectActorKeys(project) {
  if (!project || typeof project !== 'object') return project;
  for (const intent of Array.isArray(project.intents) ? project.intents : []) {
    if (!intent || typeof intent !== 'object') continue;
    if (intent.actor) intent.actor = withActorKey(intent.actor);
    if (intent.resolvedBy) intent.resolvedBy = withActorKey(intent.resolvedBy);
    if (intent.withdrawnBy) intent.withdrawnBy = withActorKey(intent.withdrawnBy);
  }
  for (const dispute of Array.isArray(project.disputes) ? project.disputes : []) {
    if (!dispute || typeof dispute !== 'object') continue;
    if (dispute.raiser) dispute.raiser = withActorKey(dispute.raiser);
    if (dispute.resolvedBy) dispute.resolvedBy = withActorKey(dispute.resolvedBy);
    if (dispute.reopenedBy) dispute.reopenedBy = withActorKey(dispute.reopenedBy);
  }
  return project;
}

/**
 * Remove every `actorKey` from an outward-facing value. Read surfaces expose
 * display ids only; the key is never a bearer token for a second request.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function publicView(value) {
  if (Array.isArray(value)) return /** @type {any} */ (value.map((entry) => publicView(entry)));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'actorKey') continue;
    out[key] = publicView(entry);
  }
  return /** @type {any} */ (out);
}

/**
 * Resolve an actor from a session registration. This is the only entrypoint
 * that mints a key for a real session. Caller-supplied actorKey fields throw.
 * @param {object} input
 */
export function issueActorKeyForRegistration(input = {}) {
  const token = registrationToken(input);
  rejectSuppliedKeys(input, token);
  const sessionId = sessionIdOf(input);
  const hasSessionObject = Boolean(input?.session && typeof input.session === 'object');
  let key = keyForRegistration(token);
  // Only a real session object may restore a durable key by session id. A
  // bare `{sessionId}` is a separate registration, not the same boundary.
  if (!key && hasSessionObject && sessionId) key = bySessionId.get(sessionId) ?? null;
  if (!key) {
    key = `${KEY_PREFIX}${randomUUID()}`;
    const registrationId = typeof token === 'string' ? token : `session:${sessionId ?? 'anonymous'}`;
    const record = {
      key,
      registrationId,
      registrationKind: hasSessionObject ? 'session' : (typeof token === 'string' && token.startsWith('inline:') ? 'inline' : 'session_id_only'),
      sessionId,
      projectId: typeof input.projectId === 'string' && input.projectId ? input.projectId : null,
      issuedAt: Date.now(),
    };
    bindKey(typeof token === 'string' ? token : token, key, record);
    persistRecord(record);
  } else {
    // A durable key restored by session id must be pinned to the new session
    // object too, or the next call after a display rename mints another key.
    if (hasSessionObject && typeof token !== 'string') bySessionObject.set(token, key);
    if (hasSessionObject && sessionId) bySessionId.set(sessionId, key);
  }
  return key;
}

/**
 * Install the v2-store persistence adapter and restore every key minted by an
 * earlier Host process. Called once by `openStore`; the adapter's `list()` must
 * be synchronous (storage table entries are), while `save()` may be async.
 * @param {{save?: (record: object) => unknown, list?: () => object[]}} adapter
 */
export function configureActorKeyStore(adapter) {
  keyStore = adapter ?? null;
  if (!adapter || typeof adapter.list !== 'function') return;
  for (const record of adapter.list()) {
    if (!record || typeof record.key !== 'string' || !record.key.startsWith(KEY_PREFIX)) continue;
    rememberKey(record.key, record);
  }
}

/** Await every persistence write started by this process (clean restart probe). */
export async function flushActorKeyStore() {
  if (pendingWrites.size === 0) return;
  await Promise.allSettled([...pendingWrites]);
}

/** Test/restart helper: forget the in-process registry but keep the adapter. */
export function resetActorKeyRegistryForTest() {
  registry.clear();
  bySessionObject = new WeakMap();
  byRegistrationId.clear();
  bySessionId.clear();
  records.clear();
  pendingWrites.clear();
}

/**
 * Record the first project a Host-issued key acts on. This is audit metadata,
 * not an ACL: cross-project identity remains the documented boundary, but a
 * restart can tell which project a key belonged to.
 * @param {string} key
 * @param {string} projectId
 */
export function bindActorKeyProject(key, projectId) {
  if (!isIssuedActorKey(key) || typeof projectId !== 'string' || !projectId) return;
  const record = records.get(key);
  if (!record || record.projectId) return;
  const next = { ...record, projectId, boundAt: Date.now() };
  records.set(key, next);
  persistRecord(next);
}

/** Raw records for restart probes; never expose this on an HTTP/tool surface. */
export function actorKeyRecords() {
  return [...records.entries()].map(([key, record]) => ({ ...record, key }));
}
