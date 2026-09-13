/**
 * @cas/mcp-server
 *
 * Read-only MCP tooling over the incident store: `list_incidents`,
 * `explain_incident`, `chain_anomalies` and `draft_section`, served over local
 * stdio only. Built on the parallel MCP tooling track (decision D28) and
 * pending its own independent audit. See `SKILL.md` for the tool contracts
 * and `docs/MCP-TOOLING-TRACK-REPORT.md` for the evidence.
 */
export * as bounds from './bounds.js';
export {
  CHAIN_ANOMALIES,
  DRAFT_SECTION,
  EXPLAIN_INCIDENT,
  EXPECTED_CATALOGUE_SHA256,
  JSON_SCHEMA_TARGET,
  LIST_INCIDENTS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  CatalogueIntegrityError,
  advertisedInputSchema,
  advertisedOutputSchema,
  assertCatalogueIntegrity,
  catalogueSha256,
  isToolName,
  toolCatalogue,
  type CatalogueEntry,
  type ToolDefinition,
  type ToolName,
} from './definitions.js';
export {
  evidenceContractLabeller,
  type AnomalyLabeller,
  type ChainAnomalyEntry,
  type ChainSeries,
} from './engines/anomaly.js';
export {
  CLAIM_CONFIDENCES,
  GRAPH_EVIDENCE_STATES,
  PREVIEW_CLAIM_RECORDS_LIMIT,
  deterministicPreviewer,
  type DraftPreviewer,
  type PreviewClaimRecord,
  type PreviewIncident,
  type PreviewIncidentAssessment,
  type PreviewRequest,
  type PreviewResult,
  type PreviewSource,
} from './engines/draft.js';
export {
  DESTINATION_CLASSES,
  GatewayPolicyError,
  assertGatewayTarget,
  classifyDestination,
  classifyRedirect,
  createPolicyFetch,
  isGatewayPolicyError,
  type DestinationClass,
  type GatewayPolicyOptions,
  type GatewayRefusal,
} from './engines/gateway-policy.js';
export {
  GraphLiveSignalSource,
  type GraphLiveSignalSourceOptions,
  type LiveObservation,
  type LiveSignalSource,
} from './engines/live-graph.js';
export {
  CallLimiter,
  ENVIRONMENT_NAMES,
  MODE_VARIABLE,
  STORE_MODES,
  createRuntime,
  invokeTool,
  parseStoreMode,
  type ActiveCall,
  type DatabaseRoleVerification,
  type InvokeOptions,
  type RuntimeOptions,
  type ToolInvocation,
  type ToolRuntime,
} from './runtime.js';
export {
  ABORT_CAUSES,
  CallScope,
  abortCause,
  combineSignals,
  errorForCause,
  throwIfAborted,
  type AbortCause,
  type CallScopeOptions,
} from './safety/cancellation.js';
export {
  TOOL_ERROR_CODES,
  ToolError,
  isToolError,
  toToolError,
  toolErrorMessage,
  type SafeDetail,
  type ToolErrorCode,
} from './safety/errors.js';
export {
  MINIMUM_SECRET_LENGTH,
  REDACTED,
  connectionSecrets,
  createRedactor,
  redactDeep,
  secretVariants,
  type Redactor,
} from './safety/redact.js';
export { codeSpan, escapeMarkdown, inertInline } from './safety/markdown.js';
export {
  REFERENCE_REJECTIONS,
  classifySourceReference,
  type ReferenceRejection,
  type ReferenceVerdict,
} from './safety/reference.js';
export {
  EVIDENCE_TRUST,
  hasControlCharacter,
  quoteBoundedEvidence,
  quoteEvidence,
  safeDisplay,
  toSingleLine,
  toSingleLineWithoutDirection,
  type BoundedTextField,
  type QuotedEvidence,
} from './safety/text.js';
export {
  ANOMALY_BOUNDARY_SENTENCE,
  EVIDENCE_LIMITATIONS,
  HISTORICAL_BASE_STATUS,
  HOSTNAME_PATTERN,
  ISO_INSTANT_PATTERN,
  ORIGIN_ACQUISITION_CLAIM,
  PROTOCOL_SLUG_PATTERN,
  RECORDED_ORIGIN_PROVENANCE,
  RESULT_NOTICE,
  TELEMETRY_SENTENCE,
  VERSION_IDENTIFIER_PATTERN,
  exactUtcInstant,
  hostnameSchema,
  instantArgument,
  protocolSlugSchema,
  recordedOriginProvenance,
  referenceVerdictSchema,
  versionIdentifierSchema,
  type RecordedOriginProvenance,
} from './schemas/common.js';
export {
  CHAIN_ANOMALY_MODES,
  DRAFT_SECTIONS,
  chainAnomaliesInput,
  chainAnomaliesLiveInput,
  chainAnomaliesStoredInput,
  draftSectionInput,
  explainIncidentInput,
  listIncidentsInput,
  type ChainAnomaliesArguments,
  type DraftSectionArguments,
  type ExplainIncidentArguments,
  type ListIncidentsArguments,
} from './schemas/input.js';
export {
  NAMING_NOTE,
  chainAnomaliesOutput,
  claimProvenance,
  incidentAssessment,
  draftSectionOutput,
  explainIncidentOutput,
  listIncidentsOutput,
  type ChainAnomaliesOutput,
  type ClaimProvenanceDto,
  type IncidentAssessmentDto,
  type DraftSectionOutput,
  type ExplainIncidentOutput,
  type ListIncidentsOutput,
} from './schemas/output.js';
export { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, createCasMcpServer } from './server.js';
export {
  NO_REFERENCE,
  PREVIEW_EVIDENCE_NOTICE,
  PREVIEW_NAMING_NOTICE,
  PREVIEW_STATUS_NOTICE,
  REFERENCE_WITHHELD_PREFIX,
  previewOriginNotice,
  renderSourceReference,
  withPreviewNotice,
} from './tools/draft-section.js';
export {
  PostgresReadStore,
  PostgresReadStoreProvider,
  textFetchMargin,
  withReadOnlyConnection,
  type PostgresReadStoreOptions,
  type StoreMode,
} from './store/postgres-store.js';
export {
  PRIVILEGE_CHECKS,
  REQUIRED_TABLES,
  verifyDatabasePrivileges,
  type PrivilegeCheck,
  type PrivilegeReport,
} from './store/privileges.js';
export type {
  BoundedText,
  DraftIncidentRow,
  DraftSourceRow,
  EvidenceRunRow,
  IncidentAssociationRow,
  IncidentReadStore,
  IncidentReadStoreProvider,
  IncidentSourceRow,
  IncidentSummaryRow,
  ReadTransactionOptions,
  SignalObservationRow,
  SignalRunBoundary,
  SignalRunRow,
  SignalTargetRow,
} from './store/read-store.js';
export type { ToolContext } from './tools/shared.js';
export {
  ARGUMENT_REJECTIONS,
  allowedArgumentNames,
  validateArguments,
  type ArgumentRejection,
} from './validation.js';
