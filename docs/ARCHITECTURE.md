# Architecture

This document records the intended architecture from Plan 2.0 as supplied in the Sprint 0
charter, and the state of each component after Sprint 0. Where the charter fixes something,
this document says so. Where the implementer has proposed something the charter does not fix,
it is marked **proposed** and is open to the project owner's revision.

Source note: the component list, the vertical slice, the non-goals and the decisions D1 to
D10 are the only Plan 2.0 material available inside the repository. No separate Plan 2.0
document exists here.

## 1. Components

| Package               | Responsibility (intended)                                                                                             | State after Sprint 0            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@cas/contracts`      | Shared types that cross package boundaries. No behaviour.                                                             | two contracts defined, tested   |
| `@cas/taxonomy`       | Incident taxonomy definitions and loaders for `data/taxonomy`.                                                        | placeholder                     |
| `@cas/database`       | Postgres schema, migrations and typed access for sources, review records, signals, incidents, evidence and drafts.    | placeholder                     |
| `@cas/graph-evidence` | Live The Graph queries, anomaly signal detection and the provenance record of every response.                         | placeholder                     |
| `@cas/classification` | Linking chain signals to selected reporting and assigning classification with a model, under the review-state rules.  | placeholder                     |
| `@cas/clustering`     | Clustering selected sources and signals into canonical incidents; assigning evidence states with complete provenance. | placeholder                     |
| `@cas/drafting`       | Generating the editable Cyberattack Sunday draft from canonical incidents, under the naming policy (D4).              | placeholder                     |
| `@cas/mcp-server`     | MCP tools exposing incident intelligence for reuse by agents and editors.                                             | placeholder                     |
| `@cas/feed-api`       | The public incident feed, later gated by x402 (Sprint 8 at the earliest).                                             | placeholder                     |
| `@cas/worker`         | Runs the pipeline: import, detection, linkage, clustering, evidence assignment.                                       | placeholder, boundary test only |
| `@cas/dashboard`      | Editorial dashboard for reviewing incidents, evidence states and drafts.                                              | placeholder                     |
| `@cas/sunday-agent`   | The drafting agent that drives `@cas/drafting` through the MCP tools.                                                 | placeholder                     |
| `@cas/payer-agent`    | An agent that consumes the x402-gated feed and completes a paid request (Sprint 8 at the earliest).                   | placeholder                     |
| `data/taxonomy`       | Taxonomy data files.                                                                                                  | empty                           |
| `data/fixtures`       | Synthetic fixtures.                                                                                                   | empty                           |

Framework choices for the applications (for example the web framework for the dashboard and
the MCP transport for the server) are **not decided** in Sprint 0 and are not implied by the
placeholder packages. Each is decided in the sprint that builds the application.

## 2. Package ownership boundaries

- A package owns its data shapes internally and exposes across boundaries only what
  `@cas/contracts` defines.
- `@cas/database` is the only package that talks to Postgres.
- `@cas/graph-evidence` is the only package that talks to a Graph provider.
- `@cas/classification` and `@cas/drafting` are the only packages that call a model, and
  only after decision D9 is resolved.
- `@cas/feed-api` and `@cas/mcp-server` are read-side surfaces. They do not run the pipeline
  and do not write pipeline state.
- Applications compose packages. They contain no pipeline logic of their own.

## 3. Planned data flow

Two flows join at incident clustering.

**Editorial flow** (fixed by the project owner, `DATA_INPUTS.md`):

```
master feed → weekly manual selection → incident clustering and editorial transformation → published issue
```

**Chain-signal flow** (the vertical slice):

```
live Graph data → anomaly signals → linkage to selected reporting → canonical incidents
   → evidence states with provenance → editable draft → MCP tools / feed API / dashboard
```

Stage by stage:

1. **Import.** CSV exports from the Excel RSS workflow (D7a) enter through `@cas/worker`
   into `@cas/database`, preserving raw values, provenance and the review state from a
   versioned weekly record. Not implemented in Sprint 0.
2. **Detection.** `@cas/graph-evidence` queries live indexed data for the chosen chains (D1)
   and watchlist (D2), emits anomaly signals, and records the request, response and block
   context as provenance.
3. **Linkage and classification.** `@cas/classification` links signals to selected sources
   and classifies them, keeping the review state and the linkage evidence.
4. **Clustering and evidence.** `@cas/clustering` groups sources and signals into canonical
   incidents and assigns each an evidence state whose provenance chain reaches back to
   Graph responses and source rows.
5. **Drafting.** `@cas/drafting` renders an editable draft to the destination in D3, with
   the evidence state visible beside every claim and the naming policy (D4) applied.
6. **Exposure.** `@cas/mcp-server` exposes tools over the incident store; `@cas/feed-api`
   serves the public metadata allowlist (D6); `@cas/dashboard` shows the same records with
   their data origin labelled.

The four editorial stages remain distinct records throughout. Source selection, incident
membership and publication are never collapsed into one label.

## 4. The shared-contract boundary

`@cas/contracts` is the single boundary between the pipeline (`graph-evidence`,
`classification`, `clustering`, `drafting`, `database`) and its consumers (`mcp-server`,
`feed-api`, `dashboard`, the agents). Rules:

- Pipeline packages produce values typed by the contracts. Consumers read those types and
  never import a pipeline package's internals.
- The contracts package has no dependencies and no runtime behaviour beyond constant
  definitions.
- A change to a contract is a reviewed change, because every surface depends on it.

Sprint 0 contents of `@cas/contracts`:

| Export        | Values                               | Fixed by                                |
| ------------- | ------------------------------------ | --------------------------------------- |
| `ReviewState` | `selected`, `rejected`, `unreviewed` | project owner's data-flow clarification |
| `DataOrigin`  | `live`, `fixture`, `replay`          | the live-versus-fixture rule below      |

Nothing else is defined yet. Incident, signal, evidence-state and feed-response contracts
arrive with the sprints that produce them.

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

## 7. Live data must never be confused with fixtures or replay

Every record the system processes or shows carries a `DataOrigin`.

- `live` is permitted only for a record obtained from a live Graph provider response whose
  request provenance (endpoint, query, variables, block or timestamp, response hash) is
  retained.
- `fixture` marks synthetic data from `data/fixtures`.
- `replay` marks a stored earlier live response replayed for development or evaluation.

The dashboard, MCP tool results, feed responses and drafts label the origin of what they
show. No default substitutes one origin for another. A failed live fetch is an explicit
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
