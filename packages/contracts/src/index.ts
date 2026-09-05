/**
 * @cas/contracts
 *
 * Shared type contracts that cross package boundaries: the pipeline, the
 * MCP server, the feed API and the dashboard. Sprint 0 defines only the two
 * contracts the project charter fixes explicitly. No runtime behaviour lives
 * here. See docs/ARCHITECTURE.md and docs/DATA_INPUTS.md.
 */

/**
 * Review state of one source record inside a versioned weekly editorial
 * snapshot. Never a context-free boolean: the master feed's working `ch`
 * column is not a stable label (docs/DATA_INPUTS.md).
 */
export const REVIEW_STATES = ['selected', 'rejected', 'unreviewed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/**
 * Origin of any record shown or processed. Live Graph data, fixtures and
 * replay data must never be visually or programmatically confused
 * (docs/ARCHITECTURE.md, docs/SECURITY.md).
 */
export const DATA_ORIGINS = ['live', 'fixture', 'replay'] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];
