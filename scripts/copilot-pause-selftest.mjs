#!/usr/bin/env node
/**
 * Contract guard for the Copilot overlay performance fix.
 *
 * A nearly full-screen Copilot drawer with `border-radius` + `overflow: hidden`
 * dragged the compositor: rAF dropped to ~5/s while open and the whole page felt
 * sluggish, even with the main thread idle. The fix removes the rounded clip and
 * pauses the covered workspace polling while the drawer is open.
 *
 * This guard keeps both halves from silently regressing:
 *  1. `.rl-copilot-native` uses a square edge (desktop and <=760px).
 *  2. The workspace poller honors a pause ref and checks a slow cadence.
 *  3. WorkspaceScreen ties that ref to copilotOpen and refreshes on close.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');
let checks = 0;
const check = (name, ok) => {
  assert.ok(ok, name);
  checks += 1;
  console.log('ok   ' + name);
};

const desktopRule = source.split('\n').find((line) => line.includes("'.rl-copilot-native { position: relative"));
check('desktop Copilot drawer uses a square edge', Boolean(desktopRule) && /border-radius:\s*0;/.test(desktopRule));
check('desktop Copilot drawer no longer paints 14px corners', Boolean(desktopRule) && !/border-radius:\s*14px;/.test(desktopRule));

const mobileRule = source.split('\n').find((line) => line.includes('@media (max-width: 760px)') && line.includes('.rl-copilot-native {'));
check('mobile Copilot drawer uses a square edge', Boolean(mobileRule) && /\.rl-copilot-native \{[^}]*border-radius:\s*0;/.test(mobileRule));
check('mobile Copilot drawer no longer paints 10px corners', Boolean(mobileRule) && !/\.rl-copilot-native \{[^}]*border-radius:\s*10px;/.test(mobileRule));

check('a slow paused cadence is defined', /const PAUSED_POLL_MS = 15000;/.test(source));
check('state polling honours the pause ref', /const pollState = async \(\) => \{[\s\S]{0,220}?pausedRef\?\.current[\s\S]{0,160}?PAUSED_POLL_MS/.test(source));
check('event polling honours the pause ref', /const pollEvents = async \(\) => \{[\s\S]{0,220}?pausedRef\?\.current[\s\S]{0,160}?PAUSED_POLL_MS/.test(source));
check('workspace hook accepts a pause ref', /function useProjectWorkspace\(projectId, t, options = undefined\)/.test(source) && /pausedRef/.test(source));
check('workspace passes its pause ref into the poller', /useProjectWorkspace\(projectId, t, \{ pausedRef: copilotPauseRef \}\)/.test(source));
check('copilotOpen drives the pause ref and resumes on close', /copilotPauseRef\.current = copilotOpen;[\s\S]{0,120}?refresh\(\)/.test(source));
check('countdown clock pauses while the drawer is open', /useNow\(!copilotPauseRef\.current && \(runningCount > 0 \|\| autoStatus === 'running'\)\)/.test(source));

console.log(`\ncopilot-pause-selftest: ${checks} checks passed`);
