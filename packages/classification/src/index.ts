/**
 * @cas/classification
 *
 * The Sprint 3 high-recall classifier and the post-hoc calibration evaluator
 * (decision D21). Everything here is pure: no database, no network, no
 * environment access, no model call, no clock, no randomness and no human
 * label. `@cas/worker` composes this package with `@cas/database`; this
 * package never talks to PostgreSQL itself.
 */

export {
  canonicalRuleset,
  classify,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  RATIONALE_CODES,
  rulesetHash,
  RULESET_VERSION,
  type ClassificationResult,
  type RationaleCode,
} from './classifier.js';
export {
  evaluateCalibration,
  meetsRetentionTarget,
  ratio,
  RETENTION_RECALL_TARGET,
  type CalibrationCell,
  type CalibrationMetrics,
} from './calibration.js';
export {
  assertClassificationInput,
  ClassificationInputError,
  PROHIBITED_INPUT_FIELDS,
  type ClassificationInput,
} from './input.js';
export {
  assembleText,
  normalizeForMatching,
  TEXT_ASSEMBLY_VERSION,
  TEXT_FIELD_ORDER,
} from './text.js';
