/**
 * Host-issued operator credential for the browser control surface.
 *
 * The HTTP carrier authenticates the browser as an owner peer, but a Peer is
 * not a human decision and a request body must never be able to claim one.
 * The page receives this Host-lifetime token through the index injection
 * table; the token is an HMAC-signed, random-per-Host bearer credential. A
 * forged body without the injected credential is rejected exactly like an
 * absent caller. A Host restart mints a new secret, invalidating old pages.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 1;
const TOKEN_PREFIX = 'mir-operator';

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Mint the operator authority for one Host process.
 * @returns {{token: string, id: string, verify: (candidate: unknown) => {ok: true, id: string, issuedAt: number} | {ok: false, code: string, message: string}}}
 */
export function createOperatorAuthority() {
  const secret = randomBytes(32);
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: VERSION,
    iat: issuedAt,
    nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const signature = sign(secret, payload);
  const token = `${TOKEN_PREFIX}.${payload}.${signature}`;

  return Object.freeze({
    token,
    id: 'operator',
    verify(candidate) {
      if (typeof candidate !== 'string' || candidate.length === 0) {
        return { ok: false, code: 'operator_required', message: 'the Host-issued operator token is required' };
      }
      const parts = candidate.split('.');
      if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
        return { ok: false, code: 'operator_invalid', message: 'the operator token is malformed' };
      }
      const expected = sign(secret, parts[1]);
      const givenBytes = Buffer.from(parts[2]);
      const expectedBytes = Buffer.from(expected);
      if (givenBytes.length !== expectedBytes.length || !timingSafeEqual(givenBytes, expectedBytes)) {
        return { ok: false, code: 'operator_invalid', message: 'the operator token signature is invalid' };
      }
      let claims;
      try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        return { ok: false, code: 'operator_invalid', message: 'the operator token payload is invalid' };
      }
      if (claims?.v !== VERSION || !Number.isFinite(Number(claims?.iat))) {
        return { ok: false, code: 'operator_invalid', message: 'the operator token payload is invalid' };
      }
      return { ok: true, id: 'operator', issuedAt: Number(claims.iat) };
    },
  });
}
