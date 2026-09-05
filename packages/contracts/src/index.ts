/**
 * @cas/contracts
 *
 * Shared type contracts that cross package boundaries: the pipeline, the
 * MCP server, the feed API and the dashboard. Sprint 0 defines only the
 * contracts the project charter and its audit corrections fix explicitly.
 * No runtime behaviour lives here. See docs/ARCHITECTURE.md and
 * docs/DATA_INPUTS.md.
 */

/**
 * HUMAN review state of one source record, as recorded in a versioned
 * editorial review record: a weekly snapshot sheet or the review workflow.
 * Written only by a human decision. Never a context-free boolean: the master
 * feed's working `ch` column is not a stable label (docs/DATA_INPUTS.md
 * section 3). Never derived from a classification decision.
 */
export const REVIEW_STATES = ['selected', 'rejected', 'unreviewed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * MACHINE decision of the automated high-recall classifier for one imported
 * source record, made before any human looks at it (docs/ARCHITECTURE.md
 * section 3, decision D15). `review` routes the record to the needs-review
 * queue. A classification decision is never a review state and never
 * implies one; the two are stored and displayed separately.
 */
export const CLASSIFICATION_DECISIONS = ['include', 'exclude', 'review'] as const;
export type ClassificationDecision = (typeof CLASSIFICATION_DECISIONS)[number];

/**
 * Execution and data context of any record, independent of the system it
 * came from:
 *
 * - `live`: obtained from a current external source during this run. A
 *   current editorial RSS or spreadsheet import and a current Graph-provider
 *   query are both `live`.
 * - `fixture`: checked-in synthetic or approved test data.
 * - `replay`: previously captured data intentionally replayed.
 *
 * Whether a record is editorial or Graph-derived is provenance, carried by a
 * later source-kind contract, not by this value. Live, fixture and replay
 * data must never be confused (docs/ARCHITECTURE.md section 7,
 * docs/SECURITY.md section 4).
 */
export const DATA_ORIGINS = ['live', 'fixture', 'replay'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];
