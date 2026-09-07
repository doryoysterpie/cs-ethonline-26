import type { SourceRowStatus } from '@cas/contracts';

/**
 * The classifier's input boundary.
 *
 * This type is deliberately narrow. It carries only what the rules read, plus
 * the two identifiers needed to associate a result with its row. Everything a
 * human decided, everything a publisher asserted and everything that could
 * identify a calibration week is absent by construction (decision D21).
 *
 * Prohibited by name, and rejected at runtime by `assertClassificationInput`:
 * human review state, weekly selected or rejected labels, the master `ch`
 * working state, publisher category, URLs in any form, raw CSV cells or
 * fields, batch labels and any database connection value.
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

/**
 * Field names that must never reach the classifier. The list names the
 * concrete columns and contract fields that carry a human decision, a
 * publisher assertion, an address or raw source data.
 */
export const PROHIBITED_INPUT_FIELDS: readonly string[] = [
  'reviewState',
  'review_state',
  'reviewRawValue',
  'review_raw_value',
  'reviewLabel',
  'review_label',
  'snapshotId',
  'snapshot_id',
  'rawCh',
  'raw_ch',
  'ch',
  'rawCategory',
  'raw_category',
  'category',
  'rawUrl',
  'raw_url',
  'url',
  'canonicalUrl',
  'canonical_url',
  'urlGroupId',
  'url_group_id',
  'rawCells',
  'raw_cells',
  'rawFields',
  'raw_fields',
  'rawTitle',
  'raw_title',
  'rawSummary',
  'raw_summary',
  'rawDescription',
  'raw_description',
  'sourceBasename',
  'source_basename',
  'connectionString',
  'databaseUrl',
  'DATABASE_URL',
];

export class ClassificationInputError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`classification input rejected: prohibited field "${field}"`);
    this.name = 'ClassificationInputError';
    this.field = field;
  }
}

/**
 * Enforces the boundary at runtime as well as in the type system, so a caller
 * that widens the object with a label or a URL fails loudly instead of
 * silently feeding it to the rules. The field name in the error is one of the
 * fixed names above, never a value.
 */
export function assertClassificationInput(input: ClassificationInput): void {
  const record = input as unknown as Record<string, unknown>;
  for (const field of PROHIBITED_INPUT_FIELDS) {
    if (Object.hasOwn(record, field)) throw new ClassificationInputError(field);
  }
}
