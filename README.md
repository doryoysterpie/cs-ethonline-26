# Cyberattack Sunday: Onchain Incident Intelligence

Working product name: **CAS Chainwatch**. Repository: `doryoysterpie/cs-ethonline-26`.
Licence: Apache License 2.0 (`LICENSE`).

An ETHOnline 2026 project that imports the current cybersecurity news feed, classifies it
automatically with high recall into an include, exclude or needs-review queue, clusters the
result into canonical incidents with explicit evidence states and complete provenance,
attaches corroborating onchain signals from live The Graph data, and gives a human an
editable draft of the weekly Cyberattack Sunday issue, exposed through reusable MCP tooling.

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

**Sprint 0: foundation and audit remediation, pending independent audit.** The repository
holds a buildable pnpm and Turborepo TypeScript monorepo, continuous integration and the
project charter documents. It holds no features. Every workspace package except
`@cas/contracts` is an explicit placeholder that compiles to an empty module. No importer,
classifier, clustering logic, Graph query, drafting logic, payment code or dashboard exists
yet. Live integrations begin in Sprint 1 (`docs/SPRINT_BOARD.md`).

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
product is not required (decision D11). Items 1 to 6 must pass the Graph release gate at the
end of 10 September. Hedera AI and Agentic Payments (x402) and the Bazantic recipe tracks are
attempted in Sprint 7 only if that gate passes and time allows; otherwise they are dropped.
Requirement status per track is in `docs/HACKATHON_REQUIREMENTS.md`.

## Monorepo layout

| Path                      | Package               | State after Sprint 0                          |
| ------------------------- | --------------------- | --------------------------------------------- |
| `apps/dashboard`          | `@cas/dashboard`      | placeholder                                   |
| `apps/worker`             | `@cas/worker`         | placeholder, one workspace-boundary test      |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                                   |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 7 conditional on the gate |
| `packages/contracts`      | `@cas/contracts`      | three shared type contracts, tested           |
| `packages/database`       | `@cas/database`       | placeholder                                   |
| `packages/taxonomy`       | `@cas/taxonomy`       | placeholder                                   |
| `packages/classification` | `@cas/classification` | placeholder                                   |
| `packages/clustering`     | `@cas/clustering`     | placeholder                                   |
| `packages/graph-evidence` | `@cas/graph-evidence` | placeholder                                   |
| `packages/mcp-server`     | `@cas/mcp-server`     | placeholder                                   |
| `packages/drafting`       | `@cas/drafting`       | placeholder                                   |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                                   |
| `data/taxonomy`           |                       | reserved, empty                               |
| `data/fixtures`           |                       | reserved, empty, synthetic fixtures only      |
| `docs`                    |                       | charter documents, listed below               |

A placeholder package contains one source file that exports nothing. The intended
responsibility of each package is in `docs/ARCHITECTURE.md`.

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

| Document                         | Content                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`           | components, runtime data flow, contract boundary, dependency rules         |
| `docs/DATA_INPUTS.md`            | editorial data, schemas, human versus machine labels, ingestion rules      |
| `docs/PRIOR_INPUTS.md`           | the pre-existing corpus, its permitted uses, and the submission disclosure |
| `docs/HACKATHON_REQUIREMENTS.md` | requirement-to-evidence matrix per sponsor track and the official schedule |
| `docs/DECISIONS.md`              | append-only decision log, D1 to D15                                        |
| `docs/ACCOUNT_READINESS.md`      | secret-free account readiness matrix                                       |
| `docs/SPRINT_BOARD.md`           | Sprints 0 to 9 against the official schedule, gates and kill criteria      |
| `docs/SECURITY.md`               | security policy                                                            |
| `docs/SPRINT-0-REPORT.md`        | Sprint 0 report and audit remediation for the independent audit            |
| `LICENSE`                        | Apache License 2.0                                                         |
