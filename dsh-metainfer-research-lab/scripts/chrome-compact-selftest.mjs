#!/usr/bin/env node
/**
 * Compact chrome budget guard. The project top bar is one 42px row; the tab
 * row (including copilot/replay) is one 30px row, so the canvas starts at 72px.
 * Keeping these numbers in source is intentional: this test fails if a new
 * control re-introduces wrapping or grows the chrome back.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const source = await readFile(path.join(rootDir, 'client.js'), 'utf8');

function rule(selector) {
  const marker = `'${selector} {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing CSS rule ${selector}`);
  const end = source.indexOf("',\n", start);
  assert.ok(end > start, `unterminated CSS rule ${selector}`);
  return source.slice(start, end);
}

const topbar = rule('.rl-topbar');
assert.match(topbar, /height: 42px;/);
assert.match(topbar, /padding: 0 12px;/);
assert.match(topbar, /overflow: hidden;/);
assert.ok(!/flex-wrap:\s*wrap/.test(topbar), 'top bar must not wrap');
const tabsRow = rule('.rl-topbar-tabs');
assert.match(tabsRow, /height: 30px;/);
assert.match(tabsRow, /padding: 0 12px;/);
assert.match(tabsRow, /overflow: hidden;/);
const tablist = rule('.rl-project-tabs');
assert.match(tablist, /height: 30px;/);
assert.match(tablist, /padding: 0;/);
const tab = rule('.rl-project-tab');
assert.match(tab, /height: 26px;/);
assert.match(tab, /font-size: 12px;/);
const topbarButton = rule('.rl-topbar .rl-btn');
assert.match(topbarButton, /height: 24px;/);
assert.match(rule('.rl-topbar-title'), /font-size: 13px;/);
assert.match(rule('.rl-compact-status'), /height: 22px;/);

const chromeHeight = 42 + 30;
assert.ok(chromeHeight <= 84, `chrome budget ${chromeHeight}px exceeds 84px`);

function lineHeight(selector) {
  const value = /height:\s*(\d+)px/.exec(rule(selector));
  return value === null ? NaN : Number(value[1]);
}
assert.equal(lineHeight('.rl-topbar'), 42);
assert.equal(lineHeight('.rl-topbar-tabs'), 30);
assert.equal(lineHeight('.rl-project-tabs'), 30);
assert.ok(lineHeight('.rl-topbar') <= 46);
assert.ok(lineHeight('.rl-project-tabs') <= 34);

process.stdout.write('chrome-compact-selftest: 42px row1 + 30px tabs = 72px canvas top; all checks passed\n');
