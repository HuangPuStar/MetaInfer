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
import { createHash } from 'node:crypto';
import { isSandboxProfile } from './sandbox-targets.js';

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
  if (Object.hasOwn(raw, 'backend')) throw new LabError('bad_request', 'legacy execution.backend is not supported', 400);
  const driver = typeof raw.driver === 'string' ? raw.driver.trim() : 'dsh';
  if (Object.hasOwn(raw, 'sandboxProfile') && (driver !== 'dsh' || !isSandboxProfile(raw.sandboxProfile))) {
    throw new LabError('bad_request', 'sandboxProfile must name an approved target with driver dsh', 400);
  }
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
    ...(Object.hasOwn(raw, 'sandboxProfile') ? { sandboxProfile: raw.sandboxProfile } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(codexPath ? { codexPath } : {}),
  };
}

/**
 * Resolve a node's profile from an explicit profile, a task type mapping, or
 * the project default.
 * @param {object} project project record.
 * @param {{executionProfile?: string, taskType?: string, fallbackToDefault?: boolean}} input requested selection.
 */
export function resolveExecutionProfile(project, input = {}) {
  const execution = project?.config?.execution ?? {};
  if (['backend', 'profile', 'driver', 'sandboxProfile'].some((key) => Object.hasOwn(execution, key))) {
    throw new LabError('bad_request', 'execution must use named profiles; legacy or wrong-level sandbox selection is not supported', 400);
  }
  const profiles = execution.profiles && typeof execution.profiles === 'object'
    ? execution.profiles
    : DEFAULT_EXECUTION_PROFILES;
  const taskType = typeof input.taskType === 'string' && input.taskType.trim()
    ? input.taskType.trim().slice(0, 64)
    : '';
  const mapped = taskType ? execution.taskTypes?.[taskType] : undefined;
  const inherited = input.inheritExecution;
  const isolatedParent = inherited?.sandboxProfile !== undefined;
  if (isolatedParent) normalizeExecutionProfile(inherited);
  const requested = input.executionProfile !== undefined && input.executionProfile !== null && input.executionProfile !== ''
    ? profileName(input.executionProfile, 'executionProfile')
    : (isolatedParent ? profileName(inherited.profile, 'inherited execution profile') : (typeof mapped === 'string' && mapped ? mapped : DEFAULT_EXECUTION_PROFILE));
  if (!profiles[requested]) {
    if (input.fallbackToDefault !== true || isolatedParent) {
      throw new LabError('bad_request', `unknown execution profile: ${requested}`, 400);
    }
    // A suggestion that names a profile this project does not define ("default"
    // and "auto" are the usual ones) must not discard the proposal that carried
    // it: selection metadata is not the experiment. Fall back to the project
    // default and let the caller report the correction.
    const fallback = normalizeExecutionProfile(profiles[DEFAULT_EXECUTION_PROFILE]);
    return {
      profile: DEFAULT_EXECUTION_PROFILE,
      requestedProfile: requested,
      profileFallback: true,
      taskType,
      ...fallback,
    };
  }
  const profile = normalizeExecutionProfile(profiles[requested]);
  if (isolatedParent && profile.sandboxProfile !== inherited.sandboxProfile) {
    throw new LabError('bad_request', 'sandbox inheritance cannot fall back to local execution or change target', 400);
  }
  return {
    profile: requested,
    requestedProfile: requested,
    profileFallback: false,
    taskType,
    ...profile,
  };
}

/** Whether this execution is the existing in-process DSH worker. */
export function isDshExecution(execution) {
  return !execution || execution.driver === 'dsh' || execution.driver === undefined;
}

/** Only immutable launch policy fields cross creation/edit/inheritance seams. */
export function executionSnapshot(execution) {
  return { profile: profileName(execution?.profile ?? DEFAULT_EXECUTION_PROFILE, 'execution profile'), ...normalizeExecutionProfile(execution) };
}

export function executionFingerprint(execution) {
  return createHash('sha256').update(JSON.stringify(executionSnapshot(execution))).digest('hex');
}
