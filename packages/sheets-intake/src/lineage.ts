/**
 * The editorial lineage of the authorized workbook.
 *
 * This is recorded in code, not only in prose, because the most dangerous
 * mistake available to this connector is a category error: treating the
 * weekly tabs as ground truth because they are named after the publication.
 * They are not. They are an intermediate selection, several edits away from
 * what was actually published.
 *
 * Every stage below is separated by a human judgement that the workbook does
 * not record. A weekly tab tells you what was a candidate that week. It does
 * not tell you what ran, in what order, under what headline, or whether a
 * story survived the owner's final edit at all.
 */

export const EDITORIAL_STAGES = [
  'rss_source_corpus',
  'weekly_candidate_cut_down',
  'assistant_reformat_and_deduplicate',
  'owner_edit',
  'published_substack_edition',
] as const;
export type EditorialStage = (typeof EDITORIAL_STAGES)[number];

export interface LineageStage {
  readonly stage: EditorialStage;
  readonly ordinal: number;
  /** What this stage is, in one sentence. */
  readonly description: string;
  /** What a record at this stage may legitimately be used for. */
  readonly permittedUse: string;
  /** True only for the stage that is the authoritative editorial outcome. */
  readonly authoritative: boolean;
}

export const EDITORIAL_LINEAGE: readonly LineageStage[] = Object.freeze([
  Object.freeze({
    stage: 'rss_source_corpus',
    ordinal: 1,
    description:
      'The continuously growing RSS feed aggregated by Make. One ledger, not a series of weekly datasets.',
    permittedUse:
      'The source corpus. Rows here are candidate inputs to classification and clustering, and carry no editorial judgement.',
    authoritative: false,
  }),
  Object.freeze({
    stage: 'weekly_candidate_cut_down',
    ordinal: 2,
    description:
      "The owner's reduction of the living feed to the possible incidents and stories of interest for one editorial week.",
    permittedUse:
      'Evidence that a story was a candidate that week. It is a selection signal, never a label for what was published.',
    authoritative: false,
  }),
  Object.freeze({
    stage: 'assistant_reformat_and_deduplicate',
    ordinal: 3,
    description:
      'An assistant reformatted the weekly export and deduplicated the candidate stories.',
    permittedUse:
      'Evidence about formatting and duplicate grouping. It reflects a tool, not an editorial decision.',
    authoritative: false,
  }),
  Object.freeze({
    stage: 'owner_edit',
    ordinal: 4,
    description:
      'The owner performed further editorial selection, ordering and editing. This step is not recorded in the workbook.',
    permittedUse:
      'Nothing in the workbook represents this stage. Its absence is why a weekly tab cannot be read as an outcome.',
    authoritative: false,
  }),
  Object.freeze({
    stage: 'published_substack_edition',
    ordinal: 5,
    description: 'The published Substack edition.',
    permittedUse:
      'The authoritative editorial outcome. Nothing else in this lineage may be substituted for it.',
    authoritative: true,
  }),
]);

/**
 * The fixed sentence every report carries about the historical weekly tabs.
 *
 * It is a constant rather than composed text so that no caller can soften it,
 * and so that a reader who sees it in two reports sees the same claim.
 */
export const WEEKLY_TAB_LIMITATION =
  'a weekly tab records an intermediate candidate selection, not a published outcome, and is not evaluation truth until it is explicitly paired with its published edition';

/**
 * The condition under which a historical week becomes usable as truth.
 *
 * Stated as a predicate rather than a paragraph, so that a future pairing
 * process has something to satisfy rather than something to interpret.
 */
export const PAIRING_REQUIREMENT = Object.freeze({
  /** A week needs all of these before it may be used for training or evaluation. */
  requires: Object.freeze([
    'the weekly candidate tab is identified',
    'the corresponding published edition is identified',
    'the pairing between them is reviewed and recorded by the owner',
    'the pairing is stored as its own record, separate from the workbook',
  ]),
  /** Until then, this is what the weeks may be used for. */
  permittedUntilPaired:
    'structural analysis of the workbook, and candidate-selection signals that are never presented as published outcomes',
  /**
   * Held-back weeks are chosen before any model sees them, never after. A
   * holdout selected once the results are known measures nothing.
   */
  holdoutRule:
    'a group of paired weeks is chosen and held back untouched before any tuning begins, and is never used to iterate',
});
