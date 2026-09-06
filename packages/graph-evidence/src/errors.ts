/**
 * Failure kinds the live client distinguishes. Every failure is explicit; the
 * client never returns an empty success (docs/SECURITY.md section 7).
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
