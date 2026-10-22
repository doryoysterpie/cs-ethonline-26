/**
 * @cas/roundup
 *
 * The round-up contract (CAS-004): the rundown template, the slot schema, the
 * prompt contract, the deterministic rendering, the validation of a model
 * response against the selection, the Markdown export and the cost estimate.
 * Pure: no network, no model client, no database, no clock.
 */
export { canonicalize, sha256 } from './canonical.js';
export {
  costMicrodollars,
  INPUT_MICRODOLLARS_PER_TOKEN,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  MONTHLY_CAP_MICRODOLLARS,
  monthKey,
  OUTPUT_MICRODOLLARS_PER_TOKEN,
  worstCaseMicrodollars,
  wouldExceedCap,
  type TokenUsage,
} from './cost.js';
export { isRoundupError, RoundupError, type BilledUsage, type RoundupErrorCode } from './errors.js';
export {
  generateRoundup,
  prepareGeneration,
  type GenerateOptions,
  type GenerationProvenance,
  type RoundupGeneration,
} from './generate.js';
export {
  assertRoundupInput,
  INPUT_LIMITS,
  inputDigest,
  publisherOf,
  type FlaggedEntry,
  type RoundupInput,
  type SelectedIncident,
  type SelectedRow,
} from './input.js';
export { PROMPT_VERSION, promptHash, systemPrompt, userPrompt } from './prompt.js';
export {
  deterministicFlagged,
  deterministicSlots,
  MAX_MARKDOWN_CHARACTERS,
  renderMarkdown,
} from './render.js';
export {
  FlaggedEntrySchema,
  ModelSlotsSchema,
  RoundupSlotsSchema,
  RundownEntrySchema,
  SLOT_LIMITS,
  slotsJsonSchema,
  type ModelSlots,
  type RoundupFlagged,
  type RoundupSlots,
  type RundownEntry,
} from './schema.js';
export { escapeInline, inlineSlotTextIssue, urlsIn, type InlineTextIssue } from './text.js';
export {
  loadTemplate,
  parseTemplate,
  sectionOf,
  TEMPLATE_PATH,
  type LoadedTemplate,
  type RundownTemplate,
  type TemplateSection,
} from './template.js';
export {
  recordedTransport,
  type GenerationRequest,
  type GenerationResponse,
  type RoundupTransport,
} from './transport.js';
export { validateResponse } from './validate.js';
