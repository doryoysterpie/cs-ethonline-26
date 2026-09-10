import { isDatabaseError } from '@cas/database';
import { isGraphProbeError } from '@cas/graph-evidence';

/**
 * Tool failures are a closed vocabulary with fixed messages. A tool result
 * never carries a driver message, a provider response body, a stack trace,
 * an environment value or a request value: it carries a code, the fixed
 * sentence for that code, and at most a SQLSTATE or a provider failure kind.
 */
export const TOOL_ERROR_CODES = [
  'unknown_tool',
  'invalid_arguments',
  'rate_limited',
  'too_many_concurrent_calls',
  'tool_timeout',
  'result_too_large',
  'database_not_configured',
  'database_configuration_invalid',
  'database_role_overprivileged',
  'database_unavailable',
  'database_query_failed',
  'evidence_run_not_found',
  'evidence_run_not_completed',
  'incident_not_found',
  'signal_run_not_found',
  'signal_run_not_completed',
  'graph_credential_missing',
  'graph_gateway_invalid',
  'graph_provider_failed',
  'internal_error',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  unknown_tool: 'no tool with that name is registered',
  invalid_arguments: 'the arguments were rejected',
  rate_limited: 'too many tool calls in the current window; retry later',
  too_many_concurrent_calls: 'too many tool calls are in flight; retry later',
  tool_timeout: 'the tool did not finish within its time budget',
  result_too_large: 'the result exceeds the size bound; narrow the request',
  database_not_configured: 'no database is configured for this server',
  database_configuration_invalid: 'the database configuration was rejected',
  database_role_overprivileged:
    'the database credential holds more than the read-only privileges the server requires; nothing was read',
  database_unavailable: 'the database is unavailable',
  database_query_failed: 'the database query failed',
  evidence_run_not_found: 'no evidence run with that id',
  evidence_run_not_completed: 'the evidence run is not completed',
  incident_not_found: 'no incident with that id in that evidence run',
  signal_run_not_found: 'no signal run with that id',
  signal_run_not_completed: 'the signal run is not completed',
  graph_credential_missing:
    'live mode requires GRAPH_API_KEY in the server environment; no replay or fixture data is substituted',
  graph_gateway_invalid: 'the configured Graph gateway URL was rejected',
  graph_provider_failed: 'the live provider query failed; no replay or fixture data is substituted',
  internal_error: 'the tool failed unexpectedly',
};

/** Only scalar, content-free values may travel in error details. */
export type SafeDetail = string | number | boolean | null;

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: Readonly<Record<string, SafeDetail>>;

  constructor(code: ToolErrorCode, details: Record<string, SafeDetail> = {}) {
    super(MESSAGES[code]);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

export function toolErrorMessage(code: ToolErrorCode): string {
  return MESSAGES[code];
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Maps any thrown value to a `ToolError`. Nothing about the original error
 * survives except its classification and, for a database failure, its
 * SQLSTATE; for a provider failure, its kind. `AbortError` and
 * `TimeoutError` names are the deadline's own signal.
 */
export function toToolError(error: unknown): ToolError {
  if (isToolError(error)) return error;
  if (isDatabaseError(error)) {
    const code = error.code !== null && SQLSTATE.test(error.code) ? { sqlstate: error.code } : {};
    switch (error.kind) {
      case 'configuration':
        return new ToolError('database_configuration_invalid');
      case 'connection':
        return new ToolError('database_unavailable', code);
      default:
        return new ToolError('database_query_failed', code);
    }
  }
  if (isGraphProbeError(error)) {
    if (error.kind === 'credential') return new ToolError('graph_credential_missing');
    if (error.kind === 'validation' && error.message.startsWith('gateway base URL rejected')) {
      return new ToolError('graph_gateway_invalid');
    }
    return new ToolError('graph_provider_failed', { providerFailureKind: error.kind });
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ToolError('tool_timeout');
  }
  return new ToolError('internal_error');
}
