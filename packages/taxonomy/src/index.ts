/**
 * @cas/taxonomy
 *
 * Sprint 3 gives this package one responsibility: the versioned
 * **classification signal policy** the high-recall classifier matches
 * against (`src/signal-policy.ts`). That policy is deliberately not called an
 * incident taxonomy. The project has no authoritative incident-taxonomy
 * specification, `data/taxonomy` is still empty, and publisher-supplied RSS
 * categories may never seed one (docs/DATA_INPUTS.md section 5). The incident
 * taxonomy and its loaders remain future work.
 */

export {
  canonicalSignalPolicy,
  CLASSIFICATION_SIGNAL_POLICY_VERSION,
  CLASSIFICATION_SIGNALS,
  CVE_IDENTIFIER_PATTERN,
  CVE_SIGNAL_ID,
  POLICY_THRESHOLDS,
  SIGNAL_TIERS,
  SIGNAL_WEIGHTS,
  type SignalDefinition,
  type SignalTier,
} from './signal-policy.js';
