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

**`main` holds the hackathon submission plus the post-event plan.** The weekly product is being
built as nine Technical Capability Units, CAS-001 to CAS-009, admitted to the sprint tracker
SPRINT-P1 (issue 13) on 21 October 2026 (`docs/POST-EVENT-PLAN.md`; one tracker per unit under
`docs/tcu/`; live status on the units' issues). The audit state of every track and production
commit is recorded in `docs/AUDIT-LEDGER.md`, and the short version is this: Sprints 0 to 4
were accepted by an independent reviewer; everything after Sprint 4, including the code the
deployed dashboard runs, is **not audited** in those words until a reviewer says otherwise.

**What runs on `main`.** Editorial ingestion from CSV (Sprint 2), a deterministic high-recall
classifier (Sprint 3, D21), deterministic clustering into provisional incidents with a human
merge-and-split layer (Sprint 4, D22), the Graph evidence, anomaly and deterministic drafting
layer (Sprint 5, corrected under D26 and not re-audited), the passwordless dashboard with
PostgreSQL persistence (migrations 0010 and 0011), the read-only Sheets connector, the MCP
tooling, and the security foundation's limits, CI jobs and supply-chain checks. The
dependency advisories the supply-chain gate reported on 21 October 2026 are closed (D29
amendment of 22 October 2026).

**Sprint 5, stated exactly.** The evidence, anomaly and drafting layer was corrected under D26
after its independent review and is not re-audited; no document may read as saying otherwise
(`docs/SPRINT-5-REPORT.md`, section 16). Its rules stand as written: a file can be ingested as
fixture or replay only; live evidence comes from the Graph client, never from a file; a claim
is a record, not a UUID. Migrations 0001 to 0022 are applied by the deploy step before the
dashboard serves traffic.

**What is on `main`, and what is in review.** Four post-event units merged on 22 October
2026, each at a head an independent review passed. CAS-001, the living feed imported from the
authorized Google Sheets workbook, at `9c03a35` after a PASS at `2ad714d`; its first real
import into the hosted database follows, the database having been recreated and `main`
redeployed on 22 October 2026 after the Railway platform incident of 21 to 22 October
(`docs/INCIDENT_RESPONSE.md`, section 7; `docs/RUNBOOK-HOSTING.md`).
CAS-002, one classification run per category bound to a policy registry (migration 0013), at
`b4c8270`, with its second correction at `592d3bc` after a PASS at `2c87946`
(`docs/CAS-002-REPORT.md`, section 7). CAS-006's release-blocker corrections: pull request 17
at `355e773`, passed at `e19449e`; pull request 18 at `c32c963`, passed at `32e1357`
(`docs/CAS-006-REPORT.md`). CAS-003, the editorial week as one command with its manifest and
the sift table where the owner selects stories per incident (migration 0014, `week run`,
`select:stories`), at `bda4303` after four review rounds and a PASS at `048e673`
(`docs/CAS-003-REPORT.md`). The Next.js advisories of the same day closed at `5d583f4`
(pull request 25). Every verdict names its head in `docs/AUDIT-LEDGER.md`.

CAS-004, the round-up generated through the rundown template and edited by the owner
(migration 0015, `@cas/roundup`, the `owner` role), merged at `6f25fb0` after four review rounds
and a PASS at `fcdf88c` (`docs/CAS-004-REPORT.md`, section 7).

Merged into `main` on 22 October 2026 as one train, before independent review; the combined
audit of `main` at `881d5a3` returned CHANGES REQUIRED on 23 October 2026 (seven findings,
`docs/AUDIT-LEDGER.md`), corrected with tests on pull request 33, which passed its re-review at
`8f06193` and merged on 23 October 2026: CAS-005, the article written
from the full sources behind the system's first outbound fetch under the fetch policy adopted as
D36 (migration 0016, `@cas/source-reader`, `@cas/article`), on pull request 26
(`docs/CAS-005-REPORT.md`); CAS-007, reader sign-up with owner approval, the `reader` role in
place of `judge`, the published mark and scrape protection (migration 0017), on pull request 27
(`docs/CAS-007-REPORT.md`); CAS-008, the supporter tier through Stripe's hosted Checkout and
signed webhooks, with the pinned donation page (migration 0018, `qrcode-generator`), on pull
request 28 (`docs/CAS-008-REPORT.md`).

Merged into `main` from 24 to 26 October 2026 with no PASS; one combined audit of `main` at
`8105678` is pending (`docs/AUDIT-LEDGER.md`): the Zod advisory, on pull request 37; CAS-010, the
dashboard's terminal grid under D47, on pull request 34 (`docs/CAS-010-REPORT.md`); the browser
harness brought to the passwordless sign-in, on pull request 36; CAS-009, shareable story cards
under D48 (migrations 0021 and 0022), on pull request 35 (`docs/CAS-009-REPORT.md`); and the
bounded readiness endpoint, on pull request 50.

**What the product is for.** The owner's weekly flow: the feed read from Google Sheets, every
story classified by category, a sift table where the owner selects stories, a round-up
generated through the rundown template, edited by the owner and pasted into Substack by the
owner. Then an article written from the full sources, reader access with owner approval, a
supporter tier with crypto donations, and shareable story cards, in that order. The hackathon
sections below are kept as the record of how the code came to exist.

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
database import path on the hackathon branches by design. CAS-001 of the post-event
plan adds one (`sheets import --tab`), gated by a committed tab map
(`data/policy/sheets-tab-map.json`): a tab the map does not declare is refused
(`docs/RUNBOOK-WEEKLY-IMPORT.md`). The workbook's weekly tabs record candidate
selections, not published outcomes, and are not evaluation truth until each is
paired with its published edition (`docs/SHEETS-INTAKE.md`). **This track has
not been audited.** The service account exists and the workbook digest is pinned;
live inventory, timestamp and dry-run reads were run on 16 September 2026, and the
import command was run against the live workbook into a local database on 21 October
2026 (`docs/CAS-001-REPORT.md`).

## Monorepo layout

| Path                      | Package               | State after integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard`          | `@cas/dashboard`      | Next.js command center, built in Sprint 6, passwordless login; from CAS-003 the editorial week pages and the per-incident selection under `select:stories`; from CAS-004 the round-up page, generation and editing under the `owner` role, and the one model transport; from CAS-005 the article page with the reading stage and the one Node transport of the source reader; from CAS-010 the terminal grid: the shell, the status block and the section blocks; from CAS-009 the story cards: the share list on the published page, the public card page and its images; from CAS-007 reader sign-up with owner approval, the published pages and the limits; from CAS-008 the support and donation pages and the Stripe webhook endpoint |
| `apps/worker`             | `@cas/worker`         | implemented: CSV validation, import, classification, clustering, evidence, claim, anomaly and drafting commands; import limits and a command deadline; `sheets import` (CAS-001) and `week run`, the editorial week as one command recording a manifest (CAS-003)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 8 conditional on the gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/contracts`      | `@cas/contracts`      | editorial and import enums, the chain set, the Graph evidence contracts and the versioned resource limits (`resource-limits@1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/database`       | `@cas/database`       | implemented: migration runner, seventeen migrations, ingestion, classification, clustering, evidence and claim ops, Sheets provenance, run categories, the editorial week (manifest, children, selections), the round-up and article revisions, the model ledger, sign-up requests and the published mark                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/roundup`        | `@cas/roundup`        | CAS-004: the rundown template, slot schema, prompt contract, deterministic rendering, response validation and cost rules; pure, no socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/source-reader`  | `@cas/source-reader`  | CAS-005: the fetch policy of `docs/FETCH-POLICY.md` over an injected transport and resolver, `robots.txt`, bounded bodies, text extraction; the one Node transport apart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/article`        | `@cas/article`        | CAS-005: the article contract, input from a reading, slot schema, prompt contract (D41, D4), validation against the selection as read, Markdown export, cost rules; pure, no socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/taxonomy`       | `@cas/taxonomy`       | versioned classification signal policy and, from CAS-002, one category policy per category (`cyberattack`, `crypto`). Incident taxonomy: future work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/classification` | `@cas/classification` | implemented: deterministic high-recall classifier and calibration evaluator; from CAS-002, one built contract per category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/clustering`     | `@cas/clustering`     | implemented: deterministic duplicate, syndication and incident grouping (D22)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/evidence`       | `@cas/evidence`       | implemented: correlation, evidence-state resolution and the anomaly feed (D25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/graph-evidence` | `@cas/graph-evidence` | implemented: live gateway client with streaming body and JSON shape limits, adapter, TVL delta, identity gate, probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/mcp-server`     | `@cas/mcp-server`     | parallel MCP tooling track (D29): four read-only tools over local stdio; candidate rejected by audit, corrections integrated, pending re-audit; 208 offline tests, 49 PostgreSQL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/sheets-intake`  | `@cas/sheets-intake`  | read-only, file-scoped Google Sheets intake; no Drive API, no write scope, no SDK; pinned, with an import command gated by a committed tab map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/drafting`       | `@cas/drafting`       | implemented: deterministic draft assembly and provenance sidecar (D25). No model is called                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `data/taxonomy`           |                       | reserved, still empty; the signal policy lives in code, not here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `data/fixtures`           |                       | synthetic editorial CSV fixtures and synthetic evidence replay fixtures (`data/fixtures/README.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tools`                   |                       | `checks/` (hygiene, forbidden-file, secret, workflow and toolchain scans; Linux network denial) and `supply-chain/` (bill of materials generator); two sandbox profiles and a probe for proving the default suite is offline: `offline-sandbox.sb` denies all network access and carries every package and every MCP file but one (`corepack pnpm test:denied`); `loopback-sandbox.sb` additionally permits addresses assigned to this machine, loopback and local-interface alike, and carries only `redirect.stdio.test.ts` (`corepack pnpm test:localhost`); `sandbox-probe.mjs` reports what either profile actually allows (`corepack pnpm sandbox:probe`)                                                                             |
| `supply-chain`            |                       | the committed CycloneDX 1.6 bill of materials and licence inventory, reproduced byte for byte in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs`                    |                       | charter documents, security documents and sprint reports, listed below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
corepack pnpm --filter @cas/dashboard provision --username <name> --role <reader|editor|admin|owner> --expires-at <instant>
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

| Document                                  | Content                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`                    | components, runtime data flow, contract boundary, dependency rules                                                                |
| `docs/DATA_INPUTS.md`                     | editorial data, schemas, human versus machine labels, ingestion rules                                                             |
| `docs/PRIOR_INPUTS.md`                    | the pre-existing corpus, its permitted uses, and the submission disclosure                                                        |
| `docs/HACKATHON_REQUIREMENTS.md`          | requirement-to-evidence matrix per sponsor track and the official schedule                                                        |
| `docs/DECISIONS.md`                       | append-only decision log, D1 to D36                                                                                               |
| `docs/AUDIT-LEDGER.md`                    | one row per track and production commit: exact commit, reviewer, verdict in the reviewer's words, date, record                    |
| `docs/SPRINT-0-REPORT.md`                 | Sprint 0 report, audit remediation and final correction                                                                           |
| `docs/SPRINT-1-REPORT.md`                 | Sprint 1 live Graph proof: discovery, selection, results, evidence                                                                |
| `docs/SPRINT-2-REPORT.md`                 | Sprint 2 ingestion proof: schema, dependencies, synthetic and real imports                                                        |
| `docs/SPRINT-3-REPORT.md`                 | Sprint 3 classification proof: classifier, migration, calibration, evidence                                                       |
| `docs/SPRINT-4-REPORT.md`                 | Sprint 4 clustering proof: engine, migrations 0006 and 0007, human review layer, audit corrections                                |
| `docs/SPRINT-5-REPORT.md`                 | Sprint 5 evidence proof: correlation, evidence states, anomaly feed, drafting, audit correction                                   |
| `docs/CHECKIN-1-DRAFT.md`                 | Project Check-in #1, submitted; owner-confirmed 8 September 2026                                                                  |
| `docs/CHECKIN-2-DRAFT.md`                 | Project Check-in #2 draft, due Thursday 10 September; not submitted                                                               |
| `docs/ACCOUNT_READINESS.md`               | secret-free account readiness matrix                                                                                              |
| `docs/SPRINT_BOARD.md`                    | Sprints 0 to 9 against the official schedule, the Graph gate, kill criteria                                                       |
| `docs/SECURITY.md`                        | security policy                                                                                                                   |
| `docs/SHEETS-INTAKE.md`                   | read-only Google Sheets intake: sharing model, Drive prohibition, editorial lineage, limits                                       |
| `docs/RUNBOOK-WEEKLY-IMPORT.md`           | the weekly Sheets import: the command, what it needs, what it prints, exit codes                                                  |
| `docs/CAS-001-REPORT.md`                  | CAS-001 report: design note, reference implementation, import path, local run                                                     |
| `docs/CAS-004-REPORT.md`                  | CAS-004 report: the round-up design note, prompt contract, migration 0015, the model boundary, tests, verification                |
| `docs/CAS-005-REPORT.md`                  | CAS-005 report: the fetch policy adopted with measured bounds, the article contract, migration 0016, the reader, tests            |
| `docs/CAS-007-REPORT.md`                  | CAS-007 report: reader sign-up with owner approval, the reader role, the published mark, limits and robots.txt, migration 0017    |
| `docs/CAS-008-REPORT.md`                  | CAS-008 report: the supporter tier through Stripe's hosted Checkout and signed webhooks, the pinned donation page, migration 0018 |
| `docs/THREAT_MODEL.md`                    | assets, boundaries, roles, entry points, flows, adversaries, abuse cases, mitigations mapped to tests, residual risks             |
| `docs/RISK_REGISTER.md`                   | risks with owner, status, next action and review date                                                                             |
| `docs/DATA_CLASSIFICATION_RETENTION.md`   | data classes, inventory, retention and removal                                                                                    |
| `docs/INCIDENT_RESPONSE.md`               | roles, severities, triggers and runbooks                                                                                          |
| `docs/MCP-TOOLING-TRACK-REPORT.md`        | MCP tooling track: server, tests, read-only proof, clean-install evidence; pending audit                                          |
| `docs/SECURITY-FOUNDATION-REPORT.md`      | security-foundation track: resource limits, CI database, toolchain pins, bill of materials; pending audit                         |
| `docs/SPRINT-6-DASHBOARD-AUTH-HANDOFF.md` | dashboard and authentication track: design, interpretation choices, known limitations; pending audit                              |
| `docs/VULNERABILITY_DISCLOSURE.md`        | how to report a vulnerability privately, scope and safe harbour                                                                   |
| `docs/RELEASE-INTEGRATION-REPORT.md`      | Latest in Cyber release integration: merges, reconciliation, verification, security review, production blockers                   |
| `docs/POST-EVENT-PLAN.md`                 | post-event plan: the product after the hackathon, the TCU definition and standard steps, nine units, open questions               |
| `docs/FETCH-POLICY.md`                    | proposed contract for fetching source pages: rules, reason codes, threat-model rows, required tests, owner decisions              |
| `docs/tcu/CAS-001.md` to `CAS-009.md`     | one tracker per unit: steps in order, standard steps, acceptance, evidence record, walk-through log                               |
| `LICENSE`                                 | Apache License 2.0                                                                                                                |
| `docs/RUNBOOK-HOSTING.md`                 | the hosted service on Railway: what runs, the variables, the rebuild after a provider incident, the plan, the proxy               |
| `docs/CAS-010-REPORT.md`                  | CAS-010 report: the dashboard's terminal grid, the S0 design note against D47 and the decisions it raises                         |
| `docs/CAS-009-REPORT.md`                  | CAS-009 report: shareable story cards under D6, D42 and D48: the design, the stack check, migration 0021, the build               |
