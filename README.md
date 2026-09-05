# Cyberattack Sunday: Onchain Incident Intelligence

Working product name: **CAS Chainwatch**. Repository: `doryoysterpie/cs-ethonline-26`.

An ETHOnline 2026 project that detects onchain anomalies through live The Graph data,
connects those signals to the cybersecurity reporting behind them, clusters that reporting
into canonical incidents with explicit evidence states and complete provenance, and produces
an editable draft of the weekly Cyberattack Sunday issue, exposed through reusable MCP
tooling.

## Event window

ETHOnline 2026, 4 to 16 September 2026 as recorded in the project charter, entered as a
Start Fresh project. The event's rules page states a submission deadline of 13 September
2026 at 12:00 EDT; that conflict is flagged for the project owner in
`docs/HACKATHON_REQUIREMENTS.md`. All project code begins on or after 4 September 2026. The pre-existing Cyberattack Sunday corpus is input
data, not project code, and is never committed (`docs/PRIOR_INPUTS.md`).

## Current status

**Sprint 0 complete: foundation only.** The repository holds a buildable pnpm and Turborepo
TypeScript monorepo, continuous integration and the project charter documents. It holds no
features. Every workspace package except `@cas/contracts` is an explicit placeholder that
compiles to an empty module. No Graph query, classifier, clustering logic, drafting logic,
payment code or dashboard exists yet. Live integrations begin in Sprint 1
(`docs/SPRINT_BOARD.md`).

## The vertical slice

1. Detect chain anomalies from live The Graph data.
2. Connect those signals to cybersecurity reporting.
3. Cluster reporting into canonical incidents.
4. Assign evidence states with complete provenance.
5. Generate an editable Cyberattack Sunday draft.
6. Expose the intelligence through reusable MCP tooling.
7. Add Hedera x402 and Bazantic integrations, only after the Graph release candidate passes
   its gate.

## Sponsor-track priority

The Graph tracks come first. Items 1 to 6 must pass the Graph release gate at the end of
10 September. Hedera AI and Agentic Payments (x402) and the Bazantic recipe tracks are
attempted only if that gate passes; otherwise they are dropped. Requirement status per track
is tracked in `docs/HACKATHON_REQUIREMENTS.md`.

## Monorepo layout

| Path                      | Package               | State after Sprint 0                     |
| ------------------------- | --------------------- | ---------------------------------------- |
| `apps/dashboard`          | `@cas/dashboard`      | placeholder                              |
| `apps/worker`             | `@cas/worker`         | placeholder, one workspace-boundary test |
| `apps/sunday-agent`       | `@cas/sunday-agent`   | placeholder                              |
| `apps/payer-agent`        | `@cas/payer-agent`    | placeholder, Sprint 8 at the earliest    |
| `packages/contracts`      | `@cas/contracts`      | two shared type contracts, tested        |
| `packages/database`       | `@cas/database`       | placeholder                              |
| `packages/taxonomy`       | `@cas/taxonomy`       | placeholder                              |
| `packages/classification` | `@cas/classification` | placeholder                              |
| `packages/clustering`     | `@cas/clustering`     | placeholder                              |
| `packages/graph-evidence` | `@cas/graph-evidence` | placeholder                              |
| `packages/mcp-server`     | `@cas/mcp-server`     | placeholder                              |
| `packages/drafting`       | `@cas/drafting`       | placeholder                              |
| `packages/feed-api`       | `@cas/feed-api`       | placeholder                              |
| `data/taxonomy`           |                       | reserved, empty                          |
| `data/fixtures`           |                       | reserved, empty, synthetic fixtures only |
| `docs`                    |                       | charter documents, listed below          |

A placeholder package contains one source file that exports nothing. The intended
responsibility of each package is in `docs/ARCHITECTURE.md`.

## Local installation and verification

Requirements: Node 24 (`.nvmrc`) and pnpm 11.10.0, pinned in the `packageManager` field of
`package.json`. `corepack enable` installs the pinned pnpm.

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm format:check
```

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

`pnpm verify` runs the five checks in that order. Continuous integration
(`.github/workflows/ci.yml`) runs the same sequence on every push to `main` or a `sprint-*`
branch and on every pull request. Set `TURBO_TELEMETRY_DISABLED=1` to silence Turborepo
telemetry locally.

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
- Live, fixture and replay data carry an explicit origin and are never confused.
- The planned x402 feed is a payment gate, not access control.
- Nothing publishes automatically. A human turns every draft into the issue.
- Failures are explicit errors, never empty successes.

Full rules: `docs/SECURITY.md` and `docs/DATA_INPUTS.md`.

## Documentation

| Document                         | Content                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`           | components, data flow, contract boundary, dependency rules     |
| `docs/DATA_INPUTS.md`            | editorial data flow, schemas, label semantics, ingestion rules |
| `docs/PRIOR_INPUTS.md`           | the pre-existing corpus and what may enter the repository      |
| `docs/HACKATHON_REQUIREMENTS.md` | requirement-to-evidence matrix per sponsor track               |
| `docs/DECISIONS.md`              | append-only decision log, D1 to D10                            |
| `docs/ACCOUNT_READINESS.md`      | secret-free account readiness matrix                           |
| `docs/SPRINT_BOARD.md`           | Sprints 0 to 9, gates and kill criteria                        |
| `docs/SECURITY.md`               | security policy                                                |
| `docs/SPRINT-0-REPORT.md`        | Sprint 0 report for the independent audit                      |
