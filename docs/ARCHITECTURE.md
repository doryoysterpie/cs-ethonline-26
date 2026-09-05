# Architecture

This document records the intended architecture as fixed by the Sprint 0 charter and the
audit-remediation decisions D11 to D15, and the state of each component after Sprint 0.
Where the project owner fixes something, this document says so. Where the implementer has
proposed something the owner has not fixed, it is marked **proposed** and is open to
revision.

Source note: the component list, the vertical slice, the non-goals and the decisions in
`DECISIONS.md` are the only plan material available inside the repository. No separate plan
document exists here.

## 1. Components

| Package               | Responsibility (intended)                                                                                                                                                                            | State after Sprint 0            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@cas/contracts`      | Shared types that cross package boundaries. No behaviour.                                                                                                                                            | three contracts defined, tested |
| `@cas/taxonomy`       | Incident taxonomy definitions and loaders for `data/taxonomy`.                                                                                                                                       | placeholder                     |
| `@cas/database`       | Postgres schema, migrations and typed access for imported sources, normalized records, classification decisions, the review queue, review records, incidents, evidence and drafts.                   | placeholder                     |
| `@cas/graph-evidence` | Live Graph-provider queries over the Messari standardized schema (D11), signal detection, and the provenance record of every request and response. Runs in parallel to editorial ingestion.          | placeholder                     |
| `@cas/classification` | Automated high-recall classification of every imported source into `include`, `exclude` or `review`, with recorded rationale. Calibrated and evaluated against snapshot labels, never gated by them. | placeholder                     |
| `@cas/clustering`     | Clustering included and needs-review sources into canonical incident records; attaching evidence, including corroborating Graph signals, with evidence states and complete provenance.               | placeholder                     |
| `@cas/drafting`       | Rendering the editable editorial output from canonical incidents after human review, under the naming policy (D4), to the D3 destination.                                                            | placeholder                     |
| `@cas/mcp-server`     | MCP tools exposing incident intelligence for reuse by agents and editors.                                                                                                                            | placeholder                     |
| `@cas/feed-api`       | The public incident feed, later gated by x402 (Sprint 7, conditional on the Graph gate).                                                                                                             | placeholder                     |
| `@cas/worker`         | Runs the pipeline in order: import and normalization, classification, queue routing, clustering, canonical records; and, in parallel, Graph signal correlation.                                      | placeholder, boundary test only |
| `@cas/dashboard`      | Editorial dashboard: the needs-review queue, evidence views, the review workflow that writes `ReviewState`, and drafts.                                                                              | placeholder                     |
| `@cas/sunday-agent`   | The drafting agent that drives `@cas/drafting` through the MCP tools.                                                                                                                                | placeholder                     |
| `@cas/payer-agent`    | An agent that consumes the x402-gated feed and completes a paid request (Sprint 7, conditional on the Graph gate).                                                                                   | placeholder                     |
| `data/taxonomy`       | Taxonomy data files.                                                                                                                                                                                 | empty                           |
| `data/fixtures`       | Synthetic fixtures.                                                                                                                                                                                  | empty                           |

Framework choices for the applications (for example the web framework for the dashboard and
the MCP transport for the server) are **not decided** in Sprint 0 and are not implied by the
placeholder packages. Each is decided in the sprint that builds the application.

## 2. Package ownership boundaries

- A package owns its data shapes internally and exposes across boundaries only what
  `@cas/contracts` defines.
- `@cas/database` is the only package that talks to Postgres.
- `@cas/graph-evidence` is the only package that talks to a Graph provider.
- `@cas/classification` is the only package that writes a `ClassificationDecision`. Only a
  human action, through the review workflow, writes a `ReviewState`. No component derives one
  from the other.
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
   live Graph queries → signals → corroborating evidence attached at steps 5 and 6
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

Stage by stage, with the Sprint 0 state:

1. **Import and normalization.** CSV exports from the Excel RSS workflow (D7a) enter through
   `@cas/worker` into `@cas/database`, preserving raw values, provenance and `DataOrigin`.
   Sprint 2. Not implemented.
2. **Classification.** `@cas/classification` assigns a `ClassificationDecision` with
   rationale to every imported source. Sprint 3. Not implemented.
3. **Queue.** Included sources proceed; `review` sources wait for a human; excluded sources
   are retained. Sprint 3. Not implemented.
4. **Clustering and canonical records.** `@cas/clustering` groups included and needs-review
   sources into canonical incidents with member lists and evidence states whose provenance
   chain reaches back to source rows. Sprint 4. Not implemented.
5. **Graph correlation.** `@cas/graph-evidence` queries live provider-backed data over the
   standardized schema for the chosen chains (D11), emits signals, and `@cas/clustering`
   attaches them as corroborating evidence with request, response and block context.
   Sprints 1 and 5. Not implemented.
6. **Review and editorial output.** `@cas/dashboard` presents the queue, evidence views and
   canonical incidents; the review workflow writes `ReviewState`; `@cas/drafting` renders an
   editable draft to the D3 destination with the evidence state visible beside every claim
   and the naming policy (D4) applied. Sprint 6. Not implemented.
7. **Exposure.** `@cas/mcp-server` exposes tools over the incident store; `@cas/feed-api`
   serves the public metadata allowlist (D6). Sprints 6 and 7. Not implemented.

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

Sprint 0 contents of `@cas/contracts`:

| Export                   | Values                               | Meaning                                                           | Fixed by                                |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| `ReviewState`            | `selected`, `rejected`, `unreviewed` | human review state from a versioned review record                 | project owner's data-flow clarification |
| `ClassificationDecision` | `include`, `exclude`, `review`       | machine decision of the automated classifier, with rationale      | decision D15                            |
| `DataOrigin`             | `live`, `fixture`, `replay`          | execution and data context of a record, independent of its source | section 7 below                         |

The contract tests in `packages/contracts/src/index.test.ts` pin the three value sets and
prove that the two decision enums share no value and are distinct types. Incident, signal,
evidence-state, source-kind and feed-response contracts arrive with the sprints that produce
them.

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

**Declared edges after Sprint 0:** one. `@cas/worker` depends on `@cas/contracts`, and its
test exercises that edge. Every other edge above is **proposed** and is declared in a package
manifest only when code that needs it lands. Declaring edges ahead of code was avoided so
that the manifests never claim a relationship the code does not have.

## 6. Placeholders after Sprint 0

Every package except `@cas/contracts` is a placeholder: a manifest, a TypeScript
configuration and one source file that exports nothing. A placeholder proves that the
workspace, the compiler and the task graph reach that package. It proves nothing else and
must not be described as a feature.

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

## 8. Toolchain (Sprint 0, implementation-level and reversible)

| Concern         | Choice                                                | Class              |
| --------------- | ----------------------------------------------------- | ------------------ |
| Package manager | pnpm 11.10.0, pinned in `packageManager`              | cost judgment      |
| Task runner     | Turborepo 2.10.12                                     | charter            |
| Language        | TypeScript 6.0.3, `NodeNext` modules, strict          | compatibility need |
| Lint            | ESLint 10.9.1 flat config with typescript-eslint 8.69 | preference         |
| Format          | Prettier 3.9.6                                        | preference         |
| Tests           | Vitest 4.1.11                                         | preference         |
| Package pattern | compiled packages: `exports` point to `dist`          | cost judgment      |

TypeScript is held below 6.1 because typescript-eslint 8.69.0 declares that peer range and
the 7.x line is the new native compiler. `typecheck` and `test` depend on `^build` in
`turbo.json` so that consumers see their dependencies' emitted declarations.
