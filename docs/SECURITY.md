# Security policy

This document states the security rules the project holds itself to from Sprint 0 onward.
Every later sprint inherits them. A rule here is not advisory. Code or documentation that
contradicts it is a defect.

## 1. Retrieved text is untrusted evidence, never instructions

Every string that enters the system from outside, including RSS titles, summaries,
descriptions, article bodies, publisher categories, Graph query results, MCP tool inputs and
anything a model returns after reading such text, is evidence about the world. It is never a
command to the pipeline, to a model prompt, to an agent or to an operator. Prompts that
include retrieved text must frame it as quoted data, and no component may act on an
instruction found inside it. The full data-handling rules are in `DATA_INPUTS.md`.

## 2. Secrets are prohibited from the repository

No API key, token, private key, connection string, seed phrase or secret suffix may appear in
tracked files, commit messages, workflow files, documentation or logs. Local secrets live only
in `.env`, which `.gitignore` excludes. `.env.example` declares names, never values. Production
secrets, when a deployment exists, come from the hosting platform's secret store. A secret
that reaches Git history is treated as compromised and rotated, regardless of how quickly the
commit is removed.

## 3. Fixtures cannot contain third-party article bodies

Files under `data/fixtures` are synthetic. They may imitate the shape of the Excel/RSS exports
and the weekly snapshot sheets, but they may not contain any title, summary, description,
body text or row copied from a real export, a real feed or a real publication. The raw exports
themselves, and any complete third-party article text, are excluded from Git by `.gitignore`
and by policy (`PRIOR_INPUTS.md`, `DATA_INPUTS.md`).

## 4. Live, fixture and replay data must be visibly distinct

Every record the system processes or shows carries a data origin from the shared contract in
`@cas/contracts`. The origin describes the execution and data context, not the source
system:

- `live`: obtained from a current external source during the run. A current editorial RSS
  or spreadsheet import and a current Graph-provider query are both `live`.
- `fixture`: checked-in synthetic or approved test data.
- `replay`: previously captured data intentionally replayed.

Whether a record is editorial or Graph-derived is provenance, carried separately by a later
source-kind contract, never inferred from the origin. Dashboards, MCP outputs, feed
responses and drafts must label the origin. Nothing may present fixture or replay data as
live, and no default may silently substitute one origin for another. A `live` record must
retain its acquisition provenance: file identity and row for an import; endpoint, query,
variables and block or timestamp for a Graph query.

## 5. The public x402 feed is a payment gate, not confidential access control

The planned x402-gated feed (Sprint 8, conditional on the Graph gate) charges for access to public incident
metadata. It provides no confidentiality. Nothing that must stay private, including private
editorial notes, corpus text or unpublished victim names, may be placed behind it on the
assumption that payment implies authorization. Decision D6 in `DECISIONS.md` governs what the
feed exposes.

## 6. Automatic publication is prohibited

The system produces an editable draft. A human turns the draft into the published issue. No
component may post, publish, schedule or push content to any publication channel. This
prohibition is a hackathon non-goal and a standing safety rule, not a missing feature.

## 7. Security-sensitive failures must be explicit

A failed live fetch, a missing credential, an unparseable input file, a provenance gap, an
untrusted-input rejection or a model refusal must surface as an explicit error with a cause.
No component may represent such a failure as an empty successful result, an empty list, a
zero count or a silently substituted fixture.

## 8. Supply chain

Every third-party version is pinned exactly through the pnpm catalog and the lockfile.
`pnpm-workspace.yaml` sets `minimumReleaseAge` to 24 hours so a freshly published package
version cannot be resolved into the project. Continuous integration installs with
`--frozen-lockfile` and runs with read-only repository permissions. GitHub Actions are pinned
to full commit SHAs. Do not lower or remove any of these controls to make an install succeed;
choose an older version instead.

One narrow exception process exists, decision D13 in `DECISIONS.md`. A package that is
required by an official sponsor integration, has no compatible release older than 24 hours,
and is necessary for a verified prize requirement may be excluded from the release-age gate
by exact package name, after a dated log entry records the package, version, official
source, reason, publication age and verification performed, with the exact version pinned
and the full suite rerun. No wildcard exclusion and no pre-approval.

**Additions of the security-foundation track (decision D27, pending audit).**

- The toolchain is pinned to exact releases: Node `24.21.0` in `.nvmrc` and pnpm `11.10.0`
  in `packageManager`, with `engines.node` naming that release line. Every CI job asserts,
  before anything else runs, that the Node and pnpm executing it are those releases
  (`tools/checks/toolchain.ts`). pnpm 11.10.0 refuses the corepack `+sha512` integrity suffix
  on `packageManager`, so the pnpm pin is the exact version alone; the blocker is recorded in
  `SECURITY-FOUNDATION-REPORT.md`.
- Every GitHub Action is pinned to a full commit SHA with its version beside it, every
  service image to a digest, every workflow declares least-privilege permissions, no workflow
  runs on `pull_request_target` or `workflow_run`, and every checkout discards its
  credentials. `tools/checks/workflows.ts` enforces all of it on every push.
- Every push runs `pnpm audit` and reproduces the committed CycloneDX 1.6 bill of materials
  and licence inventory (`supply-chain/`) byte for byte from the lockfile and the frozen
  install, cross-checked against pnpm's own generator (`tools/supply-chain/sbom.ts`).
- Every push scans every tracked file for token shapes and credential URLs
  (`tools/checks/secrets.ts`), for files the repository must never track
  (`tools/checks/forbidden-files.ts`), and for invalid UTF-8 and invisible or
  direction-changing characters (`tools/checks/hygiene.ts`). A finding names the file, the
  line and the rule and never the content.
- CodeQL runs over the TypeScript sources on every push, pull request and weekly
  (`.github/workflows/codeql.yml`).
- GitHub secret scanning, push protection, Dependabot alerts, private vulnerability
  reporting, branch protection on `main` and required SHA pinning are repository settings.
  They cannot be enabled from code; the owner-facing list is in
  `SECURITY-FOUNDATION-REPORT.md` section 7, and the first-party scans above are the
  readiness step that runs whether or not they are on.

## 9. Chain posture

Any chain interaction is testnet-only until the project owner explicitly approves otherwise.
Only public incident metadata and hashes may be written on chain. No personal data is ever
written on chain.

## 10. Live provider queries and credential handling

Rules the Sprint 1 live client (`@cas/graph-evidence`) implements and every later live
integration inherits:

- The provider API key is read from the environment (`GRAPH_API_KEY`, locally from the
  ignored `.env`) and travels only in an `Authorization: Bearer` header. It is never placed in
  a URL, a log line, an error message, a test fixture, a document, shell history or Git.
- Every string the client emits passes through a redactor that removes the known key value,
  any bearer token, and the legacy key-in-path gateway URL form. Provider error bodies are
  redacted and truncated before they are stored on an error.
- A live query fails explicitly with one of these kinds: `credential`, `http`, `graphql`,
  `schema`, `validation`, `indexing`, `timeout`, `network`, `limit`. A response with GraphQL
  errors, a non-2xx status, a non-JSON body, a missing entity, an empty snapshot list, a
  malformed decimal, or `hasIndexingErrors=true` is a failure, never an empty success.
- Every request carries an explicit timeout, and a failure while reading the response body
  is classified too: an abort is a `timeout`, any other read failure is `network`.
- The response body is read under a byte limit while it streams (`RESOURCE_LIMITS.graph`,
  decision D27, pending audit), never after an unbounded body is buffered. A declared
  `Content-Length` above the limit is refused before a byte is read; one below the limit is
  not trusted, because the bytes actually received decide; an absent or malformed length is
  treated as absent, which is the live gateway's normal case. The JSON document is bounded in
  nesting depth before it is parsed and in collection size and count after. At most a fixed
  number of requests are in flight per client. A crossed limit is a `limit` failure with a
  fixed message and numeric details; nothing is truncated to fit, and a non-2xx body is cut
  only for its redacted snippet.
- The gateway base URL is validated structurally with `new URL()` before any request: it
  must be `https:` with a hostname, and it must contain no username, no password, no query
  string and no fragment. A rejected URL is never echoed, because it may contain a
  credential; the error names only the rule that failed. Provenance records only the
  sanitized origin and path, and claims The Graph's gateway only when the host is
  `gateway.thegraph.com`; any other validated HTTPS endpoint is recorded as a
  Graph-compatible endpoint.
- The live gate trusts provider-returned facts, never registry labels. The adapter requires
  the provider's protocol `name`, `slug`, `network`, `type` and `schemaVersion`; the
  configured slug is never substituted for the provider slug. Before a target can count
  toward a gate, its live `slug`, `network`, `type` and `schemaVersion` are compared with the
  registry's declared expectations, and its deployment ID must be present, non-empty and
  distinct; no expected deployment ID is declared. A mismatch is a structured, redacted
  failure naming the target label, field, expected value, received value and subgraph ID.
  Canonical protocol identity is the normalized chain plus the provider-returned slug; the
  provider name is display metadata and never creates distinctness. Distinctness is counted
  over canonical identity, subgraph ID and deployment ID together. The registry itself is
  validated before any request: non-empty expected slugs, networks that normalize to the
  configured chain, protocol types consistent with the schema family, unique labels and
  Subgraph IDs.
- Every output boundary is safe against provider-controlled content. The evaluation and
  gate formatters redact their final output and render provider names, slugs, networks,
  types, schema versions, mismatch values and error messages as single-line text with
  control characters and ANSI sequences shown as visible escapes, so a provider cannot leak
  the key through a field or forge a `PASS`, `FAIL`, target or gate line. The ignored
  details file is serialized through the same redactor. The evidence itself is never
  mutated for display.
- A validated gateway base whose host or path contains the active `GRAPH_API_KEY`, raw or
  percent-encoded, is rejected before any request, and the rejected URL is never echoed.
- Freshness rejects a current observation older than 48 hours and one dated more than
  120 seconds in the future; a negative age never passes by accident.
- A live failure never falls back to fixture or replay data. The live code path contains no
  fixture or replay origin, and a unit test enforces that structurally.
- Live results carry `DataOrigin` `live` with full query provenance: provider, Subgraph ID,
  deployment ID, chain, UTC query time, SHA-256 of the query document, block number, hash
  and timestamp, snapshot timestamps, indexing-error state and schema versions.
- Detailed live output is written only under the ignored `output/` path with mode 600. Live
  integration tests run only through an explicitly named command and never in CI; CI needs
  no secret.

## 11. Database and editorial ingestion

Rules the Sprint 2 foundation (`@cas/database`, `@cas/worker`) implements and every later
consumer of the store inherits:

- Only `@cas/database` opens a PostgreSQL connection. The connection string is read from
  `DATABASE_URL`, validated structurally (a `postgres` or `postgresql` URL), and never
  printed; a rejected value is reported by the rule that failed. Every line the worker's
  commands emit passes through a redactor for the connection string, its password and any
  PostgreSQL URL shape. Driver error messages are never copied into an error; only the
  SQLSTATE or system code is kept, with a fixed message.
- Every query is parameterized. No source value is ever interpolated into SQL text, so
  SQL-looking source content is inert data; a database test proves a `DROP TABLE` string is
  stored verbatim while the table survives. Identifiers that must vary (test schema names)
  are validated as plain lowercase identifiers before they are quoted.
- Migrations are forward-only numbered SQL files. `schema_migrations` stores each applied
  file's SHA-256; a changed, renamed or missing file for an applied version is drift and
  stops the run before any change. Each migration runs and is recorded in one transaction. A
  session advisory lock keyed on the current schema serializes concurrent runners. There is
  no reset, no down migration, and no command that drops anything it did not name. Database
  tests create and drop only schemas whose exact names they generated.
- Provenance is enforced relationally, not merely by convention. Composite unique keys on
  the parent tables and composite foreign keys on the children make every provenance
  contradiction impossible: a source row's origin must be its batch's origin, an issue's
  batch must be its row's batch, a snapshot's review label and origin must be its batch's,
  a review entry must name one batch that owns both its snapshot and its row, and a row's
  canonical URL must be the canonical URL of the group it references. A count-only
  reconciliation cannot be relied on to notice such a contradiction, so the database
  refuses it outright.
- The two metadata values that are stored and printed, the source basename and the review
  label, are bounded in length and may not contain C0, DEL or C1 controls or the Unicode
  line and paragraph separators. The rule is enforced twice: in the importer before any
  file or database access, and by check constraints in the database. Raw editorial fields
  are exempt, because source text must be preserved exactly.
- A configured database password must be one the redactor can protect. The redactor ignores
  secret values shorter than four characters, because such a value would match ordinary
  words and blank out unrelated output; rather than weaken it, the configuration refuses the
  credential. A passwordless URL stays valid, which keeps local development simple. A
  supplied password must percent-decode, and must be at least four characters once decoded;
  one, two and three-character passwords and malformed percent-encodings are configuration
  errors. Every accepted password is then redacted in both its raw and its decoded form,
  alongside the whole connection string and any PostgreSQL URL shape. The rule is enforced
  in the shared configuration parser, so migration, check, import and report all inherit it.
  The command-line boundary runs that same parser, in full, whenever `DATABASE_URL` is
  non-empty, before it dispatches any command. A credential-only check there was not enough:
  it left values whose scheme is not PostgreSQL to the parser, which validation never
  reaches, so such a URL could carry an unprotectable password into the output of a command
  that opens no database. An absent or empty value remains no configuration at all, so
  validation still runs without a database. A rejection names the rule in a fixed sentence and never echoes
  the URL, username, hostname, raw password, decoded password or any fragment of one.
- Every line the commands emit is redacted first and escaped second, so a secret that
  itself contains a control character still matches the redactor, and is then forced to one
  physical line. Untrusted metadata is rendered with control characters, ANSI introducers
  and Unicode separators shown as visible escapes and bounded with a visible truncation
  marker, so a hostile filename or label can neither forge a status, batch, reconciliation
  or issue line nor hide content from the reader. The redactor covers the whole
  `DATABASE_URL`, its raw and percent-decoded password, and any PostgreSQL URL shape.
- Source text is hostile data. Every cell is stored exactly as read, including
  prompt-injection-looking and SQL-looking strings, and nothing interprets it. Derived plain
  text is produced by a maintained HTML parser (htmlparser2), never by regular expressions:
  script, style and similar content is dropped, entities are decoded to characters, nothing
  is executed, fetched or resolved, and the transformation is labelled and versioned on
  every row. Raw and derived values are never truncated.
- A file is rejected as a whole, before any write, when it is not valid UTF-8, contains a NUL
  character (which PostgreSQL text cannot hold), violates RFC 4180 quoting, has inconsistent
  column counts, has no header, duplicates a non-blank header name, or lacks a required
  header. Row-level problems (empty title, empty or unparseable URL, a URL whose scheme is
  not `http` or `https`, an empty or non-strict timestamp, an unknown weekly review token)
  retain and quarantine the row with stable issue codes and fixed messages. Nothing is
  dropped silently. Source URLs are never fetched.
- A batch is written in one transaction; any failure, including an interrupt, rolls it back
  entirely and closes the connection. The batch's idempotency key covers the file hash and
  every behaviour-changing configuration value, so repeating an import writes nothing.
- The batch stores the file's basename only, never an absolute path. Command output and logs
  carry only basenames, hashes, counts, row numbers, ids, statuses, durations, issue codes,
  known header names and fixed messages; unknown header names are reported as a count.
- Every import declares its `DataOrigin` explicitly; there is no default. Weekly review state
  lives in its own tables, traceable to the snapshot label that supplied it, separate from
  source content and from any future machine classification. The master sheet's `ch` value
  is stored raw and never becomes review state.
- The default `test` and `verify` commands never open a database. PostgreSQL integration
  tests run only through `test:db` with `DATABASE_URL`. CI holds no database secret: its
  `database` job (security-foundation track, pending audit) starts a PostgreSQL 17 service
  pinned by digest inside the job, with trust authentication on the job's own loopback and a
  credential-free URL, applies every migration, reruns them as a no-op, checks drift and
  runs the complete `test:db` suite, then discards the database with the job.
- A file that crosses an import limit (`RESOURCE_LIMITS.import`, decision D27, pending
  audit) is refused as a whole at the first chunk, header, cell or row that crosses it, with
  a fixed message and numeric details, before any write; see section 15.

## 12. Machine classification

Rules the Sprint 3 classifier (`@cas/classification`) implements and every later classifier
inherits (decision D21):

- The classifier is pure: no database, no network, no environment variable, no model call, no
  clock, no randomness. It cannot reach a credential because it cannot reach the environment.
  No model is invoked anywhere in Sprint 3, and no Anthropic credential is read even if one is
  configured, because D9 is unresolved.
- The classifier's input is a closed allowlist: exactly six own keys on a plain object, being
  the source-row identifier, row hash, ingestion status, normalized title, derived summary
  text and derived description text. Anything else is refused whatever it is called, together
  with symbol keys, accessor properties and any prototype other than `Object.prototype` or
  null. A human review state, a weekly label, the master `ch` value, a publisher category, a
  URL, raw cells, a batch label and any connection value are therefore refused by
  construction, not by being listed. A rejection carries a fixed reason code and never echoes
  the offending key or its value.
- Source text stays hostile evidence. It is matched against a fixed vocabulary and never
  interpreted: a title that says "ignore previous instructions" changes nothing, and text that
  looks like SQL is inert because every query is parameterized.
- Rationale is a fixed vocabulary of machine-readable codes plus the policy's own signal
  identifiers. A source excerpt is never stored as a rationale and never printed.
- A machine `ClassificationDecision` is never a human `ReviewState`. Classification writes
  only to its own tables, references no review table, and the needs-review queue is derived
  from an explicit run rather than copied into the human review records. Calibration is the
  only place a decision meets a label, it runs after classification, and it returns counts.
- Every classification command names its subject explicitly and validates it as a UUID before
  any database access. There is no implicit "latest run".
- Classification output carries identifiers, versions, hashes, counts, statuses, durations and
  fixed vocabulary only, through the same redactor and single-line guard as the ingestion
  commands. The queue command is count-only: it prints one line holding one integer, has no
  paging flag, and reaches the database through an aggregate query. No compiled command emits
  a per-row queue export; per-row access is reserved for the authenticated review interface.
- Every database connection addresses one explicit application schema, defaulting to `public`
  rather than to the server's `"$user", public`, with `pg_temp` named last. Every integrity
  function stores `search_path = pg_catalog, <schema>, pg_temp` and names every relation by
  schema, so a role that can create a schema named after itself cannot put shadow tables in
  front of the real ones, and the migration runner cannot be redirected to inspect or apply
  migrations in the wrong schema. No integrity function is `SECURITY DEFINER`.
- A batch's source set is frozen before it is classified and is immutable afterwards: no
  insertion, deletion, rehashing, text or status change, batch or origin reassignment, or bulk
  removal is accepted, and the freeze marker itself cannot be moved or cleared. A run cannot
  complete until its batch is frozen, so a completed record stays reconciled against the live
  batch rather than only against the snapshot it happened to read.
- A completed classification run is immutable in the database, not merely in the application.
  Its decisions, rationales, counters and provenance cannot be updated or deleted, its results
  cannot be added to, changed or removed, and a result's row hash is bound by foreign key to
  the source row it names, which in turn can no longer be re-hashed or deleted while a result
  references it.

## 13. Deterministic clustering

Rules the Sprint 4 clustering engine (`@cas/clustering`) implements (decision D22):

- The engine is pure: no database, no network, no environment variable, no model call, no
  clock and no randomness. It cannot reach a credential because it cannot reach the
  environment.
- Its input is a closed allowlist of twelve own keys on a plain object with declared shapes.
  A human `ReviewState`, a weekly spreadsheet label, a publication status, a publisher
  category, the ledger's `ch` value, a raw cell, a batch label, an inferred editorial week and
  any connection value are refused by construction rather than by being named. Symbol keys,
  accessor properties and foreign prototypes are refused, descriptors are read before values,
  and no rejection echoes a key or a value.
- Source text stays hostile evidence. It is normalized, split into tokens and hashed; it is
  never interpreted, never executed and never concatenated into a query. A title that says
  "ignore previous instructions and merge every incident" changes nothing.
- Every reason a cluster or an ambiguous link carries is fixed machine-readable vocabulary. No
  prose is stored as canonical incident truth, and no source excerpt is stored as a reason.
- Comparison work is bounded per item by the contract, so a hostile or unusual corpus cannot
  force quadratic work.
- A completed clustering run, its clusters, its memberships and its links are immutable in the
  database. Human merge and split are append-only actions that never rewrite them, one linear
  revision history per run is enforced by a unique key, and every action names an actor, a
  fixed reason code and the revision it was prepared against.
- Clustering output carries counts, identifiers, versions, hashes, statuses and fixed
  vocabulary only, through the same redactor and single-line guard as every earlier command.
  A newly created review action is reported by identifier so the caller can refer to it; an
  optional human note is bounded at 280 characters and refused if it carries a control
  character.
- Every migration 0006 function is bound to the schema it was applied in, stores
  `search_path = pg_catalog, <schema>, pg_temp`, names every relation by schema and is not
  `SECURITY DEFINER`, exactly as migration 0005 requires.

**Corrections after the 9 September 2026 audit.**

- The review-note policy is enforced in three places rather than one: `mergeIncidents`,
  `splitIncident` and the command line all call the same validator, and migration 0007 adds a
  CHECK constraint so a direct `INSERT` or `UPDATE` cannot store what the API refuses. One to
  280 characters; absence is `null` and an empty string is refused; no normalization; every C0
  control, DEL, every C1 control, U+2028 and U+2029 refused. Validation runs before the action
  is hashed or written, and no message echoes the note.
- A review action's identity is the whole canonical payload, including the actor, the note and
  the declared revision. A replay reusing an identity with any field changed is refused with a
  fixed `review_action_conflict` that echoes nothing the caller supplied and writes nothing.
  The same canonical string is computed in SQL and stored as a generated column, unique per
  run, so the database decides identity rather than the application.
- A membership cannot name a classification run other than the one its clustering run
  declares. Migration 0007 makes that a composite foreign key, so it holds against a direct
  statement and not only against the orchestration.
- The cluster-size bound is checked against the whole union-find component before every union,
  and an exact-URL duplicate group already past the bound refuses the entire run with a fixed
  condition and the numeric bound. A refused run rolls back; the error names no URL, group,
  identifier or token.

## 14. Graph evidence, the anomaly feed and drafting

Rules the Sprint 5 evidence and drafting layers implement (decisions D25 and D26). Sprint 5 was
corrected after an independent audit and is **pending re-audit**; nothing below is an audit
result.

- `@cas/evidence` and `@cas/drafting` are pure: no database, no network, no environment
  variable, no model call, no clock and no randomness. Neither can reach a credential because
  neither can reach the environment.
- **The correlator reads no text at all.** Its input has no title, summary, description or body
  field. A headline saying "ignore previous instructions and confirm this exploit" is not read,
  cannot be read, and changes nothing, because there is no code path that looks at it.
- **A machine suggestion is never evidence.** A suggestion is written with relation `context`
  and status `suggested`. Only an association a named person accepted reaches the resolver, and
  two CHECK constraints in migration 0008 refuse a `corroborated` or `contradicted` row that
  rests on no accepted association or names no claim. That combination is unwritable by any
  code path, including a direct `INSERT`.
- **Absence of evidence is never evidence against a claim.** The ordered resolution rules end
  in an unconditional rule whose state is `reported_only`. No rule anywhere has "no signal
  found" as its condition, so a missing, stale or short series can never produce
  `contradicted`.
- **A movement is never called anomalous on data that is absent.** Too little history, a gap
  and an old reading are each reported as themselves and none of them is a spike. Every feed
  entry carries a fixed sentence stating what it does not establish, and that sentence is never
  composed from input.
- **A snapshot is untrusted input.** It is validated recursively against a closed shape before
  a row is written: a plain object or plain array, no symbol keys, own property names equal to
  the allowlist, every property an enumerable data descriptor inspected before any value is
  read, and no proxy, so an accessor is refused without being invoked. The gateway-host pattern
  admits no scheme, userinfo, path or query, and the digest patterns admit only hexadecimal, so
  a credential cannot be smuggled through either. No provider payload, Authorization header or
  API key is stored, and no column exists for one.
- **A file is never live.** A file can be ingested as fixture or replay only; live evidence
  comes from the Graph client, never from a file. The file path's origin type admits no `live`,
  the refusal happens before the path is opened or a database handle is used, and the only
  function that writes a live run takes validated Graph-client evaluations and no path. No
  origin is inferred from a filename, a label, a host or a caller's word.
- **Origins are bound, not labelled.** An evidence run's origin must equal the origin of its
  signal run and of its clustering run and batch, by composite foreign key (migration 0009),
  and a live signal run may not name a reserved-domain host. The origin is stored on the run
  and on every signal, printed on every line, and scopes the history query. The same bytes
  ingested under two origins are two runs and two series.
- **A claim is a record, not a UUID.** A `supports` or `conflicts` decision, an association and
  a resolved state may cite only a row of `incident_claims` that belongs to the same incident,
  clustering run, batch and origin. The claim cites a source row the database proves is a
  member of the incident under the run, with that row's immutable hash. The service refuses a
  nonexistent or incompatible claim before hashing; foreign keys and the `evidence_claim_guard`
  trigger refuse it again on write. Claims are recorded by a named person, never extracted from
  text, and are append-only.
- **Every migration 0008 function is written the way migration 0005 taught.** Created through
  `pg_catalog.format` with `%1$I` quoted identifiers, `SET search_path = pg_catalog, <schema>,
pg_temp`, never `SECURITY DEFINER`, and every relation schema-qualified. A shadow table in a
  role-named or temporary schema cannot answer for a real one, and a test recreates the attempt
  and requires it to fail.
- **A rationale carries the Sprint 4 note policy**: 1 to 280 characters, absence distinguished
  from emptiness, and every C0 control, DEL, C1 control, U+2028 and U+2029 refused — at the
  worker API, at the command line, and independently by a CHECK constraint.
- **Review idempotency is payload-complete.** A replay that changes the actor, the rationale,
  the relation or the claim is a fixed conflict error, never a silent repeat. The error names
  the condition alone and echoes neither actor nor rationale.
- **Nothing is model-generated.** Decision D9 is unresolved. There is no SDK, no model path and
  no credential read anywhere in the drafting pipeline, every draft states this in its own
  text, and no document may describe the output as AI-generated.
- **Nothing is published to anyone.** Every draft is marked `unpublished_requires_human_review`
  and is a file for a person to read. It is published under one authorised root, never through
  a symbolic link, and never overwritten: the root is `output/drafts/` at the repository root,
  fixed by the worker and ignored by Git, with no flag that names another; every component of
  its path is inspected and must be a real directory; the identifier and the calendar date are
  validated against strict allowlists before they become a path component; both files are
  staged with exclusive creation and mode 0600, flushed and closed, and published together by
  atomic rename or not at all. A destination that is already occupied, by anything, is refused.
- **No name is asserted.** The drafter extracts no victim name, so every claim is `reported`,
  every name is withheld under the provisional D4 policy, and the provenance sidecar has no
  field for a name at all.

## 15. Resource limits and the command deadline

Rules the security-foundation track adds (decision D27). The track is **pending an
independent audit** and is built beside the Sprint 5 correction; nothing below is an audit
result.

- Every limit is a versioned constant in `@cas/contracts` (`resource-limits@1`), sized from a
  recorded measurement of the largest input the project has accepted or observed and at
  least four times that measurement, except where the structure fixes an exact bound. A
  limit changes only with a new version and a new measurement; a test pins every value.
- Import limits hold while the file streams: file bytes per chunk, column count and cell
  bytes (UTF-8) before a record reaches a handler, row count and retained bytes as rows
  arrive, and the parser's record buffer. A crossed limit rejects the whole file with a fixed
  message and numeric details and writes nothing. Nothing is truncated to fit: a record that
  does not fit is refused, never shortened.
- Graph responses hold to a streaming byte limit, JSON depth and collection limits and an
  in-flight cap, as section 10 describes.
- Draft limits (sections, claims, output and sidecar bytes) are declared in the same
  contract; their enforcement belongs to the draft writer, which the Sprint 5 correction
  owns, and is not claimed here.
- Every worker command runs under a deadline. At expiry the command's abort signal fires,
  the import and validation paths stop and roll back, and after a grace period the process
  exits with code `124` whether or not the command has returned; the database rolls back the
  transaction its dropped connection was inside. `CAS_COMMAND_DEADLINE_MS` may lower the
  deadline and never raise it; a malformed or oversized value is a configuration error.
- Every refusal is non-reflecting: no cell, body, path or header value reaches an error
  message, its details or a printed line, and the tests plant a marker in every hostile input
  to prove it.

## 16. Google Sheets intake (parallel track)

Rules the read-only Sheets connector implements. The track is built and
verified within Claude sessions on `parallel/google-sheets-intake`; it is not
merged, not deployed and not audited. `docs/SHEETS-INTAKE.md` is its full
record.

- **One file, and a whitelist of size one.** The authorized workbook is
  `Cyberattack Sunday - RSS Intake`. Its identifier arrives through the
  environment and is checked against a SHA-256 digest committed in
  `data/policy/authorized-workbook.json` before any request. A different
  identifier is refused at the boundary, the digest is compared in constant
  time, and there is no override flag: authorizing another workbook is a
  reviewed commit.
- **It fails closed.** The committed digest ships as `null`, so every operation
  refuses until a human pins one. A connector that defaulted to open while
  unconfigured would be most permissive exactly when nobody had checked it.
- **The decision precedes the credential.** Configuration is validated, the
  policy is loaded, and the identifier is authorized _before_ any key is read
  or any token requested. A run pointed at the wrong workbook never presents a
  credential anywhere, so a misconfiguration cannot become an access attempt
  against a file the owner did not authorize.
- **One scope, read-only.** `spreadsheets.readonly`. No write scope string
  exists in the package, no method that could write exists on the client, and a
  test enumerates the client's prototype chain to prove it.
- **No Drive API, and no Google SDK.** The Sheets API reads a file whose
  identifier the caller already holds; the Drive API _enumerates_. Only the
  first is needed, so the second is absent: no Drive host, path or scope appears
  anywhere the package ships, and a test scans the source for each. Implementing
  the JWT flow and the two REST calls directly, rather than through a client
  library, is what makes that a fact about the code instead of a claim about how
  a large dependency is used.
- **Two origins, and no redirect is followed.** Every request URL is parsed and
  its origin compared with a frozen allowlist before a socket opens. A 3xx is
  refused outright rather than chased: a redirect is the one mechanism that
  could move a request off an allowed origin, and an article URL found in a cell
  is therefore unreachable.
- **A credential never lives in the repository.** A key inside the working tree
  is refused whatever the ignore rules say, because an ignore rule stops
  `git add .` and not a force-add, a changed rule, `git archive` or a build
  context. A key readable beyond its owner is refused on POSIX hosts.
- **Nothing is echoed.** No API response body reaches an error message: a Google
  error body can quote the request, and the request path carries the identifier.
  Failures carry a status and a fixed sentence. The redactor covers the
  identifier, the key and any token in raw, percent-encoded, base64, base64url
  and hexadecimal form, because a value that reached a log encoded is a value
  that was not redacted.
- **Workbook text cannot forge a line.** Tab names and header cells are authored
  by someone else and may carry newlines, ANSI introducers or Unicode line
  separators. Every one is rendered as a single line with control characters
  shown as visible escapes before it reaches output, and the report says which
  values had to be escaped.
- **A cell is inert text.** Nothing evaluates a formula. A string beginning with
  `=`, `+`, `-`, `@`, tab or carriage return is flagged as formula-leading and
  preserved exactly, so a later exporter can neutralize it rather than hand a
  spreadsheet a live formula. Flagging is not rewriting.
- **Nothing is silently truncated.** A workbook, tab, row, column, cell or
  response past its bound is an explicit counted refusal, never a prefix
  presented as the whole. A partial reading that looks complete is worse than no
  reading, because its counts will be believed.
- **Row identity is derived, never positional.** A spreadsheet row number
  changes when somebody inserts a row above it, so it is recorded as provenance
  and never used as identity alone. Identity is a digest over the workbook
  digest, the tab, the position and the content together, which is what makes a
  re-read idempotent.
- **Nothing is written, anywhere.** Not to the workbook, and not to the
  database: the connector has no database handle, and no import command exists.
  The dry run reads, validates and counts.
- **A weekly tab is not a published outcome.** The workbook holds the RSS corpus
  and the weekly candidate cut-downs; the assistant reformatting, the owner's
  edit and the published edition are not in it. Treating a weekly tab as truth
  would be the most damaging error available here, so the lineage is a typed
  constant, every dry run requires an explicit stage that is never inferred from
  a tab's name, and every inventory prints the limitation verbatim.

## Reporting a vulnerability

Report privately; never open a public issue describing an unpatched weakness. The policy,
scope, timelines and safe harbour are in `VULNERABILITY_DISCLOSURE.md`; what happens after a
report is in `INCIDENT_RESPONSE.md`. The threat model is `THREAT_MODEL.md`, the risk register
`RISK_REGISTER.md`, and the data handling rules `DATA_CLASSIFICATION_RETENTION.md`.
