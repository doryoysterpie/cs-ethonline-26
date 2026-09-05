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

**Sprint 0: foundation, audit remediation and final correction, pending independent
audit.** The repository holds a buildable pnpm and Turborepo TypeScript monorepo, continuous
integration and the project charter documents. It holds no features. Every workspace package
except `@cas/contracts` is an explicit placeholder that compiles to an empty module. No
importer, classifier, clustering logic, Graph query, drafting logic, payment code or
dashboard exists yet. Live integrations begin in Sprint 1 (`docs/SPRINT_BOARD.md`).

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

| Path                      | Package               | State after Sprint 0                                   |
| ------------------------- | --------------------- | ------------------------------------------------------ |
| `apps/dashboard`          | `@cas/dashboard`      | placeholder; Next.js command center, built in Sprint 6 |
| `apps/worker`             | `@cas/worker`         | placeholder, one workspace-boundary test               |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                                            |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 8 conditional on the gate          |
| `packages/contracts`      | `@cas/contracts`      | three shared type contracts, four tests                |
| `packages/database`       | `@cas/database`       | placeholder                                            |
| `packages/taxonomy`       | `@cas/taxonomy`       | placeholder                                            |
| `packages/classification` | `@cas/classification` | placeholder                                            |
| `packages/clustering`     | `@cas/clustering`     | placeholder                                            |
| `packages/graph-evidence` | `@cas/graph-evidence` | placeholder                                            |
| `packages/mcp-server`     | `@cas/mcp-server`     | placeholder                                            |
| `packages/drafting`       | `@cas/drafting`       | placeholder                                            |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                                            |
| `data/taxonomy`           |                       | reserved, empty                                        |
| `data/fixtures`           |                       | reserved, empty, synthetic fixtures only               |
| `docs`                    |                       | charter documents, listed below                        |

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
branch and on every pull request. Set `TURBO_TELEMETRY_DISABLED=1` to silence Turborepo
telemetry locally.

## Audit policy

Claude implements on sprint branches. Codex independently reviews diffs, installs locked
dependencies when appropriate, and reruns verification. Neither agent merges to `main`
without the project owner's instruction.

## Live integrations begin in later sprints

Nothing in this repository talks to The Graph, Anthropic, Postgres, Hedera, an x402
facilitator or Bazantic yet. `.env.example` declares only the two variable names an existing
architectural need already fixes; every other configuration category is listed there without
a name until the sprint that introduces it.

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
  Origins are never confused.
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
| `docs/DECISIONS.md`              | append-only decision log, D1 to D16                                         |
| `docs/ACCOUNT_READINESS.md`      | secret-free account readiness matrix                                        |
| `docs/SPRINT_BOARD.md`           | Sprints 0 to 9 against the official schedule, the Graph gate, kill criteria |
| `docs/SECURITY.md`               | security policy                                                             |
| `docs/SPRINT-0-REPORT.md`        | Sprint 0 report, audit remediation and final correction                     |
| `LICENSE`                        | Apache License 2.0                                                          |
