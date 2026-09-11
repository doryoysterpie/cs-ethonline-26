# MCP tooling track report: `@cas/mcp-server`

**Status: the candidate `7f03a34f` was REJECTED by its independent Codex Desktop audit of
10 September 2026 (CHANGES REQUIRED, findings F1 to F16). Three correction branches have been
integrated additively onto that candidate; the combined revision is PENDING a re-audit and is
NOT accepted. Not merged, not deployed. No remote MCP service has been enabled or deployed.
The Sprint 5 evidence layer this server reads is itself under correction and has not passed
its own audit.**

This track built the Sprint 6 MCP server (charter item 6, requirement A9) ahead of the
dashboard, in isolation, while Sprint 5 is under correction. Decision D28 and its amendment of
10 September 2026 record the design and the corrections. Nothing in this report is an audit
result.

> **Sections 1 to 15 below are HISTORICAL EVIDENCE recorded at the rejected candidate
> `7f03a34f3d4816ba72d041f1541818cae990eaf8`.** They are kept verbatim so the audit's findings
> can be read against what they were written about. Every figure, hash, count and behavioural
> claim in them describes that rejected revision and is superseded where section 16 says so.
> **Section 16 carries the current state.**

## 1. Provenance of the track

| Item                  | Value                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Branch                | `parallel/s6-mcp-tooling`                                                                                                         |
| Base                  | `6fad82c3b03325101940d9ca25575d94550e7d25` (the Sprint 5 candidate; Sprint 5 is under correction)                                 |
| Commit 1              | `5ba0e00e9535ed3a778622157cf42d05e9bedae7` `chore(mcp): pin the MCP SDK v2 and open the parallel tooling track`                   |
| Commit 2              | `980d67ebb8e1e5bf1d7767b95a8f617a1b3e926a` `feat(mcp): add the read-only stdio MCP server with four static tools`                 |
| Commit 3              | the documentation commit that adds this report, D28 and the README section; it changes no code                                    |
| CI, commit 2          | run 34491540892, `Verify` job, every step successful: <https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34491540892> |
| `main`                | untouched at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                                                                           |
| Migrations            | none added; 0001 to 0008 byte-identical (section 10)                                                                              |
| Sprint 5 files        | `@cas/evidence`, `@cas/drafting`, `apps/worker`, `@cas/database` and `SPRINT-5-REPORT.md` untouched                               |
| Diff against the base | 43 files, 6,946 insertions, 11 deletions (before this documentation commit)                                                       |

Integration rule, recorded in D28 and in `SKILL.md`: final integration of this track begins
from the Codex-accepted Sprint 5 revision, not from this base. The two Sprint 5 packages are
consumed behind interfaces (section 4) so that re-pointing is two files.

## 2. What was built (design)

`@cas/mcp-server` is a read-only MCP server over local stdio with four static tools. The
contract a host reads is `packages/mcp-server/SKILL.md`; the rules are `SECURITY.md` section
15; the module map is `ARCHITECTURE.md` section 14.

### 2.1 SDK

The official TypeScript SDK, second major line, which implements the 2026-07-28 protocol
revision. Every version is pinned exactly through the pnpm catalog and was published more
than 24 hours before it landed, so `minimumReleaseAge` stands and no D13 exception was needed.

| Package                        | Version | Published (UTC)      | Role                               |
| ------------------------------ | ------- | -------------------- | ---------------------------------- |
| `@modelcontextprotocol/server` | 2.0.0   | 2026-07-27T23:55:22Z | runtime dependency                 |
| `@modelcontextprotocol/core`   | 2.0.0   | 2026-07-27T23:55:21Z | transitive, runtime                |
| `zod`                          | 4.5.4   | 2026-08-29T17:55:42Z | schemas; the SDK requires `^4.2.0` |
| `@modelcontextprotocol/client` | 2.0.0   | 2026-07-27T23:55:22Z | development only, tests            |
| `eventsource`                  | 3.0.7   | via the client       | development only, transitive       |
| `eventsource-parser`           | 3.1.1   | via the client       | development only, transitive       |
| `jose`                         | 6.2.12  | via the client       | development only, transitive       |
| `pkce-challenge`               | 5.0.1   | via the client       | development only, transitive       |

The lockfile gained exactly those eight entries. `corepack pnpm audit` reports no known
vulnerability, with and without development dependencies.

### 2.2 Transport

Local stdio only, through `serveStdio` from `@modelcontextprotocol/server/stdio`. stdout
carries protocol messages and nothing else; every diagnostic is one redacted, single-line
record on stderr. The process exits when the host closes stdin, on SIGINT (130) and on
SIGTERM (143), after closing the transport and the pool; a rejected configuration exits 2
with a fixed line. No HTTP, SSE or WebSocket transport is enabled, no socket is opened, and
no session exists beyond the process pair.

### 2.3 The static catalogue

Four tools are declared as frozen application code with strict zod input and output schemas
that render to JSON Schema with `additionalProperties: false` at every object, and with
`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` on each;
`openWorldHint` is true only for `chain_anomalies`. The canonical SHA-256 of names, titles,
descriptions, annotations and both schemas is

```
edb68f5268e419e1b4294f4a4290c31e2d8ea9f06e3db872bc180ee299ae9b3a
```

pinned in `src/definitions.ts`, checked before the server accepts a connection, and reproduced
by a test from the `tools/list` result over the wire. A test mutates a name, a description, an
annotation, an input schema, an output schema and the tool count and requires the digest to
move each time. Descriptions describe; a test forbids instruction-like phrasing in them and in
the server's fixed instructions.

### 2.4 Tools

| Tool               | Subject (explicit, no default)                                                      | Returns                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_incidents`   | `evidenceRunId`; `afterIncidentId` cursor; `limit` 1 to 50                          | run provenance and state counts; per incident: kind, member and source counts, evidence state with fixed sentence, recorded subject, quoted headline, origin; keyset `nextCursor`                                      |
| `explain_incident` | `evidenceRunId`, `incidentId`                                                       | the summary; up to 50 sources as quoted evidence; up to 100 associations, each with the machine suggestion and, separately, the latest human decision; fixed telemetry sentence                                        |
| `chain_anomalies`  | `mode: stored` with `signalRunId` and optional `asOf`; or `mode: live` with `chain` | stored: the run's provenance, the labelled entries of the run's origin, stats; live: provider, sanitized base, per-target identity, signal, freshness, full provenance, label, or a failure kind with a fixed sentence |
| `draft_section`    | `evidenceRunId`, `section`, `periodStart`, `periodEnd`, `maximumIncidents` 1 to 100 | the section's Markdown assembled in memory, `unpublished_requires_human_review`, `persisted: false`, `modelInvoked: false`, drafter and contract versions, contract hash, counts                                       |

### 2.5 The input boundary

Every argument is a UUID, an enumeration, a bounded integer or an explicit UTC instant. There
is no free-text argument, no search, no path, no URL and no query. Before any value is read
the argument object must be a plain object whose prototype is `Object.prototype` or null,
with no symbol key, no accessor, no key outside the schema's allowlist (read with
`getOwnPropertyNames`, so a non-enumerable key cannot hide), no nested value, no string over
64 characters and no C0, DEL, C1, U+2028 or U+2029 character in any string. Only then does
the schema run. A rejection names the rule and, for a schema failure, the argument, and never
echoes a value. The SDK validates the same strict schema before the handler runs, so the wire
refuses an unexpected key twice.

### 2.6 The output boundary

Every result is validated against its strict output contract twice, once by the server's own
check and once by the SDK, so a shape the contract does not declare cannot be serialized.
Retrieved text (headline, publisher, URL, provider-returned identity) leaves only as
`{ text, truncated, trust: "untrusted_quoted_evidence" }`, with control characters, ANSI
sequences, Unicode separators and angle brackets rendered as visible escapes and the length
bounded with a visible marker. Every string of every result and every stderr line passes one
redactor covering `DATABASE_URL`, its password raw and decoded, `GRAPH_API_KEY`, bearer tokens
and PostgreSQL URL shapes; live provider values pass the Sprint 1 client's own redactor
first. Every record carries `dataOrigin`; evidence states carry a fixed sentence; every chain
entry carries the engine's fixed limitation and every result the fixed telemetry sentence.
Fields the server controls are never composed from retrieved text, so a forged status in a
headline stays inside its quoted field (section 5 lists the test).

### 2.7 Read-only, enforced by the database

Every read runs through `readOnly()` in `src/store/postgres-store.ts`: one transaction opened
`REPEATABLE READ`, declared `READ ONLY` as its first statement, with
`SET LOCAL statement_timeout = 8000`. A write on that connection is refused by PostgreSQL with
SQLSTATE 25006; a statement past the budget is cancelled with 57014. The server adds no
migration, imports none of the worker's orchestration, and reaches no classification,
clustering, resolution, ingestion or review path. Section 7 records the digest proof.

### 2.8 Bounds

| Bound                        | Value                                   |
| ---------------------------- | --------------------------------------- |
| Incidents per page           | 1 to 50, default 20                     |
| Sources per explanation      | 50                                      |
| Associations per explanation | 100                                     |
| Incidents per draft preview  | 1 to 100, default 25                    |
| Targets per stored anomaly   | 128; 400 observations per target        |
| Entries per stored anomaly   | 500 (the contract's feed bound)         |
| Argument string length       | 64 characters                           |
| Headline / publisher / URL   | 300 / 120 / 512 characters, then marked |
| Identity fields (live)       | 120 characters, then marked             |
| Structured result size       | 262,144 bytes                           |
| Draft preview size           | 200,000 characters                      |
| Time budget per call         | 10 s stored, 30 s live                  |
| Live request timeout         | 15 s per target                         |
| Database statement timeout   | 8 s                                     |
| Rate limit                   | 60 calls per 10 s; 4 in flight          |
| Pool                         | 2 connections                           |

### 2.9 Errors

A failure is an `isError` result whose text is `{ "error": { "code", "message", "details" } }`
with one of nineteen fixed codes and a fixed message; details carry at most the argument
name, the rejection rule, a SQLSTATE or a provider failure kind. The handler catches every
throw, so no exception message ever reaches a result.

## 3. Environment

The server reads `DATABASE_URL`, `GRAPH_API_KEY` and `GRAPH_GATEWAY_URL` and no other name; a
test hands it a proxied environment that throws on enumeration and records exactly those three
reads. A non-empty `DATABASE_URL` is validated in full by `parseDatabaseConfig` before the
server starts, so the credential policy of `SECURITY.md` section 11 is inherited. A bad gateway
URL is rejected by the Sprint 1 validator before any request and is never echoed.

## 4. The Sprint 5 boundary

Sprint 5 is under correction (audit of 2026-09-10, findings F1 to F5). This track consumes it
behind interfaces and touches none of its files:

- `src/engines/anomaly.ts` defines `AnomalyLabeller` and is the only file that imports
  `@cas/evidence` for labelling (`chainAnomalies` and the contract's two bounds).
- `src/engines/draft.ts` defines `DraftPreviewer` and is the only file that imports
  `@cas/drafting`. It calls `generateDraft` in memory and never imports the worker's writer,
  so the path-handling finding F3 has no reach into this server.
- The database reads reuse `getEvidenceRun`, `getGraphSignalRun`, `listSignalHistory` and
  `listDraftIncidents` from `@cas/database` and add three parameterized queries of their own;
  no database file is modified.

Inherited risk from finding F1: a stored signal run whose origin was mislabelled at ingest is
reported under the origin it carries. This server labels what the store holds and cannot
detect that; the correction belongs to Sprint 5 and to migration 0009, which this branch does
not carry.

## 5. Tests

Offline, 70 tests in seven files, run by `corepack pnpm mcp:test` after building the entry
point; no socket, database or secret:

| File                  | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definitions.test.ts` |    11 | four tools; pinned digest; digest moves under every mutation and under a fifth tool; frozen definitions; annotations; `additionalProperties: false` everywhere; no free-text argument; no instructing phrase; wire catalogue hashes to the pin; only the tools capability; undeclared tools refused without touching the store                                                                                         |
| `validation.test.ts`  |    15 | allowlists; plain and null-prototype objects; arrays, functions, class instances, inherited prototypes, symbol keys, unexpected, `__proto__` and non-enumerable keys, accessors never invoked, nested values, oversized strings, control characters and separators, traversal and query-looking identifiers, uppercase identifiers, page bounds, mode cross-field rules, period order; no value echoed                 |
| `tools.test.ts`       |    13 | keyset paging; case-insensitive identifiers; unknown, incomplete and malformed runs; no database; every hostile headline escaped and the forged state kept inside its quoted field; no environment value, stack trace or driver text; sources and associations; cross-run and unknown incidents; stored anomaly labels from the run's origin only; repeatability; every draft section unpublished, model-free, escaped |
| `live.test.ts`        |     8 | exact live provenance with a synthetic provider; key only in the bearer header; missing credential fails with a fixed code and no substitution; empty credential; bad gateway URL never echoed; five provider failure kinds with fixed sentences and no provider text; identity escaping and redaction; mixed-mode refusal; the live module names no store, replay or fixture                                          |
| `runtime.test.ts`     |    10 | a hung store becomes `tool_timeout` inside the budget; `result_too_large`; an output violating its contract is refused; rate window; concurrency cap; burst `rate_limited`; unknown tool names; one redacted log record per call; exactly three environment names read; malformed `DATABASE_URL` never echoed                                                                                                          |
| `stdio.test.ts`       |     5 | the built entry point serves the catalogue, answers without a database, and exits when the client disconnects; stdout is newline-delimited JSON only and stderr carries no secret; SIGINT 130 and SIGTERM 143; rejected configuration exits 2 without echo; a garbage line does not break framing                                                                                                                      |
| `skill.test.ts`       |     8 | `SKILL.md` frontmatter; every tool and no other; trust model, origin labels, model-free and read-only statements; SDK and zod versions equal to the catalog; installation and invocation without command substitution or unsafe shell; no secret; no administrative-event claim; no audit claim                                                                                                                        |

PostgreSQL, 11 tests in `integration.db.test.ts`, run by `corepack pnpm mcp:test:db` with
`DATABASE_URL`, in a schema the test creates and drops:

- a complete pipeline seeded with SQL under the real guard triggers: one replay batch, frozen
  before its classification completes, a completed classification run, a completed clustering
  run with one two-member incident and three singletons, the twelve committed replay snapshots
  as twelve completed signal runs, a live-origin copy of the twelfth, two recorded subjects,
  and a completed evidence run with one accepted `supports` and one accepted `context`
  decision; plus a second, foreign pipeline;
- paging with origin and provenance, escaped headlines, no derived body text;
- sources and the human decision beside the machine suggestion; no note, actor or rationale;
- cross-run access refused; a foreign run lists only its own incidents;
- the replay run labelled exactly as `data/fixtures/README.md` says (one of every label) from
  replay history only, with the live copy present and unread; the live copy labelled from live
  history only;
- every draft section previewed with nothing written;
- malformed, duplicate-key and mixed-mode requests refused before any read;
- every base table of the schema byte-identical after all of the above (section 7);
- an `INSERT` inside `readOnly()` refused with SQLSTATE 25006; a `pg_sleep(30)` cancelled with
  57014 inside the budget.

Repository totals with this branch, from the runner: **554 offline** (contracts 9, taxonomy 7,
evidence 69, database 24, drafting 19, graph-evidence 102, clustering 50, classification 56,
worker 148, mcp-server 70) and **184 PostgreSQL** (database 81, worker 92, mcp-server 11).

## 6. Verification

Run on 2026-09-10 in the worktree at commit 2, and repeated in a fresh clone (section 9):

| Check                                                             | Result                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile`                         | passes, lockfile up to date                                                        |
| `corepack pnpm format:check`, `lint`, `typecheck`, `build`        | green                                                                              |
| `corepack pnpm test --force`                                      | 554 passed, 0 failed                                                               |
| `corepack pnpm test:db`                                           | 81 + 92 + 11 passed                                                                |
| `sandbox-exec -f tools/offline-sandbox.sb corepack pnpm mcp:test` | 70 passed under `deny network*`; the probe in the same session failed with `EPERM` |
| `corepack pnpm audit`, with and without `--prod`                  | no known vulnerabilities                                                           |
| Secret scan of the branch diff                                    | no credential-bearing URL, key, token or private key                               |
| Invisible-character scan of every changed file                    | none; the worker's hygiene test also passes                                        |
| CI                                                                | run 34491540892 green at commit 2                                                  |

## 7. Read-only proof

The integration suite computes, for every base table of the isolated schema (21 tables under
migrations 0001 to 0008, `schema_migrations` included), the row count and an
order-independent digest (one MD5 per row, one MD5 over the sorted row digests) before the
first tool call and after the last, and requires every entry equal. Between the two digests
the suite calls every tool in both success and failure paths, including cross-run and
mixed-mode requests. The same suite then proves the mechanism rather than the outcome: an
`INSERT` issued inside `readOnly()` is refused by the server with SQLSTATE 25006 and the table
digest is unchanged, and a statement past the budget is cancelled with SQLSTATE 57014.

The same digest was taken on the real local database `cas_sprint2_verify` around a read-only
demonstration through the built entry point over stdio (section 8): 22 base tables before and
after, 0 changed. That database carries an `incident_claims` table from the Sprint 5
correction in flight, applied outside this branch; the digest covered it and it was untouched.

## 8. Real-data demonstration (read-only)

Run on 2026-09-10 through `dist/bin.js` with the client over stdio, against the real local
database, with no Graph credential in the environment. Counts, labels and codes only; no
headline was printed.

| Call                                                                                  | Result                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/list`                                                                          | `list_incidents, explain_incident, chain_anomalies, draft_section`                                                                                                                                                                                                                         |
| `list_incidents` on the latest completed evidence run                                 | origin `replay`, 154 incidents in the run, 5 returned, a cursor present, all five `reported_only`, every headline marked `untrusted_quoted_evidence`                                                                                                                                       |
| `explain_incident` on the first of them                                               | `reported_only`, 1 source, 0 associations, no recorded subject                                                                                                                                                                                                                             |
| `chain_anomalies` stored on the latest replay signal run, `asOf` 2026-09-04T09:11:23Z | origin `replay`, 7 targets, 70 observations read; `aave-v3` normal, `spark-lend` positive_spike, `compound-v3` negative_spike, `makerdao` positive_spike, `liquity` insufficient_history, `seamless-protocol` missing_observation, `moonwell` stale_observation, exactly the fixture table |
| `chain_anomalies` live without a credential                                           | `graph_credential_missing`, nothing substituted                                                                                                                                                                                                                                            |
| `draft_section` header and crypto                                                     | `unpublished_requires_human_review`, `persisted: false`, `modelInvoked: false`, 25 incidents considered, contract hash `f89382d6794e…` (the D25 drafting hash)                                                                                                                             |
| Digest                                                                                | 22 tables before and after, 0 changed                                                                                                                                                                                                                                                      |
| stderr                                                                                | 8 lines; the connection string and the `postgres://` scheme absent                                                                                                                                                                                                                         |

## 9. Live provenance run

One real live-mode call per chain on 2026-09-10 at 15:02:56 UTC through `dist/bin.js`, with
`GRAPH_API_KEY` loaded into the server's environment from the ignored `.env` and nothing
else. Printed fields only; the key appeared in no result and on no stderr line.

| Target                   | Provider slug       | Network | Schema | Block    | Deployment                                       | Fresh | Delta      | Label                  |
| ------------------------ | ------------------- | ------- | ------ | -------- | ------------------------------------------------ | ----- | ---------- | ---------------------- |
| `aave-v3-ethereum`       | `aave-v3`           | MAINNET | 3.1.0  | 25947758 | `QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd` | yes   | -0.499114% | `insufficient_history` |
| `spark-lend-ethereum`    | `spark-lend`        | MAINNET | 3.1.0  | 25947758 | `QmTVumjhubXWP8MeDx5g114MRX99E4Gie5mFqVurttF99X` | yes   | 1.406150%  | `insufficient_history` |
| `makerdao-ethereum`      | `makerdao`          | MAINNET | 2.0.1  | 25947758 | `QmYZq1vyFUgFYqyHJgFg2kYfRuYj2U4aXnxrKhZ7t2ApWy` | yes   | -0.662808% | `insufficient_history` |
| `compound-v3-ethereum`   | `compound-v3`       | MAINNET | 3.1.0  | 25947758 | `QmNrQoow7pjM3biRnnhzeCaDYhuEbDyjKCpFeNv2oGXnuK` | yes   | -0.946921% | `insufficient_history` |
| `liquity-ethereum`       | `liquity`           | MAINNET | 2.0.1  | 25947758 | `QmWEnV6povhA9Eq9Y315LsjJg7qwv169r1ZGw9o2uT24eZ` | yes   | -0.418366% | `insufficient_history` |
| `seamless-protocol-base` | `seamless-protocol` | BASE    | 3.1.0  | 51131614 | `QmPSmTkJPSKLFn46YdgwMKV5K2c9a3pkWnzDCC4ccCLAXE` | yes   | 0.009795%  | `insufficient_history` |
| `moonwell-base`          | `moonwell`          | BASE    | 2.0.1  | 51131614 | `QmeE6TgfRmK2iLAgCLBeXuxJQ2VXLFAeHVMTvmnECiFw7y` | yes   | -1.099516% | `insufficient_history` |

Provider `the-graph-gateway`, sanitized base `https://gateway.thegraph.com/api`, query
document SHA-256 `780080c4…` (the Sprint 1 document), `origin: live`, `stored: null` in both
results, Ethereum 5 valid of 5 configured in 1,871 ms, Base 2 valid of 2 in 424 ms. Every
label is `insufficient_history` by construction: a live observation is one reading and the
contract needs seven prior observations before any other label; the result says so in its
fixed `baselineNote`.

## 10. Hashes

| Artefact                                          | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Tool catalogue (canonical, section 2.3)           | `edb68f5268e419e1b4294f4a4290c31e2d8ea9f06e3db872bc180ee299ae9b3a` |
| `packages/mcp-server/SKILL.md`                    | `81c55b778c0d6a9d9db8143fed2b68a47f934db2c706c8c6b17269fa7b2c7c02` |
| `packages/mcp-server/src/definitions.ts`          | `2d0adfee9e07adda0099b8e3c24f3ee15f9bccd8c6531bc0004af64ef0bd6671` |
| `packages/mcp-server/src/bin.ts`                  | `a6180791952c9ec6fbc74cc8f434e94875a8986245a8ecb45b624f623ce6e8e9` |
| `packages/mcp-server/src/validation.ts`           | `d20cfcfde1c69fbabb4a87dfeb13d2a6de5113b7669b455d6447b0f3ca610054` |
| `packages/mcp-server/src/safety/text.ts`          | `477bbf045d84c14109c9c27cbb8722a82badd86b34bddcb23538cff0599b34c2` |
| `packages/mcp-server/src/store/postgres-store.ts` | `58fcb35a00f50a90292140796279025f266aeb614b0f8ef0a8c22e4b8ed4caed` |
| `pnpm-lock.yaml`                                  | `c91fae1c923192af7544fcbc1069726caa6b744e181781cbab20a3a6e0d96588` |
| `pnpm-workspace.yaml`                             | `8cde2681c18cddb9cc3369d0914bd644ae5944af5eeeb2c33a341b2fe31b5d4c` |

Migrations, unchanged from the base: 0001 `6ccf4b05cd…`, 0002 `4139f25cd5…`, 0003
`60d24e6ce0…`, 0004 `89763968c2…`, 0005 `f94c3342c1…`, 0006 `cb88b6a9ba…`, 0007
`1f066032ae…`, 0008 `548c810d92…`. Sprint 5 contract hashes are consumed unchanged: evidence
`faabdade6fb05e0fd8a3f7dcf92807731da126642954e4ddcd9db28ac8dec873`, drafting
`f89382d6794e77a90eb11df841de234421dee2a75651d1cb95187b29b6ddade3`.

## 11. Clean installation from a fresh clone

On 2026-09-10, from GitHub, at commit 2, with an empty pnpm store directory and an empty
Turbo cache:

```
git clone --branch parallel/s6-mcp-tooling https://github.com/doryoysterpie/cs-ethonline-26.git
corepack pnpm mcp:setup
```

`mcp:setup` ran `pnpm install --frozen-lockfile` (lockfile up to date, resolution skipped, 164
packages added to the fresh store, 3.2 s) and `turbo run build --filter=@cas/mcp-server...`
(6 tasks, all successful); `packages/mcp-server/dist/bin.js` was present, 2,167 bytes. In the
same clone, `corepack pnpm verify` was green with 554 offline tests, and a client over stdio
against the built entry point listed the four tools, received the fixed instructions, and got
`database_not_configured` for a store-backed call with no `DATABASE_URL`.

## 12. The brief's boundaries, and the mechanism behind each

| Must not expose            | Mechanism                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| arbitrary SQL              | no SQL argument; every statement is fixed text with parameters                                                                       |
| arbitrary GraphQL          | live mode sends only the Sprint 1 document, SHA-256 `780080c4…`, to registry targets                                                 |
| arbitrary URLs             | no URL argument; the gateway base is validated `https:` only without credentials, query or fragment; the server fetches nothing else |
| arbitrary filesystem paths | no path argument; the tools import no filesystem module; the server reads no file                                                    |
| raw database records       | strict output contracts; no raw cell, `ch` value, review state, derived body text or unbounded column is selected                    |
| raw article bodies         | only `normalized_title`, `raw_category` and `canonical_url` are read, cut to their bound in SQL, returned as quoted evidence         |
| private editorial notes    | no review note, rationale or actor is selected; a test asserts their absence from every result                                       |
| environment values         | three names read, never emitted; a test proves no enumeration                                                                        |
| credentials                | one redactor over every string; the key travels only as a bearer header; a test checks results and stderr                            |
| provider response bodies   | live failures carry a kind and a fixed sentence; identity fields pass two redactors and the evidence quoter                          |
| stack traces               | every throw becomes a fixed code; tests search results for `   at` and `node_modules`                                                |
| unbounded text search      | no text argument exists                                                                                                              |
| implicit "latest run"      | every tool takes its run identifier; there is no default                                                                             |

OWASP MCP guidance, section by section: least privilege (read-only transactions, three
environment names, no writes); schema integrity (frozen catalogue, pinned digest, strict
schemas, no runtime redefinition); isolation (stdio only, no socket, no filesystem, no
network outside live mode); input and output validation (sections 2.5 and 2.6); authentication
and transport (not applicable to a local process pair, and no remote transport exists);
replay resistance (idempotent read-only tools over a process-bound pipe, so a replayed request
returns the same result and changes nothing); logging (one redacted, single-line record per
call with tool, outcome, duration, bytes and the identifier-only arguments); prompt injection
through results (quoted evidence, fixed notice, no instruction in any result, angle brackets
escaped).

## 13. Judgment calls and deviations

- **SDK v2 rather than v1.** The current official documentation is the 2.0.0 line
  (2026-07-28 revision), released the same day as 1.30.0. The v2 server package has two
  runtime dependencies (`core` and `zod`) where 1.30.0 has seventeen, including HTTP
  frameworks this track must not enable.
- **Dependency direction.** `ARCHITECTURE.md` section 5 proposed that read-side surfaces
  depend on `@cas/database` and `@cas/contracts` only. Live mode needs the Sprint 1 client,
  and labelling and previewing need the Sprint 5 engines. D28 records the deviation and the
  interface boundary that keeps it to three imports in three files.
- **Read-only through `SET TRANSACTION READ ONLY`** inside the audited `withTransaction`,
  rather than a separate database role. A role is a deployment decision (D8 is unresolved); the
  transaction declaration is enforced by the server on every connection and is proven by test.
  A read-only role remains available to add at deployment and would compose with it.
- **Live labels.** A live observation is labelled with the same contract as stored history,
  from the one observation, so the label is `insufficient_history` unless the reading is
  stale. Mixing a live observation into stored history was rejected because it would cross
  the origin boundary and because finding F1 shows stored "live" history may be mislabelled.
- **`asOf` in stored mode** makes the replay demonstration reproducible, as the worker's
  `--as-of` does; live mode refuses it and uses the clock.
- **`draft_section` assembles the whole draft** and returns one section, so the provenance
  section is consistent with the others; the cost is bounded by `maximumIncidents`.
- **`mcp:setup` runs `pnpm install` inside a pnpm script.** It is the one-command
  installation the brief asked for; the clean-clone run proves it works from an empty store.
- **The client SDK is a development dependency** for the tests only; its transitive packages
  (`jose`, `eventsource`, `pkce-challenge`, `eventsource-parser`) never load at runtime.
- **The database test seed is SQL, not the worker.** No package may depend on an application,
  so the pipeline is seeded directly under the same guard triggers; the seed is test support,
  excluded from the build.

## 14. Unresolved risks

1. **Sprint 5 is under correction.** The evidence states, the labelling contract and the
   drafter this server consumes are the candidate's, not an accepted revision; finding F1
   means a stored origin can be wrong at the source, and this server reports the stored
   origin. Final integration must re-point the two adapters at the accepted Sprint 5 SHA and
   rerun this track's suites, and this track's own audit is still to come.
2. **SDK maturity.** `@modelcontextprotocol/server` 2.0.0 is six weeks old. Two SDK behaviours
   are noted, not changed: an unknown tool name and an unrecognized argument key are echoed
   back to the calling client in the SDK's own error text (JSON-escaped, the caller's own
   input, never a stored value); and the server's `tools/list` result is cacheable by the
   client under the 2026-07-28 revision, which is harmless for a static catalogue.
3. **Live mode has no baseline by design**, so its anomaly label is normally
   `insufficient_history`; the value is the telemetry. A stored-history baseline for live
   readings would need the Sprint 5 origin correction first.
4. **Source URLs are returned as quoted evidence.** This server never fetches them; a consuming
   agent could. `SKILL.md` says they are references, not instructions.
5. **Rate limit and concurrency are per process**, which is the right unit for a stdio pair
   and would not be for a remote transport; no remote transport exists.
6. **Node 25 locally, Node 24 in CI.** CI and the clean clone prove Node 24 (`.nvmrc`); the
   local runs used 25.
7. **Not exercised:** a host application other than the SDK client; a database with a
   read-only role; the dashboard (out of scope); Google Sheets, Hedera, Bazantic and remote
   hosting (out of scope by the brief).

## 15. Reproduction for Codex Desktop

From a fresh clone of `parallel/s6-mcp-tooling`, Node 24 and `corepack`:

```
corepack pnpm mcp:setup
corepack pnpm verify
sandbox-exec -f tools/offline-sandbox.sb corepack pnpm mcp:test
corepack pnpm audit
```

With a local PostgreSQL 17 and `DATABASE_URL` set to a database you control:

```
corepack pnpm mcp:test:db
corepack pnpm test:db
```

The MCP suite prints 11 tests; the whole PostgreSQL run prints 81, 92 and 11. To watch the
server itself, point any MCP client at `packages/mcp-server/dist/bin.js` with `DATABASE_URL`
in its environment and call `list_incidents` with a completed evidence run identifier; without
`DATABASE_URL` every store-backed call answers `database_not_configured`, and without
`GRAPH_API_KEY` every live call answers `graph_credential_missing`.

**MCP tooling track remains pending until Codex Desktop issues PASS.**

**No remote MCP service has been enabled or deployed.**

## 16. Audit correction (current state)

This section supersedes sections 1 to 15 wherever they disagree. It describes the integrated
revision on `parallel/s6-mcp-tooling`, not the rejected candidate.

### 16.1 What was integrated

Three correction branches, each cut from the rejected candidate `7f03a34f`, imported
additively in the order store, runtime, content. No commit was amended, rebased or squashed,
no migration was added, and no Sprint 5 correction commit was incorporated.

| Branch                        | Final SHA                                  | Findings it owned          |
| ----------------------------- | ------------------------------------------ | -------------------------- |
| `parallel/s6-mcp-fix-store`   | `022aab55cfd154f8a04b8bd7e89e29ff19b0951e` | F7, F8, F9, F10, F13       |
| `parallel/s6-mcp-fix-runtime` | `bae8add8821fbcd2c3b829e9cc309d5e9a5a5744` | F1, F2, F3, F4, F11        |
| `parallel/s6-mcp-fix-content` | `1960a961ee0d15dd8c56e90a3949ad1ab74819bd` | F5, F6, F12, F14, F15, F16 |

### 16.2 Behaviour that differs from sections 1 to 15

- **The error vocabulary is twenty-two codes**, not nineteen. The three branches each added
  one: `call_cancelled`, `database_role_overprivileged` and `stored_metadata_invalid`. Section
  2 and section 5 say nineteen; they describe the rejected candidate.
- **The pinned catalogue digest is**
  `676c0cf8ae08fa7c78a33c108c3a0b1072fe179822e74a62ad99478b2682f625`. The value
  `edb68f5268e419e1b4294f4a4290c31e2d8ea9f06e3db872bc180ee299ae9b3a` in section 2 and section
  10 is the rejected candidate's.
- **The server reads four environment names**, not three: `DATABASE_URL`, `GRAPH_API_KEY`,
  `GRAPH_GATEWAY_URL` and `CAS_MCP_MODE`.
- **`readOnly()` no longer exists.** A tool call now opens one connection through
  `withReadOnlyConnection`, runs one `REPEATABLE READ`, `READ ONLY` transaction on it, and
  destroys the connection when the call ends. Section 7's description of a per-method
  transaction describes the rejected candidate.
- **A production start requires a dedicated reader role.** `CAS_MCP_MODE` unset or
  `production` runs an eighteen-check privilege matrix at start-up (fail closed, exit code 2)
  and again on every stored call's own connection before any application read. The template is
  `packages/mcp-server/sql/mcp-reader-role.sql`; `corepack pnpm mcp:verify-role` reports the
  matrix. Section 13's description of a separate role as optional future work is superseded:
  it is a required production control.
- **A stored anomaly evaluation requires `asOf`** and is bounded by the named run's completion
  instant. The server clock is never read on that path.
- **Redirects are never followed.** Live Graph requests run with `redirect: "manual"`; every
  3xx is a fixed failure with zero requests to the destination.
- **Cancellation stops work.** One call-scoped signal, aborted by the deadline, the client's
  protocol cancellation or shutdown, reaches the transaction and the live request; a statement
  in flight is cancelled at the server; the permit is released only once the work has unwound.
- **A draft preview is inert Markdown** with a fixed opening notice, classified source
  references, truthful truncation markers and a per-claim provenance sidecar, and it proposes
  no structured victim name and redacts no name from quoted text.
- **A duplicate JSON key is not detected.** The parser keeps the last value and the request is
  validated as if only that value had been sent. Section 12's statement that duplicate keys
  are refused is wrong and is withdrawn.

### 16.3 Test totals at the integrated revision

Derived from Vitest's own collection (`vitest list --json`), not estimated, and held to these
figures by `src/documentation.test.ts`.

| Suite                         | Tests | Files |
| ----------------------------- | ----: | ----: |
| `@cas/mcp-server`, offline    |   184 |    19 |
| `@cas/mcp-server`, PostgreSQL |    49 |     4 |

Workspace totals: **668 offline tests** across ten packages (contracts 9, taxonomy 7,
drafting 19, evidence 69, database 24, graph-evidence 102, clustering 50, classification 56,
worker 148, mcp-server 184) and **222 PostgreSQL tests** (database 81, worker 92,
mcp-server 49). Section 5's figure of seventy offline tests in seven files is the rejected
candidate's.

The PostgreSQL suite now creates a database and a login role of its own per file, named
`cas_mcp_test_<random>`, and drops both on close; the compiled stdio group runs against that
database as the provisioned reader role and is no longer opt-in behind an environment
variable.

### 16.4 A cancelling connection the provider did not own

Integrated verification found one defect the three corrections did not: a cancel opens a
second connection of its own, and only `withReadTransaction` registered that connection with
the provider. `verifyPrivileges`, the start-up privilege check, forwarded its options
unchanged, so a verification cancelled during start-up left a connection `close` knew nothing
about; any direct caller of `withReadOnlyConnection` was in the same position. The claim in
`SECURITY.md` section 15 that shutdown waits for every cancelling connection was therefore
true of tool calls and not of the verification.

Both paths now register: the provider's registration is one method used by every entry point
that opens a connection, and the primitive waits for its own cancelling connection when the
caller registers none. `store.db.test.ts` covers it, and `SECURITY.md` section 15 now states
the property for every connection the store opens rather than for tool calls alone.

The defect surfaced as the existing F8 test `destroys the connection of a call that fails, and
sends nothing once aborted` failing once under machine load of about 100. A standalone
reproduction left a reader backend after `close()` in 2 of 8 rounds before the fix and 0 of 10
after. The window is narrow on an idle server, so the regression test opens it ten times per
run; it passes every run with the fix and caught the unfixed code in 2 of 4 runs. It is a
partial detector of the defect and a complete statement of the property.

### 16.5 Offline proof under enforced network denial

Section 6's line, `sandbox-exec -f tools/offline-sandbox.sb corepack pnpm mcp:test`, no longer
holds at this revision and is the rejected candidate's. Two files the content correction brings
in need a loopback socket, which `tools/offline-sandbox.sb` denies along with every other
network operation: `src/redirect.stdio.test.ts` serves real synthetic HTTP and HTTPS redirects
from 127.0.0.1 to prove the gateway refuses every one of them, and `src/stdio.test.ts` asserts
the fixed start-up line for an unreachable database, whose reason is derived from the refusal
the operating system returns. Run under the deny-all profile the two fail with `EPERM` on
`listen` and on `connect`. That is the profile working, not the suite reaching the network.

`tools/loopback-sandbox.sb` is added for this: it denies every network operation except a
loopback socket, so the whole default suite can still be shown to reach no host off this
machine. Both profiles were exercised at the integrated revision.

| Check                                                        | Result                                         |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `offline-sandbox.sb`, every package except `@cas/mcp-server` | 16 of 16 tasks pass under `deny network*`      |
| `offline-sandbox.sb`, whole suite                            | fails: 2 files, `EPERM` on a loopback socket   |
| `loopback-sandbox.sb`, whole suite                           | 18 of 18 tasks, 668 tests, 0 failed, 0 skipped |
| `loopback-sandbox.sb` probe, `net.connect(443, '1.1.1.1')`   | `EPERM`                                        |
| `loopback-sandbox.sb` probe, `dns.lookup('example.com')`     | `ENOTFOUND`, so no name resolution             |
| `loopback-sandbox.sb` probe, UNIX-domain socket              | `EPERM`                                        |
| `offline-sandbox.sb` probe, `net.connect(443, '1.1.1.1')`    | `EPERM`                                        |

The loopback allowance cannot exclude the local PostgreSQL port: this sandbox dialect accepts
only `*` or `localhost` as a network address host and does not enforce the port. That the
default suite needs no database is carried by the deny-all profile, under which every package
except `@cas/mcp-server` passes with all network denied, and by the database suite being a
separate command over separate files.

### 16.6 What has not changed

The track is still isolated, still unmerged and still unaudited. It must not merge until
Sprint 5 passes its own audit and the combined result passes a further independent audit.
Even a `PASS - ISOLATED TRACK ONLY` on this historical base would authorize no merge, no
deployment, no remote access and no trust in rejected-base evidence.
