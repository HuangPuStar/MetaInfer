/**
 * Opaque actor identity.
 *
 * Display names are for humans, logs and intent ids; they are not an
 * authorization primitive. Every actor created at a session/human/system
 * registration boundary carries an `actorKey`: an opaque, immutable value that
 * encodes no case, Unicode or namespace semantics. Authorization compares keys
 * for exact equality; the display `actor.id` is never folded, trimmed or
 * suffix-stripped.
 *
 * `actorKeyFor` is the deterministic key used when an actor predates keyed
 * identities (migration) or when an internal system actor is constructed
 * inline. It hashes the exact legacy id bytes, so a legacy record can always be
 * migrated without making two different ids collide.
 */
import { createHash } from 'node:crypto';

const KEY_PREFIX = 'ak_';
const KEY_CHARS = 32;

/** @param {unknown} value @returns {string|null} */
export function actorKeyOf(actor) {
  return actor && typeof actor === 'object' && typeof actor.actorKey === 'string' && actor.actorKey.length > 0
    ? actor.actorKey
    : null;
}

/**
 * Derive the opaque key for the exact legacy id. The input is intentionally not
 * normalized: `ｈ１`, `h1\u200b`, `h1:resolver`, `alice@home.com` and
 * `alice@work.com` are distinct ids and therefore distinct keys.
 * @param {unknown} id
 * @returns {string}
 */
export function actorKeyFor(id) {
  const exact = typeof id === 'string' ? id : String(id ?? '');
  // UTF-16 code units preserve the exact JavaScript string, including lone
  // surrogates that a UTF-8 encoder would collapse to U+FFFD.
  return `${KEY_PREFIX}${createHash('sha256').update(Buffer.from(exact, 'utf16le')).digest('base64url').slice(0, KEY_CHARS)}`;
}

/**
 * @param {{kind?: string, id?: string, actorKey?: string}} actor
 * @returns {object}
 */
export function withActorKey(actor) {
  if (!actor || typeof actor !== 'object') return actor;
  const key = actorKeyOf(actor);
  if (key) return { ...actor, actorKey: key };
  // A record with no id has no identity to migrate. Do not mint a shared hash
  // of the empty string: that would make every malformed actor the same actor.
  if (typeof actor.id !== 'string' || !actor.id) return actor;
  return { ...actor, actorKey: actorKeyFor(actor.id) };
}

/**
 * True when an actor has a usable identity (opaque key or a non-empty legacy
 * id). Authorization paths use this to fail closed on malformed records instead
 * of treating "both ids missing" as two distinct actors.
 * @param {object} actor
 * @returns {boolean}
 */
export function hasActorIdentity(actor) {
  return Boolean(actorKeyOf(actor) || (actor && typeof actor === 'object' && typeof actor.id === 'string' && actor.id.length > 0));
}

/**
 * Exact identity comparison. New actors compare only opaque keys. Two records
 * that predate keys fall back to exact-byte id equality (no trim/case-fold/
 * suffix removal). Mixing a keyed actor with an unkeyed legacy record fails
 * closed: there is no sound way to know they are the same principal.
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function sameActor(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKey = actorKeyOf(left);
  const rightKey = actorKeyOf(right);
  if (leftKey && rightKey) return leftKey === rightKey;
  if (!leftKey && !rightKey) {
    return typeof left.id === 'string' && typeof right.id === 'string' && left.id === right.id;
  }
  return false;
}

/**
 * Fill actorKey on every actor-bearing record of a pre-key project. The key is
 * deterministic from the exact legacy actor id, so reopening the same project
 * produces the same identities and an existing resolution remains resolvable.
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
