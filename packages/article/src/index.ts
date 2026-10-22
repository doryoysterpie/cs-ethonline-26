/**
 * @cas/article
 *
 * The article contract (CAS-005): the input built from a reading of the
 * selection's sources, the slot schema, the prompt contract for the reporter
 * register (D41), the validation of a model response against the selection
 * and the texts read, the Markdown export and the cost rules. Pure: no
 * network, no model client, no database, no clock.
 */
export { canonicalize, sha256 } from './canonical.js';
export {
  CHARACTERS_PER_TOKEN,
  costMicrodollars,
  estimatedInputTokens,
  INPUT_MICRODOLLARS_PER_TOKEN,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  MONTHLY_CAP_MICRODOLLARS,
  OUTPUT_MICRODOLLARS_PER_TOKEN,
  worstCaseMicrodollars,
  wouldExceedCap,
  type TokenUsage,
} from './cost.js';
export { ArticleError, isArticleError, type ArticleErrorCode } from './errors.js';
export {
  generateArticle,
  prepareArticle,
  sourceProvenance,
  type ArticleGeneration,
  type ArticleProvenance,
  type ArticleSourceProvenance,
  type GenerateOptions,
} from './generate.js';
export {
  assertArticleInput,
  INPUT_LIMITS,
  inputDigest,
  readableRows,
  unreadRows,
  type ArticleIncident,
  type ArticleInput,
  type ArticleRow,
  type ReadingStatus,
  type SourceReading,
} from './input.js';
export { PROMPT_VERSION, promptHash, systemPrompt, userPrompt } from './prompt.js';
export { renderMarkdown } from './render.js';
export {
  ArticleSlotsSchema,
  CONTRACT,
  NAMING_BASES,
  ParagraphSchema,
  SECTIONS,
  SLOT_LIMITS,
  slotsJsonSchema,
  VictimNamingSchema,
  type ArticleParagraph,
  type ArticleSlots,
  type NamingBasis,
  type Section,
  type VictimNaming,
} from './schema.js';
export { countWords, normalizeForMatch, quotedSpans } from './text.js';
export {
  recordedTransport,
  type ArticleTransport,
  type GenerationRequest,
  type GenerationResponse,
} from './transport.js';
export { validateArticle, wordCountOf } from './validate.js';
