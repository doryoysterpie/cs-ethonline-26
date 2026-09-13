# Threat model

**Status: speculative.** This document belongs to the security-foundation track on branch
`parallel/s6-security-foundation`, built from Sprint 5 candidate
`6fad82c3b03325101940d9ca25575d94550e7d25` while that candidate is under independent audit.
Nothing here is accepted, merged or deployed. Where a control below is pending a Sprint 5
correction, it says so; where a component does not exist yet, it says that too, because a
threat model that describes the system it wishes it had is worse than none.

## 1. Scope and method

The model covers the system as it exists at the base commit plus this track: the editorial
CSV importer, the PostgreSQL store, the deterministic classifier and clustering engine, the
Graph-evidence client and the snapshot ingest, the evidence resolver and anomaly feed, the
deterministic drafter and its file writer, the command-line interface that drives all of
them, and the repository's own toolchain and continuous integration. The Next.js dashboard,
the MCP server, the x402 feed, the payer agent and the sponsor integrations are planned
components with placeholder packages; they are modelled only as far as the obligations
already recorded for them, and every control they will need is listed as a requirement, not
as a mitigation.

Method: enumerate what is worth protecting (section 2), where trust changes hands (3), who
acts (4), where input enters (5), how data moves (6), what the system depends on (7), what
each adversary can do (8), then walk the eleven abuse cases the track was asked to cover (9),
map every mitigation to the test that proves it (10 and 12), and state plainly what is left
(11). Identifiers (`A`, `B`, `R`, `E`, `DF`, `X`, `C`, `AC`, `M`, `RR`) are stable so the
risk register and the report can point at them.

## 2. Assets

| ID  | Asset                                                                                                                                                        | Why it matters                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | The editorial corpus: raw RSS and spreadsheet exports, the weekly snapshot sheets, and every retained source row with its raw cells                          | Third-party article text under its publishers' rights; never committed; the evidence every later stage rests on                      |
| A2  | Human judgement: `ReviewState` from weekly sheets, recorded incident subjects, accepted or rejected associations, merge and split actions, reviewer identity | The only thing that can turn a report into a stronger claim; must be attributable, append-only and never manufactured by the machine |
| A3  | The provenance chain: batch to row to classification result to cluster membership to evidence state to draft claim, with every hash and version              | The whole product claim is "every statement traces to its sources"; a broken link is a broken product                                |
| A4  | The Graph credential `GRAPH_API_KEY` and the database URL `DATABASE_URL`                                                                                     | A leaked key spends the owner's quota and identity at the provider; a leaked URL exposes the store                                   |
| A5  | The PostgreSQL store and its migrations                                                                                                                      | Holds A1, A2 and A3; its schema is the enforcement point for provenance and immutability                                             |
| A6  | Generated drafts and their provenance sidecars under `output/drafts`                                                                                         | Unpublished text derived from third-party reporting; may name nobody; must never be mistaken for a published statement               |
| A7  | The repository, its pinned toolchain, its workflows and its dependency set                                                                                   | What Codex audits and what judges read; a compromised build is a compromised everything                                              |
| A8  | The versioned behaviour contracts and their hashes (classification, clustering, evidence, drafting) and the versioned resource limits                        | Accepted behaviour is identified by hash; a silent change is a silent audit bypass                                                   |
| A9  | The newsletter's reputation and its readers' trust                                                                                                           | A false attribution or an invented incident harms a named organisation and the publication; decision D4 exists for this              |
| A10 | Availability of the pipeline before the 13 September 2026 submission                                                                                         | A resource-exhaustion failure at the wrong hour is a missed deadline                                                                 |

## 3. Trust boundaries

| ID  | Boundary                                     | Crossing                                                                               | Present state                                                                                                        |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| B1  | Operator's filesystem to the importer        | `editorial validate` and `editorial import` read a CSV the operator names              | Implemented; hardened here with byte, row, column, cell and retained-byte limits                                     |
| B2  | Operator's filesystem to the evidence ingest | `evidence ingest` reads a JSON snapshot the operator names                             | Implemented; audit finding F1 (origin relabelling) and F4 (validator closure) open, owned by the Sprint 5 correction |
| B3  | The Graph gateway to the client              | HTTPS `POST` with the key in a bearer header; the response body is provider-controlled | Implemented; hardened here with a streaming byte limit, JSON shape limits and an in-flight cap                       |
| B4  | The worker to PostgreSQL                     | Parameterised queries over a connection named by `DATABASE_URL`                        | Implemented                                                                                                          |
| B5  | Shell to the worker                          | Arguments and environment variables                                                    | Implemented; every argument validated before any file or database access; a command deadline added here              |
| B6  | The drafter to the filesystem                | `drafting generate` writes two files under a directory the operator may name           | Implemented; audit finding F3 (traversal, symlink) open, owned by the Sprint 5 correction                            |
| B7  | The repository to continuous integration     | Pushes and pull requests run workflows with a read-only token                          | Implemented; extended here with a database job, a network-denied test job, supply-chain checks and CodeQL            |
| B8  | The npm registry and GitHub to the toolchain | Packages, actions and images enter the build                                           | Implemented; exact pins, the 24-hour release-age gate, digest-pinned images, a committed bill of materials           |
| B9  | A dashboard user to the review interface     | Planned (Sprint 6)                                                                     | Not built; requirements only                                                                                         |
| B10 | An MCP client to the MCP server              | Planned (Sprint 6)                                                                     | Not built; requirements only                                                                                         |
| B11 | A paying agent to the x402 feed              | Planned (Sprint 8, conditional)                                                        | Not built; requirements only                                                                                         |

## 4. Roles

| ID  | Role                                      | Trust                                                                                                                                    |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Project owner and editor                  | Full trust; the only person who publishes, merges, decides D3, D4, D9 and D10, and holds the accounts                                    |
| R2  | Operator running the worker               | Trusted to run commands; not trusted to be infallible, which is why every command validates and rolls back                               |
| R3  | Reviewer named by `--actor`               | Trusted for the judgement they record; the record is append-only and attributable, never rewritten                                       |
| R4  | Independent auditor (Codex Desktop)       | Reads and reruns; changes nothing; issues PASS or CHANGES REQUIRED                                                                       |
| R5  | Continuous-integration runner             | Holds a read-only repository token and no secret; must never be handed one                                                               |
| R6  | Database operator                         | Can read and alter the store; constrained by constraints, guard functions and checksummed migrations, not by trust                       |
| R7  | The Graph provider                        | Trusted for transport integrity; every returned value is validated against declared expectations and treated as hostile text for display |
| R8  | Upstream publishers (RSS, spreadsheets)   | Untrusted; their text is evidence about the world and never an instruction                                                               |
| R9  | Judges and readers                        | Untrusted readers of public output; must never see an unpublished draft, a private note or a withheld name                               |
| R10 | Dashboard users, MCP clients, feed payers | Future roles; untrusted by default                                                                                                       |
| R11 | Contributors and forks                    | Untrusted; a pull request runs with read-only permissions and no secret                                                                  |

## 5. Entry points

| ID  | Entry point                                                                                                          | Validation at the door                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | `editorial validate` and `editorial import` (`--file`, `--kind`, `--origin`, `--review-label`)                       | Kind and origin from closed vocabularies; label and basename bounded and control-free; strict UTF-8, no NUL, RFC 4180, header rules; `RESOURCE_LIMITS.import` while streaming |
| E2  | `evidence ingest` (`--file`, `--origin`)                                                                             | Closed-field snapshot validation; **origin restriction to fixture and replay pending (F1)**; **validator closure pending (F4)**                                               |
| E3  | `classification`, `clustering`, `evidence` and `drafting` commands (`--run`, `--batch`, `--incident`, `--window`, …) | Every identifier a UUID before any database access; reason codes, actors and notes from fixed shapes; windows explicit and ordered; no "latest" default anywhere              |
| E4  | `drafting generate --out`                                                                                            | **Root confinement, traversal and symlink refusal pending (F3)**                                                                                                              |
| E5  | Environment: `DATABASE_URL`, `GRAPH_API_KEY`, `GRAPH_GATEWAY_URL`, `CAS_COMMAND_DEADLINE_MS`                         | URL scheme and credential policy; key never echoed; gateway base structurally validated; deadline a positive integer never above the ceiling                                  |
| E6  | The Graph response body                                                                                              | Streaming byte limit, declared-length distrust, UTF-8, JSON depth and collection limits, GraphQL error and schema checks, provider-identity validation, freshness             |
| E7  | The migrations directory                                                                                             | Numbered forward-only files; checksums recorded and compared; drift stops the run                                                                                             |
| E8  | GitHub events (push, pull request, schedule)                                                                         | Read-only token; SHA-pinned actions; digest-pinned image; no `pull_request_target`; checkout without persisted credentials                                                    |
| E9  | The package registry                                                                                                 | Frozen lockfile; exact catalog versions; 24-hour release age; audit; bill of materials reproduced in CI                                                                       |
| E10 | Rows already in the store                                                                                            | Treated as hostile text at every output; hashes re-derived at reconciliation; immutability enforced by constraints and guard functions                                        |

## 6. Data flows

| ID  | Flow                                                                                                                                           | Trust change                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| DF1 | Publisher text → RSS → the owner's spreadsheet → CSV export → importer → `source_rows` (raw and derived columns) → classification → clustering | Untrusted text enters once, is stored exactly, is never interpreted, and is matched only against fixed vocabularies       |
| DF2 | Weekly snapshot sheet → `review_snapshots` and `review_entries` (`ReviewState`)                                                                | Human judgement enters, scoped to the sheet that supplied it, separate from source content and from machine decisions     |
| DF3 | Graph gateway → client → validated reading → snapshot → `graph_signal_runs` and `graph_signals`                                                | Provider data enters as `live`; the same bytes replayed from a file must be `fixture` or `replay` (F1 pending)            |
| DF4 | Recorded subject + signals → correlator → suggested association → human decision → resolver → `evidence_states`                                | No text is read; nothing becomes evidence until a named person accepts it; absence never contradicts                      |
| DF5 | Evidence run → draft request → deterministic drafter → Markdown and sidecar under `output/drafts`                                              | Text leaves the store into a file marked unpublished, with every name withheld under provisional D4; no model is called   |
| DF6 | Repository → CI runner → checks, tests, database service, bill of materials                                                                    | Code is verified by a runner that holds no secret; the database it uses is created and discarded inside the job           |
| DF7 | Commands → stdout and stderr                                                                                                                   | Every line passes the redactor and the single-line guard; untrusted metadata is escaped and bounded; secrets never appear |

## 7. External dependencies

| ID  | Dependency                                                                                            | Pin and control                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| X1  | The Graph gateway serving the Messari standardized lending subgraphs (seven deployments)              | HTTPS only; bearer header; identity validated against registry expectations; body and shape limits; freshness limits                             |
| X2  | PostgreSQL 17 (Homebrew 17.10 locally; `postgres:17.11` by digest in CI)                              | Migrations checksummed; schema-qualified guard functions; no `SECURITY DEFINER`                                                                  |
| X3  | 185 npm packages (152 unconstrained, 33 platform-specific optional binaries)                          | Exact catalog versions; frozen lockfile; `minimumReleaseAge: 1440`; `pnpm audit`; CycloneDX 1.6 bill of materials reproduced byte for byte in CI |
| X4  | GitHub Actions: `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `github/codeql-action` | Full commit SHA pins with version comments; enforced by `tools/checks/workflows.ts`                                                              |
| X5  | Node 24.21.0 and pnpm 11.10.0                                                                         | Exact pins in `.nvmrc` and `packageManager`; asserted at the start of every CI job by `tools/checks/toolchain.ts`                                |
| X6  | GitHub-hosted runners (`ubuntu-latest`)                                                               | Read-only token; no secret; network denial for the offline suite proven inside the job                                                           |

## 8. Attacker capabilities

| ID  | Adversary                          | Can                                                                                                                                                            | Cannot (by construction or assumption)                                                                                           |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Malicious RSS publisher            | Put any text in a title, summary, description, author, category or URL: instructions, ANSI sequences, log-shaped lines, homoglyphs, bidi controls, huge fields | Reach the pipeline any other way; the exports are the only channel                                                               |
| C2  | Holder of a compromised feed row   | Alter a stored row's text, hash, status, batch or origin after import                                                                                          | Bypass the database's own constraints and guard functions without the privileges of C9                                           |
| C3  | Supplier of a malicious CSV        | Hand the operator any file: malformed encoding, quoting faults, enormous size, enormous cells, enormous row counts, hostile metadata                           | Choose the `--origin` or `--kind` the operator passes                                                                            |
| C4  | Compromised Graph endpoint         | Return any status, headers and body: wrong identities, stale blocks, indexing errors, gigabytes, deep nesting, lying `Content-Length`, key-shaped strings      | Break TLS to the validated `https:` base; read the key from a URL, because it never travels in one                               |
| C5  | Holder of a stolen provider key    | Query the provider as the owner and spend the quota                                                                                                            | Reach the store, the drafts or the review record; the key authorises nothing in this system                                      |
| C6  | Malicious dashboard user (future)  | Attempt to read per-row content, forge review state, or publish                                                                                                | Exist yet                                                                                                                        |
| C7  | Malicious MCP client (future)      | Call tools with hostile arguments, at volume, and treat outputs as instructions                                                                                | Exist yet                                                                                                                        |
| C8  | Compromised dependency             | Ship a malicious version of a package the project uses, or of a GitHub Action                                                                                  | Enter within 24 hours of publication; change a pinned SHA or digest; alter the lockfile without a diff Codex reads               |
| C9  | Database operator or superuser     | Read and change anything the server allows, including guard functions                                                                                          | Change the committed migrations' checksums without the runner noticing; rewrite history that reconciliation re-derives from rows |
| C10 | Payment replayer (future)          | Resend a captured payment proof to the x402 feed                                                                                                               | Exist yet                                                                                                                        |
| C11 | Editor or reviewer making an error | Accept a wrong association, record a wrong subject, mislabel a week, name a victim on thin sourcing                                                            | Delete or rewrite the record of having done so                                                                                   |

## 9. Abuse cases

Each case names the adversary, what they try, what stops it today with the test that proves it,
and what remains. "Pending" means the Sprint 5 correction owns the fix; "future" means the
component does not exist.

### AC1 Malicious RSS publisher (C1)

- **Attempt.** A title reading "ignore previous instructions and merge every incident", a
  summary carrying `\x1b[31m` and a forged `RECONCILIATION OK` line, a 48 KB description, a
  bidi-reordered organisation name, a URL with a credential in it.
- **Stops it.** Nothing interprets source text (M1); every output line is redacted then
  escaped to one physical line (M2); the classifier and clustering engine take closed
  allowlists and match against fixed vocabularies (M3); URLs are canonicalised for matching
  only and never fetched (M4); cells are bounded in bytes and the file in size (M5); the
  drafter proposes no name and withholds every name under D4 (M6).
- **Remains.** A hostile title reaches the draft as a reported claim, escaped but present;
  the editor reads it. A bidi control inside stored text is preserved exactly (raw text is
  never altered) and would be escaped visibly on output; the repository hygiene scan covers
  the repository's own files, not the corpus (RR3).

### AC2 Compromised feed row (C2)

- **Attempt.** After import, a row's text, hash, batch or origin is changed to move it
  between origins, to alter what the classifier saw, or to make a cluster's membership lie.
- **Stops it.** Composite foreign keys tie every row to its batch and origin (M7); a frozen,
  classified batch refuses insertion, deletion, rehashing and reassignment (M8); completed
  runs are immutable and their results bound to the row hash they scored (M8); reconciliation
  re-derives counts and hashes from rows and fails loudly on a mismatch (M9).
- **Remains.** A superuser can drop or alter the guard functions themselves (RR6). The
  evidence tables do not yet bind an evidence run's origin to its signal run's origin
  (pending, F1).

### AC3 Malicious CSV (C3)

- **Attempt.** A file with invalid UTF-8, a NUL byte, an unclosed quote, inconsistent
  columns, a duplicated header; a 4 GB file; a 300,000-row file; a 64 MB cell; a header
  with a thousand columns; a basename carrying a newline.
- **Stops it.** Structural faults reject the whole file before any write (M10); the versioned
  limits refuse a file that crosses any bound at the first crossing chunk, row or cell, with
  a fixed message and numeric details, and write nothing (M5); the basename and label are
  bounded and control-free (M2); a file changed between the two passes is refused (M10).
- **Remains.** The operator chooses the path; a symlink to a file the operator may read is
  readable by design. Only the basename is stored (M2).

### AC4 Compromised Graph endpoint (C4)

- **Attempt.** A gigabyte body, a body declared at 10 bytes that streams forever, a JSON
  document nested 100,000 deep, an array of a million snapshots, a protocol renamed to
  count twice, a `MAINNET` deployment answering for Base, a block from 2019, a body carrying
  the key so an error message would print it.
- **Stops it.** The body is read under a byte limit while it streams and a declared length is
  refused above the limit and distrusted below it (M11); nesting depth is bounded before
  parsing and collections after (M11); at most eight requests are in flight (M11); identity
  is validated against registry expectations and distinctness counted over canonical
  identity, subgraph and deployment (M12); freshness rejects old and future observations
  (M12); every emitted string is redacted and rendered single-line (M2); a failure never
  becomes an empty success or a fixture (M13).
- **Remains.** A provider that returns internally consistent but false numbers is a data
  quality risk, not an integrity risk; the anomaly feed labels absence and staleness rather
  than inventing signal (RR4).

### AC5 Stolen provider key (C5)

- **Attempt.** The key leaks through a URL, a log, a details file, a test fixture, a commit,
  a CI log or an error body echoed back by the provider.
- **Stops it.** The key travels only in the bearer header and never in a URL (M14); a gateway
  base that contains the key is refused (M14); every emission passes a redactor for the key,
  any bearer token and the legacy key-in-path form (M2); CI holds no secret and the live
  tests run only by explicit command (M15); the repository secret scan and forbidden-file scan
  run in CI (M16); a key that reaches Git is treated as compromised and rotated (policy,
  `SECURITY.md` section 2).
- **Remains.** Rotation is a human action at the provider (RR8). GitHub secret scanning and
  push protection are repository settings the owner must enable (RR7).

### AC6 Malicious dashboard user (C6, future)

- **Requirements recorded for Sprint 6.** Authentication before any per-row content; the
  review interface writes `ReviewState` separately from `ClassificationDecision`; no export
  of per-row text; every record labelled with its origin; no action that publishes; every
  action attributable and append-only as the command-line review actions already are.
- **State.** Not built. Nothing on this branch implements authentication or a dashboard.

### AC7 Malicious MCP client (C7, future)

- **Requirements recorded for Sprint 6.** Read-only tools returning identifiers, counts,
  hashes, statuses and fixed vocabulary; arguments validated exactly as the command-line
  arguments are; the same output redaction and single-line guard; rate and concurrency bounds
  in the spirit of `RESOURCE_LIMITS`; no tool that writes review state, generates a draft to a
  caller-chosen path, or publishes.
- **State.** Not built.

### AC8 Compromised dependency (C8)

- **Attempt.** A malicious release of a direct or transitive package, a retagged GitHub
  Action, a replaced container image, a lockfile edit that slips a package in.
- **Stops it.** Exact versions through the catalog and a frozen lockfile (M17); the 24-hour
  release-age gate with a narrow, recorded exception process, D13 (M17); every action pinned
  to a full commit SHA and the image to a digest, enforced by a scan (M18); `pnpm audit` in
  CI (M19); a CycloneDX bill of materials with SHA-512 hashes reproduced byte for byte in CI
  and cross-checked against pnpm's own generator (M20); CodeQL over the sources (M21).
- **Remains.** A malicious version older than 24 hours with no advisory passes the gate; the
  defence is the diff review of every lockfile change (RR9). Lifecycle scripts of dependencies
  run at install unless pnpm's `ignore-scripts` is set; it is not set today (RR10).

### AC9 Database operator (C9)

- **Attempt.** Edit a migration file after it was applied; apply a different migration under
  a known number; disable a guard function; insert a corroborated state with no accepted
  association; run the runner against the wrong schema through `search_path`.
- **Stops it.** Checksummed forward-only migrations refuse drift before any change (M22); the
  runner and every guard function are schema-qualified and never `SECURITY DEFINER` (M22);
  CHECK constraints make an unbacked corroboration unwritable (M23); reconciliation re-derives
  counters from rows (M9); CI applies every migration to a fresh database, reruns as a no-op
  and checks drift on every push (M24).
- **Remains.** A superuser can alter anything; the model assumes the local and any future
  hosted database are administered by R1 or a delegate under D8, which is unresolved (RR6).

### AC10 Payment replay (C10, future)

- **Requirements recorded for Sprint 8.** Every paid request carries a single-use identifier
  bound to the request and the amount; the facilitator's verification, not the feed, decides
  validity; a replayed proof is refused with a fixed error; the feed exposes public metadata
  only (D6), so a successful replay leaks nothing confidential.
- **State.** Not built; conditional on the 10 September gate.

### AC11 Editorial error (C11)

- **Attempt.** A reviewer accepts a `supports` association for the wrong claim; a subject is
  recorded on the wrong incident; a weekly label is applied to the wrong batch; an editor
  names an organisation on a single report.
- **Stops it.** Every decision is append-only with actor, reason code, revision and optional
  bounded note (M25); an acceptance produces a new immutable evidence run rather than
  rewriting one (M25); the drafter withholds every name until the sourcing meets D4 and says
  so in the text (M6); every draft is marked unpublished and publication is human (M26).
- **Remains.** A corroboration can today name a claim UUID that is not a real claim of the
  incident (pending, F2). A wrong but well-formed decision is caught by a person, not a
  program (RR5).

## 10. Mitigations

| ID  | Mitigation                                                                                                                                  | Where                                                                                                      | Proven by                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Source text is stored exactly and never interpreted                                                                                         | `apps/worker/src/editorial/rows.ts`, `html-text.ts`                                                        | `apps/worker/src/editorial/import.db.test.ts`, `rows.test.ts`, `html-text.test.ts`                                                                                                               |
| M2  | Every emitted line is redacted then escaped to one physical line; metadata bounded and control-free                                         | `apps/worker/src/editorial/display.ts`, `output.ts`; `packages/graph-evidence/src/display.ts`, `redact.ts` | `apps/worker/src/editorial/output-safety.test.ts`, `display.test.ts`; `packages/graph-evidence/src/output-safety.test.ts`, `redact.test.ts`                                                      |
| M3  | Classifier and clustering inputs are closed allowlists; rationale is fixed vocabulary                                                       | `packages/classification/src/input.ts`, `packages/clustering/src/input.ts`                                 | `packages/classification/src/input.test.ts`, `label-invariance.test.ts`; `packages/clustering/src/input.test.ts`                                                                                 |
| M4  | URLs are canonicalised for matching only and never fetched                                                                                  | `apps/worker/src/editorial/urls.ts`                                                                        | `apps/worker/src/editorial/urls.test.ts`; no fetcher exists in the worker                                                                                                                        |
| M5  | Import limits enforced while streaming: file bytes, columns, cell bytes, rows, retained bytes, record buffer; fixed error; no partial write | `apps/worker/src/editorial/csv-stream.ts`; `packages/contracts/src/limits.ts`                              | `apps/worker/src/editorial/limits.test.ts` (boundary minus one, exact, plus one; large Unicode; non-reflection), `limits.db.test.ts` (no partial write); `packages/contracts/src/limits.test.ts` |
| M6  | No name proposed; every name withheld under provisional D4; withholding disclosed in the draft                                              | `apps/worker/src/drafting/build.ts`, `packages/drafting/src/draft.ts`                                      | `packages/drafting/src/draft.test.ts`, `apps/worker/src/drafting/generate.db.test.ts`                                                                                                            |
| M7  | Relational provenance: composite keys tie rows, issues, snapshots and entries to one batch and origin                                       | `packages/database/migrations/0002_provenance_integrity.sql`                                               | `packages/database/src/provenance.db.test.ts`                                                                                                                                                    |
| M8  | Frozen batches; immutable completed runs, results, clusters, memberships and links                                                          | migrations `0004`, `0005`, `0006`, `0007`                                                                  | `packages/database/src/classification.db.test.ts`, `clustering.db.test.ts`, `schema-security.db.test.ts`                                                                                         |
| M9  | Reconciliation re-derives counts and hashes from rows                                                                                       | `apps/worker/src/editorial/report.ts`, `classification/report.ts`, `clustering/report.ts`                  | `apps/worker/src/editorial/import.db.test.ts`, `classification/run.db.test.ts`, `clustering/run.db.test.ts`                                                                                      |
| M10 | Structural faults reject the whole file before any write; a file changed between passes is refused                                          | `apps/worker/src/editorial/csv-stream.ts`, `import.ts`                                                     | `apps/worker/src/editorial/csv-stream.test.ts`, `import.db.test.ts`                                                                                                                              |
| M11 | Graph body read under a streaming byte limit; declared length distrusted; JSON depth and collections bounded; in-flight cap                 | `packages/graph-evidence/src/bounded-body.ts`, `json-shape.ts`, `client.ts`                                | `packages/graph-evidence/src/limits.test.ts` (exact bound, overrun, lying and missing lengths, depth, sizes, concurrency, non-reflection)                                                        |
| M12 | Provider identity validated against registry expectations; distinctness over canonical identity; freshness limits                           | `packages/graph-evidence/src/gate.ts`, `freshness.ts`                                                      | `packages/graph-evidence/src/gate.test.ts`, `freshness.test.ts`                                                                                                                                  |
| M13 | A live failure is explicit and never an empty success or a fixture                                                                          | `packages/graph-evidence/src/client.ts`, `adapter.ts`                                                      | `packages/graph-evidence/src/client.test.ts` (structural proof of no fixture path)                                                                                                               |
| M14 | Key only in the bearer header; a base containing the key is refused                                                                         | `packages/graph-evidence/src/client.ts`, `gateway-url.ts`                                                  | `packages/graph-evidence/src/client.test.ts`, `gateway-url.test.ts`                                                                                                                              |
| M15 | CI holds no secret; live tests run only by explicit command; the default suite passes with the network denied                               | `.github/workflows/ci.yml`, `tools/checks/network-denial.sh`, `tools/offline-sandbox.sb`                   | CI job `verify`, step "Offline suite under enforced network denial"                                                                                                                              |
| M16 | Repository scans: hygiene, forbidden files, secrets, workflow policy                                                                        | `tools/checks/*.ts`                                                                                        | `tools/checks/checks.test.ts` (clean tree and planted defects); CI step "Repository scans"                                                                                                       |
| M17 | Exact catalog versions, frozen lockfile, 24-hour release age, D13 exception process                                                         | `pnpm-workspace.yaml`, `pnpm-lock.yaml`                                                                    | CI "Install with frozen lockfile"; Codex verifies any D13 entry against the lockfile                                                                                                             |
| M18 | Actions pinned to full SHAs, image pinned to a digest, least-privilege permissions, no dangerous trigger, credentials not persisted         | `.github/workflows/*.yml`, `tools/checks/workflows.ts`                                                     | `tools/checks/checks.test.ts` (workflows); CI step "Repository scans"                                                                                                                            |
| M19 | Dependency audit                                                                                                                            | `package.json` `audit:deps`                                                                                | CI job `supply-chain`                                                                                                                                                                            |
| M20 | Reproducible CycloneDX 1.6 bill of materials with hashes and licences, cross-checked against pnpm's generator                               | `tools/supply-chain/sbom.ts`, `lockfile.ts`; `supply-chain/`                                               | `tools/supply-chain/supply-chain.test.ts`; CI step "Reproduce the bill of materials and licence inventory"; schema validation recorded in the report                                             |
| M21 | First-party static analysis                                                                                                                 | `.github/workflows/codeql.yml`                                                                             | CodeQL workflow run                                                                                                                                                                              |
| M22 | Checksummed forward-only migrations; schema-qualified runner and guard functions; no `SECURITY DEFINER`                                     | `packages/database/src/migrate.ts`, migrations `0005` onward                                               | `packages/database/src/migrate.db.test.ts`, `schema-security.db.test.ts`                                                                                                                         |
| M23 | An unbacked corroboration or contradiction is unwritable                                                                                    | migration `0008_graph_evidence.sql`                                                                        | `apps/worker/src/evidence/run.db.test.ts`                                                                                                                                                        |
| M24 | Fresh-database migration, no-op rerun and drift check on every push                                                                         | `.github/workflows/ci.yml` job `database`                                                                  | CI job `database`                                                                                                                                                                                |
| M25 | Append-only, attributable review actions; payload-complete idempotency; a new run per acceptance                                            | `apps/worker/src/clustering/review.ts`, `evidence/review.ts`, `evidence/run.ts`                            | `apps/worker/src/clustering/run.db.test.ts`, `evidence/run.db.test.ts`                                                                                                                           |
| M26 | Every draft marked unpublished; publication is human; no model called                                                                       | `packages/drafting/src/draft.ts`, `docs/SECURITY.md` section 6                                             | `packages/drafting/src/draft.test.ts`                                                                                                                                                            |
| M27 | Command deadline: abort, roll back, exit 124 after a grace period; never raised above the ceiling                                           | `apps/worker/src/deadline.ts`, `cli.ts`                                                                    | `apps/worker/src/deadline.test.ts`                                                                                                                                                               |
| M28 | Exact toolchain pins asserted at the start of every CI job                                                                                  | `.nvmrc`, `package.json`, `tools/checks/toolchain.ts`                                                      | `tools/checks/checks.test.ts` (toolchain); CI step "Assert the pinned toolchain is the one running"                                                                                              |

## 11. Residual risks

| ID   | Residual risk                                                                                                                                                | Owner                       | Status                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| RR1  | A committed replay snapshot can be ingested as `live` (audit F1); evidence runs are not origin-bound to their signal run in the schema                       | Sprint 5 correction         | Open                                                               |
| RR2  | A corroboration can name a claim UUID that is not a claim of the incident (audit F2)                                                                         | Sprint 5 correction         | Open                                                               |
| RR3  | The draft writer follows a symlinked output directory and accepts traversal in the identifier (audit F3); draft size limits declared but unenforced          | Sprint 5 correction         | Open; limits in `RESOURCE_LIMITS.draft` await the writer           |
| RR4  | The snapshot validator is not closed against inherited, symbol, non-enumerable or accessor properties (audit F4); snapshot files have no byte or shape limit | Sprint 5 correction         | Open; `readBodyBounded` and `parseJsonBounded` are available to it |
| RR5  | A wrong but well-formed human decision is caught by review, not by code                                                                                      | Owner                       | Accepted; append-only record                                       |
| RR6  | A database superuser can alter guard functions and history; D8 (hosting) unresolved                                                                          | Owner                       | Accepted for local development; reopen at D8                       |
| RR7  | GitHub secret scanning, push protection, Dependabot alerts, branch protection and required SHA pinning are disabled                                          | Owner (repository settings) | Open; manual settings listed in the report                         |
| RR8  | Key rotation at the provider is a human action                                                                                                               | Owner                       | Accepted; runbook in `INCIDENT_RESPONSE.md`                        |
| RR9  | A malicious package older than 24 hours with no advisory passes the release-age gate                                                                         | Owner and auditor           | Accepted; every lockfile diff is reviewed                          |
| RR10 | Dependency lifecycle scripts run at install (`ignore-scripts` unset)                                                                                         | Owner                       | Open; recorded in the risk register                                |
| RR11 | Node's own runtime and the container image are trusted as distributed (checksummed by nvm and by digest, not built from source)                              | Owner                       | Accepted                                                           |
| RR12 | The offline-suite network denial is proven on Linux runners and macOS; not on other platforms                                                                | Track                       | Accepted                                                           |
| RR13 | Bidi and zero-width characters inside stored corpus text are preserved exactly and escaped on output, not refused                                            | Owner                       | Accepted by design (raw text is never altered)                     |

## 12. Security verification map

The controls this track adds, mapped to what runs and what each run proves. The complete
test totals and the CI run identifiers are recorded in `SECURITY-FOUNDATION-REPORT.md`.

| Control                              | Test or job                                                                     | Proves                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versioned limits                     | `packages/contracts/src/limits.test.ts`                                         | Every value pinned; every measured limit at least four times its measurement; structural limits exact                                                                                                                                                              |
| Import limits                        | `apps/worker/src/editorial/limits.test.ts`                                      | Exact bound accepted and one past it refused for file bytes, columns, cell bytes (in UTF-8, with four-byte characters), rows, retained bytes and the record buffer; refusal at the crossing chunk; fixed messages; numeric details; nothing of the input reflected |
| Import limits leave no partial write | `apps/worker/src/editorial/limits.db.test.ts`                                   | A refused file leaves every table as it was; the same file imports whole under the defaults                                                                                                                                                                        |
| Command deadline                     | `apps/worker/src/deadline.test.ts`                                              | Default equals the ceiling; lower accepted; higher refused with a fixed message; abort at the deadline and exit only after grace; disarm cancels                                                                                                                   |
| Graph body limit                     | `packages/graph-evidence/src/limits.test.ts`                                    | Exact bound and one past it; an endless stream stops being pulled; declared length refused above and distrusted below the limit; malformed length treated as absent; absent body never an empty success; non-2xx body cut at the snippet bound                     |
| Graph JSON shape limits              | `packages/graph-evidence/src/limits.test.ts`                                    | Depth refused before parsing at the bound plus one and cheaply at 100,000; collection size and count at their bounds                                                                                                                                               |
| Concurrent request cap               | `packages/graph-evidence/src/limits.test.ts`                                    | The request past the bound is refused before any fetch; a failure releases its slot                                                                                                                                                                                |
| Repository hygiene                   | `tools/checks/checks.test.ts`, CI "Repository scans"                            | Clean tree; planted bidi, zero-width, NUL, CR, BOM and invalid UTF-8 reported by file, line and code point; fixtures exempt from exactly one rule each                                                                                                             |
| Forbidden files                      | `tools/checks/checks.test.ts`, CI "Repository scans"                            | Clean index; planted environment files, key material, exports, ignored content, SQL outside migrations, archives, artifacts, oversized files, symlinks and executables reported                                                                                    |
| Secret scan                          | `tools/checks/checks.test.ts`, CI "Repository scans"                            | Clean tree; planted tokens reported without being printed; hashes and integrity strings do not fire                                                                                                                                                                |
| Workflow policy                      | `tools/checks/checks.test.ts`, CI "Repository scans"                            | Unpinned actions, undigested images, broad or missing permissions, dangerous triggers and persisted checkout credentials reported                                                                                                                                  |
| Toolchain pins                       | `tools/checks/checks.test.ts`, CI "Assert the pinned toolchain"                 | The running Node and pnpm are the pinned releases                                                                                                                                                                                                                  |
| Bill of materials                    | `tools/supply-chain/supply-chain.test.ts`, CI "Reproduce the bill of materials" | Reader fails closed on unknown formats; document reproducible byte for byte; hashes, licences and graph correct on a synthetic lockfile; component set and every pnpm edge agree with pnpm's generator                                                             |
| Network denial                       | CI "Offline suite under enforced network denial"                                | The loopback probe connects outside and fails inside the namespace; the whole default suite passes inside it                                                                                                                                                       |
| Fresh-database migrations            | CI job `database`                                                               | Every migration applies to an empty database; the rerun applies nothing; drift is zero; the complete PostgreSQL suite passes                                                                                                                                       |
| Static analysis                      | CodeQL workflow                                                                 | The `security-extended` query suite over the TypeScript sources                                                                                                                                                                                                    |
