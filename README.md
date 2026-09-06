# Cyberattack Sunday: Onchain Incident Intelligence

Working product name: **CAS Chainwatch**. Repository: `doryoysterpie/cs-ethonline-26`.
Licence: Apache License 2.0 (`LICENSE`).

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

**Sprint 1 corrected after audit, pending re-audit: the live Graph proof passes on
provider-validated evidence.** On 5 September 2026 at 23:03 America/Toronto, one common
standardized GraphQL query, run by `@cas/graph-evidence` against The Graph gateway, returned
live data for five Ethereum lending deployments at block 25915485. The gate validated each
response's provider-returned network, protocol type, schema version and deployment against
the registry's declared expectations, counted five distinct provider identities, subgraph IDs
and deployment IDs, and computed a deterministic 24-hour TVL-delta signal for each with
complete provenance. Both Base targets passed the same validation at block 50937221, so Base
is kept as the secondary chain with thin coverage (`docs/SPRINT-1-REPORT.md`, decisions D17
and D18).

Everything else is still a placeholder. No importer, classifier, clustering logic, drafting
logic, payment code or dashboard exists yet (`docs/SPRINT_BOARD.md`).

## Build sequence and the Graph gate

| Sprint | Dates (Sept) | Scope                                                                                                 |
| ------ | ------------ | ----------------------------------------------------------------------------------------------------- |
| 1      | 5            | live Graph provider proof, Messari standardized-schema spike, Ethereum mandatory, Base four-hour gate |
| 2      | 5 to 6       | Postgres schema, editorial-feed import, normalization, provenance                                     |
| 3      | 6 to 7       | high-recall classification, review queue, Check-in #1                                                 |
| 4      | 7 to 8       | clustering, canonical incidents, Graph correlation, evidence-state resolver, anomaly feed             |
| 5      | 8 to 9       | drafting pipeline, live crypto section, fixed historical draft                                        |
| 6      | 9 to 10      | Next.js dashboard, review workflow, draft editor, MCP server, `SKILL.md`, Check-in #2, Graph gate     |
| 7      | 10 to 11     | holdout evaluation, fixtures, clean-install verification, Graph-track hardening                       |
| 8      | 11 to 12     | conditional Hedera and Bazantic work; feature freeze 12 September at 12:00 PM                         |
| 9      | 12 to 13     | videos, submission documentation, final checks, submission before 13 September at 12:00 PM            |

At the Graph release gate at the end of 10 September, six deliverables must be complete and
demonstrable, not in progress: live Graph anomaly detection, editorial connection,
clustering, evidence states and provenance, an editable draft, and reusable MCP tooling with
`SKILL.md` and clean installation. If the gate fails, Hedera and Bazantic are dropped and
Sprints 7 and 8 finish and harden the Graph submission (decision D16).

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

## Sponsor-track priority

The Graph tracks come first. For the standardized-data track the primary route is meaningful
use of the Messari standardized schema over live provider-backed data; a second Graph
product is not required (decision D11). Hedera AI and Agentic Payments (x402) and the
Bazantic recipe tracks are attempted in Sprint 8 only if the Graph gate passes and time
allows; otherwise they are dropped. Requirement status per track is in
`docs/HACKATHON_REQUIREMENTS.md`.

## Monorepo layout

| Path                      | Package               | State after Sprint 1                                                                      |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `apps/dashboard`          | `@cas/dashboard`      | placeholder; Next.js command center, built in Sprint 6                                    |
| `apps/worker`             | `@cas/worker`         | placeholder, one workspace-boundary test                                                  |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                                                                               |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 8 conditional on the gate                                             |
| `packages/contracts`      | `@cas/contracts`      | three enums, the chain set and the Graph evidence contracts; five tests                   |
| `packages/database`       | `@cas/database`       | placeholder                                                                               |
| `packages/taxonomy`       | `@cas/taxonomy`       | placeholder                                                                               |
| `packages/classification` | `@cas/classification` | placeholder                                                                               |
| `packages/clustering`     | `@cas/clustering`     | placeholder                                                                               |
| `packages/graph-evidence` | `@cas/graph-evidence` | implemented: live gateway client, adapter, TVL delta, identity gate, probe; 80 unit tests |
| `packages/mcp-server`     | `@cas/mcp-server`     | placeholder                                                                               |
| `packages/drafting`       | `@cas/drafting`       | placeholder                                                                               |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                                                                               |
| `data/taxonomy`           |                       | reserved, empty                                                                           |
| `data/fixtures`           |                       | reserved, empty, synthetic fixtures only                                                  |
| `docs`                    |                       | charter documents and sprint reports, listed below                                        |

A placeholder package contains one source file that exports nothing. The intended
responsibility of each package is in `docs/ARCHITECTURE.md`. Next.js is fixed by the plan for
the dashboard and is not installed before Sprint 6.

## Local installation and verification

Requirements: Node 24 (`.nvmrc`) and pnpm 11.10.0, pinned in the `packageManager` field of
`package.json`. `corepack pnpm` runs the pinned version without a global install.

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

`corepack pnpm verify` runs the five checks in that order. Continuous integration
(`.github/workflows/ci.yml`) runs the same sequence on every push to `main` or a `sprint-*`
branch and on every pull request. None of these steps touches the network or needs a secret.
Set `TURBO_TELEMETRY_DISABLED=1` to silence Turborepo telemetry locally.

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
prints the field, the expected value and the received value. Detailed output goes only to
`output/graph-probe/`, which Git ignores. Exit code 0 means the Ethereum gate passed on five
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

## Audit policy

Claude implements on sprint branches. Codex independently reviews diffs, installs locked
dependencies when appropriate, and reruns verification. Neither agent merges to `main`
without the project owner's instruction.

## Live integrations

The Graph is live as of Sprint 1. Nothing in this repository talks to Anthropic, Postgres,
Hedera, an x402 facilitator or Bazantic yet. `.env.example` declares only the variable names
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

Full rules: `docs/SECURITY.md` and `docs/DATA_INPUTS.md`.

## Documentation

| Document                         | Content                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`           | components, runtime data flow, contract boundary, dependency rules          |
| `docs/DATA_INPUTS.md`            | editorial data, schemas, human versus machine labels, ingestion rules       |
| `docs/PRIOR_INPUTS.md`           | the pre-existing corpus, its permitted uses, and the submission disclosure  |
| `docs/HACKATHON_REQUIREMENTS.md` | requirement-to-evidence matrix per sponsor track and the official schedule  |
| `docs/DECISIONS.md`              | append-only decision log, D1 to D17                                         |
| `docs/ACCOUNT_READINESS.md`      | secret-free account readiness matrix                                        |
| `docs/SPRINT_BOARD.md`           | Sprints 0 to 9 against the official schedule, the Graph gate, kill criteria |
| `docs/SECURITY.md`               | security policy                                                             |
| `docs/SPRINT-0-REPORT.md`        | Sprint 0 report, audit remediation and final correction                     |
| `docs/SPRINT-1-REPORT.md`        | Sprint 1 live Graph proof: discovery, selection, results, evidence          |
| `LICENSE`                        | Apache License 2.0                                                          |
