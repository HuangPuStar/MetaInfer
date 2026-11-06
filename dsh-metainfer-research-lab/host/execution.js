/**
 * Provider-neutral execution profile selection and driver registry.
 *
 * A profile names a local execution runtime and its defaults:
 *   dsh            — DSH local worker (existing behavior)
 *   codex          — official local Codex SDK
 * Future profiles can add Claude, ACP, etc. without changing node semantics.
 */
import { LabError } from './git-engine.js';
import { runCodexExecution } from './execution-codex.js';

export const DEFAULT_EXECUTION_PROFILE = 'dsh';
export const DEFAULT_EXECUTION_PROFILES = {
  dsh: { driver: 'dsh' },
  codex: { driver: 'codex' },
  'codex-strong': { driver: 'codex', reasoningEffort: 'high' },
};

export const EXECUTION_DRIVERS = {
  codex: runCodexExecution,
};

function profileName(value, field) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new LabError('bad_request', `${field} must be a profile name`, 400);
  }
  return name;
}

/**
 * Validate one execution profile record.
 * @param {object} raw profile author input.
 * @returns {{driver: string, model?: string, reasoningEffort?: string}}
 */
export function normalizeExecutionProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LabError('bad_request', 'execution profile must be an object', 400);
  }
  const driver = typeof raw.driver === 'string' ? raw.driver.trim() : 'dsh';
  if (!['dsh', ...Object.keys(EXECUTION_DRIVERS)].includes(driver)) {
    throw new LabError('bad_request', `unknown execution driver: ${driver}`, 400);
  }
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';
  const codexPath = typeof raw.codexPath === 'string' ? raw.codexPath.trim() : '';
  if (model.length > 256) throw new LabError('bad_request', 'execution model is too long', 400);
  if (codexPath.length > 4096) throw new LabError('bad_request', 'execution codexPath is too long', 400);
  if (reasoningEffort.length > 64) throw new LabError('bad_request', 'execution reasoningEffort is too long', 400);
  return {
    driver,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(codexPath ? { codexPath } : {}),
  };
}

/**
 * Resolve a node's profile from an explicit profile, a task type mapping, or
 * the project default.
 * @param {object} project project record.
 * @param {{executionProfile?: string, taskType?: string}} input requested selection.
 */
export function resolveExecutionProfile(project, input = {}) {
  const execution = project?.config?.execution ?? {};
  const profiles = execution.profiles && typeof execution.profiles === 'object'
    ? execution.profiles
    : DEFAULT_EXECUTION_PROFILES;
  const taskType = typeof input.taskType === 'string' && input.taskType.trim()
    ? input.taskType.trim().slice(0, 64)
    : '';
  const mapped = taskType ? execution.taskTypes?.[taskType] : undefined;
  const requested = input.executionProfile !== undefined && input.executionProfile !== null && input.executionProfile !== ''
    ? profileName(input.executionProfile, 'executionProfile')
    : (typeof mapped === 'string' && mapped ? mapped : DEFAULT_EXECUTION_PROFILE);
  if (!profiles[requested]) {
    throw new LabError('bad_request', `unknown execution profile: ${requested}`, 400);
  }
  const profile = normalizeExecutionProfile(profiles[requested]);
  return {
    profile: requested,
    taskType,
    ...profile,
  };
}

/** Whether this execution is the existing in-process DSH worker. */
export function isDshExecution(execution) {
  return !execution || execution.driver === 'dsh' || execution.driver === undefined;
}
