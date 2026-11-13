/**
 * Contract test: the presets that need compaction actually mount it, and they
 * mount it in the shape DSH requires.
 *
 * `dsh-web-app` disables the host-plane `compaction-basic` / `command-compact` /
 * `tool-result-pruner` rows and hands compaction ownership to the preset plane,
 * so a preset without the group has no `agent/pre-step` pressure compaction and
 * no `CONTEXT_WINDOW_EXCEEDED` recovery at all.
 *
 * Two shapes are load-bearing and are asserted structurally rather than by
 * searching for substrings:
 *
 *   - the group must set `isolate` for BOTH `compaction` and `toolResultPruner`.
 *     The preset registry rejects any preset row that publishes a service into
 *     the root realm ("Preset services require isolate realms"), and a missing
 *     key makes mounting fail — the session ends up with no compaction at all.
 *   - the provider rows (`compaction-basic`, `command-compact`,
 *     `tool-result-pruner`) must be CHILDREN of the group. As sibling rows they
 *     still parse as valid YAML, but they resolve services outside the isolate
 *     realm, so the same mount failure follows.
 *
 * Earlier revisions matched raw text, which meant a commented-out entry counted
 * as present and a provider moved outside the group still passed. Comments are
 * stripped before parsing and the group's own subtree is inspected.
 *
 * Scope note: nothing here asserts that `/compact` is reachable from the
 * composer. DSH gives subagent sessions an empty command directory
 * (`dsh-client-ui-commands`: `if (sessions.subagentAddress(sessionId) !==
 * void 0) return []`), so manual compaction is a framework property this preset
 * cannot change.
 *
 * Run from the plugin directory: `node --test tests/`
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PRESETS = await readFile(new URL('../presets.patch.yml', import.meta.url), 'utf8');

/** Presets whose session keeps history across many turns. */
const LONG_LIVED = ['lab-worker', 'lab-chat', 'lab-merge', 'lab-dashboard'];

/** One-shot or never-running presets: compaction would only add a summarizer call. */
const ONE_SHOT = ['lab-advisor', 'lab-scheduler', 'lab-controller', 'lab-gc', 'lab-intake'];

/** Package names that must appear only inside the compaction group. */
const PROVIDER_PACKAGES = [
  'dsh-compaction-basic',
  'dsh-command-compact',
  'dsh-compaction-tool-result-pruner',
];

/** Drop whole-line comments so a commented-out row cannot satisfy an assertion. */
function stripComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Map each preset's `config.id` to its raw block text.
 * @param {string} source presets.patch.yml contents
 * @returns {Map<string, string>}
 */
function parsePresets(source) {
  const blocks = new Map();
  let currentId = null;
  let buffer = [];
  const flush = () => {
    if (currentId !== null) blocks.set(currentId, buffer.join('\n'));
    currentId = null;
    buffer = [];
  };
  for (const line of stripComments(source).split('\n')) {
    if (/^ {4}- id: preset-[\w-]+\s*$/.test(line)) {
      flush();
      continue;
    }
    if (currentId === null) {
      const id = /^ {8}id: ([\w-]+)\s*$/.exec(line);
      if (id !== null) {
        currentId = id[1];
        buffer.push(line);
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/**
 * Split one preset block into its compaction group and everything else.
 * @param {string} presetBody raw block text
 * @returns {{body: string, outside: string, children: string[]}|null}
 */
function compactionGroup(presetBody) {
  const lines = presetBody.split('\n');
  const start = lines.findIndex((line) => /^ {10}- id: compaction\s*$/.test(line));
  if (start === -1) return null;
  const group = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      group.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= 10) break;
    group.push(line);
  }
  const body = group.join('\n');
  const outside = [...lines.slice(0, start), ...lines.slice(start + group.length)].join('\n');
  const children = [...body.matchAll(/^ {14}- id: ([\w-]+)\s*$/gm)].map((match) => match[1]);
  return { body, outside, children };
}

const presets = parsePresets(PRESETS);

test('preset parsing is not vacuous', () => {
  assert.ok(presets.size >= 9, `expected at least 9 presets, parsed ${presets.size}`);
  for (const id of [...LONG_LIVED, ...ONE_SHOT]) {
    assert.ok(presets.has(id), `expected preset "${id}" in presets.patch.yml`);
  }
});

test('every long-lived preset mounts an isolated compaction group', () => {
  for (const id of LONG_LIVED) {
    const group = compactionGroup(presets.get(id));
    assert.ok(group !== null, `preset "${id}" must mount the compaction group`);
    assert.match(group.body, /isolate:/, `preset "${id}" group must set isolate`);
    // Both keys are required: compaction and toolResultPruner publish services.
    // Matching this way accepts the inline and block YAML styles alike.
    assert.match(group.body, /compaction:\s*true/, `preset "${id}" must isolate "compaction"`);
    assert.match(group.body, /toolResultPruner:\s*true/, `preset "${id}" must isolate "toolResultPruner"`);
    assert.ok(
      group.children.includes('compaction-basic'),
      `preset "${id}" group must have a compaction-basic child, got ${JSON.stringify(group.children)}`,
    );
    assert.ok(
      group.children.includes('tool-result-pruner'),
      `preset "${id}" group must have a tool-result-pruner child, got ${JSON.stringify(group.children)}`,
    );
  }
});

test('provider rows are children of the group, never sibling rows', () => {
  for (const id of LONG_LIVED) {
    const group = compactionGroup(presets.get(id));
    assert.ok(group !== null, `preset "${id}" must mount the compaction group`);
    for (const pkg of PROVIDER_PACKAGES) {
      assert.doesNotMatch(
        group.outside,
        new RegExp(pkg),
        `preset "${id}" mounts ${pkg} outside the isolated group; it must be a group child`,
      );
    }
  }
});

test('only the human-driven Copilot mounts the slash command', () => {
  const copilot = compactionGroup(presets.get('lab-chat'));
  assert.ok(copilot !== null, 'lab-chat must mount the compaction group');
  assert.ok(
    copilot.children.includes('command-compact'),
    `lab-chat group must include command-compact, got ${JSON.stringify(copilot.children)}`,
  );
  for (const id of ['lab-worker', 'lab-merge', 'lab-dashboard']) {
    const group = compactionGroup(presets.get(id));
    assert.ok(group !== null, `preset "${id}" must mount the compaction group`);
    assert.ok(
      !group.children.includes('command-compact'),
      `preset "${id}" is Host-driven and should not mount the slash command`,
    );
  }
});

test('one-shot presets stay without compaction as a deliberate choice', () => {
  for (const id of ONE_SHOT) {
    const body = presets.get(id);
    assert.ok(body !== undefined, `expected preset "${id}"`);
    assert.equal(compactionGroup(body), null, `preset "${id}" must not mount a compaction group`);
  }
});
