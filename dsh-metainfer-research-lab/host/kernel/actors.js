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
 * kept in this process's registry, keyed by the registration object (or, for
 * session-id-only calls, by that registration id). Callers cannot supply or
 * choose a key. Any `actorKey` appearing on a session, session header/meta or
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
const bySessionObject = new WeakMap();
/** string registration id -> key. */
const byRegistrationId = new Map();

function keyForRegistration(token) {
  return typeof token === 'string' ? (byRegistrationId.get(token) ?? null) : (bySessionObject.get(token) ?? null);
}

function bindKey(token, key) {
  if (typeof token === 'string') byRegistrationId.set(token, key);
  else bySessionObject.set(token, key);
  registry.set(key, token);
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
  const existing = keyForRegistration(token);
  for (const key of supplied) {
    const owner = registry.get(key);
    if (owner !== undefined && owner !== token) {
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

/** True only for a key this Host process minted. */
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
  bindKey(token, key);
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
  if (!project || !Array.isArray(project.intents)) return project;
  for (const intent of project.intents) {
    if (!intent || typeof intent !== 'object') continue;
    if (intent.actor) intent.actor = withActorKey(intent.actor);
    if (intent.resolvedBy) intent.resolvedBy = withActorKey(intent.resolvedBy);
    if (intent.withdrawnBy) intent.withdrawnBy = withActorKey(intent.withdrawnBy);
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
  let key = keyForRegistration(token);
  if (!key) {
    key = `${KEY_PREFIX}${randomUUID()}`;
    bindKey(token, key);
  }
  return key;
}
