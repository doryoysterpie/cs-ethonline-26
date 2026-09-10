/**
 * Failure kinds the live client distinguishes. Every failure is explicit; the
 * client never returns an empty success (docs/SECURITY.md section 7). `limit`
 * is a resource limit crossed by the provider's response or by the caller:
 * an oversized body, a too-deep or too-large JSON document, or too many
 * requests in flight (`RESOURCE_LIMITS.graph`, decision D26).
 */
export const GRAPH_PROBE_FAILURE_KINDS = [
  'credential',
  'http',
  'graphql',
  'schema',
  'validation',
  'indexing',
  'timeout',
  'network',
  'limit',
] as const;
export type GraphProbeFailureKind = (typeof GRAPH_PROBE_FAILURE_KINDS)[number];

export class GraphProbeError extends Error {
  readonly kind: GraphProbeFailureKind;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(kind: GraphProbeFailureKind, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GraphProbeError';
    this.kind = kind;
    this.details = details;
  }
}

export function isGraphProbeError(value: unknown): value is GraphProbeError {
  return value instanceof GraphProbeError;
}
