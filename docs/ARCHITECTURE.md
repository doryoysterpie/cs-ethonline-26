# Architecture

This document records the intended architecture as fixed by the Sprint 0 charter, the
supplied project plan (Plan 2.0) and decisions D11 to D20, and the state of each component
after Sprint 2. Where the project owner or the plan fixes something, this document says so.
Where the implementer has proposed something that is not fixed, it is marked **proposed**
and is open to revision.

Source note: the component list, the vertical slice, the non-goals, the plan's package line
for the dashboard, and the decisions in `DECISIONS.md` are the plan material available
inside the repository. No separate plan document exists here.

## 1. Components

| Package               | Responsibility (intended)                                                                                                                                                                                      | State after Sprint 2                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@cas/contracts`      | Shared types that cross package boundaries. No behaviour.                                                                                                                                                      | seven enums, the chain set, and the Graph evidence contracts; tested                          |
| `@cas/taxonomy`       | Incident taxonomy definitions and loaders for `data/taxonomy`.                                                                                                                                                 | placeholder                                                                                   |
| `@cas/database`       | Postgres schema, migrations and typed access for imported sources, normalized records, classification decisions, the review queue, review records, incidents, evidence and drafts. Sprint 2.                   | implemented (Sprint 2): migration runner, ingestion schema and parameterized operations       |
| `@cas/graph-evidence` | Live Graph-provider queries over the Messari standardized schema (D11), signal detection, the anomaly feed, and the provenance record of every request and response. Runs in parallel to editorial ingestion.  | implemented (Sprint 1): live client, adapter, TVL-delta signal, probe. Anomaly feed: Sprint 4 |
| `@cas/classification` | Automated high-recall classification of every imported source into `include`, `exclude` or `review`, with recorded rationale. Calibrated and evaluated against snapshot labels, never gated by them. Sprint 3. | placeholder                                                                                   |
| `@cas/clustering`     | Clustering included and needs-review sources into canonical incident records; the evidence-state resolver, attaching evidence including corroborating Graph signals, with complete provenance. Sprint 4.       | placeholder                                                                                   |
| `@cas/drafting`       | The drafting pipeline: the editable editorial output from canonical incidents, the live crypto section and the fixed historical draft, under the naming policy (D4), to the D3 destination. Sprint 5.          | placeholder                                                                                   |
| `@cas/mcp-server`     | MCP tools exposing incident intelligence for reuse by agents and editors, with a `SKILL.md` and a clean installation from a fresh clone. Sprint 6.                                                             | placeholder                                                                                   |
| `@cas/feed-api`       | The public incident feed, later gated by x402 (Sprint 8, conditional on the Graph gate).                                                                                                                       | placeholder                                                                                   |
| `@cas/worker`         | Runs the pipeline in order: import and normalization, classification, queue routing, clustering, canonical records; and, in parallel, Graph signal correlation.                                                | implemented (Sprint 2): CSV validation, row evaluation, manual import, CLI; later stages next |
| `@cas/dashboard`      | Next.js application, as Plan 2.0 fixes: command center, review queue, incident explorer, draft editor; judge login. The review workflow here is the only writer of `ReviewState`. Sprint 6.                    | placeholder                                                                                   |
| `@cas/sunday-agent`   | The drafting agent that drives `@cas/drafting` through the MCP tools.                                                                                                                                          | placeholder                                                                                   |
| `@cas/payer-agent`    | An agent that consumes the x402-gated feed and completes a paid request (Sprint 8, conditional on the Graph gate).                                                                                             | placeholder                                                                                   |
| `data/taxonomy`       | Taxonomy data files.                                                                                                                                                                                           | empty                                                                                         |
| `data/fixtures`       | Synthetic fixtures. Editorial CSV fixtures from Sprint 2; the remaining fixture set in Sprint 7.                                                                                                               | seven synthetic editorial CSV files (`data/fixtures/README.md`)                               |

The dashboard framework is Next.js. Plan 2.0 fixes it in the package line
`apps/dashboard: Next.js; command center, review queue, incident explorer, draft editor;
judge login`. It is an intended architectural choice, not an open decision. Next.js is not
scaffolded or installed before Sprint 6, and the placeholder package does not imply it.
Implementation choices the plan does not fix, such as the MCP transport for `@cas/mcp-server`,
remain open until their implementation sprint.

## 2. Package ownership boundaries

- A package owns its data shapes internally and exposes across boundaries only what
  `@cas/contracts` defines.
- `@cas/database` is the only package that talks to Postgres.
- `@cas/graph-evidence` is the only package that talks to a Graph provider.
- `@cas/classification` is the only package that writes a `ClassificationDecision`. Only a
  human action, through the dashboard's review workflow, writes a `ReviewState`. No component
  derives one from the other.
- `@cas/classification` and `@cas/drafting` are the only packages that call a model, and
  only after decision D9 is resolved.
- `@cas/feed-api` and `@cas/mcp-server` are read-side surfaces. They do not run the pipeline
  and do not write pipeline state.
- Applications compose packages. They contain no pipeline logic of their own.

## 3. Runtime data flow

Decision D15 fixes the runtime flow. Automated classification comes before any human
selection, and the human reviews a queue rather than the whole feed.

```
1. current master RSS / Excel / CSV feed
2. import and normalization                      (@cas/worker → @cas/database)
3. automated high-recall classification          (@cas/classification)
4. include / exclude / needs-review queue        (@cas/database, shown by @cas/dashboard)
5. incident clustering                           (@cas/clustering)
6. canonical incident records                    (@cas/database)
7. human review and editorial output             (@cas/dashboard, @cas/drafting)

in parallel:
   live Graph queries → signals → anomaly feed → corroborating evidence attached at steps 5 and 6
                                                  (@cas/graph-evidence → @cas/clustering)
```

Rules that follow from D15:

- The historical CS79 and CS86 selections, and any other confirmed weekly snapshot, are
  calibration and evaluation labels. They are never a production filter and never a
  prerequisite for processing a current feed.
- Live Graph signals corroborate. They attach evidence to canonical incidents and do not
  replace editorial ingestion. An incident with no Graph signal is still an incident.
- Step 3 must be high recall: a source the classifier is unsure about goes to `review`, not
  to `exclude`. Excluded sources are retained with their decision and rationale, so a human
  can still select them.
- The present manual workflow described in `DATA_INPUTS.md` section 1 is background for
  understanding the data and its labels, not the runtime design.

Stage by stage, with the sprint that delivers it (D16) and the current state:

1. **Import and normalization.** CSV exports from the Excel RSS workflow (D7a, D20) enter
   through `@cas/worker` into `@cas/database`, preserving raw values, provenance and
   `DataOrigin`. **Implemented in Sprint 2** (section 10): manual, on demand, through a
   command-line interface; a dashboard upload wrapper may call the same service in Sprint 6.
2. **Classification.** `@cas/classification` assigns a `ClassificationDecision` with
   rationale to every imported source. Sprint 3. Not implemented.
3. **Queue.** Included sources proceed; `review` sources wait for a human; excluded sources
   are retained. Sprint 3. Not implemented.
4. **Clustering, canonical records and evidence states.** `@cas/clustering` groups included
   and needs-review sources into canonical incidents with member lists, and the
   evidence-state resolver assigns each incident a state whose provenance chain reaches back
   to source rows and Graph responses. Sprint 4. Not implemented.
5. **Graph correlation.** `@cas/graph-evidence` queries live provider-backed data over the
   standardized schema for the chosen chains (D11) and produces `TvlDeltaSignal` records
   with full provenance. **Implemented in Sprint 1** (section 9). The anomaly feed and the
   attachment of signals as corroborating evidence by `@cas/clustering` are Sprint 4. Not
   implemented.
6. **Drafting.** `@cas/drafting` renders an editable draft to the D3 destination with the
   evidence state visible beside every claim and the naming policy (D4) applied, including
   the live crypto section and a fixed historical draft. Sprint 5. Not implemented.
7. **Review and exposure.** `@cas/dashboard` presents the command center, the queue, the
   incident explorer and the draft editor; the review workflow writes `ReviewState`;
   `@cas/mcp-server` exposes tools over the incident store with `SKILL.md`. Sprint 6.
   `@cas/feed-api` serves the public metadata allowlist (D6) behind x402. Sprint 8,
   conditional. Not implemented.

Everything in stages 1 to 7 except the feed API must be complete and demonstrable at the
Graph release gate at the end of 10 September (`SPRINT_BOARD.md`).

The four judgments in `DATA_INPUTS.md` section 4 remain distinct records throughout:
classification decision, review state, incident membership and publication are never
collapsed into one label.

## 4. The shared-contract boundary

`@cas/contracts` is the single boundary between the pipeline (`graph-evidence`,
`classification`, `clustering`, `drafting`, `database`) and its consumers (`mcp-server`,
`feed-api`, `dashboard`, the agents). Rules:

- Pipeline packages produce values typed by the contracts. Consumers read those types and
  never import a pipeline package's internals.
- The contracts package has no dependencies and no runtime behaviour beyond constant
  definitions.
- A change to a contract is a reviewed change, because every surface depends on it.
- Human decisions and machine decisions are separate contracts. Nothing may map one onto
  the other.

Contents of `@cas/contracts` after Sprint 2:

| Export                   | Kind                | Meaning                                                                                                                                                                                                                                                                                                  | Fixed by                                |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `ReviewState`            | enum, Sprint 0      | `selected`, `rejected`, `unreviewed`: human review state from a versioned review record                                                                                                                                                                                                                  | project owner's data-flow clarification |
| `ClassificationDecision` | enum, Sprint 0      | `include`, `exclude`, `review`: machine decision of the automated classifier, with rationale                                                                                                                                                                                                             | decision D15                            |
| `DataOrigin`             | enum, Sprint 0      | `live`, `fixture`, `replay`: execution and data context of a record, independent of its source                                                                                                                                                                                                           | section 7 below                         |
| `ChainId`                | enum, Sprint 1      | `ethereum`, `base`: chains whose indexed data the project reads, Ethereum mandatory                                                                                                                                                                                                                      | decision D11                            |
| `ProtocolIdentity`       | interface, Sprint 1 | the provider-returned identity of one observed deployment: `name`, `slug`, `network` verbatim, the normalized `chain`, `protocolType` and `schemaVersion`. Canonical identity is normalized chain plus provider slug; the name is required display metadata and never creates distinctness               | D18, D19                                |
| `GraphQueryProvenance`   | interface, Sprint 1 | provider kind and sanitized provider base, Subgraph ID, deployment ID as returned, the configured target's chain and slug kept separate from the provider identity, UTC query time, query-document SHA-256, block number, hash and timestamp, snapshot timestamps, indexing-error state, schema versions | Sprint 1 charter, D18                   |
| `ProtocolTvlObservation` | interface, Sprint 1 | one TVL observation with its raw decimal string, timestamp, block and source                                                                                                                                                                                                                             | Sprint 1                                |
| `TvlDeltaSignal`         | interface, Sprint 1 | current and baseline observations, measured elapsed window, window rule, exact delta and truncated percentage, provenance                                                                                                                                                                                | Sprint 1                                |
| `EditorialSourceKind`    | enum, Sprint 2      | `master`, `weekly`: which editorial export a batch came from; provenance, never inferred from content                                                                                                                                                                                                    | decision D20                            |
| `ImportBatchStatus`      | enum, Sprint 2      | `completed`, `completed_with_issues`: the only terminal batch states, because a rejected file creates no batch and a batch is never half written                                                                                                                                                         | decision D20                            |
| `SourceRowStatus`        | enum, Sprint 2      | `accepted`, `quarantined`: a quarantined row is retained in full with its issues                                                                                                                                                                                                                         | decision D20                            |
| `RowIssueSeverity`       | enum, Sprint 2      | `error` quarantines the row, `warning` records an observation and leaves it accepted                                                                                                                                                                                                                     | Sprint 2                                |

The seven contract tests in `packages/contracts/src/index.test.ts` pin the enum value sets
and prove that the two decision enums share no value and are distinct types, and that row
status and review state are distinct. Incident, evidence-state and feed-response contracts
arrive with the sprints that produce them.

## 5. Dependency direction rules

```
apps/*  →  packages/*  →  @cas/contracts
```

- `@cas/contracts` depends on nothing in the workspace.
- Every other package may depend on `@cas/contracts`.
- Pipeline packages may depend on `@cas/database` and `@cas/taxonomy`. They may not depend
  on `@cas/mcp-server`, `@cas/feed-api` or any application.
- `@cas/mcp-server` and `@cas/feed-api` may depend on `@cas/database` and `@cas/contracts`.
  They may not depend on each other or on pipeline packages.
- Applications may depend on packages. No package may depend on an application.
- No cycles. Turborepo's task graph (`turbo.json`) orders `build`, `typecheck` and `test`
  by declared dependencies, so a cycle fails the build.

**Declared edges after Sprint 2:** four. `@cas/worker` depends on `@cas/contracts` and on
`@cas/database`; `@cas/database` depends on `@cas/contracts`; `@cas/graph-evidence` depends
on `@cas/contracts`. Every other edge above is **proposed** and is declared in a package
manifest only when code that needs it lands.

## 6. Placeholders after Sprint 2

Every package except `@cas/contracts`, `@cas/graph-evidence`, `@cas/database` and
`@cas/worker` is a placeholder: a manifest, a TypeScript configuration and one source file
that exports nothing. A placeholder proves that the workspace, the compiler and the task
graph reach that package. It proves nothing else and must not be described as a feature.
`@cas/worker` implements only the import stage; its later stages are not implemented.

## 7. Data origin: execution context, not source system

Every record the system processes or shows carries a `DataOrigin`. It describes how the
record was obtained in this run, not which system it came from:

- `live`: obtained from a current external source during the run. A current editorial RSS
  or spreadsheet import and a current Graph-provider query are both `live`.
- `fixture`: checked-in synthetic or approved test data from `data/fixtures`.
- `replay`: previously captured data intentionally replayed for development or evaluation.

Whether a record is editorial or Graph-derived is provenance, not origin. It will be carried
by a later source-kind or provenance contract. A `live` record retains its acquisition
provenance: file identity and row for an import; endpoint, query, variables and block or
timestamp for a Graph query.

The dashboard, MCP tool results, feed responses and drafts label the origin of what they
show. No default substitutes one origin for another. A failed live acquisition is an explicit
error, never an empty result and never a silent fallback to fixture or replay data
(`SECURITY.md` sections 4 and 7).

## 8. Toolchain (implementation-level and reversible)

| Concern         | Choice                                                | Class                   |
| --------------- | ----------------------------------------------------- | ----------------------- |
| Package manager | pnpm 11.10.0, pinned in `packageManager`              | cost judgment           |
| Task runner     | Turborepo 2.10.12                                     | charter                 |
| Language        | TypeScript 6.0.3, `NodeNext` modules, strict          | compatibility need      |
| Lint            | ESLint 10.9.1 flat config with typescript-eslint 8.69 | preference              |
| Format          | Prettier 3.9.6                                        | preference              |
| Tests           | Vitest 4.1.11                                         | preference              |
| Node typings    | `@types/node` 24.13.3, Sprint 1, through the catalog  | necessity for Node APIs |
| Postgres driver | `pg` 8.23.0 with `@types/pg` 8.23.1, Sprint 2         | necessity; no ORM       |
| CSV parser      | `csv-parse` 7.0.2, Sprint 2, streaming RFC 4180       | necessity               |
| HTML parser     | `htmlparser2` 12.0.0, Sprint 2, derived text only     | security necessity      |
| Package pattern | compiled packages: `exports` point to `dist`          | cost judgment           |

TypeScript is held below 6.1 because typescript-eslint 8.69.0 declares that peer range and
the 7.x line is the new native compiler. TypeScript 6 no longer includes `@types/*` packages
automatically, so a package that uses Node APIs lists `"types": ["node"]` in its tsconfig.
`typecheck` and `test` depend on `^build` in `turbo.json` so that consumers see their
dependencies' emitted declarations.

## 9. Sprint 1 boundary: `@cas/graph-evidence`

Implemented and tested in Sprint 1 and corrected after two Codex audits
(`SPRINT-1-REPORT.md`, D17, D18, D19). Built on Node's global `fetch`; no GraphQL client and
no decimal package. The gate trusts provider-returned facts, never registry labels: two
identities are carried side by side, the configured target and the provider's own
`ProtocolIdentity`, and only validated provider identities are counted. Canonical protocol
identity is the normalized chain plus the provider-returned slug; the provider name is
required display metadata and never creates distinctness. A deployment ID is required to be
present, non-empty and distinct; no expected deployment ID is declared, because deployment
IDs change with every subgraph version. Every output boundary redacts credentials and
renders provider-controlled values as safe single-line text.

| Module               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/query.ts`       | The one common GraphQL document (`Protocol` interface, `financialsDailySnapshots`, `_meta`) and its SHA-256. Only the Subgraph ID varies between deployments.                                                                                                                                                                                                                                                      |
| `src/gateway-url.ts` | Structural base-URL validation with `new URL()`: `https:` only, no credentials, query or fragment, normalized `origin + path`. Provenance claims `the-graph-gateway` only for host `gateway.thegraph.com`, otherwise `graph-compatible-https-endpoint`.                                                                                                                                                            |
| `src/client.ts`      | `GraphGatewayClient`: `POST {base}/subgraphs/id/{id}`, API key only in `Authorization: Bearer`, explicit timeout, injectable fetch. Distinguishes `credential`, `http`, `graphql`, `schema`, `validation`, `indexing`, `timeout`, `network` failures, including failures while reading the body.                                                                                                                   |
| `src/adapter.ts`     | Strict validation of the response. Requires the provider's `name`, `slug`, `network`, `type` and `schemaVersion`; maps to `ProtocolTvlObservation` records plus `GraphQueryProvenance` with `origin: 'live'`, preserving the configured target separately. No protocol-specific branch.                                                                                                                            |
| `src/network.ts`     | The documented network alias table: `MAINNET` to `ethereum`, `BASE` to `base`; anything else is unrecognized and fails.                                                                                                                                                                                                                                                                                            |
| `src/display.ts`     | `safeDisplay`: renders any provider-controlled value as one line, escaping control characters and ANSI sequences, so provider content cannot forge a target or gate line. The evidence itself is never mutated.                                                                                                                                                                                                    |
| `src/gate.ts`        | The executable gate: registry validation (`validateRegistry`), identity validation with structured mismatches including the expected provider slug, target evaluation (identity, delta, freshness), and chain gates that count distinct canonical identities (chain plus provider slug), subgraph IDs and deployment IDs. Base requires every configured target.                                                   |
| `src/freshness.ts`   | 48-hour freshness limit with a 120-second clock-skew tolerance for future-dated observations.                                                                                                                                                                                                                                                                                                                      |
| `src/decimal.ts`     | Exact scaled-BigInt decimal parsing and formatting of the raw strings.                                                                                                                                                                                                                                                                                                                                             |
| `src/tvl-delta.ts`   | Deterministic `TvlDeltaSignal`: observations sorted by timestamp, baseline chosen between 12 h and 48 h before the current observation and closest to 24 h, measured elapsed window reported, percentage truncated to six fraction digits.                                                                                                                                                                         |
| `src/deployments.ts` | Configuration only: the selected public Subgraph IDs for Ethereum and Base with their declared expectations (expected provider slug, provider network, protocol type, schema version) from the verified live runs. The registry is validated at load: non-empty expected slugs, networks that normalize to the configured chain, protocol types consistent with the schema family, unique labels and Subgraph IDs. |
| `src/redact.ts`      | Redactor for the key value, bearer tokens and the legacy key-in-path URL form. The client also refuses a gateway base whose host or path contains the active key, raw or percent-encoded.                                                                                                                                                                                                                          |
| `src/probe.ts`       | The `graph:probe` command: queries every selected deployment, validates and evaluates each, prints a redacted single-line-safe summary with provider identity beside the configured slug, writes redacted details under the ignored `output/graph-probe/`, exits 0 on Ethereum gate pass, 1 on fail, 2 without a credential or with an invalid registry. Base prints `PASS/KEEP` or `FAIL/DROP`.                   |

Inputs: `GRAPH_API_KEY` (required, from the environment) and `GRAPH_GATEWAY_URL` (optional).
Outputs: `TvlDeltaSignal` records for `@cas/clustering` to consume in Sprint 4. Unit tests
(102) run without network or secret; the live test runs only through `graph:test:live` and
asserts both gates, Base included.

Out of scope and not implemented: Substreams, the anomaly feed, correlation to incidents,
any second Graph product.

## 10. Sprint 2 boundary: `@cas/database` and `@cas/worker`

Implemented and tested in Sprint 2 (`SPRINT-2-REPORT.md`, decision D20). `@cas/database` is
the only package that opens a PostgreSQL connection; `@cas/worker` parses and evaluates CSV
files and calls the database package's exported operations. A maintained driver (`pg`) and
forward-only SQL migrations replace any ORM; identifiers are application-generated UUIDs, so
no extension is needed.

### `@cas/database`

| Module             | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`    | `parseDatabaseConfig`: reads `DATABASE_URL`, validates it structurally and never echoes it; `summarizeConnection`: content-free transport summary (unix socket, loopback or remote TCP, password present, SSL requested); schema-name validation as a plain identifier.                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/redact.ts`    | Redactor for the connection string, its password and any PostgreSQL URL shape. Applied to every line the worker's commands print.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/errors.ts`    | `DatabaseError` with kinds `configuration`, `connection`, `migration`, `drift`, `query`, `transaction`; driver errors are classified by SQLSTATE or system code with fixed messages, never by copying the driver text.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/database.ts`  | `Database`: a `pg.Pool` with UTC session time zone and an optional schema on `search_path`; `withClient` and `withTransaction` (commit on resolve, rollback on throw, destroy the client if rollback fails).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/migrate.ts`   | Forward-only runner over `migrations/NNNN_name.sql`: `schema_migrations` with SHA-256 checksums, drift detection (changed, renamed or missing file), one transaction per migration, session advisory lock keyed on the current schema, no-op rerun, `migrationStatus`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/ingestion.ts` | Parameterized operations: batch lookup by idempotency key, batch insert and finalize, URL-group upsert by canonical URL, multi-row inserts of source rows, issues and review entries (VALUES lists built from parameter placeholders only), and count-only reads for reconciliation and tests. A review entry names its batch explicitly, so the composite keys of migration 0002 can check it.                                                                                                                                                                                                                                                            |
| `src/schema.ts`    | Create, drop and list for isolated test schemas; names validated before quoting; nothing drops what it did not name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `migrations/0001…` | `import_batches`, `url_groups`, `source_rows`, `row_issues`, `review_snapshots`, `review_entries`, all TEXT and JSONB with check constraints (origin, kind, status, counts, basename without a path separator, weekly label present exactly for weekly batches).                                                                                                                                                                                                                                                                                                                                                                                           |
| `migrations/0002…` | Relational provenance integrity (Codex audit correction): composite unique keys on the parents and composite foreign keys on the children, so a source row cannot differ in origin from its batch, an issue cannot name a different batch from its row, a snapshot cannot differ in label or origin from its batch, a review entry cannot join one batch's snapshot to another batch's row, and a row's canonical URL cannot disagree with its URL group. Adds `review_entries.batch_id`, backfilled from each entry's snapshot, and check constraints keeping printed metadata (basename, review label) free of control characters and bounded in length. |

### `@cas/worker`

| Module                        | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/editorial/csv-stream.ts` | Streaming read: strict UTF-8 decoding, NUL rejection, byte-order-mark handling, csv-parse with RFC 4180 quoting, embedded newlines, unlimited field size, strict column counts; byte length and SHA-256 computed while streaming; parser error codes mapped to fixed messages, never the parser's text.                                                                                                                              |
| `src/editorial/headers.ts`    | Header layout by exact normalized name: known fields, unknown names retained, blank positions accepted and never mapped, duplicates and missing required headers rejected as structural.                                                                                                                                                                                                                                             |
| `src/editorial/timestamps.ts` | Strict timezone-aware ISO 8601 parsing to a UTC instant; naive or lenient forms rejected; raw preserved by the caller.                                                                                                                                                                                                                                                                                                               |
| `src/editorial/urls.ts`       | Canonical URL for matching only: lowercase scheme and host, default port, fragment and userinfo removed, tracking parameters removed, remaining parameters sorted, path and trailing slash preserved; `http` and `https` only; no network.                                                                                                                                                                                           |
| `src/editorial/html-text.ts`  | Derived plain text through htmlparser2, labelled `html-to-text@1`; script and style content dropped, entities decoded, blocks to line breaks, whitespace collapsed, never truncated.                                                                                                                                                                                                                                                 |
| `src/editorial/rows.ts`       | Pure evaluation of one row: exact cells and named fields, parsed timestamps, normalized title, derived text, canonical URL, deterministic row hash, issues with stable codes, status, and weekly review mapping (`TRUE` selected, `FALSE` rejected, blank unreviewed, unknown quarantined); master `ch` never produces review state.                                                                                                 |
| `src/editorial/validate.ts`   | Structural pass (`inspectCsvFile`) and full count-only validation (`validateCsvFile`) without a database.                                                                                                                                                                                                                                                                                                                            |
| `src/editorial/import.ts`     | Manual import: explicit origin required, weekly label required and master label forbidden, review label and file basename validated for length and control characters before any file or database access, structural pass before any write, idempotency key over file hash and configuration, one transaction with chunked flushes, header and hash re-checked in the second pass, rollback on any error or interrupt.               |
| `src/editorial/report.ts`     | Count-only reconciliation of stored batches against recorded counts, with issue codes, review states and URL-group statistics.                                                                                                                                                                                                                                                                                                       |
| `src/editorial/display.ts`    | `toSingleLine` and `safeDisplay`: render untrusted metadata as one physical line, escaping C0, DEL, C1, ANSI introducers and the Unicode line and paragraph separators visibly, with a bounded length and a visible truncation marker. Built from code points, so the source holds no control byte. Equivalent to the proven approach in `@cas/graph-evidence`, with no dependency between the two packages.                         |
| `src/editorial/output.ts`     | Every printed line built from safe values only; the two untrusted values, basename and review label, are redacted first and then escaped and bounded; every returned entry is exactly one physical line; unknown header names reported as a count; errors rendered as kind, code, fixed message and safe details, then redacted.                                                                                                     |
| `src/cli.ts`                  | `db migrate`, `db check`, `editorial validate`, `editorial import`, `editorial report`; a batch id must be a UUID; the base redactor covers the whole `DATABASE_URL` and its raw and percent-decoded password; every emitted entry passes the redactor and then the single-line guard; exit codes 0, 2 configuration, 3 structural, 4 database, 5 unexpected, 130 interrupted; SIGINT and SIGTERM abort the import and roll it back. |

Inputs: `DATABASE_URL` (required for every command except validation) and a CSV path.
Outputs: rows in the six ingestion tables for Sprint 3 to classify. Unit tests (111 in the
worker, 15 in the database package) run without a database; PostgreSQL integration tests
(8 and 22) run only through `test:db` in schemas they create and drop themselves.

Out of scope and not implemented: classification, embeddings, clustering, model calls, the
dashboard upload wrapper, drafting, any watched directory, scheduler or cloud-drive
integration, and any editorial week boundary (D10 stays unresolved).
