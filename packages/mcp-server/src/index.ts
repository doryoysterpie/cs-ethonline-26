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
  LIST_INCIDENTS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  CatalogueIntegrityError,
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
  deterministicPreviewer,
  type DraftPreviewer,
  type PreviewIncident,
  type PreviewRequest,
  type PreviewResult,
  type PreviewSource,
} from './engines/draft.js';
export {
  GraphLiveSignalSource,
  type GraphLiveSignalSourceOptions,
  type LiveObservation,
  type LiveSignalSource,
} from './engines/live-graph.js';
export {
  CallLimiter,
  ENVIRONMENT_NAMES,
  createRuntime,
  invokeTool,
  type RuntimeOptions,
  type ToolInvocation,
  type ToolRuntime,
} from './runtime.js';
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
  REDACTED,
  connectionSecrets,
  createRedactor,
  redactDeep,
  type Redactor,
} from './safety/redact.js';
export {
  EVIDENCE_TRUST,
  hasControlCharacter,
  quoteEvidence,
  safeDisplay,
  toSingleLine,
  type QuotedEvidence,
} from './safety/text.js';
export { RESULT_NOTICE, TELEMETRY_SENTENCE } from './schemas/common.js';
export {
  CHAIN_ANOMALY_MODES,
  DRAFT_SECTIONS,
  chainAnomaliesInput,
  draftSectionInput,
  explainIncidentInput,
  listIncidentsInput,
  type ChainAnomaliesArguments,
  type DraftSectionArguments,
  type ExplainIncidentArguments,
  type ListIncidentsArguments,
} from './schemas/input.js';
export {
  chainAnomaliesOutput,
  draftSectionOutput,
  explainIncidentOutput,
  listIncidentsOutput,
  type ChainAnomaliesOutput,
  type DraftSectionOutput,
  type ExplainIncidentOutput,
  type ListIncidentsOutput,
} from './schemas/output.js';
export { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, createCasMcpServer } from './server.js';
export { PostgresReadStore, readOnly } from './store/postgres-store.js';
export type {
  DraftIncidentRow,
  EvidenceRunRow,
  IncidentAssociationRow,
  IncidentReadStore,
  IncidentSourceRow,
  IncidentSummaryRow,
  SignalObservationRow,
  SignalRunRow,
  SignalTargetRow,
} from './store/read-store.js';
export {
  ARGUMENT_REJECTIONS,
  allowedArgumentNames,
  validateArguments,
  type ArgumentRejection,
} from './validation.js';
