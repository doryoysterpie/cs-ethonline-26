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
- **Status:** PROVISIONAL
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
