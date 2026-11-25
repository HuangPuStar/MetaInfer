#!/usr/bin/env node
/**
 * Contract guard for the 2026-11-25 batch (AFD 22h run defect list):
 *  - multi-parent merge commits each parent step and never reports a false clean
 *  - a failed merge preparation fails the node instead of starting a worker
 *  - running attempts checkpoint their worktree and commit once before a timeout
 *  - successor's "parent not completed" error code no longer says "sealed"
 *  - the agent tool schema exposes `prompt` for successor
 *  - retry surfaces a structural candidate block as the real reason
 *  - auto resume after a wall-clock pause starts a new window
 *  - nodes_page returns planning fields unless `full` is requested
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, '..', name), 'utf8');
const runtime = read('host/runtime.js');
const service = read('host/lab-service.js');
const tool = read('host/agent-tool.js');
const auto = read('host/auto.js');
const orch = read('host/orchestrator.js');
const client = read('client.js');
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks += 1; console.log('ok   ' + name); };

check('each merged parent is committed before the next merge', /const step = await git\.finishMergeInWorktree\(node\.git\.worktreePath, `dshex\(\$\{node\.id\}\): merge parent \$\{other\.id\} \(prepare\)`\);/.test(runtime));
check('merge preparation reports failures instead of clean', /state: conflicts\.length > 0 \? 'conflict' : failure \? 'failed' : 'clean'/.test(runtime));
check('a failed merge preparation fails the node', /merge_prepare_failed/.test(runtime));
check('running attempts checkpoint on a timer', /WIP_CHECKPOINT_MS = 10 \* 60_000/.test(runtime) && /entry\.wipTimer = setInterval/.test(runtime));
check('a timeout commits a final checkpoint', /details\.stage === 'timeout'[\s\S]{0,400}checkpoint before/.test(runtime));
check('successor uses node_not_completed_source', /node_not_completed_source/.test(orch) && !/node_not_sealed_source/.test(orch));
check('agent tool exposes prompt for successor', /prompt: \{ type: 'string', description: 'for successor/.test(tool));
check('retry surfaces the structural candidate block', /blocked: \$\{relevant\.code\} - \$\{relevant\.reason\}/.test(service));
check('auto resume starts a new wall-clock window', /const wasWallClock = state\.pauseReason === 'maxWallClock';/.test(auto) && /if \(wasWallClock \|\| !state\.startedAt\) state\.startedAt = Date\.now\(\);/.test(auto));
check('nodes_page is compact unless full is requested', /const nodes = input\?\.full === true \? page : page\.map/.test(service));
check('nodes_page full flag is documented', /full: \{ type: 'boolean', description: 'for nodes_page/.test(tool));
check('merge state failed has translations', /"ws\.merge\.state\.failed": "合并失败"/.test(client) && /"ws\.merge\.state\.failed": "Merge failed"/.test(client));
check('runtime exposes requeueWithNeeds', /requeueWithNeeds,/.test(runtime) && /async function requeueWithNeeds\(projectId, nodeId, needs, reason = 'needs_changed'\)/.test(runtime));
check('requeue terminates the attempt without auto-upgrade', /\['cancel', 'dispose', 'preempted', 'requeue'\]\.includes\(kind\)/.test(runtime));
check('editing needs on a running node delegates to requeue', /runtime\.requeueWithNeeds\(projectId, nodeId, checkedNeeds\.needs, 'needs_changed'\)/.test(service));
check('advisor nodes in a pooled project must declare needs', /needs_required/.test(orch) && /spec\.cpuOnly !== true/.test(orch));
check('agent tool and advisor schema accept cpuOnly', /cpuOnly: \{ type: 'boolean'/.test(tool) && /cpuOnly: \{ type: 'boolean' \}/.test(orch));

console.log(`\nfixes-20261125-selftest: ${checks} checks passed`);
