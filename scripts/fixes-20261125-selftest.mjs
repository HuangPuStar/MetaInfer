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
const registry = read('host/experts/registry.js');
const activation = read('host/experts/activation.js');
const models = read('host/models.js');
check('built-in experts inherit the install model instead of hard-coding deepseek', /model: null, \/\/ inherit/.test(registry) && !/provider: 'deepseek'/.test(registry));
check('roster resolution never invents a provider', !/\?\? 'deepseek'/.test(activation));
check('registered provider routes are enumerable', /export async function registeredProviderIds\(ctx\)/.test(models));
check('an unregistered expert provider falls back to the project/default model', /provider "\$\{expert\.model\?\.provider\}" is not registered/.test(orch));
check('hiring without an explicit model stores no model override', /provider && model \? \{ provider, model \} : \{\}/.test(service));
check('running needs can shrink in place', /async function shrinkNeeds\(projectId, nodeId, needs, reason = 'needs_shrunk'\)/.test(runtime) && /needs_increase_requires_readmission/.test(runtime));
check('shrinking releases the quota delta on the held record', /held\[key\] = Math\.max\(0, Number\(held\[key\] \?\? 0\) - released\)/.test(runtime));
check('the service routes decreases to shrink and increases to requeue', /await runtime\.shrinkNeeds\(projectId, nodeId, checkedNeeds\.needs, 'needs_shrunk'\)/.test(service));
check('lease TTL is configurable and swept with a warning before release', /leaseTtlMinutes: integer\(input\.leaseTtlMinutes/.test(service) && /async function sweepLeaseTtl\(nowMs = Date\.now\(\)\)/.test(runtime) && /node\/lease_idle_warning/.test(runtime) && /lease TTL expired/.test(runtime));

check('canvas search box is wired to a centering lookup', /className: 'rl-canvas-search'/.test(client) && /const runSearch = React\.useCallback/.test(client) && /centerOnNode\(id\)/.test(client) && /searchMatches/.test(client));
check('canvas search is keyword based and testable', /function matchDagNodes\(items, query\)/.test(client) && /node\.prompt,/.test(client) && /node\.reportText,/.test(client));
check('the task list follows the node number', /const idOrdinal = \(node\) =>/.test(client) && /idOrdinal\(left\) - idOrdinal\(right\)/.test(client));
check('search has a highlight ring and shortcuts', /highlightIds: searchMatches/.test(client) && /setLineDash/.test(client) && /event\.key === '\/'/.test(client));

check('cancelling a running node asks for confirmation first', /const \[cancelRequest, setCancelRequest\]/.test(client) && /setCancelRequest\(\{ nodeId \}\)/.test(client) && /ws\.cancel\.confirmTitle/.test(client));
check('the cancel confirmation sends humanConfirmed', /runNodeCommand\('node\.cancel', request\.nodeId, \{ humanConfirmed: true \}\)/.test(client));
check('humanDirect covers every irreversible action', /context\.humanDirect === true && IRREVERSIBLE_ACTIONS\.includes\(action\)/.test(read('host/kernel/claims.js')));

check('the project menu escapes the clipped topbar', /rl-topbar-menu-open/.test(client) && /projectMenuOpen \? 'rl-topbar rl-topbar-menu-open' : 'rl-topbar'/.test(client));

check('waiting shows the Host reason instead of a flat approval message', /autoWaitingLabelKeyOf/.test(client) && /ws\.auto\.waiting\.capacityFull/.test(client) && /ws\.auto\.waiting\.awaitingGpu/.test(client));
check('known gate errors get a human message', /KNOWN_ERROR_KEYS/.test(client) && /error\.code\.human_confirmation_required/.test(client));

const promptsSrc = read('host/prompts.js');
const gitSrc = read('host/git-engine.js');
check('the default worker prefix carries the disk policy', /Disk policy \(hard requirement/.test(promptsSrc) && /NEVER copy raw captures/.test(promptsSrc));
check('the commit guard refuses oversized untracked artifacts', /artifact_too_large/.test(gitSrc) && /maxFileMb/.test(gitSrc) && /untrackedFiles/.test(gitSrc));
check('default repository excludes are installed and never committed', /ensureRepoExcludes/.test(gitSrc) && /info\/exclude/.test(gitSrc) && /profile\//.test(gitSrc));
check('the node report declares artifacts with sizes', /artifacts: \{/.test(runtime) && /sizeBytes/.test(runtime));
check('disk audit and cleanup actions exist', /async function diskReport\(projectId\)/.test(service) && /async function diskPrune\(projectId, input = \{\}\)/.test(service) && /disk_report/.test(read('host/agent-tool.js')));
check('terminal disk warnings are recorded', /diskWarning/.test(runtime) && /maxUntrackedMb/.test(runtime));

check('the settings page can pin a role thinking effort', /modelField\('worker', 'workerProvider', 'workerModel', 'workerEffort'\)/.test(client) && /ws\.settings\.model\.effort/.test(client));
check('models.defaultEffort defaults to max and degrades gracefully', /models\.defaultEffort = .*\?\? 'max'/.test(service) && /projectDefaultEffort/.test(read('host/models.js')) && /effortFallbackFrom/.test(read('host/models.js')));
check('a saved role effort reaches the model ref', /models\[role\] = \{ provider: p, model: m, \.\.\.\(e \? \{ reasoningEffort: e \} : \{\}\) \}/.test(client));

check('needs keys are validated against the project pools in the service path', /unknown resource: \$\{name\} \(available:/.test(service));
check('a project can forbid multi-parent merges', /mergePolicy: \{/.test(service) && /merge_disabled/.test(service) && /merge_disabled/.test(orch));

check('auto resume reads wasWallClock before clearing the reason', /const wasWallClock = state\.pauseReason === 'maxWallClock';/.test(read('host/auto.js')) && /if \(wasWallClock \|\| !state\.startedAt\) state\.startedAt = Date\.now\(\);/.test(read('host/auto.js')));
check('needs.machines without a fleet fails fast', /fleet_unavailable/.test(service) && /no fleet inventory is registered/.test(service));

check('host slots count live attempts, not stale claims', /slotsUsed:live\.length/.test(read('host/dispatch/host-budget.js')) && /persistent-owner/.test(read('host/dispatch/host-budget.js')));
check('boot clears stale ownership on planned/terminal nodes', /node\/ownership_cleared/.test(read('host/reconcile.js')));
check('ghost attempts are reaped', /async function sweepGhostAttempts/.test(runtime) && /ghost_attempt/.test(runtime));
check('provider quota exhaustion pauses as quota_backoff', /provider_quota_exhausted/.test(read('host/role-errors.js')) && /quotaFailureOf/.test(read('host/auto.js')) && /nextLocalMidnight/.test(read('host/auto.js')));
check('a stale settings save cannot erase pools', /poolsChanged/.test(client) && /poolsFingerprint/.test(client));
check('workers are told to clean up their services', /Clean up before you finish/.test(read('host/prompts.js')));

check('the model catalog advertises adapter reasoning efforts', /resolveCapabilities\(ctx, provider\.id, model\.id\)/.test(read('host/models.js')) && /defaultEffort/.test(read('host/models.js')));
check('effort selects use the model gears with a generic fallback', /GENERIC_EFFORTS/.test(client) && /modelEffortsOf\(/.test(client) && /allEffortChoicesOf\(/.test(client));

check('a role can pin only its thinking effort', /else if \(e\) models\[role\] = \{ reasoningEffort: e \}/.test(client) && /effort-only ref is valid/.test(read('host/models.js')));
check('provider and model must be given together', /provider and model must be provided together/.test(service));

console.log(`\nfixes-20261125-selftest: ${checks} checks passed`);
