# Latest in Cyber

Onchain incident intelligence for the weekly **Cyberattack Sunday** workflow, with a
crypto-focused editorial feed, **Latest in Crypto**. Repository: `doryoysterpie/cs-ethonline-26`.
Licence: Apache License 2.0 (`LICENSE`). `CAS Chainwatch` was the working name; it survives only
in machine identifiers such as the `@cas/` scope and the `cas-chainwatch-mcp` server name (D5).

An ETHOnline 2026 project that imports the current cybersecurity news feed, classifies it
automatically with high recall into an include, exclude or needs-review queue, clusters the
result into canonical incidents with explicit evidence states and complete provenance,
attaches corroborating onchain signals from live The Graph data, and gives a human an
editable draft of the weekly Cyberattack Sunday issue, exposed through reusable MCP
tooling.

## Event schedule

ETHOnline 2026, entered as a Start Fresh project. All times America/Toronto.

| Milestone                | When                        |
| ------------------------ | --------------------------- |
| Hacking began            | 4 September 2026, 12:00 PM  |
| Project Check-in #1      | 7 September 2026, 11:59 PM  |
| Project Check-in #2      | 10 September 2026, 11:59 PM |
| Final project submission | 13 September 2026, 12:00 PM |
| Judging begins           | 13 September 2026, 3:00 PM  |

14 to 16 September are not build or submission time. All project code begins on or after
4 September 2026. The pre-existing Cyberattack Sunday corpus is input data, not project code,
is never committed, and is disclosed in the submission (`docs/PRIOR_INPUTS.md`).

## Current status

**Sprint 5 in progress: the Graph evidence, anomaly and drafting layer, corrected after an
independent audit and pending re-audit.** Sprint 4's deferred work is built — correlation on
recorded chain and protocol identity, the four evidence states, the chain-and-reporting anomaly
feed — together with the deterministic drafting pipeline (decision D25, migration 0008).
Correlation reads no text of any kind, a machine suggestion is never evidence until a named
person accepts it, and the absence of a signal never counts against a claim. Nothing is
model-generated: there is no SDK, no model path and no credential read.

Codex Desktop audited candidate `6fad82c3b03325101940d9ca25575d94550e7d25` on 10 September
2026 and returned CHANGES REQUIRED with five findings: a replay file could be ingested as live,
a corroboration could name an unverified UUID as its claim, the draft writer followed a
symbolic link and accepted traversal, the snapshot validator invoked accessors, and the hygiene
test never proved detection. All five are corrected on the branch (decision D26, migration
0009): a file can be ingested as fixture or replay only; live evidence comes from the Graph
client, never from a file; an evidence run's origin is bound to its signal and clustering runs
by foreign key; a claim is a record, not a UUID, proven a member of its incident by the
database; a draft is published under one authorised root, never through a symbolic link, and
never overwritten. **Sprint 5 has not passed re-audit**, and no part of this repository may be
read as saying otherwise until Codex Desktop issues a result (`docs/SPRINT-5-REPORT.md`,
section 16).

**Sprint 4 accepted by Codex Desktop at `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`
(9 September 2026): eligible classified sources become provisional canonical incidents.** A deterministic, model-free clustering engine
(decision D22) consolidates exact URL duplicates, detects syndication and groups separate
reports into provisional incidents. Recomputed on 9 September 2026 for all three accepted
Sprint 3 classification runs at the corrected contract hash: 24,193 eligible results became
23,596 provisional incidents, every eligible result covered exactly once, no excluded result
covered at all, no cluster larger than the 500-member bound, and every run reconciled. A human
can merge and split incidents through an append-only review layer that never rewrites what the
machine produced. These are structural counts, not clustering accuracy: no machine-readable
record of the final editorial outcome exists yet (`docs/SPRINT-4-REPORT.md`).

The first Sprint 4 candidate was rejected on 9 September 2026 with seven findings, and an
eighth followed on re-audit: a cluster bound that did not hold over a whole component, a
membership that could name another classification run of the same batch, review idempotency
that accepted a changed payload, review notes validated only at the command line, a default
test that opened a socket, a contradictory check-in status, an inaccurate complexity claim and
a stale test count in the reproduction instructions. All eight were corrected, and Codex
Desktop accepted the result. Section 13 of the Sprint 4 report records each one.

**Graph scope, decided 8 September 2026 (D23).** Seven protocol identities are proven live on
the standardized TVL lane, and that lane is the project's live Graph capability. Plan 2.0's
separate ten-protocol administrative-event watchlist was planned and is not delivered: the live
query reads protocol identity, total value locked and daily financial snapshots, and reads no
administrative event. The project owner has removed that watchlist from hackathon scope by an
explicit deviation and moved it to the post-event roadmap, to protect the 10 September Graph
release gate. The two are different capabilities, and neither is presented as the other.

**Sprint 3 accepted at `71394c9b8e732bc7508b6276eafcbbac414c3a07`**, after two independent
Codex Desktop audits and two correction passes. A deterministic, versioned rule-based
classifier (decision D21) classified all 24,248 imported rows across the three batches: 13,015
include, 55 exclude, 11,178 needs-review, one result per row, every run reconciled against its
batch. Candidate-retention is 0.992307 on CS79 and 1.0 on CS86 against a 0.98 target: those
two files are weekly **candidate** cut-downs, so the figures measure retention against the
owner's intermediate candidate decisions, not agreement with the final published selection.
They are calibration evidence for a high-recall filter, not end-to-end editorial accuracy,
publication recall or validated incident truth. The weekly candidate decisions never reach the
classifier, and nothing in it is fitted or weighted from them. No model is called and no
Anthropic credential is read, because D9 is unresolved.

## The vertical slice

The charter's must-ship list, whose numbering the Graph release gate uses:

1. Detect chain anomalies from live The Graph data.
2. Connect those signals to cybersecurity reporting.
3. Cluster reporting into canonical incidents.
4. Assign evidence states with complete provenance.
5. Generate an editable Cyberattack Sunday draft.
6. Expose the intelligence through reusable MCP tooling.
7. Add Hedera x402 and Bazantic integrations, only after the Graph release candidate passes
   its gate.

The runtime order differs from this list. Editorial ingestion and automated classification
come first; Graph signals run in parallel and corroborate canonical incidents; the human
reviews a queue at the end (`docs/ARCHITECTURE.md` section 3, decision D15).

## The editorial workflow being automated

```
living RSS ledger → weekly candidate cut-down → reformatted and deduplicated candidate draft
   → owner's final editorial decisions → published Substack report
```

Make continuously aggregates many websites into a living RSS feed, maintained and exported
through Excel. The owner reviews that living feed and cuts it down to the possible cyberattack
incidents and other stories of interest for one editorial week. That cut-down is a candidate
list, not the final word: Claude reformats and deduplicates it, and the owner then makes the
final selection, ordering and editing before publishing on Substack. The published report is
the closest available record of the final editorial outcome, and this project does not yet
hold those reports in machine-readable form.

CS79 and CS86 are two weekly candidate cut-downs. They are not weekly master RSS datasets,
there are no eighty-eight independent weekly master datasets, and a row kept in one is a
possible story rather than a confirmed incident. Neither Publisher Category, nor the ledger's
`ch` working state, nor weekly inclusion is a definitive incident label
(`docs/DATA_INPUTS.md` sections 1, 3 and 4).

End-to-end evaluation will need the published reports: pairing weekly cut-downs with their
Substack reports, reconstructing the final include, exclude and grouping outcomes through an
explicit reviewed mapping, preserving provenance from the ledger through the candidate list to
the publication, and reserving an untouched group of paired weeks as a holdout before the
wider archive is opened to development. That split has not been made. Decision D10, which
fixes the automated week boundary, the late-arriving-story rule and the publication cutoff,
stays unresolved.

## Sponsor-track priority

The Graph tracks come first. For the standardized-data track the primary route is meaningful
use of the Messari standardized schema over live provider-backed data; a second Graph
product is not required (decision D11). Hedera AI and Agentic Payments (x402) and the
Bazantic recipe tracks are attempted in Sprint 8 only if the Graph gate passes and time
allows; otherwise they are dropped. Requirement status per track is in
`docs/HACKATHON_REQUIREMENTS.md`.

**Parallel track: read-only Google Sheets intake.** A file-scoped connector for
the one authorized workbook `Cyberattack Sunday - RSS Intake`, on
`parallel/google-sheets-intake`. It reads through the Sheets API only: no Drive
API, no user OAuth, no write scope, no Google SDK, and two allowed origins with
no redirect ever followed. The workbook is a whitelist of one, pinned as a
SHA-256 digest in a committed policy file that ships unpinned, so the connector
fails closed until a human pins it. Nothing is written anywhere, and there is no
database import path yet by design: the owner reviews an inventory report and
approves a tab mapping first. The workbook's weekly tabs record candidate
selections, not published outcomes, and are not evaluation truth until each is
paired with its published edition (`docs/SHEETS-INTAKE.md`). **This track has
not been audited, and no live inventory has been run.**

## Monorepo layout

| Path                      | Package               | State after integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard`          | `@cas/dashboard`      | placeholder; Next.js command center, built in Sprint 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/worker`             | `@cas/worker`         | implemented: CSV validation, import, classification, clustering, evidence, claim, anomaly and drafting commands; import limits and a command deadline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 8 conditional on the gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/contracts`      | `@cas/contracts`      | editorial and import enums, the chain set, the Graph evidence contracts and the versioned resource limits (`resource-limits@1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/database`       | `@cas/database`       | implemented: migration runner, nine migrations, ingestion, classification, clustering, evidence and claim ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/taxonomy`       | `@cas/taxonomy`       | versioned classification signal policy. Incident taxonomy: future work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/classification` | `@cas/classification` | implemented: deterministic high-recall classifier and calibration evaluator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/clustering`     | `@cas/clustering`     | implemented: deterministic duplicate, syndication and incident grouping (D22)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/evidence`       | `@cas/evidence`       | implemented: correlation, evidence-state resolution and the anomaly feed (D25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/graph-evidence` | `@cas/graph-evidence` | implemented: live gateway client with streaming body and JSON shape limits, adapter, TVL delta, identity gate, probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-server`     | `@cas/mcp-server`     | parallel MCP tooling track (D29): four read-only tools over local stdio; candidate rejected by audit, corrections integrated, pending re-audit; 208 offline tests, 49 PostgreSQL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/sheets-intake`  | `@cas/sheets-intake`  | read-only, file-scoped Google Sheets intake; no Drive API, no write scope, no SDK; inactive until pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/drafting`       | `@cas/drafting`       | implemented: deterministic draft assembly and provenance sidecar (D25). No model is called                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `data/taxonomy`           |                       | reserved, still empty; the signal policy lives in code, not here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `data/fixtures`           |                       | synthetic editorial CSV fixtures and synthetic evidence replay fixtures (`data/fixtures/README.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools`                   |                       | `checks/` (hygiene, forbidden-file, secret, workflow and toolchain scans; Linux network denial) and `supply-chain/` (bill of materials generator); two sandbox profiles and a probe for proving the default suite is offline: `offline-sandbox.sb` denies all network access and carries every package and every MCP file but one (`corepack pnpm test:denied`); `loopback-sandbox.sb` additionally permits addresses assigned to this machine, loopback and local-interface alike, and carries only `redirect.stdio.test.ts` (`corepack pnpm test:localhost`); `sandbox-probe.mjs` reports what either profile actually allows (`corepack pnpm sandbox:probe`) |
| `supply-chain`            |                       | the committed CycloneDX 1.6 bill of materials and licence inventory, reproduced byte for byte in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `docs`                    |                       | charter documents, security documents and sprint reports, listed below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

A placeholder package contains one source file that exports nothing. The intended
responsibility of each package is in `docs/ARCHITECTURE.md`. Next.js is fixed by the plan for
the dashboard and is not installed before Sprint 6.

## Local installation and verification

Requirements: Node 24.21.0 exactly (`.nvmrc`) and pnpm 11.10.0, pinned in the `packageManager`
field of `package.json`. `corepack pnpm` runs the pinned version without a global install.
`corepack pnpm check:toolchain` asserts that the Node and pnpm in use are the pinned releases.

```bash
corepack pnpm install --frozen-lockfile
```

```bash
corepack pnpm format:check
```

```bash
corepack pnpm lint
```

```bash
corepack pnpm typecheck
```

```bash
corepack pnpm test
```

```bash
corepack pnpm build
```

`corepack pnpm verify` runs those checks in that order, then `test:tools` (the repository
tooling's own tests), `check:repo` (the hygiene, forbidden-file, secret and workflow scans)
and `build`. None of these steps touches the network or needs a secret.
Set `TURBO_TELEMETRY_DISABLED=1` to silence Turborepo telemetry locally.

Continuous integration (`.github/workflows/ci.yml`) runs on every push to `main`, a
`sprint-*`, `parallel/*` or `release/*` branch and on every pull request, in three jobs: `Verify`
(the sequence above, preceded by the toolchain assertion and followed by the offline suite
rerun under an enforced network denial), `PostgreSQL integration` (a fresh, digest-pinned
PostgreSQL 17 service: every migration applied, a no-op rerun, the drift check and the
complete `test:db` suite, with a credential-free loopback URL) and `Supply chain`
(`pnpm audit` and the byte-for-byte reproduction of `supply-chain/`). A separate CodeQL
workflow analyses the TypeScript sources. Every action is pinned to a full commit SHA. The
CI additions belong to the security-foundation track and are pending an independent audit.

Two further commands exist for the same purpose locally: `corepack pnpm test:offline-enforced` (Linux; proves the network denial with a loopback control, then runs the default suite inside it) and `corepack pnpm test:denied` (macOS). Both run every default test except `redirect.stdio.test.ts`, which needs a listening socket that a strict denial refuses; it runs in the ordinary `Test` step and, on macOS, under `corepack pnpm test:localhost`.
`corepack pnpm supply-chain:generate` regenerates the bill of materials after a lockfile
change; `corepack pnpm supply-chain:check` fails when the committed files no longer match.

## Live Graph probe

The Sprint 1 proof is reproducible with one Subgraph Studio API key.

1. Create an API key in Subgraph Studio and put it in a local `.env` at the repository
   root, which Git ignores:

   ```
   GRAPH_API_KEY=your-key
   ```

   The gateway base URL defaults to the public gateway; `GRAPH_GATEWAY_URL` overrides it
   and must be a plain `https` URL with no credentials, query string or fragment
   (`.env.example`).

2. Load the file into your shell without echoing it, then run the probe:

   ```bash
   set -a && . ./.env && set +a && corepack pnpm graph:probe
   ```

The probe compiles the package, runs the one common query against every selected deployment
(five Ethereum, two Base), validates each response's provider-returned network, protocol
type, schema version and deployment against the registry's declared expectations, and prints
a redacted summary per deployment: provider identity beside the configured slug, block and
block time, deployment ID, the baseline and current observation with the measured elapsed
window and freshness, the raw current and baseline TVL, and the percentage delta. A mismatch
prints the field, the expected value and the received value. Every printed line is redacted
and every provider-controlled value is rendered as single-line text, so a hostile endpoint
can neither leak the key nor forge a gate line. Detailed output goes only to
`output/graph-probe/`, which Git ignores, through the same redactor. Exit code 0 means the Ethereum gate passed on five
distinct provider-validated identities, 1 means it failed, 2 means the credential is missing
or the registry is invalid. Base is reported as `PASS/KEEP` only when both configured Base
targets verify, otherwise `FAIL/DROP`, and never changes the exit code.

The live integration test runs the same queries under Vitest and fails, rather than skips,
without a credential:

```bash
set -a && . ./.env && set +a && corepack pnpm graph:test:live
```

The key travels only in an `Authorization: Bearer` header, is redacted from every output, and
is never added to CI. Rules are in `docs/SECURITY.md` section 10.

## Local database and editorial import

Sprint 2 adds a local PostgreSQL foundation and a manual, on-demand CSV import (decision
D20). Requirements: a local PostgreSQL 17 and `DATABASE_URL` in the ignored `.env`, for
example a loopback URL naming a database created for this project. A passwordless URL is
valid, which is the simplest local setup. If you do supply a password, it must be at least
four characters once percent-decoded, because the redactor cannot protect a shorter value;
a shorter or malformed one is refused with a fixed message that never echoes the URL or the
password. Every accepted password is redacted in its raw and decoded forms. Load the file
into your shell without echoing it, as for the Graph probe.

```bash
set -a && . ./.env && set +a && corepack pnpm db:migrate
```

`db:migrate` applies the numbered SQL migrations under `packages/database/migrations` in
order, records each one's SHA-256 in `schema_migrations`, refuses to run if a recorded
checksum no longer matches its file, holds an advisory lock so two runners cannot race, and
is a reported no-op when nothing is pending. Migration 0002 makes provenance contradictions
impossible relationally; it upgrades a database that already has 0001 applied without data
loss, and refuses to run against one whose existing rows already contradict each other. `db:check` prints connectivity, server version,
the connection transport and the migration status without printing the connection string.

```bash
corepack pnpm editorial:validate --file /path/to/export.csv --kind weekly
```

Validation needs no database and writes nothing: it streams the file, rejects it as a whole
on a structural fault (invalid UTF-8, a NUL character, a quoting fault, inconsistent column
counts, a duplicated or missing required header), and otherwise prints count-only results:
rows, accepted and quarantined, issue codes, `ch` token counts, duplicate URL excess and the
longest cell. `--kind` is `master` or `weekly`.

```bash
set -a && . ./.env && set +a && corepack pnpm editorial:import --file /path/to/export.csv --kind weekly --origin replay --review-label CS79
```

Import requires an explicit `--origin` (`live`, `fixture` or `replay`; there is no default),
requires `--review-label` for a weekly file and forbids it for a master file, validates the
file structurally before any write, and then writes the batch in one transaction. Every
original cell is stored, unknown columns included; rows with semantic problems are stored
as quarantined with stable issue codes, never dropped; weekly `TRUE` and `FALSE` become
`selected` and `rejected` review entries in their own snapshot, while the master `ch` column
stays working state; duplicate URLs remain separate rows sharing a URL group. Importing the
same file with the same configuration again identifies the original batch and writes
nothing. `editorial:report` prints count-only reconciliation for every batch.

The commands print only basenames, hashes, counts, ids, statuses, durations and issue codes.
Every emitted entry is redacted for the connection string and its password, rendered as one
physical line, and shows any control character or ANSI sequence in a filename or label as a
visible escape, so hostile metadata cannot forge a line in captured evidence. pnpm itself echoes the
command line it runs, path argument included; pass `-s` to `corepack pnpm` when capturing
evidence. Exit codes: 0 success (including `completed_with_issues`), 2 configuration,
3 structural input (including a file that crosses an import limit), 4 database,
5 unexpected, 124 command deadline expired, 130 interrupted. PostgreSQL integration tests
run only through `corepack pnpm test:db`, need `DATABASE_URL`, and create and drop only
schemas named `cas_test_<random>` in that database. Rules are in `docs/SECURITY.md`
sections 11 and 15 and `docs/DATA_INPUTS.md` section 14.

## Dashboard (parallel Sprint 6 track, speculative)

The Next.js dashboard and its authentication live on `parallel/s6-dashboard-auth` (decision
D28) and are **pending an independent audit**. Account persistence is paused until the next
migration number is allocated after the Sprint 5 correction, so the track runs only with the
in-memory store in the `local` environment. No account is provisioned. Set the four
`DASHBOARD_*` variables from `.env.example`, then:

```bash
corepack pnpm --filter @cas/dashboard build
```

```bash
corepack pnpm --filter @cas/dashboard start
```

```bash
corepack pnpm --filter @cas/dashboard provision --username <name> --role <judge|editor|admin> --expires-at <instant>
```

The provisioning command reads the password on the terminal without echo, validates it,
stores an Argon2id hash under a fresh salt and nothing else. `--rotate` replaces an existing
account's hash and revokes every session of that account. A judge requires `--expires-at`.

```bash
set -a && . ./.env && set +a && corepack pnpm --filter @cas/dashboard test:db
```

```bash
set -a && . ./.env && set +a && corepack pnpm --filter @cas/dashboard test:browser
```

The browser suite builds the production bundle, migrates and seeds an isolated schema through
the real pipeline, provisions synthetic accounts with random passwords into a temporary seed
file, runs Playwright against `next start`, then drops the schema and deletes the files. Rules
are in `docs/SECURITY.md` section 15; the handoff for the audit is
`docs/SPRINT-6-DASHBOARD-AUTH-HANDOFF.md`.

## MCP tooling track (parallel, rejected candidate, corrections pending re-audit)

The Sprint 6 MCP server was built ahead of the dashboard on the speculative branch
`parallel/s6-mcp-tooling`, from the Sprint 5 candidate, while Sprint 5 is under correction
(decision D28). **Its candidate `7f03a34f` was rejected by its independent Codex Desktop audit
of 10 September 2026 with findings F1 to F16.** Three correction branches have been integrated
additively onto that candidate; the combined revision is **pending a re-audit and is not
accepted**. It is not merged and not deployed, and final integration begins from the
Codex-accepted Sprint 5 revision, which does not yet exist: **Sprint 5 has not passed its own
audit.**

`@cas/mcp-server` exposes four read-only tools over local stdio and nothing else:
`list_incidents`, `explain_incident`, `chain_anomalies` and `draft_section`. One tool call is
one connection and one `REPEATABLE READ`, `READ ONLY` transaction, destroyed when the call
ends, and a production start requires a dedicated least-privilege reader role that an
eighteen-check matrix verifies before anything is read. The tool catalogue is frozen
application code with a pinned SHA-256; every argument is an identifier, an enumeration, a
bounded integer or an exact UTC instant, advertised exactly as it is validated; a cancelled or
timed-out call has its statement cancelled at the server and its connection destroyed before
it reports; a live Graph request follows no redirect; every text field a tool returns is
quoted evidence, redacted before it is escaped, bounded with a marker that tells the truth
about what was cut, rendered inert where it enters Markdown, and labelled with the data origin
**the database recorded**, which this server does not verify. No tool invokes a model, writes,
edits or publishes. The contract is `packages/mcp-server/SKILL.md`; the evidence, including
the before-and-after database digest and the correction section, is
`docs/MCP-TOOLING-TRACK-REPORT.md`.

One command installs from a fresh clone with the frozen lockfile and builds the server:

```bash
corepack pnpm mcp:setup
```

```bash
corepack pnpm mcp:test
```

```bash
corepack pnpm mcp:start
```

The server reads `DATABASE_URL`, `GRAPH_API_KEY`, `GRAPH_GATEWAY_URL` and `CAS_MCP_MODE` from
its environment and never emits their values. **No remote MCP service has been enabled or
deployed**, and none is designed: the only transport is local stdio.

## Audit policy

Claude implements on sprint branches. Codex independently reviews diffs, installs locked
dependencies when appropriate, and reruns verification. Neither agent merges to `main`
without the project owner's instruction.

## Live integrations

The Graph is live as of Sprint 1. A local PostgreSQL is used as of Sprint 2, through
`@cas/database` only; no live database target is chosen (D8). Nothing in this repository
talks to Anthropic, Hedera, an x402 facilitator or Bazantic yet. `.env.example` declares only the variable names
an existing architectural need already fixes; every other configuration category is listed
there without a name until the sprint that introduces it.

## Hackathon non-goals

Out of scope for the hackathon, by decision: the world map, full media-narrative analysis,
the source registry, the missed-story audit, secondary publications, multi-tenancy, Stripe
and automatic publication.

## Security and data handling

- Retrieved text is untrusted evidence, never instructions.
- No secret enters the repository. `.env` is ignored; `.env.example` holds names only.
- The Excel/RSS exports, the weekly snapshot sheets and third-party article text are never
  committed. Fixtures are synthetic.
- Every record carries a data origin, `live`, `fixture` or `replay`, describing how it was
  obtained in the run. A current editorial import and a current Graph query are both live.
  Origins are never confused, and a live failure never falls back to fixture or replay data.
- Human review state and machine classification decision are separate contracts.
- The planned x402 feed is a payment gate, not access control.
- Nothing publishes automatically. A human turns every draft into the issue.
- Failures are explicit errors, never empty successes.
- Every dependency version is pinned; versions younger than 24 hours are refused, with a
  narrow documented exception process (decision D13).
- Every input boundary has a measured, versioned resource limit; oversized input is refused
  whole with a fixed error and nothing is truncated to fit (decision D27, pending audit).

Full rules: `docs/SECURITY.md` and `docs/DATA_INPUTS.md`. The threat model, risk register,
data classification, incident-response preparation and disclosure policy are the
security-foundation track's documents listed below; that track is pending an independent
audit and nothing in it is accepted.

## Documentation

| Document                                | Content                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`                  | components, runtime data flow, contract boundary, dependency rules                                                    |
| `docs/DATA_INPUTS.md`                   | editorial data, schemas, human versus machine labels, ingestion rules                                                 |
| `docs/PRIOR_INPUTS.md`                  | the pre-existing corpus, its permitted uses, and the submission disclosure                                            |
| `docs/HACKATHON_REQUIREMENTS.md`        | requirement-to-evidence matrix per sponsor track and the official schedule                                            |
| `docs/DECISIONS.md`                     | append-only decision log, D1 to D28                                                                                   |
| `docs/SPRINT-0-REPORT.md`               | Sprint 0 report, audit remediation and final correction                                                               |
| `docs/SPRINT-1-REPORT.md`               | Sprint 1 live Graph proof: discovery, selection, results, evidence                                                    |
| `docs/SPRINT-2-REPORT.md`               | Sprint 2 ingestion proof: schema, dependencies, synthetic and real imports                                            |
| `docs/SPRINT-3-REPORT.md`               | Sprint 3 classification proof: classifier, migration, calibration, evidence                                           |
| `docs/SPRINT-4-REPORT.md`               | Sprint 4 clustering proof: engine, migrations 0006 and 0007, human review layer, audit corrections                    |
| `docs/SPRINT-5-REPORT.md`               | Sprint 5 evidence proof: correlation, evidence states, anomaly feed, drafting, audit correction                       |
| `docs/CHECKIN-1-DRAFT.md`               | Project Check-in #1, submitted; owner-confirmed 8 September 2026                                                      |
| `docs/CHECKIN-2-DRAFT.md`               | Project Check-in #2 draft, due Thursday 10 September; not submitted                                                   |
| `docs/ACCOUNT_READINESS.md`             | secret-free account readiness matrix                                                                                  |
| `docs/SPRINT_BOARD.md`                  | Sprints 0 to 9 against the official schedule, the Graph gate, kill criteria                                           |
| `docs/SECURITY.md`                      | security policy                                                                                                       |
| `docs/SHEETS-INTAKE.md`                 | read-only Google Sheets intake: sharing model, Drive prohibition, editorial lineage, limits                           |
| `docs/THREAT_MODEL.md`                  | assets, boundaries, roles, entry points, flows, adversaries, abuse cases, mitigations mapped to tests, residual risks |
| `docs/RISK_REGISTER.md`                 | risks with owner, status, next action and review date                                                                 |
| `docs/DATA_CLASSIFICATION_RETENTION.md` | data classes, inventory, retention and removal                                                                        |
| `docs/INCIDENT_RESPONSE.md`             | roles, severities, triggers and runbooks                                                                              |
| `docs/MCP-TOOLING-TRACK-REPORT.md`      | MCP tooling track: server, tests, read-only proof, clean-install evidence; pending audit                              |
| `LICENSE`                               | Apache License 2.0                                                                                                    |
