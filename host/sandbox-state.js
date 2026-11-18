/** Shared interpretation of physical ownership versus unresolved admission/results. */
import { isSandboxProfile } from './sandbox-targets.js';
export function sandboxProfileOf(node) {
  return node?.execution?.sandboxProfile ?? null;
}

function bindingOf(node) {
  return node?.sandbox?.backend === 'opensandbox' ? node.sandbox : null;
}

export function holdsResources(node) {
  if (node?.status === 'running') return true;
  const binding = bindingOf(node);
  if (binding) return binding.verifiedClean !== true;
  return false; // a logical admission/gate is not a physical allocation
}

export function sandboxAdmissionBlock(node) {
  const binding = bindingOf(node);
  const profile = sandboxProfileOf(node);
  if (node?.execution && Object.hasOwn(node.execution, 'sandboxProfile') && !isSandboxProfile(node.execution.sandboxProfile)) return 'sandbox_target_invalid';
  if (profile === null && !binding && !node?.sandboxGate && node?.admission?.broker !== 'sandbox-admission') return null;
  if (binding && (profile === null || binding.profile !== profile)) return 'sandbox_identity_mismatch';
  if (profile !== null && node?.execution?.driver !== 'dsh') return 'sandbox_driver_mismatch';
  if (node?.sandboxGate) {
    const gate = node.sandboxGate;
    return gate.profile === profile && typeof gate.code === 'string' && gate.code.length > 0
      && Array.isArray(gate.blockers) && Number.isFinite(gate.at) && gate.retryable === false
      ? 'sandbox_gate:' + gate.code : 'sandbox_gate_invalid';
  }
  if (node?.dispatchHold?.reason === 'sandbox_held') return 'sandbox_held';
  if (binding?.cancelRequested === true) return 'sandbox_cancelling';
  // The newest completed release must never erase an older command Unknown.
  const operations = binding?.operations ?? {};
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) return 'sandbox_operation_unknown';
  for (const operation of Object.values(operations)) {
    if (operation?.state !== 'completed') return operation?.state === 'intent' ? 'sandbox_operation_pending' : 'sandbox_operation_unknown';
  }
  if (binding && binding.verifiedClean !== true) return 'sandbox_cleanup_pending';
  if (!binding && node?.admission?.broker === 'sandbox-admission') return 'sandbox_admission_pending';
  return null;
}
