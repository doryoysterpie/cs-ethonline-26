# Decision log

Append-only. A decision is never edited in place. To change one, append a new entry whose
`Supersedes` field names the old ID, and set the old entry's status to `SUPERSEDED` with a
pointer. Provisional decisions become `ACCEPTED` only on explicit approval by the project
owner, recorded as a new dated entry.

Statuses: `PROVISIONAL`, `UNRESOLVED`, `ACCEPTED`, `SUPERSEDED`.

Fields for every entry: Decision ID, Date, Status, Decision, Rationale, Consequences,
Decided by, Supersedes.

---

## D1 Chains

- **Date:** 2026-09-04
- **Status:** SUPERSEDED by D11 (2026-09-04)
- **Decision:** The provisional recommendation is Ethereum mainnet and Base as the chains
  whose live indexed data the anomaly detector reads. Human confirmation is required before
  Sprint 1.
- **Rationale:** Both chains are broadly indexed by The Graph and carry the volume of
  protocol activity that makes incident-linked anomalies observable. Reading indexed data
  from a mainnet is not a chain interaction and does not conflict with the testnet-only
  posture in `SECURITY.md`.
- **Consequences:** Sprint 1 verifies live indexed-data availability for both. If either
  fails that check, the recommendation returns to the project owner.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

## D2 Watchlist

- **Date:** 2026-09-04
- **Status:** UNRESOLVED
- **Decision:** No watchlist is selected. Sprint 1 must rank candidate protocols by live
  indexed-data availability and comparability before any final selection.
- **Rationale:** Prominence alone is not a selection criterion. A protocol with no
  comparable live data cannot yield a detectable anomaly, however well known it is.
- **Consequences:** Sprint 1 produces a ranked candidate list with the evidence behind each
  rank. Selection is a human decision on that evidence.
- **Decided by:** Pending, project owner.
- **Supersedes:** none.

## D3 Draft destination

- **Date:** 2026-09-04
- **Status:** PROVISIONAL
- **Decision:** The repository-local fallback destination for a generated draft is a new
  dated file under `output/drafts/`. Automatic overwriting of an existing draft is
  forbidden. The actual vault path remains a human decision.
- **Rationale:** A dated, never-overwritten file preserves every generated draft and keeps
  the human step between generation and publication intact.
- **Consequences:** `output/` is excluded from Git by default because drafts may contain
  text derived from third-party reporting. Whether any draft is ever committed is a
  separate future decision.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

## D4 Victim naming

- **Date:** 2026-09-04
- **Status:** PROVISIONAL
- **Decision:** A victim may be named after a primary statement from the victim, or after
  two independent credible reports. Otherwise the draft uses a generic description. Human
  confirmation is required before drafting work begins.
- **Rationale:** Naming on a single secondary report risks defamation and error
  propagation; the two-source or primary-statement bar is a conventional editorial
  threshold.
- **Consequences:** The drafting package must carry the evidence state that justifies a
  name, and the evidence state must be visible in the editable draft.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

## D5 Public identity

- **Date:** 2026-09-04
- **Status:** PROVISIONAL (repository name fixed)
- **Decision:** The repository name is fixed as `cs-ethonline-26`. The display name remains
  provisionally `Cyberattack Sunday: Onchain Incident Intelligence`, with `CAS Chainwatch` as
  the working product name. Workspace packages use the internal scope `@cas/`; they are
  private and never published, so the scope carries no registry commitment.
- **Rationale:** The repository name must not change once submitted. The display and product
  names can be revised in documentation without code changes.
- **Consequences:** Documentation uses the display name in headings and the working name in
  prose where a short form is needed.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

## D6 Public-feed exposure

- **Date:** 2026-09-04
- **Status:** PROVISIONAL
- **Decision:** During the demo the public feed exposes only public incident metadata. It
  excludes private editorial notes and corpus text.
- **Rationale:** The x402 gate is a payment mechanism, not access control (`SECURITY.md`
  section 5). Anything behind it must already be publishable.
- **Consequences:** The feed API's response contract in `@cas/contracts` must be a strict
  allowlist of fields; anything not on it is not serialized.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

## D7 Living-feed source (original single question)

- **Date:** 2026-09-04
- **Status:** SUPERSEDED by D7a and D7b
- **Decision:** Originally recorded as one unresolved question covering source, format,
  permitted fields, refresh cadence and failure behaviour.
- **Rationale:** The project owner's clarification of the actual editorial data flow
  (`DATA_INPUTS.md`) showed that the input format and the transport are separable
  questions with different urgency.
- **Consequences:** Split into D7a and D7b on the same day.
- **Decided by:** Project owner, via the Sprint 0 charter and its clarification.
- **Supersedes:** none.

## D7a Input format

- **Date:** 2026-09-04
- **Status:** PROVISIONAL (provisionally decided)
- **Decision:** The hackathon baseline accepts standards-compliant CSV exports from the
  existing Excel-based RSS workflow: the master feed export and the weekly snapshot sheets,
  with the representative schemas recorded in `DATA_INPUTS.md`.
- **Rationale:** A file-based CSV import is the reliable baseline the project owner already
  produces. It requires no new account, no workbook synchronization and no change to the
  editorial workflow.
- **Consequences:** The importer (not implemented in Sprint 0) must use a
  standards-compliant CSV parser, tolerate unnamed blank columns, preserve raw values and
  retain provenance. Direct Excel or cloud-workbook synchronization must never become a
  prerequisite for the Graph release candidate.
- **Decided by:** Project owner, provisionally, via the Sprint 0 clarification.
- **Supersedes:** D7.

## D7b Transport

- **Date:** 2026-09-04
- **Status:** UNRESOLVED
- **Decision:** The transport for the CSV inputs, whether manual upload, a watched local
  export directory or direct authenticated workbook access, must be chosen before Sprint 2.
  Permitted fields, refresh cadence and failure behaviour are decided with it.
- **Rationale:** Each transport has a different security surface and a different failure
  mode; the choice affects the Sprint 2 ingestion design.
- **Consequences:** Sprint 2 cannot start until this is decided. The file-based baseline
  from D7a remains valid under every transport option.
- **Decided by:** Pending, project owner.
- **Supersedes:** D7.

## D8 Deployment and Postgres targets

- **Date:** 2026-09-04
- **Status:** UNRESOLVED
- **Decision:** No live deployment target and no live Postgres target are chosen. Local
  development support is recorded separately: a local Postgres reachable through
  `DATABASE_URL` is the Sprint 1 development baseline.
- **Rationale:** The live demo's hosting and database must be chosen on cost, reliability and
  the sponsor requirement to host a live service, which is not yet designed.
- **Consequences:** `ACCOUNT_READINESS.md` tracks local Postgres and live hosting as separate
  rows. The live decision is due before Sprint 7.
- **Decided by:** Pending, project owner.
- **Supersedes:** none.

## D9 Model configuration

- **Date:** 2026-09-04
- **Status:** UNRESOLVED
- **Decision:** Anthropic is planned as the model provider for classification and drafting.
  The exact model, the deterministic structured-output settings and the spending cap remain
  unresolved.
- **Rationale:** Classification must be reproducible enough to audit, which constrains the
  settings; the cap bounds hackathon cost.
- **Consequences:** No model SDK is added until this is decided. `ANTHROPIC_API_KEY` is the
  only model-related name declared in `.env.example`, because the official SDK reads it.
- **Decided by:** Pending, project owner.
- **Supersedes:** none.

## D10 Editorial week boundary

- **Date:** 2026-09-04
- **Status:** PROVISIONAL (timezone); UNRESOLVED (timestamps)
- **Decision:** The editorial timezone is provisionally `America/Toronto`. The exact start,
  freeze and publication timestamps of the editorial week remain unresolved.
- **Rationale:** The weekly snapshot sheets are cut on a weekly window; the pipeline must
  agree with the editor on where that window starts and ends.
- **Consequences:** Every stored timestamp keeps its raw value and its UTC interpretation
  (`DATA_INPUTS.md`); the editorial boundary is applied at query time, not at import.
- **Decided by:** Project owner, provisionally, via the Sprint 0 charter.
- **Supersedes:** none.

---

Entries D11 to D15 were appended on 2026-09-04 during the Sprint 0 audit remediation. Earlier
entries are unchanged except for status pointers.

## D11 Chains and Graph route

- **Date:** 2026-09-04
- **Status:** ACCEPTED
- **Decision:** Ethereum mainnet is the mandatory primary chain and Base is the secondary
  chain for Sprint 1's Graph proof. The route for The Graph's standardized-data track is
  meaningful use of the Messari standardized schema. A second Graph product is not required,
  Substreams remains optional and must never become a prerequisite, and Graph Market access
  is required only if an optional product path actually needs it. Sprint 1's internal proof
  gate is: one common query and data model; at least five relevant protocols or entities;
  live provider-backed results; Ethereum mandatory; Base secondary. Base validation is
  time-boxed to four hours. Base is retained only if the same query contract produces
  sufficiently complete and fresh provider-backed results; otherwise the evidence is
  documented and the MVP is reduced to Ethereum without blocking the standardized-schema
  route.
- **Rationale:** The prizes page, read on 2026-09-04, qualifies the standardized track
  through either composition of two or more Graph products or meaningful use of a
  standardized schema, and requires live data from a Graph provider. Meaningful use of one
  standardized schema is the shortest verified path. Reading indexed mainnet data is not a
  chain interaction and does not conflict with the testnet-only posture in `SECURITY.md`.
- **Consequences:** `HACKATHON_REQUIREMENTS.md` section B and `SPRINT_BOARD.md` Sprint 1
  encode the gate. `ACCOUNT_READINESS.md` treats Graph Studio or equivalent provider access
  as the Sprint 1 dependency and Graph Market as conditional on an optional path.
- **Decided by:** Project owner, audit-remediation instruction of 2026-09-04.
- **Supersedes:** D1.

## D12 Licence

- **Date:** 2026-09-04
- **Status:** ACCEPTED
- **Decision:** The repository is licensed under the Apache License, Version 2.0. The
  canonical licence text is the root `LICENSE` file, unaltered. The root `package.json`
  declares `"license": "Apache-2.0"` and the README states the licence.
- **Rationale:** The Graph tracks require open-source code, and the project owner chose
  Apache-2.0.
- **Consequences:** All contributions are under Apache-2.0. Any future `NOTICE` file is a
  separate decision.
- **Decided by:** Project owner, audit-remediation instruction of 2026-09-04.
- **Supersedes:** none. Resolves finding 3 of the first `HACKATHON_REQUIREMENTS.md`.

## D13 Package release-age exception policy

- **Date:** 2026-09-04
- **Status:** ACCEPTED
- **Decision:** `minimumReleaseAge: 1440` in `pnpm-workspace.yaml` stays. A narrow
  exception may be granted only for a package that is all three of: required by an official
  sponsor integration; unavailable in a compatible release older than 24 hours; and necessary
  to satisfy a verified prize requirement. Every exception records, as a dated entry in this
  log before the dependency lands: the exact package, the exact version, the official source,
  the reason, the publication age at the time, and the verification performed. The exact
  version is pinned and the complete test suite is rerun. The exclusion names the exact
  package only. No wildcard or pattern exception, and no pre-approved package, is permitted.
- **Rationale:** The release-age gate is the project's defence against a freshly published
  malicious or broken version. Sponsor integrations may legitimately ship a package during
  the event, and a documented, per-package exception preserves the gate while allowing that
  case.
- **Consequences:** `SECURITY.md` section 8 references this policy. Codex verifies any
  exception entry against the lockfile.
- **Decided by:** Project owner, audit-remediation instruction of 2026-09-04.
- **Supersedes:** none.

## D14 Corrected submission schedule

- **Date:** 2026-09-04
- **Status:** ACCEPTED; its per-sprint calendar and due dates are SUPERSEDED by D16, its
  official milestones and freeze stand
- **Decision:** The operative schedule is the official ETHOnline 2026 schedule, in
  America/Toronto time: hacking began 4 September 2026 at 12:00 PM; Project Check-in #1 is
  7 September at 11:59 PM; Project Check-in #2 is 10 September at 11:59 PM; final project
  submission is 13 September at 12:00 PM; judging begins 13 September at 3:00 PM. 14 to
  16 September are not build or submission time. Feature freeze is 12 September at
  12:00 PM. The Graph release gate stays at the end of 10 September, and Hedera and Bazantic
  remain conditional on that gate and on the remaining time budget.
- **Rationale:** The first sprint board carried a 14 September freeze and a 16 September
  buffer from the charter; the event's schedule contradicts them.
- **Consequences:** `SPRINT_BOARD.md` is re-cut. README, `HACKATHON_REQUIREMENTS.md` and
  `ACCOUNT_READINESS.md` deadlines follow. D7b is due by 6 September, D9 by 7 September, and
  D8 by 10 September.
- **Decided by:** Project owner, audit-remediation instruction of 2026-09-04.
- **Supersedes:** the freeze and buffer controls recorded in the first version of
  `SPRINT_BOARD.md`, which were never D-numbered.

## D15 Classification before selection

- **Date:** 2026-09-04
- **Status:** ACCEPTED
- **Decision:** The runtime flow is: current master RSS, Excel or CSV feed; import and
  normalization; automated high-recall classification; an include, exclude or needs-review
  queue; incident clustering; canonical incident records; human review and editorial
  output. The historical CS79 and CS86 selections are calibration and evaluation labels
  only. They are never a production filter or prerequisite. Live Graph signals run in
  parallel and attach corroborating evidence to canonical incidents; they do not replace
  editorial ingestion. Human `ReviewState` and machine `ClassificationDecision` are distinct
  contracts in `@cas/contracts`.
- **Rationale:** The first architecture placed classification after manual source
  selection, which preserved the manual bottleneck and contradicted the product goal.
- **Consequences:** `ARCHITECTURE.md`, `DATA_INPUTS.md`, `SPRINT_BOARD.md`, package
  descriptions and the contracts package are updated. The classifier itself is Sprint 3
  work and is not built in Sprint 0.
- **Decided by:** Project owner, audit-remediation instruction of 2026-09-04.
- **Supersedes:** the data-flow section of the first `ARCHITECTURE.md`. D7a is unaffected.

## D16 Gate-aligned implementation sequence

- **Date:** 2026-09-04
- **Status:** ACCEPTED
- **Decision:** The implementation sequence, in America/Toronto dates, is:
  Sprint 1, 5 September: live Graph provider proof, Messari standardized-schema spike,
  Ethereum mandatory, Base four-hour gate.
  Sprint 2, 5 to 6 September: Postgres schema, editorial-feed import, normalization,
  provenance.
  Sprint 3, 6 to 7 September: high-recall classification, review queue, Check-in #1.
  Sprint 4, 7 to 8 September: clustering, canonical incidents, Graph correlation,
  evidence-state resolver, anomaly feed.
  Sprint 5, 8 to 9 September: drafting pipeline, live crypto section, fixed historical
  draft.
  Sprint 6, 9 to 10 September: Next.js dashboard, review workflow, draft editor, MCP server,
  `SKILL.md`, Check-in #2, Graph release gate.
  Sprint 7, 10 to 11 September: holdout evaluation, fixtures, clean-install verification,
  Graph-track hardening.
  Sprint 8, 11 to 12 September: conditional Hedera and Bazantic work; feature freeze
  12 September at 12:00 PM.
  Sprint 9, 12 to 13 September: videos, submission documentation, final checks, submission
  before 13 September at 12:00 PM.
  At the Graph release gate at the end of 10 September the following must be complete and
  demonstrable, not in progress: live Graph anomaly detection; editorial connection;
  clustering; evidence states and provenance; editable draft; reusable MCP tooling with
  `SKILL.md` and clean installation. If the gate fails, Hedera and Bazantic are dropped and
  Sprints 7 and 8 finish and harden the Graph submission.
- **Rationale:** The previous board required must-ship items 1 to 6 to pass at the end of
  10 September while scheduling the editable draft and MCP tooling through 11 September. A
  pass gate cannot be satisfied by work in progress.
- **Consequences:** `SPRINT_BOARD.md` is re-cut to this sequence. Due dates for open
  decisions follow it: D7b by 5 September, before Sprint 2; D9 by 6 September, before
  Sprint 3; D3 and D4 by 8 September, before Sprint 5; D8 by 10 September, before Sprint 8.
  Sponsor accounts are needed by 10 September only if the gate passes. The dashboard
  framework is Next.js, as Plan 2.0 fixes (`apps/dashboard`: command center, review queue,
  incident explorer, draft editor, judge login), built in Sprint 6 and not scaffolded before
  it. Implementation choices the plan does not fix, such as the MCP transport, stay open
  until their implementation sprint.
- **Decided by:** Project owner, final Sprint 0 audit correction of 2026-09-04.
- **Supersedes:** the per-sprint calendar and due dates of D14. D14's official milestones
  and freeze stand.

## D17 Sprint 1 outcome: schema family, deployments, provider interface, chains

- **Date:** 2026-09-05
- **Status:** SUPERSEDED by D18 (2026-09-05) for the gate definition and the recorded
  results, because the verifier that produced them trusted registry labels and required only
  one successful Base target. The schema family, provider interface and deployment selection
  recorded here stand.
- **Decision:**
  - Schema family: Messari Lending/CDP standardized schema. The one common query document
    (`packages/graph-evidence/src/query.ts`, SHA-256
    `780080c478815b08437d6c8bd0b814c895a9a7be9547da61befa128c0ed62306`) reads the
    standardized `Protocol` interface, `financialsDailySnapshots` and `_meta`, and succeeded
    unchanged on schema versions 2.0.1, 3.0.1 and 3.1.0 during discovery.
  - Provider interface: The Graph gateway, `POST {GRAPH_GATEWAY_URL}/subgraphs/id/{subgraphId}`
    with default base `https://gateway.thegraph.com/api`, API key only in an
    `Authorization: Bearer` header, 20 s timeout, four snapshots requested.
  - Ethereum (mandatory): PASS on 5 September 2026 at 21:50 America/Toronto with five
    distinct protocols in five deployments, all at block 25915123, no indexing errors:
    Aave v3 `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`, Spark
    `GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si`, MakerDAO
    `8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1`, Compound v3
    `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`, Liquity
    `2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY`.
  - Base (secondary): KEPT under D11's rule. The same query document and adapter produced
    fresh, provenance-complete results with no indexing errors at block 50935047 for two
    deployments in the same schema family: Seamless Protocol
    `2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP` (3.1.0) and Moonwell
    `33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg` (2.0.1). Coverage is thin: the Aave v3
    Base subgraph has no indexer allocations and the registry's Compound v3 Base entry
    points at the Ethereum deployment. Investigation took about 33 minutes of the four-hour
    box; the box was not extended and no protocol-specific query fork was written.
  - Freshness rule: the current observation must be at most 48 hours old at query time;
    the baseline is the observation between 12 and 48 hours before it that is closest to
    24 hours, and the measured elapsed window is always reported.
  - Substreams: no implementation time, as required. Graph Market access is not needed.
- **Rationale:** Evidence in `SPRINT-1-REPORT.md`: 44 candidates swept live, selection and
  rejection reasons recorded per deployment, and the probe output with block, deployment,
  snapshot and version provenance.
- **Consequences:** `@cas/graph-evidence` is the implemented Sprint 1 boundary. D2 remains
  UNRESOLVED; the report appends a ranked candidate list backed by live coverage evidence
  for the project owner to select from. Sprint 4 correlation reads the `TvlDeltaSignal`
  contract this sprint added.
- **Decided by:** Implementer applying D11's gate rules; Base keep subject to the project
  owner's confirmation.
- **Supersedes:** none. Resolves the Sprint 1 part of D11.

## D18 Corrected Sprint 1 gate: provider-validated identities

- **Date:** 2026-09-05
- **Status:** ACCEPTED, as the recorded result of the corrected gate. The project owner may
  still override the Base keep on coverage grounds.
- **Decision:**
  - The executable Graph release gate counts only provider-validated identities. For every
    configured target the live `protocol.network`, `protocol.type`, `protocol.schemaVersion`
    and `_meta.deployment` are compared with the expectations declared in
    `packages/graph-evidence/src/deployments.ts`, which are the exact values observed in the
    verified sweep. The provider's `slug` and `name` are required and preserved; the
    configured slug is never substituted. Distinctness is counted jointly over provider
    identity, subgraph ID and deployment ID. Configured labels never establish distinctness.
    Only `MAINNET` and `BASE` are recognized network values; anything else fails.
  - Ethereum (mandatory): PASS, rerun on 2026-09-05 at 23:03 America/Toronto
    (2026-09-06T03:02:59Z, block 25915485). Five valid of five configured; five distinct
    provider identities, five distinct subgraph IDs, five distinct deployment IDs; every
    target reports `MAINNET`, type `LENDING`, and its declared schema version. Provider
    slugs and names as returned: `aave-v3` "Aave v3", `spark-lend` "Spark Lend",
    `makerdao` "MakerDAO", `compound-v3` "Compound III", `liquity` "Liquity".
  - Base (secondary): PASS/KEEP under the corrected rule, which requires every configured
    Base target to verify. Both targets valid at block 50937221 (2026-09-06T03:03:09Z): two
    distinct provider identities (`seamless-protocol` "Seamless Protocol", `moonwell`
    "Moonwell"), two distinct subgraph IDs and deployment IDs, both reporting `BASE`, type
    `LENDING`, and their declared schema versions. One successful Base target would have
    been FAIL/DROP. Coverage remains two deployments, as recorded in D17.
  - Gateway URL: validated structurally with `new URL()`; `https:` only; no username,
    password, query string or fragment; trailing slashes normalized. Provenance records the
    sanitized origin and path only, and claims `the-graph-gateway` only when the host is
    `gateway.thegraph.com`; any other validated HTTPS endpoint is recorded as
    `graph-compatible-https-endpoint`.
  - Freshness: 48-hour limit, and a future-dated observation is rejected once it leads the
    query clock by more than 120 seconds. Inside that tolerance it is accepted and its
    negative age is reported.
  - Response-body read failures are classified: an abort is a `timeout`, any other read
    failure is `network`.
- **Rationale:** Codex's audit of `e02fc190` found that the first verifier trusted registry
  labels for chain and distinctness, required only one successful Base target, validated
  the URL by regular expression, left body-read errors unstructured and let a negative age
  pass as fresh. The results D17 recorded were produced by that verifier and are superseded
  for that reason, not because the live data changed. The corrected rerun reproduces PASS
  for Ethereum and PASS/KEEP for Base on validated evidence (`SPRINT-1-REPORT.md`,
  "Correction after Codex audit").
- **Consequences:** `packages/graph-evidence/src/gate.ts` is the gate; eighty unit tests
  cover identity, distinctness, thresholds, URL security, freshness and exit codes. D2 stays
  UNRESOLVED.
- **Decided by:** Implementer applying D11's rules with the corrected gate, after Codex's
  audit.
- **Supersedes:** D17's gate definition and recorded results.
