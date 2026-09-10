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
- **Status:** SUPERSEDED by D20 (2026-09-06), which records the initial standardized-TVL
  watchlist selected on the Sprint 1 evidence
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
- **Status:** PROVISIONAL (provisionally decided); confirmed ACCEPTED by D20 (2026-09-06)
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
- **Status:** SUPERSEDED by D20 (2026-09-06), which fixes manual on-demand CSV import through
  a command-line interface
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
- **Status:** ACCEPTED, as the recorded result of the corrected gate; its identity-key
  definition is SUPERSEDED by D19 (2026-09-06). The project owner may still override the
  Base keep on coverage grounds.
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

## D19 Final Sprint 1 correction: output safety and canonical identity

- **Date:** 2026-09-06
- **Status:** ACCEPTED, as the recorded result of the final corrected gate. The project
  owner may still override the Base keep on coverage grounds.
- **Decision:**
  - Output safety. The evaluation and gate formatters redact their final output and render
    every provider-controlled value (name, slug, network, type, schema version, mismatch
    values, error messages) as safe single-line text with control characters and ANSI
    sequences shown as visible escapes. The probe and the live tests use only these
    formatters; the ignored details file is serialized through the same redactor. The
    evidence itself is never mutated for display. A validated gateway base whose host or
    path contains the active key, raw or percent-encoded, is rejected before any request
    and never echoed.
  - Canonical identity. The protocol identity key is the normalized chain plus the
    provider-returned slug. The provider name is required display metadata and never
    creates distinctness, so a renamed protocol counts once. Each registry target declares
    `expectedProviderSlug` from the verified live runs (`aave-v3`, `spark-lend`,
    `makerdao`, `compound-v3`, `liquity`, `seamless-protocol`, `moonwell`), and the live
    slug must equal it before the target can count. The registry is validated before any
    request: non-empty expected slugs, expected networks that normalize to the configured
    chain, protocol types consistent with the `lending` family, unique labels and Subgraph
    IDs. A null, empty or whitespace-only `_meta.deployment` is missing.
  - Live rerun on the final gate, 2026-09-06 at 00:19 America/Toronto
    (2026-09-06T04:19:23Z): Ethereum PASS, five valid of five at block 25915866, five
    distinct canonical identities, subgraph IDs and deployment IDs, every provider slug equal
    to its expectation. Base PASS/KEEP under the all-targets rule, two valid of two at block
    50939508, both provider slugs equal to their expectations. The Base live test now asserts
    the strict gate passes and reports the gate reasons on failure.
- **Rationale:** Codex's audit of `b7e1fc80` reproduced two exploits. First, a
  Graph-compatible endpoint returning the bearer key as `protocol.name` reached the probe
  output, because `formatEvaluation()` emitted provider fields without redaction. Second,
  the identity key `chain:slug:name` let one protocol count twice under two display names.
  The handoff for `b7e1fc80` claimed a renamed protocol already counted once; that claim was
  false at that commit and is corrected here. D18's recorded results stand as evidence; its
  identity-key definition is superseded.
- **Consequences:** `packages/graph-evidence/src/display.ts` and the redacting formatters in
  `probe.ts`; `expectedProviderSlug` in `deployments.ts`; `validateRegistry` in `gate.ts`;
  102 unit tests in `@cas/graph-evidence`, including the eight output-safety cases, the
  forgery cases and the identity regressions. D2 stays UNRESOLVED.
- **Decided by:** Implementer applying D11's rules with the final corrected gate, after
  Codex's second audit.
- **Supersedes:** D18's identity-key definition. D18's other rules and recorded results
  stand.

## D20 Sprint 2 inputs: watchlist, source and transport, provenance, preservation

- **Date:** 2026-09-06
- **Status:** ACCEPTED
- **Decision:**
  - **D2, initial standardized-TVL watchlist.** The initial watchlist for the standardized
    Graph TVL lane is, on Ethereum: Aave v3, Spark, MakerDAO, Compound v3, Liquity; on Base:
    Seamless Protocol, Moonwell. Base is explicitly confirmed as `KEEP`. Its two-protocol
    coverage continues to be labelled thin coverage wherever Base is described. This
    decision does not satisfy and does not silently replace Plan 2.0's separate
    ten-protocol administrative-event watchlist. Sprint 4 must either expand that watchlist
    using verified contracts and event sources or record an explicit scope deviation. No
    document may claim that the ten-protocol requirement has already been delivered.
  - **D7a and D7b, source and transport.** CSV remains the accepted baseline source format.
    Import is manual and on demand for the hackathon; the import cadence is on demand.
    Sprint 2 provides a command-line interface. Sprint 6 may add a dashboard upload wrapper
    that invokes the same ingestion service. No watched directory, scheduled importer,
    Google authentication, cloud-drive integration or background polling is added.
  - **Provenance.** Every import requires an explicit `DataOrigin`; there is no default.
    `replay` is used for the supplied historical exports, `fixture` for synthetic test data,
    and `live` only for a genuinely current import performed during the run.
  - **Failure and preservation rules.** Structural CSV corruption or an invalid header set
    rejects the entire file before any database write. Semantic row problems retain and
    quarantine the row with stable issue codes. A batch containing quarantined rows
    completes as `completed_with_issues`. Nothing is silently dropped. Repeating the same
    file with the same import configuration creates no duplicate batch and no duplicate
    source rows. Every original cell is preserved, including repeated blank-column
    positions and unknown columns. Recognized fields are derived only from known, named
    headers, never from positions. The master sheet's `ch` field is working state and never
    becomes a stable editorial review decision. For weekly extracts, `TRUE` means selected
    and `FALSE` means rejected; review state is kept separate from source content and from
    machine classification. Weekly date boundaries are not inferred; D10 remains unresolved.
- **Rationale:** The Sprint 1 evidence (D17 to D19, audited PASS at `56bc95c4`) identifies
  the seven deployments with live, provider-validated standardized data, which is the
  evidence D2 required before any selection. The transport question in D7b is settled by the
  hackathon constraint that the project owner already produces CSV exports on demand, so a
  manual command-line import carries no new account, credential or background surface. The
  provenance and preservation rules restate `DATA_INPUTS.md` sections 3, 5 to 8 and 12 as
  binding rules for the Sprint 2 importer.
- **Consequences:** Sprint 2 builds the local PostgreSQL foundation and the manual CSV
  ingestion path under these rules (`SPRINT-2-REPORT.md`). `SPRINT_BOARD.md` Sprint 4 must
  address the administrative-event watchlist explicitly. D10 stays unresolved and no
  importer applies a week boundary.
- **Decided by:** Project owner, Sprint 2 implementation instruction of 2026-09-06.
- **Supersedes:** D2 and D7b. Confirms D7a as accepted.

## D21 Sprint 3 classification approach: deterministic rules, calibration, separation

- **Date:** 2026-09-07
- **Status:** ACCEPTED
- **Decision:**
  - **Approach.** Sprint 3 classifies with a deterministic, versioned, rule-based
    high-recall classifier in `@cas/classification`. This is the approved fallback that the
    sprint board's kill criterion names, taken because D9 is unresolved.
  - **D9 stays unresolved.** This decision does not resolve it and does not choose a model,
    settings or spending cap. No Anthropic SDK, no model-backed code path and no model call
    is added in Sprint 3. Even if `ANTHROPIC_API_KEY` is present in the environment, nothing
    in this sprint reads or uses it.
  - **Calibration, not filtering.** CS79 and CS86 are calibration datasets, and the 2026-09-07
    amendment below states precisely what they calibrate. They are not a production filter and
    not holdouts. Historical candidate decisions never enter the classifier:
    they are not passed to it, not used as features, not used to choose which rows are
    classified, not used to vary rules for particular source-row identifiers, and never
    encoded as special cases. Classification runs first and calibration is a separate
    post-hoc evaluation that joins completed results to a weekly review snapshot.
  - **Scope of a run.** Classification operates on one explicitly named imported batch. No
    editorial week is inferred, because D10 remains unresolved.
  - **Recall posture.** An uncertain source is routed to `review`, never to `exclude`. A
    source is excluded only on strong, explicit out-of-scope evidence with no material cyber
    signal. Excluded sources remain stored with stable rationale codes; nothing is dropped.
  - **Separation.** A machine `ClassificationDecision` is never a human `ReviewState`, never
    written into the review tables and never derived from one. The needs-review queue is
    derived from an explicit classification run.
- **Rationale:** The sprint board's kill criterion for Sprint 3 is explicit: if the model
  path cannot run reproducibly enough to audit, ship a rule-based high-recall pass with the
  queue and defer the model. D9 is unresolved, no model, settings or cap is chosen, and at
  the time of this decision no Anthropic credential is configured. A deterministic ruleset
  is auditable line by line, needs no credential, runs in continuous integration and can be
  hashed, which a model call cannot. Keeping calibration strictly after classification is
  what makes the recall figure meaningful rather than circular.
- **Consequences:** `@cas/taxonomy` carries the versioned classification signal policy;
  `@cas/classification` carries the pure classifier and the pure calibration evaluator;
  `@cas/database` gains migration `0003_classification.sql` and the run and result
  operations; `@cas/worker` gains the classification commands. D9 and D10 both stay
  unresolved and are listed as open human items. The classifier's ruleset is hashed and the
  hash is stored with every run, so a rule change is visible and produces a distinct run.
- **Decided by:** Project owner, Sprint 3 implementation instruction of 2026-09-07.
- **Supersedes:** none. Applies the Sprint 3 kill criterion recorded in `SPRINT_BOARD.md`
  and leaves D9 and D10 open.
- **Amendment, 2026-09-07 (audit correction).** Codex Desktop returned CHANGES REQUIRED on
  the first Sprint 3 candidate. The decision itself is unchanged; the following recorded
  particulars are. The classifier identity is now `rules-classifier@2` with ruleset
  `classification-behavior-contract@1`, and the stored hash covers every component that can
  change a decision rather than the signal policy and rule order alone. The classifier input
  is a closed allowlist of six keys instead of a denylist of prohibited names. `@cas/database`
  gains migration `0004_classification_integrity.sql`, which binds a result's row hash to its
  source row and makes a completed run immutable in the database. A run is written in one pass
  under a `REPEATABLE READ` snapshot, inserted as `running` and completed last with counters
  the database re-derives from the stored results. The `classification queue` command is
  count-only. Decisions on all three real batches are unchanged. Details and evidence are in
  section 12 of `SPRINT-3-REPORT.md`.
- **Second amendment, 2026-09-07 (re-audit correction).** Codex Desktop re-audited the first
  correction and returned CHANGES REQUIRED, closing the input allowlist and the queue output
  and reopening three findings. The decision itself is again unchanged; these particulars are.
  The classifier identity is now `rules-classifier@3` with ruleset
  `classification-behavior-contract@2` and engine `classification-engine@2`, and the contract
  is the artefact the classifier executes rather than a description beside it: fields that
  could not be executed were removed, and the taxonomy is carried in the contract instead of
  imported past it. `@cas/database` gains migration
  `0005_classification_schema_security.sql`, which binds every integrity function to the
  schema it is applied in and freezes a batch's source set before it may be classified. A run
  may not complete until its batch is frozen, and a frozen batch's rows are immutable, so a
  completed run stays reconciled against the live batch. Decisions on all three real batches
  are unchanged again. Details and evidence are in sections 13 and 14 of
  `SPRINT-3-REPORT.md`.
- **Data-lineage clarification, 2026-09-07.** The project owner set out the editorial
  workflow in full, and it has five stages, not three: Make aggregates many websites into one
  living RSS ledger maintained and exported through Excel; the owner cuts that living feed
  down to an Excel list of possible cyberattack incidents and other stories of interest for
  one editorial week; Claude reformats and deduplicates that list; the owner then performs
  further selection, ordering and editing; and the result is published on Substack.

  ```
  living RSS ledger → weekly candidate cut-down → reformatted and deduplicated candidate draft
     → owner's final editorial decisions → published Substack report
  ```

  What follows for this decision. CS79 and CS86 are weekly **candidate** cut-downs, not
  weekly master RSS datasets, and there are no eighty-eight independent weekly master
  datasets. A row kept in a weekly cut-down is a possible story, not a confirmed incident, and
  a weekly sheet is not final publication ground truth. Their review states therefore measure
  retention against the owner's intermediate candidate decisions, not agreement with the final
  published selection: the retention figures stay as technical calibration evidence and must
  never be presented as end-to-end editorial accuracy, publication recall or validated
  incident truth. Publisher Category, the ledger's `ch` working state and weekly spreadsheet
  inclusion are none of them definitive incident labels. The deterministic rules remain
  measured against these files, never trained on them.

  A future end-to-end evaluation must pair weekly Excel cut-downs with their corresponding
  final Substack reports, reconstruct the final include, exclude and incident-grouping
  outcomes through an explicit reviewed mapping, preserve provenance from the living ledger
  through the candidate list to the publication, and reserve an untouched group of paired
  weeks for holdout evaluation before the wider archive is exposed to development. That split
  was not invented here.

  This clarification establishes data provenance and the editorial stages. It does not resolve
  D10: the automated week boundary, the late-arriving-story rule and the publication cutoff
  all remain open.

## D22 Sprint 4 clustering: deterministic stages, conservative grouping, human corrections

- **Date:** 2026-09-08
- **Status:** ACCEPTED
- **Decision:**
  - **Deterministic and model-free.** Clustering is a pure function of its declared inputs
    and a versioned contract. No model, no network, no environment, no clock, no randomness
    and no human label. D9 is still unresolved, and nothing in Sprint 4 depends on it.
  - **Eligibility.** Only `include` and `review` classification results of one explicitly
    named completed classification run are eligible. `exclude` results are retained with
    their decision and rationale and receive no incident membership at all.
  - **Three distinct concepts, kept distinct.** An exact URL duplicate is the same canonical
    URL group. Syndication is substantially identical reporting carried by different URLs or
    publishers. An incident group is separate reports that plausibly describe the same
    underlying event. Each is reasoned about separately, and each leaves its own trace on the
    record.
  - **Conservative separation.** A merge must be positively supported. Shared generic
    security vocabulary is never sufficient. Where the evidence is close to a threshold the
    reports stay separate and the relationship is recorded as an ambiguous link for human
    review. False splits are preferred to unsupported false merges.
  - **Immutability.** A completed clustering run and its base clusters and memberships are
    immutable, enforced by the database as in Sprint 3.
  - **Human corrections are a separate layer.** Merge and split are append-only review
    actions over a completed run. They never rewrite machine output. The effective incident
    view is derived deterministically from the base output plus the ordered accepted actions,
    so the machine record and the human record can always be told apart.
  - **Provenance.** Every effective membership retains its source row and hash, its
    classification result, its batch and origin, its classification run and its clustering
    run. A membership may not cross any of them.
  - **What the counts are not.** Sprint 4 reports structural counts from real data. They do
    not establish clustering precision or agreement with any published issue, because the
    project holds no machine-readable record of the final editorial outcome. Establishing
    that requires weekly Excel cut-downs paired with their final Substack reports, through
    the explicit reviewed mapping recorded in the 2026-09-07 amendment to D21.
  - **Scope of a run.** Clustering operates on one explicitly named classification run. No
    editorial week is inferred, because D10 remains unresolved.
- **Rationale:** The pipeline's value depends on a human trusting the grouping, and an
  unsupported merge destroys that trust faster than an obvious split. A deterministic engine
  driven by a hashed contract can be audited line by line, reproduced exactly and re-run
  without a credential, which no model call can offer while D9 is open. Separating the human
  layer from the machine layer keeps the machine record falsifiable: it stays exactly what
  the engine produced, whatever the reviewer later decides.
- **Consequences:** `@cas/clustering` carries the executable contract and the pure engine;
  `@cas/database` gains migration `0006_incident_clustering.sql` with the run, cluster,
  membership, ambiguous-link and review-action tables; `@cas/worker` gains the clustering
  commands. The dashboard, the drafting system, the evidence-state resolver and the anomaly
  feed are explicitly out of Sprint 4. D9 and D10 both stay unresolved.
- **Decided by:** Project owner, Sprint 4 implementation instruction of 2026-09-08.
- **Supersedes:** none. Builds on D15, D21 and the accepted Sprint 3 result.

## D23 Administrative-event watchlist: accepted scope deviation

- **Date:** 2026-09-08
- **Status:** ACCEPTED
- **Decision:** The project owner selected the explicit scope deviation offered as option B in
  section 10 of `SPRINT-4-REPORT.md`, in answer to the choice D20 left to Sprint 4.
  - **What ships.** The hackathon build retains the seven protocol identities already proven
    live through the standardized TVL lane: Aave v3, Spark, MakerDAO, Compound v3 and Liquity
    on Ethereum; Seamless and Moonwell on Base.
  - **Two different capabilities.** The standardized TVL lane and an administrative-event lane
    are not the same thing. The TVL lane reads protocol identity, total value locked and daily
    financial snapshots from the Messari standardized lending schema. It emits no
    administrative event, and in particular it does not read `Upgraded`,
    `OwnershipTransferred`, `Paused` or token-outflow events.
  - **No misrepresentation.** No document, submission, README or demo may present TVL coverage
    as administrative-event coverage, or describe the seven proven identities as an
    administrative-event watchlist.
  - **Removed from must-ship scope.** Plan 2.0's ten-protocol administrative-event watchlist is
    removed from the hackathon must-ship scope as of this date. It is not delivered, and no
    document may claim otherwise.
  - **Moved to the post-event roadmap.** The administrative-event lane is deferred to after the
    event rather than abandoned.
  - **Nothing fabricated.** No protocol entry, contract address, event signature or live-proof
    claim is invented to reach a count, and no third-party administrative-event infrastructure
    is introduced during the remaining gate period.
  - **What a future implementation must do.** Independently verify each protocol's official
    contracts, its deployment provenance, the administrative events those contracts actually
    emit, and live Graph coverage for them, before any watchlist claim is made.
- **Rationale:** Schedule protection. Building and validating a separate administrative-event
  lane now means a second query document, verified contract addresses and event signatures for
  ten protocols, a provider that indexes them, and deployment provenance for each. That is a
  sprint of its own, and starting it now would jeopardise the Graph release gate at the end of
  10 September and the primary Cyberattack Sunday deliverable. Declaring the gap plainly costs
  the submission a claim it could not honestly make anyway.
- **Consequences:** The seven-protocol live Graph evidence from Sprint 1 is unchanged and
  remains the project's live Graph capability. The Sprint 4 clustering implementation, the
  database schema, the classification results and every real-data figure are unchanged: this
  decision alters documentation and scope, not code. `SPRINT_BOARD.md` no longer carries the
  watchlist as a Sprint 4 exit item, and `HACKATHON_REQUIREMENTS.md` records the deviation
  where the requirement was. Sprint 4's clustering work remains pending independent Codex
  Desktop audit.
- **Decided by:** Project owner, 8 September 2026, after the three-option recommendation in
  `SPRINT-4-REPORT.md` section 10.
- **Supersedes:** the Sprint 4 obligation in D20 to expand the watchlist. D20's statement that
  the standardized-TVL watchlist does not satisfy and must not silently replace the
  administrative-event watchlist stands unchanged, and is the reason this deviation is recorded
  explicitly rather than absorbed quietly.

## D24 Sprint 4 cluster-size bound: component-wide, and an oversized duplicate group refuses the run

- **Date:** 2026-09-09
- **Status:** ACCEPTED
- **Decision:** The clustering contract's `maximumClusterSize` is enforced against the whole
  union-find component, counted in source rows, and checked before every union in both the
  syndication and the incident stage. An exact-URL duplicate group that already exceeds the
  bound refuses the entire clustering run with a fixed `exact_duplicate_group_exceeds_limit`
  condition and the numeric bound, rather than being split or admitted.
  - **Two new contract fields.** `bounds.clusterSizeUnit` names what the bound counts, and
    `bounds.oversizedDuplicateGroupBehaviour` names what happens to a group already past it.
    Both are hashed and both change executable behaviour.
  - **Versions advance.** `clustering-engine@2` and `clustering-behavior-contract@2`, contract
    hash `f0fc48b986959feb341b2762760a0e570186c84e8dfbf73c8d6eaf17bc0f8967`. The corrected
    engine therefore creates new runs; runs at the superseded hashes remain immutable
    historical evidence and no command selects them implicitly.
- **Rationale:** Codex Desktop's audit of `4da68716` chained 501 unique URL groups into a
  single 501-member cluster while `boundsReached` stayed at zero, because the check read the
  pair in front of it rather than what the merge would produce. A bound that a chain can walk
  past is not a bound. Refusing the run on an oversized duplicate group is the conservative
  choice of the three available: splitting rows that share a canonical URL would publish one
  report as several, and admitting them would publish a cluster past the declared bound, while
  a refused run is recoverable and says exactly why.
- **Consequences:** Migration 0007 accompanies this decision with the relational corrections
  the same audit required, and `docs/SPRINT-4-REPORT.md` section 13 records all seven findings.
  Sprint 4 remains pending an independent re-audit.
- **Decided by:** Sprint 4 correction pass of 2026-09-09, on the audit's required correction.
- **Supersedes:** the cluster-bound behaviour described in D22, which is otherwise unchanged.

## D25 Sprint 5 evidence, anomaly and drafting design

- **Date:** 2026-09-10
- **Status:** ACCEPTED
- **Decision:** Sprint 5 adds a Graph evidence layer, a chain-and-reporting anomaly feed and a
  deterministic drafting pipeline, built on six commitments.
  - **Correlation reads no text at all.** An incident correlates with a Graph signal only when
    a person has recorded that incident's chain and protocol identity and it equals the
    identity the signal carries, inside a declared window, at a movement of at least five
    percent. There is no extraction: no rule reads a headline for a protocol name. An incident
    with no recorded subject never correlates, which is the intended outcome rather than a gap.
  - **A machine suggestion is not evidence.** `correlation.suggestionIsEvidence` is `false`, so
    a suggestion is `context` and nothing stronger until a named person accepts it. Only an
    accepted association reaches the resolver. This is the mechanism that stops a value
    movement from quietly turning a report into a confirmed cyberattack.
  - **Four evidence states, and absence is never evidence against.** `reported_only`,
    `onchain_observed`, `corroborated`, `contradicted`. The ordered resolution rules end in a
    rule whose condition is `always`, so a missing signal, a stale observation and an empty
    history all fall through to `reported_only`. No rule has "no evidence" as its condition.
  - **A movement is never anomalous on data that is absent.** Too little history produces
    `insufficient_history`, a gap produces `missing_observation`, an old reading produces
    `stale_observation`, and none of the three is a spike. Every entry carries a fixed sentence
    saying what it does not establish, and its data origin.
  - **No editorial week is inferred.** D10 is unresolved, so every command that needs a period
    takes explicit validated bounds or an explicit imported batch, and no weekly candidate
    decision is read as a feature or a label.
  - **Nothing is model-generated.** D9 is unresolved. The drafter is deterministic: no SDK, no
    model, no key. Every draft says so in its own text, is marked
    `unpublished_requires_human_review`, and is never overwritten.
  - **Versions and hashes.** `evidence-resolver@1` with `evidence-behavior-contract@1`, hash
    `faabdade6fb05e0fd8a3f7dcf92807731da126642954e4ddcd9db28ac8dec873`; `deterministic-drafter@1`
    with `drafting-behavior-contract@1`, hash
    `f89382d6794e77a90eb11df841de234421dee2a75651d1cb95187b29b6ddade3`. Every hashed field
    changes observable behaviour, and each is pinned by a mutation test.
  - **A resolution's identity includes the human judgement behind it.** The evidence run's
    idempotency key covers the clustering run, the signal run, the contract hash, the resolver
    version and a digest of every decision bearing on that clustering run. A replay that
    changes nothing is a no-op; an acceptance makes the next resolution a new immutable run.
  - **`@cas/evidence` is a package of its own.** Clustering's contract was audited and accepted
    at a fixed hash. Keeping the two apart means a change to one cannot move the other's
    identity.
- **Rationale:** The September 10 gate needs the anomaly feed and the evidence layer, and the
  primary deliverable needs a draft. The risk in building both at once is that a plausible
  correlation quietly becomes a published assertion about a named organisation. Every
  commitment above exists to make that specific failure structurally impossible rather than
  merely unlikely: the correlator cannot read a name, the resolver cannot count an undecided
  suggestion, the database refuses a corroboration with nothing behind it, and the drafter
  proposes no name at all.
- **Consequences:** Migration 0008 adds seven tables and five guard functions, checksum
  `548c810d925d113f2d5ab74f399d3dff9b22f9e144bd2202072489a030344449`. Recording an incident's
  subject becomes a command, because without one the evidence layer would correlate nothing
  ever. D3 and D4 remain PROVISIONAL and are implemented as configurable policies at their
  conservative settings; neither is owner-confirmed. Sprint 5 remains pending an independent
  Codex Desktop audit.
- **Decided by:** Sprint 5 implementation of 2026-09-09 and 2026-09-10, on the owner's brief.
- **Supersedes:** nothing. It builds on D21 (classification), D22 and D24 (clustering) and D23
  (the seven retained live identities), and it does not revisit D9, D10, D3 or D4.

## D27 Security-foundation track: versioned resource limits, CI database and toolchain pins

- **Date:** 2026-09-10
- **Numbering:** the track's brief reserved D26. The Sprint 5 correction (`313db359c72ea305c03c30cc764ea67e51cbcec8`) appended its own D26 while this track was being built, so this entry is D27, renumbered on 10 September 2026 before any rebase, to avoid a collision.
- **Status:** PROPOSED. Speculative: the track was built on branch
  `parallel/s6-security-foundation` from Sprint 5 candidate
  `6fad82c3b03325101940d9ca25575d94550e7d25` while that candidate was under audit and then
  returned with findings. The decision stands only if Sprint 5 is accepted and Codex Desktop
  separately audits this track; nothing from it is merged or deployed.
- **Decision:** Four commitments.
  - **Measured, versioned resource limits.** `@cas/contracts` publishes `resource-limits@1`:
    import file bytes (512 MiB), rows (250,000), columns (64), cell bytes (1 MiB), retained
    bytes (512 MiB) and the derived record buffer; Graph response body bytes (1 MiB), JSON
    depth (32), collection size (4,096), collection count (16,384) and requests in flight
    (8); draft sections (4), claims (10,000), output and sidecar bytes (16 MiB each); command
    duration (30 minutes) and grace (5 seconds). Each was sized against a recorded measurement
    of 10 September 2026 with at least four times headroom, except the two structural draft
    bounds. Enforcement is at the boundary that reads the input, while it reads; a crossed
    limit is a fixed, non-reflecting refusal that writes nothing; nothing is truncated to
    fit. Draft limits are declared and left to the draft writer, which the Sprint 5
    correction owns.
  - **A command deadline.** Every worker command aborts at the deadline, rolls back, and
    exits `124` after the grace period. `CAS_COMMAND_DEADLINE_MS` lowers and never raises it.
  - **A database in CI without a secret.** The `database` job runs a digest-pinned
    PostgreSQL 17.11 service with trust authentication on the job's loopback and a
    credential-free URL, applies every migration, reruns as a no-op, checks drift and runs
    the complete `test:db` suite. The default suite additionally runs under a proven network
    denial.
  - **Toolchain and supply-chain reproducibility.** Node `24.21.0` and pnpm `11.10.0` pinned
    exactly and asserted at run time; every action SHA-pinned and every image digest-pinned,
    enforced by a scan; `pnpm audit`; a reproducible CycloneDX 1.6 bill of materials and
    licence inventory generated by first-party code from the lockfile and cross-checked
    against pnpm's own generator; CodeQL; first-party hygiene, forbidden-file and secret
    scans as the readiness step for the repository settings only the owner can enable.
- **Rationale:** The audit of Sprint 5 confirmed that CI ran no database and that the
  drafting output boundary was unsafe; the same review showed no bound anywhere on what a
  hostile file or a hostile provider could make the worker read or hold. Limits without
  measurements are guesses, and truncation is a silent edit of evidence, so the limits are
  measured, versioned and refusing. Reproducibility of the toolchain is what makes an audit's
  rerun the same run.
- **Consequences:** New documents `THREAT_MODEL.md`, `RISK_REGISTER.md`,
  `DATA_CLASSIFICATION_RETENTION.md`, `INCIDENT_RESPONSE.md`, `VULNERABILITY_DISCLOSURE.md`
  and `SECURITY-FOUNDATION-REPORT.md`; `SECURITY.md` sections 8, 10, 11 and 15; the `limit`
  failure kind in `@cas/graph-evidence`; exit code `124` in the worker; `tools/checks`,
  `tools/supply-chain` and `supply-chain/`; two additional CI jobs and a CodeQL workflow;
  `@types/node` added to the root manifest for the tooling (no new third-party version). The
  branch must be rebased or rebuilt additively from the Codex-accepted Sprint 5 SHA before
  it is audited. The pnpm `+sha512` integrity suffix is a recorded blocker, not adopted.
- **Decided by:** Security-foundation track of 2026-09-10, on the owner's brief; not yet
  owner-confirmed.
- **Supersedes:** nothing. It does not revisit D3, D4, D8, D9, D10 or D13.
