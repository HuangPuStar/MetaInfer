/**
 * Round 38: role-run failure classification.
 *
 * The subagent seam intentionally resolves a child failure as
 * `{stopReason: 'error', diagnostic?}` instead of rejecting. Before this module
 * the orchestrator recorded only `stopped: error`, so an operator could not tell
 * a stream disconnect from a schema rejection without guessing from duration or
 * tool-call counts. Keep the human-readable error, but attach a stable code,
 * bounded structured detail, and an explicit retryability decision.
 */

const MAX_MESSAGE = 2000;
const MAX_STACK = 500;
const MAX_DIAGNOSTIC = 2000;
const MAX_RAW_TAIL = 200;
const MAX_PARTIAL_OUTPUT = 2000;

export const RETRYABLE_ROLE_ERROR_CODES = Object.freeze(new Set([
  'stream_disconnected',
  'run_timeout',
  'provider_rate_limited',
  'provider_unavailable',
]));

const STREAM_RE = /(stream disconnected|disconnected before completion|reconnecting|os error 110|econnreset|econnrefused|etimedout|epipe|socket hang up|connection reset|network error|fetch failed|upstream connect error|premature close|connection closed)/i;
const TIMEOUT_RE = /(timed out|deadline exceeded|run exceeded)/i;
const PERMISSION_RE = /(permission denied|permission_required|forbidden|unauthori[sz]ed|not allowed|eacces|eperm|401|403)/i;
const SCHEMA_RE = /(schema|structured[_ -]?output|validation|required property|additionalproperties|must be (?:an?|one of|of type)|invalid (?:output|result|payload))/i;
const JSON_RE = /(unexpected token|unexpected end of json|json\.parse|parse error|invalid json|json parse|unterminated string|end of json input)/i;
const RATE_RE = /(rate limit|too many requests|429|overloaded|capacity exceeded)/i;
const PROVIDER_RE = /(provider|upstream|502|503|504|500|bad gateway|service unavailable|internal server error)/i;
const AUTH_RE = /(api key|authentication|unauthorized|forbidden|401|403)/i;

function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(value) {
  return truncate(String(value ?? '').split('\n')[0], MAX_STACK);
}

/**
 * Flatten an Error and its `cause` chain without walking arbitrary graphs.
 * @param {unknown} error
 * @returns {{name:string,message:string,code:string|null,stack:string|null,chain:string[]}|null}
 */
function flattenError(error) {
  if (!error) return null;
  const chain = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'object') {
      const name = typeof current.name === 'string' ? current.name : 'Error';
      const message = typeof current.message === 'string' ? current.message : textOf(current);
      const code = typeof current.code === 'string' ? current.code : (typeof current.code === 'number' ? String(current.code) : null);
      chain.push({ name, message, code, stack: typeof current.stack === 'string' ? current.stack : null });
      current = current.cause;
      continue;
    }
    chain.push({ name: 'Error', message: textOf(current), code: null, stack: null });
    break;
  }
  if (chain.length === 0) return null;
  return {
    name: chain[0].name,
    message: chain.map((row) => row.message).filter(Boolean).join(' | ') || chain[0].message || chain[0].name,
    code: chain.find((row) => row.code)?.code ?? null,
    stack: chain[0].stack,
    chain: chain.map((row) => row.message).filter(Boolean),
  };
}

function jsonTextCandidate(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  return candidate.startsWith('{') || candidate.startsWith('[') ? candidate : null;
}

function parseJsonFailure(rawText) {
  const candidate = jsonTextCandidate(rawText);
  if (!candidate) return null;
  try {
    JSON.parse(candidate);
    return null;
  } catch (error) {
    return error;
  }
}

function looksLikeStructuredString(value) {
  if (typeof value !== 'string') return null;
  const candidate = jsonTextCandidate(value);
  if (!candidate) return null;
  try {
    JSON.parse(candidate);
    return null;
  } catch (error) {
    return error;
  }
}

function classifyCode({ failureInfo, childInfo, diagnostic, stopReason, rawText, parseError, missingStructured }) {
  const combined = [
    failureInfo?.message,
    failureInfo?.code,
    childInfo?.message,
    childInfo?.code,
    diagnostic,
    stopReason,
  ].filter(Boolean).join(' | ');
  const lower = combined.toLowerCase();

  if (parseError) return 'invalid_json';
  if (STREAM_RE.test(combined)) return 'stream_disconnected';
  if (String(stopReason ?? '').toLowerCase() === 'timeout' || TIMEOUT_RE.test(lower) || /run_timeout/i.test(failureInfo?.code ?? '')) {
    return 'run_timeout';
  }
  if (PERMISSION_RE.test(combined) || AUTH_RE.test(combined)) return 'permission_denied';
  if (SCHEMA_RE.test(combined)) return 'invalid_schema';
  if (/query_budget_exceeded/i.test(failureInfo?.code ?? '') || /tool calls, budget/i.test(combined)) return 'query_budget_exceeded';
  if (RATE_RE.test(combined)) return 'provider_rate_limited';
  if (PROVIDER_RE.test(combined)) return 'provider_unavailable';
  if (String(stopReason ?? '').toLowerCase() === 'refusal') return 'model_refused';
  if (['aborted', 'cancelled', 'canceled'].includes(String(stopReason ?? '').toLowerCase())) return 'run_cancelled';
  if (missingStructured) return 'missing_structured_output';
  if (failureInfo || childInfo || diagnostic) return 'subagent_error';
  return 'unknown_role_error';
}

/**
 * @param {{
 *   role?: string,
 *   failure?: unknown,
 *   childError?: unknown,
 *   result?: any,
 *   stopReason?: string|null,
 *   rawText?: string,
 *   syntheticFailure?: boolean,
 *   missingStructured?: boolean,
 * }} input
 */
export function classifyRoleFailure({
  role = 'role',
  failure = null,
  childError = null,
  result = null,
  stopReason = null,
  rawText = '',
  syntheticFailure = false,
  missingStructured = false,
  hasStructured = false,
} = {}) {
  const failureInfo = flattenError(failure);
  const childInfo = flattenError(childError);
  const diagnostic = typeof result?.diagnostic === 'string' ? result.diagnostic : '';
  const raw = String(rawText ?? '');
  let parseError = null;
  if (typeof result?.structured === 'string') parseError = looksLikeStructuredString(result.structured);
  if (!parseError && !hasStructured) parseError = parseJsonFailure(raw);
  if (!parseError && (failureInfo?.name === 'SyntaxError' || childInfo?.name === 'SyntaxError' || JSON_RE.test(diagnostic))) {
    parseError = failure ?? childError ?? new SyntaxError(diagnostic || 'invalid JSON');
  }
  if (!parseError && (JSON_RE.test(failureInfo?.message ?? '') || JSON_RE.test(childInfo?.message ?? ''))) {
    parseError = failure ?? childError;
  }

  const diagnosticInfo = diagnostic ? { name: 'SubagentError', message: diagnostic, code: null, stack: null } : null;
  const primary = syntheticFailure
    ? (childInfo ?? diagnosticInfo ?? failureInfo)
    : (failureInfo ?? childInfo ?? diagnosticInfo);
  const primaryMessage = primary?.message
    || parseError?.message
    || diagnostic
    || `${role} failed${stopReason ? ` (${stopReason})` : ''}`;
  const normalizedStop = stopReason ?? result?.stopReason ?? null;
  const errorCode = classifyCode({
    failureInfo,
    childInfo,
    diagnostic,
    stopReason: normalizedStop,
    rawText: raw,
    parseError,
    missingStructured,
  });
  const disconnectReason = errorCode === 'stream_disconnected'
    ? (diagnostic || primaryMessage)
    : null;
  const parseMessage = parseError instanceof Error
    ? parseError.message
    : (typeof parseError === 'string' ? parseError : null);

  const detail = {
    name: primary?.name ?? (parseError ? 'JSONParseError' : 'RoleRunError'),
    message: truncate(primaryMessage, MAX_MESSAGE),
    ...(primary?.code ? { code: primary.code } : {}),
    ...(primary?.stack ? { stack: firstLine(primary.stack) } : {}),
    stopReason: normalizedStop ? String(normalizedStop) : null,
    ...(diagnostic ? { diagnostic: truncate(diagnostic, MAX_DIAGNOSTIC) } : {}),
    hasPartialOutput: raw.length > 0,
    partialOutputChars: raw.length,
    ...(raw ? { partialOutput: truncate(raw, MAX_PARTIAL_OUTPUT) } : {}),
    ...(disconnectReason ? { disconnectReason: truncate(disconnectReason, MAX_MESSAGE) } : {}),
    ...(parseMessage ? { parseError: truncate(parseMessage, MAX_MESSAGE), rawTail: raw.slice(-MAX_RAW_TAIL) } : {}),
    ...(missingStructured ? { missingStructured: true } : {}),
  };

  const baseMessage = typeof failure?.message === 'string' && failure.message
    ? failure.message
    : `${role} stopped: ${normalizedStop ?? 'error'}`;
  let readable = baseMessage;
  const extra = detail.message || parseMessage;
  if (extra && !readable.includes(extra)) readable = `${readable}; ${extra}`;
  if (parseMessage && !readable.includes(parseMessage)) readable = `${readable}; parse error: ${parseMessage}`;
  if (missingStructured && !/structured result/i.test(readable)) {
    readable = `${readable}; completed without a valid structured result`;
  }

  return {
    error: truncate(readable, 4000),
    errorCode,
    retryable: RETRYABLE_ROLE_ERROR_CODES.has(errorCode),
    errorDetail: detail,
  };
}

/** Stable compact form used by cycle.errors and state.auto.lastLeadError. */
export function formatRoleFailure(record) {
  const code = record?.errorCode ?? 'unknown_role_error';
  const retryable = record?.retryable === true;
  let detail = '';
  if (record?.errorDetail && typeof record.errorDetail === 'object') {
    try {
      detail = JSON.stringify(record.errorDetail);
    } catch {
      detail = '';
    }
  }
  const suffix = `[code=${code}; retryable=${retryable}${detail ? `; detail=${truncate(detail, 2400)}` : ''}]`;
  return `${record?.error ?? 'role run failed'} ${suffix}`;
}
