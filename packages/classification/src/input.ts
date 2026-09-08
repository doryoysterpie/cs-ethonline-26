import type { SourceRowStatus } from '@cas/contracts';

import { BEHAVIOR_CONTRACT, type BehaviorContract } from './contract.js';

/**
 * The classifier's input boundary: a closed allowlist.
 *
 * Codex Desktop's Sprint 3 audit passed extra own fields named
 * `analystDisposition` and `hiddenSnapshotToken` through the compiled
 * classifier, because admission was a denylist of known-bad names. It is now
 * an exact allowlist: the object must carry these six own string keys and
 * nothing else, as plain data properties on a plain prototype, each with the
 * right runtime shape. Anything else is refused.
 *
 * Error messages are fixed per reason. They never echo a key name or a value,
 * so a rejected object cannot leak a label, a token or source text through
 * the error itself.
 *
 * The admitted keys and their shapes come from the behaviour contract rather
 * than from a constant beside it, so the hashed `allowedInputKeys` is what
 * actually decides admission. Emptying it admits nothing.
 */
export interface ClassificationInput {
  /** Source row identifier, used only to associate the result with the row. */
  readonly sourceRowId: string;
  /** The row's ingestion fingerprint, stored with the result for traceability. */
  readonly rowHash: string;
  /** Ingestion status. A quarantined row is routed to review, never excluded. */
  readonly status: SourceRowStatus;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
}

export const CLASSIFICATION_INPUT_REJECTIONS = {
  notPlainObject: 'not_plain_object',
  prototypeNotPlain: 'prototype_not_plain',
  symbolKey: 'symbol_key',
  unexpectedKey: 'unexpected_key',
  missingKey: 'missing_key',
  accessorProperty: 'accessor_property',
  invalidIdentifier: 'invalid_identifier',
  invalidStatus: 'invalid_status',
  invalidTextField: 'invalid_text_field',
} as const;
export type ClassificationInputRejection =
  (typeof CLASSIFICATION_INPUT_REJECTIONS)[keyof typeof CLASSIFICATION_INPUT_REJECTIONS];

/** Fixed sentences. None of them interpolates anything from the rejected object. */
const MESSAGES: Readonly<Record<ClassificationInputRejection, string>> = {
  not_plain_object: 'classification input rejected: not a plain object',
  prototype_not_plain: 'classification input rejected: prototype is not the plain object prototype',
  symbol_key: 'classification input rejected: symbol keys are not permitted',
  unexpected_key: 'classification input rejected: an own key outside the allowed set is present',
  missing_key: 'classification input rejected: a required field is missing',
  accessor_property: 'classification input rejected: a field is an accessor rather than data',
  invalid_identifier:
    'classification input rejected: an identifier field is not a non-empty string',
  invalid_status: 'classification input rejected: status is not accepted or quarantined',
  invalid_text_field: 'classification input rejected: a text field is not a string or null',
};

export class ClassificationInputError extends Error {
  readonly reason: ClassificationInputRejection;

  constructor(reason: ClassificationInputRejection) {
    super(MESSAGES[reason]);
    this.name = 'ClassificationInputError';
    this.reason = reason;
  }
}

function reject(reason: ClassificationInputRejection): never {
  throw new ClassificationInputError(reason);
}

/**
 * Enforces the closed allowlist at runtime, so the compiled artifact behaves
 * exactly like the type. A caller that widens the object with any additional
 * own key, a symbol key, an accessor, or a non-plain prototype is refused
 * before a single rule runs.
 */
export function assertClassificationInput(
  input: ClassificationInput,
  contract: BehaviorContract = BEHAVIOR_CONTRACT,
): void {
  const fields = contract.allowedInputKeys;
  const allowed = new Set<string>(fields.map((field) => field.key));
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input === 'function'
  ) {
    reject(CLASSIFICATION_INPUT_REJECTIONS.notPlainObject);
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    reject(CLASSIFICATION_INPUT_REJECTIONS.prototypeNotPlain);
  }
  // Symbol keys are checked before string keys, so a symbol-carrying object
  // is refused for the right reason.
  if (Object.getOwnPropertySymbols(input).length > 0) {
    reject(CLASSIFICATION_INPUT_REJECTIONS.symbolKey);
  }
  const record = input as unknown as Record<string, unknown>;
  const ownKeys = Object.getOwnPropertyNames(record);
  for (const key of ownKeys) {
    if (!allowed.has(key)) reject(CLASSIFICATION_INPUT_REJECTIONS.unexpectedKey);
  }
  // Descriptors are inspected before any value is read, so an accessor is
  // refused rather than invoked.
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field.key);
    if (descriptor === undefined) reject(CLASSIFICATION_INPUT_REJECTIONS.missingKey);
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      reject(CLASSIFICATION_INPUT_REJECTIONS.accessorProperty);
    }
  }
  for (const field of fields) {
    const value = record[field.key];
    if (field.kind === 'identifier') {
      if (typeof value !== 'string' || value.length === 0) {
        reject(CLASSIFICATION_INPUT_REJECTIONS.invalidIdentifier);
      }
    } else if (field.kind === 'status') {
      if (value !== 'accepted' && value !== 'quarantined') {
        reject(CLASSIFICATION_INPUT_REJECTIONS.invalidStatus);
      }
    } else if (value !== null && typeof value !== 'string') {
      reject(CLASSIFICATION_INPUT_REJECTIONS.invalidTextField);
    }
  }
}
