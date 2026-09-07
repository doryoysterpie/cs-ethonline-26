/**
 * @cas/classification
 *
 * The Sprint 3 high-recall classifier and the post-hoc calibration evaluator
 * (decision D21), corrected after the Codex Desktop audit. Everything here is
 * pure: no database, no network, no environment access, no model call, no
 * clock, no randomness and no human label. `@cas/worker` composes this
 * package with `@cas/database`; this package never talks to PostgreSQL.
 */

export { classify, type ClassificationResult } from './classifier.js';
export {
  ALLOWED_INPUT_KEYS,
  BEHAVIOR_CONTRACT,
  canonicalize,
  canonicalRuleset,
  CLASSIFIER_MODE,
  CLASSIFIER_VERSION,
  ENGINE_VERSION,
  INPUT_FIELD_ORDER,
  RATIONALE_CODES,
  rulesetHash,
  RULESET_VERSION,
  type AllowedInputKey,
  type BehaviorContract,
  type DecisionRuleContract,
  type InputTextField,
  type MatchingContract,
  type RationaleCode,
  type ScoringContract,
  type TextAssemblyContract,
} from './contract.js';
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
  CLASSIFICATION_INPUT_REJECTIONS,
  ClassificationInputError,
  type ClassificationInput,
  type ClassificationInputRejection,
} from './input.js';
export { assembleText, normalizeForMatching } from './text.js';
