/**
 * @cas/drafting
 *
 * The Sprint 5 deterministic drafting pipeline (decision D25). Turns reviewed
 * canonical incidents into an editable Cyberattack Sunday draft with a
 * structured provenance sidecar. Pure: no database, no network, no
 * environment, no clock, no randomness and no model call. Decision D9 is
 * unresolved, so nothing here is model-generated and nothing here may be
 * described as AI-generated.
 */
export {
  canonicalize,
  CONTRACT_VERSION,
  deepFreeze,
  DRAFTING_CONTRACT,
  DRAFTING_MODE,
  DRAFTING_VERSION,
  draftingContractHash,
  DRAFT_SECTIONS,
  CLAIM_CONFIDENCES,
  VICTIM_SUPPORTS,
  type ClaimConfidence,
  type DraftBoundsContract,
  type DraftSection,
  type DraftingContract,
  type NamingContract,
  type StyleContract,
  type VictimSupport,
} from './contract.js';
export {
  DRAFT_ID_PATTERN,
  DRAFT_MARKDOWN_NAME,
  DRAFT_SIDECAR_NAME,
  GRAPH_EVIDENCE_STATES,
  assertDraftId,
  draftDirectoryName,
  draftFileName,
  generateDraft,
  generateSection,
  publicationDate,
  serializeProvenance,
  sidecarFileName,
  type ClaimProvenance,
  type DraftClaim,
  type DraftIncident,
  type DraftProvenance,
  type DraftRequest,
  type DraftSource,
  type GeneratedDraft,
  type GraphEvidenceState,
  type IncidentAssessment,
} from './draft.js';
