#!/usr/bin/env node
/**
 * Contract guard for the 2026-11-24 batch of review fixes:
 *  - node cards are wide enough for long titles
 *  - Copilot overlay opens legacy root sessions instead of archiving them
 *  - role model clearing is explicit (`null`) end to end
 *  - expert timeout default matches the Host
 *  - running nodes may extend their timebox
 *  - repo wizard refuses subdirectories, preserves staged content, rejects
 *    credential URLs and publishes clones atomically
 *  - no operator token is embedded into rendered HTML any more
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, '..', name), 'utf8');
const client = read('client.js');
const service = read('host/lab-service.js');
const git = read('host/git-engine.js');
const entry = read('index.js');
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks += 1; console.log('ok   ' + name); };

check('node cards are 260px wide for long titles', /const NODE_W = 260;/.test(client));
check('advisor timeout draft defaults to the Host default (240s)', /numberOr\(advisor\.timeoutSeconds, 240\)/.test(client));
check('advisor timeout save fallback is 240s', /parseInteger\(draft\.advisorTimeoutSeconds, 240\)/.test(client));
check('cleared role models are sent as explicit null', /else models\[role\] = null;/.test(client));
check('Host deletes a null role instead of keeping the old value', /if \(raw === null\) \{\s*delete models\[role\];/.test(service));
check('running nodes may extend their timebox only', /extendingRunningTimebox = node\.status === 'running'/.test(service));
check('running timebox moves the absolute deadline', /node\.deadlineAt = Math\.max\(base \+ node\.timeboxMs, Date\.now\(\) \+ 60_000\)/.test(service));
check('legacy root sessions are no longer archived on open/create',
  !/await archiveRootCopilots\(projectId\);\n\s*\/\/ A proper Copilot/.test(service)
  && !/async function createPrivateCopilotSession\(projectId, title = ''\) \{\n\s*const project = requireProject\(projectId\);\n\s*await archiveRootCopilots/.test(service));
check('an unknown requested Copilot session is an error, not a silent substitute', /copilot_session_not_found/.test(service));
check('legacy sessions stay in the picker and open natively', /legacy: entry\?\.private === false/.test(client) && /picked\?\.legacy === true/.test(client));
check('repo wizard rejects subdirectories of an existing repository', /repo_not_root/.test(git));
check('first commit preserves already staged content', /diff', '--cached', '--name-only'/.test(git));
check('credential-bearing remote URLs are refused', /remote_credentials_rejected/.test(git));
check('clones publish through a staging directory', /\.tmp-\$\{cacheDirName\(url\)\}/.test(git) && /await rename\(staging, target\)/.test(git));
check('no operator token is injected into rendered HTML', !/webserver\/index-inject/.test(entry));

console.log(`\nfixes-20261124-selftest: ${checks} checks passed`);
