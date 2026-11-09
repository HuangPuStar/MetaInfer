/**
 * Contract test: long-lived lab agent presets must mount the compaction group.
 *
 * Regression: `lab-chat` (the project Copilot) shipped without the
 *
 *     - id: compaction
 *       name: cordis:group
 *       isolate: { compaction: true, toolResultPruner: true }
 *
 * group that `lab-worker`, `lab-merge` and `lab-dashboard` already mount. In
 * that configuration the Copilot agent context never provides the `compaction`
 * service, so:
 *
 *   - `@deepseek-ai/dsh-command-compact` declares `inject = ['commands', 'compaction']`
 *     (it is mounted per leaf by `dsh-base/cordis.patch.yml`), so `/compact`
 *     cannot load and manual compaction is unavailable;
 *   - `@deepseek-ai/dsh-compaction-basic`'s `agent/pre-step` pressure listener is
 *     absent, so there is no automatic compaction;
 *   - its `CONTEXT_WINDOW_EXCEEDED` listener is absent, so there is no overflow
 *     recovery either.
 *
 * The Copilot keeps one resumable session per project, so its history only grows
 * and eventually every turn fails at the provider.
 *
 * Run from the plugin directory: `node --test tests/`
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PRESETS_URL = new URL('../presets.patch.yml', import.meta.url);
const PRESETS = await readFile(PRESETS_URL, 'utf8');

/**
 * Split `presets.patch.yml` into one record per `- id: preset-*` row.
 *
 * The file is a flat Cordis patch: preset rows sit at four-space indent under
 * `plugins:`, and each row's `config:` block is the following lines until the
 * next row. Parsing the text (rather than importing a YAML parser) keeps this
 * test dependency-free, which matters because the plugin ships no dev deps.
 *
 * @returns {Map<string, string>} preset id (`lab-chat`) -> raw row text.
 */
function parsePresets(source) {
  const presets = new Map();
  const lines = source.split('\n');
  let currentId = null;
  let current = [];
  const flush = () => {
    if (currentId !== null) presets.set(currentId, current.join('\n'));
    currentId = null;
    current = [];
  };
  for (const line of lines) {
    const header = /^ {4}- id: preset-[\w-]+\s*$/.test(line);
    if (header) {
      flush();
      continue;
    }
    if (currentId === null) {
      // Look for the row's `config.id` (eight-space indent) to learn its name.
      const id = /^ {8}id: ([\w-]+)\s*$/.exec(line);
      if (id) currentId = id[1];
      else if (/^ {0,3}\S/.test(line)) currentId = null;
      if (currentId !== null) current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return presets;
}

const presets = parsePresets(PRESETS);

/** Presets whose session lives across many turns and therefore needs compaction. */
const LONG_LIVED = ['lab-worker', 'lab-chat', 'lab-merge', 'lab-dashboard'];

/** Single-shot structured-output presets: one turn, then dispose. */
const ONE_SHOT = ['lab-advisor', 'lab-scheduler', 'lab-controller', 'lab-gc', 'lab-intake'];

test('every long-lived preset mounts the compaction group', () => {
  for (const presetId of LONG_LIVED) {
    const body = presets.get(presetId);
    assert.ok(body, `preset "${presetId}" should be declared in presets.patch.yml`);
    assert.match(
      body,
      /- id: compaction\s*\n\s+name: cordis:group/,
      `preset "${presetId}" must mount the compaction group`,
    );
    assert.match(
      body,
      /isolate: \{[^}]*compaction: true/,
      `preset "${presetId}" must isolate the compaction service`,
    );
    assert.match(
      body,
      /'@deepseek-ai\/dsh-compaction-basic'/,
      `preset "${presetId}" must mount dsh-compaction-basic`,
    );
    assert.match(
      body,
      /'@deepseek-ai\/dsh-compaction-tool-result-pruner'/,
      `preset "${presetId}" must mount the tool-result pruner so oversized tool output is pruned before summarizing`,
    );
  }
});

test('compaction wiring is identical across long-lived presets', () => {
  const blockOf = (presetId) => {
    const body = presets.get(presetId);
    assert.ok(body, `preset "${presetId}" should be declared in presets.patch.yml`);
    const match = /^( {10}- id: compaction\n(?: {12,}.*\n|\s*\n)*)/m.exec(body);
    assert.ok(match, `preset "${presetId}" has no compaction block`);
    return match[1].trimEnd();
  };
  const reference = blockOf('lab-worker');
  for (const presetId of LONG_LIVED) {
    assert.equal(blockOf(presetId), reference, `preset "${presetId}" compaction block must match lab-worker`);
  }
});

test('one-shot presets stay without compaction as a deliberate choice', () => {
  for (const presetId of ONE_SHOT) {
    const body = presets.get(presetId);
    if (!body) continue;
    assert.doesNotMatch(
      body,
      /dsh-compaction-basic/,
      `preset "${presetId}" answers in one turn; mounting compaction only adds a summarizer request`,
    );
  }
});
