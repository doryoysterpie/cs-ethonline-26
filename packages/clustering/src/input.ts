import { CLUSTERING_CONTRACT, type ClusteringContract } from './contract.js';

/**
 * The clustering engine's input boundary: a closed allowlist.
 *
 * The admitted keys and their shapes come from the behaviour contract, so the
 * hashed `allowedInputKeys` is what actually decides admission. Emptying it
 * admits nothing. A human `ReviewState`, a weekly spreadsheet label, a
 * publication status, a publisher category, the ledger's `ch` value, a raw CSV
 * cell, a batch label, an inferred week and any connection value are refused
 * by construction rather than by being listed.
 *
 * Error messages are fixed per reason and never echo a key or a value, so a
 * rejected object cannot leak a label, a token or source text.
 */
export interface ClusteringInput {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly classificationResultId: string;
  readonly classificationRunId: string;
  readonly batchId: string;
  readonly dataOrigin: string;
  /** `include`, `review` or `exclude`; only the eligible ones are clustered. */
  readonly decision: string;
  /** Canonical URL group from Sprint 2, or null when the row carried no URL. */
  readonly urlGroupId: string | null;
  /** ISO-8601 instant, or null when the export carried no usable timestamp. */
  readonly postedAt: string | null;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
}

export const CLUSTERING_INPUT_REJECTIONS = {
  notPlainObject: 'not_plain_object',
  prototypeNotPlain: 'prototype_not_plain',
  symbolKey: 'symbol_key',
  unexpectedKey: 'unexpected_key',
  missingKey: 'missing_key',
  accessorProperty: 'accessor_property',
  invalidIdentifier: 'invalid_identifier',
  invalidDecision: 'invalid_decision',
  invalidTextField: 'invalid_text_field',
  invalidTimestamp: 'invalid_timestamp',
  duplicateSourceRow: 'duplicate_source_row',
  inputBoundExceeded: 'input_bound_exceeded',
  mixedProvenance: 'mixed_provenance',
} as const;
export type ClusteringInputRejection =
  (typeof CLUSTERING_INPUT_REJECTIONS)[keyof typeof CLUSTERING_INPUT_REJECTIONS];

const MESSAGES: Readonly<Record<ClusteringInputRejection, string>> = {
  not_plain_object: 'clustering input rejected: not a plain object',
  prototype_not_plain: 'clustering input rejected: prototype is not the plain object prototype',
  symbol_key: 'clustering input rejected: symbol keys are not permitted',
  unexpected_key: 'clustering input rejected: an own key outside the allowed set is present',
  missing_key: 'clustering input rejected: a required field is missing',
  accessor_property: 'clustering input rejected: a field is an accessor rather than data',
  invalid_identifier: 'clustering input rejected: an identifier field is not a non-empty string',
  invalid_decision: 'clustering input rejected: decision is not a known classification decision',
  invalid_text_field: 'clustering input rejected: a text field is not a string or null',
  invalid_timestamp: 'clustering input rejected: a timestamp field is not an ISO instant or null',
  duplicate_source_row: 'clustering input rejected: the same source row appears more than once',
  input_bound_exceeded: 'clustering input rejected: more inputs than the contract permits',
  mixed_provenance:
    'clustering input rejected: the inputs do not share one batch and classification run',
};

export class ClusteringInputError extends Error {
  readonly reason: ClusteringInputRejection;

  constructor(reason: ClusteringInputRejection) {
    super(MESSAGES[reason]);
    this.name = 'ClusteringInputError';
    this.reason = reason;
  }
}

function reject(reason: ClusteringInputRejection): never {
  throw new ClusteringInputError(reason);
}

const DECISIONS = new Set(['include', 'exclude', 'review']);

/** Enforces the closed allowlist at runtime, so the compiled artifact behaves like the type. */
export function assertClusteringInput(
  input: ClusteringInput,
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): void {
  const fields = contract.allowedInputKeys;
  const allowed = new Set<string>(fields.map((field) => field.key));
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input === 'function'
  ) {
    reject(CLUSTERING_INPUT_REJECTIONS.notPlainObject);
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    reject(CLUSTERING_INPUT_REJECTIONS.prototypeNotPlain);
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    reject(CLUSTERING_INPUT_REJECTIONS.symbolKey);
  }
  const record = input as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) reject(CLUSTERING_INPUT_REJECTIONS.unexpectedKey);
  }
  // Descriptors are inspected before any value is read, so an accessor is
  // refused rather than invoked.
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field.key);
    if (descriptor === undefined) reject(CLUSTERING_INPUT_REJECTIONS.missingKey);
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      reject(CLUSTERING_INPUT_REJECTIONS.accessorProperty);
    }
  }
  for (const field of fields) {
    const value = record[field.key];
    switch (field.kind) {
      case 'identifier':
        if (typeof value !== 'string' || value.length === 0) {
          reject(CLUSTERING_INPUT_REJECTIONS.invalidIdentifier);
        }
        break;
      case 'decision':
        if (typeof value !== 'string' || !DECISIONS.has(value)) {
          reject(CLUSTERING_INPUT_REJECTIONS.invalidDecision);
        }
        break;
      case 'optional-identifier':
        if (value !== null && (typeof value !== 'string' || value.length === 0)) {
          reject(CLUSTERING_INPUT_REJECTIONS.invalidIdentifier);
        }
        break;
      case 'optional-timestamp':
        if (value !== null) {
          if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
            reject(CLUSTERING_INPUT_REJECTIONS.invalidTimestamp);
          }
        }
        break;
      default:
        if (value !== null && typeof value !== 'string') {
          reject(CLUSTERING_INPUT_REJECTIONS.invalidTextField);
        }
    }
  }
}

/**
 * Validates the whole page of inputs: every item individually, no repeated
 * source row, one batch and one classification run throughout, and the
 * contract's input bound respected.
 */
export function assertClusteringInputs(
  inputs: readonly ClusteringInput[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): void {
  if (inputs.length > contract.bounds.maximumInputs) {
    reject(CLUSTERING_INPUT_REJECTIONS.inputBoundExceeded);
  }
  const seen = new Set<string>();
  let batchId: string | null = null;
  let runId: string | null = null;
  for (const input of inputs) {
    assertClusteringInput(input, contract);
    if (seen.has(input.sourceRowId)) reject(CLUSTERING_INPUT_REJECTIONS.duplicateSourceRow);
    seen.add(input.sourceRowId);
    batchId ??= input.batchId;
    runId ??= input.classificationRunId;
    if (input.batchId !== batchId || input.classificationRunId !== runId) {
      reject(CLUSTERING_INPUT_REJECTIONS.mixedProvenance);
    }
  }
}
