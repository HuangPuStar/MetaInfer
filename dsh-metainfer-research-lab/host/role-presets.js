/**
 * Canonical agent-preset identifiers used by role and session activations.
 *
 * A preset id is an executable reference: `startActivation({agentPreset})` and
 * `agentPresets.mount(ctx, id)` fail only when a real cycle reaches them. This
 * module lets boot validate the references before any run starts.
 */

/** L0/L1/L2 and planning roles dispatched through `runRole`. */
export const ROLE_PRESETS = Object.freeze({
  advisor: 'lab-advisor',
  scheduler: 'lab-scheduler',
  branch: 'lab-branch',
  lead: 'lab-lead',
  chief: 'lab-chief',
});

/** Every preset id this plugin passes to an activation or mounts explicitly. */
export const REQUIRED_PRESETS = Object.freeze({
  ...ROLE_PRESETS,
  worker: 'lab-worker',
  merge: 'lab-merge',
  gc: 'lab-gc',
  chat: 'lab-chat',
  intake: 'lab-intake',
  controller: 'lab-controller',
  dashboard: 'lab-dashboard',
});

export class RolePresetError extends Error {
  /**
   * @param {Array<{role: string, preset: string, message: string}>} unresolved
   * @param {string[]} available
   */
  constructor(unresolved, available = []) {
    const detail = unresolved.map((entry) => `${entry.role}=${entry.preset} (${entry.message})`).join('; ');
    super(`unresolvable role agent preset(s): ${detail}${available.length > 0 ? `; available: ${available.join(', ')}` : ''}`);
    this.name = 'RolePresetError';
    this.code = 'ROLE_PRESET_NOT_FOUND';
    this.unresolved = unresolved;
    this.available = available;
  }
}

/**
 * Resolve every role preset against the live AgentPresetRegistry.
 *
 * This runs during plugin boot, after the bundle's preset rows have registered.
 * A missing or broken definition is a startup error, not a first-cycle skip.
 *
 * @param {{resolve: Function, list?: Function}} registry
 * @param {Record<string, string>} presets
 * @returns {Promise<string[]>} resolved preset ids
 */
export async function assertRolePresets(registry, presets = ROLE_PRESETS) {
  const entries = Object.entries(presets);
  if (!registry || typeof registry.resolve !== 'function') {
    throw new RolePresetError(
      entries.map(([role, preset]) => ({ role, preset, message: 'agentPresets.resolve is unavailable' })),
    );
  }
  const unresolved = [];
  const resolved = [];
  for (const [role, preset] of entries) {
    try {
      const result = await registry.resolve(preset);
      if (result?.broken) {
        unresolved.push({ role, preset, message: `preset is broken: ${result.broken}` });
      } else {
        resolved.push(preset);
      }
    } catch (error) {
      unresolved.push({ role, preset, message: error?.message ?? String(error) });
    }
  }
  if (unresolved.length > 0) {
    let available = [];
    if (typeof registry.list === 'function') {
      try {
        const rows = await registry.list();
        available = [...new Set((Array.isArray(rows) ? rows : []).map((row) => row?.id).filter(Boolean))].sort();
      } catch {
        // The missing ids and their original errors are the actionable detail.
      }
    }
    throw new RolePresetError(unresolved, available);
  }
  return resolved;
}
