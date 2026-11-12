#!/usr/bin/env node
/**
 * Static guard: every SCREAMING_SNAKE identifier referenced in client.js must be
 * declared somewhere in the same module. Added after `MAX_RENDERED_NODES` was
 * used in the canvas window chip but never defined, which surfaced only in the
 * browser (ReferenceError inside the render path) and slipped past the jsdom
 * panel smoke because that branch needs culled nodes to execute.
 *
 * Scope is deliberately narrow: uppercase identifiers only, comments and string
 * literals stripped first, and a small explicit allowlist for identifiers the
 * browser provides. Declaration may be const/let/var, a function, an import, a
 * parameter, or a destructuring binding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** Identifiers supplied by the platform or by JSON, not by this module. */
const ALLOWED = new Set([
  'JSON', 'URL', 'GPU', 'LDS', 'DOM', 'SVG', 'API', 'HTTP', 'HTTPS', 'HBM',
  'NODE_ENV', 'NaN', 'Infinity',
]);

/** Remove comments and string/template literals so prose never looks like code. */
function codeOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
      out += ' "" ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const code = codeOnly(source);

/** Collect every `NAME` that looks like a module-level constant reference. */
const used = new Map();
for (const match of code.matchAll(/(^|[^\w$.])([A-Z][A-Z0-9_]{2,})\b(?!\s*:)/g)) {
  const name = match[2];
  if (ALLOWED.has(name)) continue;
  used.set(name, (used.get(name) ?? 0) + 1);
}

/** A binding exists if the name is declared, imported, destructured or bound. */
function isDeclared(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`),                 // const NAME =
    new RegExp(`\\b(?:const|let|var)\\s*[{\\[]`, 'g'),             // placeholder, handled below
    new RegExp(`\\bfunction\\s+${n}\\b`),                          // function NAME(
    new RegExp(`\\bimport\\s+[^;]*\\b${n}\\b[^;]*from\\s`),         // import { NAME }
    new RegExp(`\\b${n}\\s*[,}]`),                                  // { NAME } destructuring
    new RegExp(`\\b${n}\\s*=[^=]`),                                 // NAME = (param default / assignment)
    new RegExp(`\\b${n}\\s*\\)\\s*(?:=>|\\{)`),                     // (NAME) => or (NAME) {
  ];
  return patterns.some((re) => re.test(code));
}

const missing = [...used.keys()].filter((name) => !isDeclared(name)).sort();
assert.deepEqual(
  missing,
  [],
  `client.js references constants it never defines: ${missing.join(', ')}`,
);

const defined = code.match(/\bconst\s+MAX_RENDERED_NODES\b/);
assert.ok(defined, 'MAX_RENDERED_NODES must stay defined; the canvas window chip depends on it');
assert.ok(
  code.includes('maxRendered: MAX_RENDERED_NODES'),
  'the canvas must pass MAX_RENDERED_NODES to computeViewportWindow, so the chip and the cap agree',
);

process.stdout.write(`ok   client.js constant references resolve (${used.size} uppercase identifiers)\n`);

// Operator credential UX guard: the banner copy key and the actor_required
// mapping are part of the user-facing contract, not optional presentation.
assert.ok(source.includes("t('ws.operator.missing')"), 'operator credential banner must use ws.operator.missing');
assert.ok(source.includes('actor_required'), 'the client must map the actor_required error code');
assert.ok(source.includes('operatorCredentialIssueOf'), 'actor_required/401/403 need one shared client mapping');
assert.ok(source.includes('__METAINFER_OPERATOR_ISSUED_AT__'), 'the client must read the injected Host issue time');
assert.ok(source.includes('OPERATOR_RELOAD_MARK') && source.includes('location.reload'), 'actor_required needs one guarded automatic reload');
process.stdout.write('ok   operator credential banner, actor_required mapping and reload guard are present\n');
