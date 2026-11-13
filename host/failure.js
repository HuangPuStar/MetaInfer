/**
 * Failure attribution shared by runtime, reconcile and hierarchy compression.
 *
 * A durable failed node must carry a human-readable reason, including when an
 * external driver throws a non-Error (or nothing at all) and when a legacy node
 * only has its error on an attempt or execution log.
 */

/**
 * Render one thrown/recorded error as a non-empty reason.
 * @param {unknown} error
 * @returns {string}
 */
export function failureMessage(error) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code.trim() ? error.code.trim() : '';
    const message = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : '';
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
    try {
      const rendered = JSON.stringify(error);
      if (typeof rendered === 'string' && rendered !== '{}') return rendered;
    } catch {
      // fall through to the explicit unknown reason
    }
  }
  return 'unknown failure (no error detail was provided)';
}

/**
 * Extract an error code when the thrown value carries one.
 * @param {unknown} error
 * @returns {string|null}
 */
export function failureCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' && error.code.trim() ? error.code.trim() : null;
}

/**
 * Build the durable `node.error` record for a failed node.
 * @param {{timeboxMs?: number, timeboxMinutes?: number, deadlineAt?: number, timestamps?: {startedAt?: number}}} node
 * @param {'start'|'run'|'timeout'|'commit'} stage
 * @param {unknown} error
 */
export function failureDiagnostic(node, stage, error) {
  const timeoutMs = stage === 'timeout'
    ? (Number(node?.timeboxMs) || (Number(node?.timeboxMinutes) * 60_000) || (Number(node?.deadlineAt) - Number(node?.timestamps?.startedAt)))
    : null;
  const code = failureCode(error);
  return {
    message: failureMessage(error),
    at: Date.now(),
    stage,
    role: stage === 'start' ? 'dispatcher' : 'worker',
    ...(code ? { code } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

/**
 * Resolve the reason a terminal node is failed/cancelled, tolerating the
 * shapes seen in old records: `error` object, `error` string, attempt error,
 * execution-driver error, or a termination record with no message.
 * @param {object} node
 * @param {number} max
 * @returns {string}
 */
export function nodeFailureReason(node, max = 160) {
  const direct = node?.error;
  if (direct !== null && direct !== undefined) {
    const reason = failureMessage(direct);
    if (reason && reason !== 'unknown failure (no error detail was provided)') return reason.slice(0, max);
  }
  const candidates = [
    node?.executionRun?.error,
    ...(Array.isArray(node?.attempts) ? node.attempts.map((attempt) => attempt?.error) : []),
    node?.report?.error,
    node?.lastError,
    node?.termination?.message,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const reason = failureMessage(candidate);
    if (reason && reason !== 'unknown failure (no error detail was provided)') return reason.slice(0, max);
  }
  if (typeof node?.termination?.kind === 'string' && node.termination.kind.trim()) {
    return `terminated: ${node.termination.kind.trim()}`.slice(0, max);
  }
  const fallback = failureMessage(direct);
  return fallback.slice(0, max);
}
