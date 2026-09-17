# Post-event plan: weekly sort-and-produce

Version 0.2. Written 16 September 2026. Status: **DRAFT, pending the owner's review**. Branch
`post-event/weekly-production-plan` from `main` at `cfb2a86`. All times America/Toronto.

## 0. Document authority and use

This is the single normative plan for the work after ETHOnline 2026. It defines what a
Technical Capability Unit (TCU) is in this repository, the standard steps every unit must
complete, and the nine units that turn the hackathon submission into the owner's weekly
product. The GitHub issues created from `docs/tcu/CAS-00N.md` hold live status, blockers and
evidence, and link here; they do not restate contracts. When a contract changes, this file and
the affected tracker change together.

Nothing in this document marks a test as passed, changes an audit status, or admits any unit to
active work. Every audit status recorded elsewhere in this repository is unchanged: Sprints 0
to 4 were accepted by Codex Desktop; nothing after Sprint 4 has been independently audited.

## 1. The product after the hackathon

Stated by the owner on 16 September 2026, in this order of priority:

1. **Intake is Google Sheets.** The owner maintains the living RSS ledger in the workbook
   `Cyberattack Sunday - RSS Intake` (current full feed plus roughly seventy historical weekly
   tabs, `docs/SHEETS-INTAKE.md` section 1). That workbook is the source. CSV export is no
   longer the intended path.
2. **A table to sift stories by category.** The owner filters to one category, reads, and
   selects. Categories begin with cyberattack (the Cyberattack Sunday issue) and crypto (the
   Latest in Crypto feed), and later add vulnerabilities, patch alerts and others. Every
   category receives the same cleanup and deduplication.
3. **The program produces two kinds of output from a selection, and they are different.**
   - A **round-up**: the selected stories reformatted into the **rundown template**, cleaned
     and deduplicated. This is the specific article type the owner produces today with Claude
     for Cyberattack Sunday and for the crypto round-up. Reformatting is this, and only this.
     **The rundown template is built first**, for cyberattack or crypto round-ups.
   - An **article**: the program reads every source of the selected stories in full and
     writes an original article the way a tech reporter would. Writing an article is not
     reformatting. This is built second.
     Both results are editable. The owner pastes them into Substack personally and adds the
     extras for Cyberattack Sunday. Both capabilities belong to the owner's account alone; no
     other account receives them.
4. **Shareable story cards, later.** A reader picks stories and gets something to share on
   social media ("these stories caught my interest"). The owner designs the creatives;
   functionality comes first, so this unit is queued behind the weekly product.
5. **No vendor allegiance.** The hackathon has ended. Sponsor integrations are kept only where
   they serve the product.
6. **Readers sign up with an email address only.** Anyone may request an account on the
   owner's instance; the one-time code sent to that address proves they hold it; the owner
   approves each request before it becomes an account; an approved reader sees only what D6
   allows. Today only the owner's admin account exists and an unknown address is refused with a
   generic response. The instance is protected from bulk scraping and from AI crawlers that
   would cost the owner money: humans yes, crawlers no.
7. **Free, with a supporter tier and crypto donations.** Reading is free. A paid tier exists for
   anyone who wants to support the publication, and one-off donations are accepted in crypto.
   Payment is never access control. What the tier grants beyond support is undecided.
8. **Parked, recorded in the owner's words:** "incorporate dust". Not interpreted here. The owner
   will look at it after the weekly product is finished.

Non-goals, fixed by the same statement: the system never posts to Substack; a model never
chooses which facts are true or which stories are in the issue; nothing is built for other
accounts before the owner's weekly flow works end to end.

## 2. Where the repository stands, verified 16 September 2026

| Fact                                                                                                                                              | Evidence                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `main` is `cfb2a86`, merging PR #1 (production candidate) and PR #2 (passwordless email login), both merged by the owner on 13 September          | `git log origin/main`                                                                                                  |
| The repository is public and licensed Apache-2.0                                                                                                  | `gh api repos/doryoysterpie/cs-ethonline-26` (`visibility: public`), `LICENSE`, decision D12                           |
| Migrations 0001 to 0011 exist; the next number is 0012                                                                                            | `packages/database/migrations/`                                                                                        |
| Railway runs the dashboard image; migrations run before serving; no scheduled job runs the pipeline                                               | `Dockerfile`, `railway.json`                                                                                           |
| The populated local database, ledger plus two weekly cut-downs plus every run to migration 9, is 527 MB                                           | `pg_database_size('cas_sprint2_verify')`, measured 16 September                                                        |
| Railway Free and Trial volumes are 0.5 GB; Hobby is USD 5 per month with 5 GB                                                                     | `railway.com/pricing`, read 16 September                                                                               |
| The README's status section still says "Sprint 5 in progress"                                                                                     | `README.md` line 33                                                                                                    |
| Secret scanning, push protection and Dependabot security updates are disabled; Dependabot alerts are not enabled; `main` has no branch protection | `gh api repos/doryoysterpie/cs-ethonline-26`, `.../branches/main/protection`, `.../vulnerability-alerts`, 16 September |
| No GitHub issue exists in the repository                                                                                                          | `gh issue list --state all`                                                                                            |
| The database stores each story's title, description and summary as exported from the feed; it does not hold the full text of source articles      | `docs/DATA_INPUTS.md` section 2                                                                                        |

The editorial pipeline against the owner's four stages:

| Stage             | Runs today                                                                                                                                                                                                                                                     | Missing for the product                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed in           | Manual CSV export, then `editorial import` (`apps/worker/src/cli.ts`). The Sheets connector pins, inventories, reports timestamps and dry-runs the one workbook; it imports nothing.                                                                           | A Sheets-to-import path. The service account and the single-file share (`docs/SHEETS-INTAKE.md` section 2) are human steps that have not been recorded as done.                                      |
| Sort              | One classifier answering one question, cyber or not, into include, exclude or review (`packages/taxonomy/src/signal-policy.ts`, D21). Deterministic clustering is the deduplication (D22). Queue and incident pages in the dashboard, keyed by run identifier. | Categories as a first-class record, a decision per category, a category filter and story selection in the table, and an editorial week boundary (D10 unresolved).                                    |
| On-chain evidence | Replay and fixture ingestion. Live signals have no runnable path: the worker does not depend on `@cas/graph-evidence` and the live ingest function is not exported.                                                                                            | Nothing, for the product. Disposition is an owner decision in CAS-006.                                                                                                                               |
| Produce           | A deterministic draft with header, incidents, crypto and provenance sections (`packages/drafting/src/draft.ts`), where "crypto" means the incident has a recorded on-chain subject, not that it is a crypto story. Editor revisions in the dashboard.          | Round-up generation from a selection through the rundown template; later, article writing from the full text of every source; an owner-only capability; an editor over revisions; copy-ready output. |

The release integration report's production blockers (`docs/RELEASE-INTEGRATION-REPORT.md`
section 15): blockers 1, 2 and 4 have correction commits on `main` (`67e3941`, `587b4ee`,
`b5c162f`), none audited; blockers 3, 5, 6 and 7 remain open in whole or in part.

## 3. Decisions taken on 16 September 2026

These are the owner's decisions from the planning conversation, with their grounds. They are
recorded here first and transcribed into `docs/DECISIONS.md` as the next free numbers by
CAS-001 step 2, so that they exist where a third party can contest them. Numbers are reserved
in `DECISIONS.md` at transcription, never assumed here.

| Ref | Decision                                                                                                                                                                                                                                                                                                                                        | Ground                                                                                                                                                                                                 | Class              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| P-1 | Hosting stays on Railway, upgraded to the Hobby plan. D8 is resolved this way.                                                                                                                                                                                                                                                                  | The measured database (527 MB) already exceeds the free volume (0.5 GB); Hobby (5 GB) gives roughly nine times headroom; the Dockerfile, health check and pre-deploy migration already target Railway. | Cost judgment      |
| P-2 | Google Sheets is the intake. The CSV transport of D20 becomes the fallback, not the path.                                                                                                                                                                                                                                                       | The owner maintains the ledger in Sheets. The read-only, file-scoped connector already exists and was built for this workbook.                                                                         | Owner's fact       |
| P-3 | Each hackathon-only component receives an explicit disposition, keep, park or remove, decided by the owner in CAS-006. Nothing is removed before that decision.                                                                                                                                                                                 | No vendor allegiance after the event; silent deletion is a named failure mode and is forbidden.                                                                                                        | Owner's decision   |
| P-4 | Two output types, produced by a model from a selection: the round-up through the rundown template, built first; the article written from the full text of every source, built second. This resolves the direction of D9, not its parameters (model, settings, cap), which CAS-004 closes for the round-up and CAS-005 revisits for the article. | The owner's product statement of 16 September, including the correction that reformatting is one specific article type and writing an article is a different act.                                      | Owner's decision   |
| P-5 | Round-up generation, article generation and editing of either are capabilities of the owner's account only.                                                                                                                                                                                                                                     | The owner's product statement. The dashboard's role table is deny by default (D28), so a capability granted to one role is the existing mechanism.                                                     | Owner's decision   |
| P-6 | Publication to Substack stays a manual act by the owner.                                                                                                                                                                                                                                                                                        | The owner's product statement. It also keeps the human step between generation and publication that D3 preserves.                                                                                      | Owner's decision   |
| P-7 | Any outbound fetch of a source page obeys the contract in `docs/FETCH-POLICY.md`; it is PROPOSED until CAS-005 records it at S0 with the two owner decisions it lists.                                                                                                                                                                          | The fetch is a new outbound boundary from the deployed service; without the address, resolution, redirect and size rules a feed URL can aim the service at the hosting network.                        | Security necessity |

## 4. What a TCU is in this repository

A **Technical Capability Unit** is one bounded scope with one primary engineer, one independent
reviewer, and one merge authority, that moves through the states **Queued → Ready → Active →
Review → Complete**, with **Blocked** recording the state from which work stopped. Roles for
every unit: Claude Code implements on a branch; Codex reviews independently; the owner decides
scope and merges by hand. Work in progress is at most one active unit and one unit awaiting
review; a unit under rework occupies the active slot.

The reason this repository uses TCUs, in the owner's words: if the owner asks for an app and does
not explicitly say "build the framework", the framework is not guaranteed to be built. A TCU
therefore carries a fixed list of standard steps that every unit must complete whether or not
anyone remembered to ask for them. The list is written once, here, and repeated verbatim in
every tracker.

### 4.1 The standard steps

Derived from the build phases and security baseline the owner has fixed for every build, and
from this repository's own conventions (numbered migrations, decision log, clean-checkout
verification, independent audit).

| Step | Name                     | Done means                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0   | Scope and decisions      | The unit's boundary is written: what is in, what is out, which files will be touched, which will not. Every decision the unit needs is reserved by number in `docs/DECISIONS.md` and recorded with its ground before code depends on it. No default is guessed for an unresolved field.                                                                                                |
| S1   | Stack check              | `package.json`, `pnpm-workspace.yaml` and the pinned toolchain (Node 24.21.0, pnpm 11.10.0) were inspected before any code. A new dependency is named with its exact version, its reason, and the rejected alternative; the lockfile is updated in the same commit. No framework, library or pattern is introduced that the repository does not already use, without its own decision. |
| S2   | Data contract            | Any schema change is the next free migration number, forward-only, never an edit of an applied migration; its checksum is recorded. Any new contract lives in `@cas/contracts` or the owning package with a versioned identifier and hash.                                                                                                                                             |
| S3   | Reference implementation | The smallest module that proves the unit's mechanism exists and runs to exit 0 from a clean clone, before any interface is built on it.                                                                                                                                                                                                                                                |
| S4   | Tests                    | Unit tests for the invariants; failure-mode tests for malformed input, missing configuration, absent network and absent credentials; PostgreSQL tests for anything that touches the database. Counts are taken from the runner, never estimated.                                                                                                                                       |
| S5   | Interface wired          | The command or page the owner touches calls the real implementation. No handler returns fabricated data. Any stub throws with a fixed message and carries a loud marker. An end-to-end proof is recorded: the exact command and its output, or the request and its response.                                                                                                           |
| S6   | Security baseline        | Secrets come from the environment only and never appear in output, logs, chat or commits. Every input is validated at its boundary. Every protected operation checks authorization at the resource, deny by default. Limits are enforced where input is read. Audit events carry identifiers and fixed codes, never content. `pnpm audit` is clean at low.                             |
| S7   | Documentation            | `README.md` status, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and the unit's own report are current. Every limitation and seam is named where a reader would otherwise be misled, not only in a limitations section.                                                                                                                                                                 |
| S8   | Verification             | `corepack pnpm verify` and `corepack pnpm test:db` pass in a clean checkout of the exact final commit; CI is green on that commit. The diff is narrated: files touched, added, removed, renamed. Nothing was deleted without the owner's explicit consent in the same conversation.                                                                                                    |
| S9   | Review and acceptance    | Codex reviews the exact commit independently; every finding is closed or explicitly accepted by the owner; the evidence table in the tracker is complete; the owner merges. Until then the tracker says "not audited" in those words.                                                                                                                                                  |

Rules:

- A tracker cannot move to **Complete** with an unchecked standard step.
- A step that does not apply is marked `N/A` with a one-line reason. It is never deleted.
- Each step in a tracker is tagged `[HUMAN]`, `[CLAUDE]` or `[CODEX]` for who performs it.
- Every claim of fact in a tracker carries a file and line, a runnable command, or the word
  **unverified**.

## 5. TCU backlog

Sequence: CAS-001 → CAS-002 → CAS-003 → CAS-004 → CAS-005 → CAS-007 → CAS-008. CAS-006 runs
in parallel as the second slot and never blocks the sequence. CAS-009 is queued and is not
admitted until CAS-007 is Complete and the owner opens it. Nothing is built for other accounts
(CAS-007 onward) before the owner's weekly flow (CAS-001 to CAS-005) works end to end.

### CAS-001: Hosting and intake

**Tracker:** `docs/tcu/CAS-001.md`, then its GitHub issue.

- **Objective.** The current feed tab of the owner's workbook reaches PostgreSQL on Railway
  Hobby by one command, idempotently, with the same provenance the CSV importer records.
- **In scope.** Railway Hobby upgrade; Google Cloud service account with the Sheets read-only
  scope only, shared as Viewer on the one workbook; live inventory and timestamp report; a
  worker command that reads the current feed tab and writes a batch with `DataOrigin` `live`
  through the existing two-pass import and idempotency key; the weekly import runbook;
  transcription of P-1 to P-6 into `docs/DECISIONS.md`.
- **Out of scope.** Historical weekly tabs (they are calibration data for CAS-002);
  classification; any dashboard change; any change to the CSV importer's behaviour.
- **Depends on.** Nothing.
- **Decisions to close.** P-1 and P-2 transcribed; D8 resolved as Railway Hobby; D7b amended to
  name Sheets as the transport with CSV as fallback.
- **Acceptance, falsifiable.** From a clean checkout with `GOOGLE_APPLICATION_CREDENTIALS`,
  `GOOGLE_SHEETS_SPREADSHEET_ID` and `DATABASE_URL` set: one command creates a batch from the
  current feed tab with origin `live`; the same command a second time creates no new rows and
  reports the idempotent outcome; the run refuses a workbook whose digest is not the pinned
  one; `DATABASE_URL` and the spreadsheet identifier appear in no output; the database size
  after import is recorded and is under 5 GB with the headroom stated.
- **Known seams.** No scheduler; the first real import runs from the owner's machine against
  the Railway database. Scheduling is CAS-003's decision.

### CAS-002: Categories

**Tracker:** `docs/tcu/CAS-002.md`, then its GitHub issue.

- **Objective.** Every imported story receives a decision per category, beginning with
  cyberattack and crypto, and adding a category is a policy change with tests, not a code
  change across packages.
- **In scope.** A category contract (identifier, version, hash) alongside the existing signal
  policy; a classifier run that emits one decision per category per row; a migration that
  stores the category with each result; the review queue filtered by category; calibration
  of the cyberattack category against CS79 and CS86 as before; calibration of the crypto
  category against a labelled set the owner provides, or an explicit record that crypto
  recall is unmeasured in v0.
- **Out of scope.** Round-up or article generation; any change to clustering's grouping
  rules; a model call, unless the owner decides at S0 that classification uses one (that
  would reopen D9's parameters and D21).
- **Depends on.** CAS-001 (real data in the database).
- **Decisions to close.** Whether category classification stays deterministic (D21 amendment)
  or uses a model (D9 parameters). Recommendation, as a cost judgment: deterministic rules per
  category first, because the cyber rules already exist and calibrate; a model-assisted pass
  is a later unit if recall is insufficient.
- **Acceptance, falsifiable.** A classification run on the real ledger writes a decision for
  every row and every category; retention recall for cyberattack against CS79 and CS86 is
  reported as counts; a third, fixture-only category added in tests requires no change outside
  the policy package and its tests; the queue shows one category at a time.
- **Known seams.** Crypto recall depends on a labelled set that does not exist yet.

### CAS-003: Weekly run and sift table

**Tracker:** `docs/tcu/CAS-003.md`, then its GitHub issue.

- **Objective.** One command runs the editorial week (import, classify, cluster) for a fixed
  window, and the dashboard shows a category-filtered table of clustered stories where the
  owner selects the stories for the issue.
- **In scope.** D10 resolved (week start, end, timezone, late-arrival rule); a `week run`
  orchestration command that records a run manifest naming every child run; a table page with
  category filter, search, sort and selection; a persisted, append-only issue selection record
  bound to the clustering run and the source rows; a `select:stories` capability; the
  scheduling decision (Railway cron service, or manual from the owner's machine).
- **Out of scope.** Any generation; any change to how incidents are formed.
- **Depends on.** CAS-002.
- **Decisions to close.** D10; scheduling; whether selection is per incident or per source row
  (recommendation: per incident, with its member rows carried as provenance).
- **Acceptance, falsifiable.** For a fresh week, one command and one table produce a persisted
  selection whose every entry traces to source rows; the selection survives reload and a
  second browser; an account without `select:stories` sees no selection control and a direct
  request is refused with a fixed code; the run manifest reproduces the same child runs on a
  second execution over the same window.

### CAS-004: Round-up generation through the rundown template, and the owner editor

**Tracker:** `docs/tcu/CAS-004.md`, then its GitHub issue.

- **Objective.** From a persisted selection, generate a round-up by filling the rundown
  template with a model, for a cyberattack or a crypto selection alike, editable by the owner
  alone, exported as copy-ready Markdown.
- **What a round-up is.** The selected stories, reformatted into the template's entry format,
  cleaned and deduplicated, in the template's order. It is the article type the owner produces
  today with Claude. It is not an original article; the model reformats recorded fields and
  invents nothing.
- **In scope.** D9 closed for this output type (model identifier, settings, prompt contract,
  spend cap, provenance record); the rundown template as a versioned, hashed file the owner
  can edit; an owner role or account flag carrying `generate:roundup` and `edit:output`; a
  server-side generation service that receives only the selected stories' recorded fields
  (title, summary text, publisher, URL, category, incident grouping) and returns the
  template's slots with per-entry source citations; the deterministic draft kept as revision
  0 and the generated round-up stored as revision 1 with model identifier, prompt hash,
  template hash and input digest; owner edits as later revisions under the existing
  optimistic concurrency; a copy-ready export; golden tests over recorded model responses; a
  fail-closed test with the key absent.
- **Out of scope.** Reading source articles in full; original prose beyond the template's
  slots; posting to Substack; images; generation for any other account.
- **Depends on.** CAS-003.
- **Decisions to close.** D9 parameters for the round-up; D4's naming rule applied to
  generated entries; the owner-role mechanism; the rundown template's first version, supplied
  by the owner as structure only.
- **Security necessity.** Every generated entry cites source rows from the selection, and a
  citation outside the selection rejects the whole response. Without this the provenance
  chain the repository enforces from import to draft breaks at the last step.
- **Acceptance, falsifiable.** The owner selects stories, requests a round-up, and receives an
  editable round-up in the template's structure naming every source it used; the same flow
  works for a crypto selection with the same template; a non-owner account sees no control
  and a direct request is refused with a fixed code; the cost of each generation is recorded
  as an audit event; with the key absent the request fails closed with a fixed message and
  writes nothing; a recorded response whose citation names a row outside the selection is
  rejected in a test.
- **Known seams.** Model output is not deterministic; regression is by recorded responses.

### CAS-005: Article writing from the full sources

**Tracker:** `docs/tcu/CAS-005.md`, then its GitHub issue.

- **Objective.** From a persisted selection, read every source in full and write an original
  article in a tech reporter's register, editable by the owner alone, exported as copy-ready
  Markdown.
- **What an article is.** Not a round-up. The model reads the full text of every source of the
  selected stories and writes original prose from them, with a headline, a standfirst and
  body paragraphs, each paragraph citing the sources it rests on.
- **In scope.** A source-reading boundary: at generation time the service fetches the full
  text of each selected story's URL under a fetch policy (`http` and `https` only, no
  credentials in the URL, no private or reserved address, every redirect refused or
  re-checked, bounded body bytes, a deadline, a fixed refusal for each failure), then extracts
  text; an owner decision on where fetched text lives and for how long, recorded in
  `docs/DATA_CLASSIFICATION_RETENTION.md`; the article contract and its schema; the reporter
  register as a versioned, hashed prompt; D9 parameters revisited for the larger context; the
  same owner-only mechanism as CAS-004 with `generate:article`; revision storage, editor and
  export reused from CAS-004; tests with recorded pages and recorded responses; failure modes
  for a refused fetch, an unavailable source, an oversize page and a timeout, where an
  unavailable source is reported as missing and never invented around.
- **Out of scope.** The round-up; posting to Substack; images; any fetch that is not for a
  story in the selection.
- **Depends on.** CAS-004.
- **Decisions to close.** The fetch policy, written as `docs/FETCH-POLICY.md` (P-7) and
  adopted at S0; its owner decisions O-1 (storage and retention of fetched text), O-2
  (publisher terms and `robots.txt`) and O-3 (the user-agent string), with options and a
  recommendation in that document's section 6; the reporter register; D9 parameters for the
  article.
- **Security necessity.** The fetch is a new outbound network boundary from the deployed
  service. Without the address and redirect rules above, a crafted URL in the feed turns the
  generator into a request forger against the hosting network. The reference policy already
  written for the MCP server (`packages/mcp-server/src/safety/reference.ts`) is the starting
  point, and the resource limits of `resource-limits@1` the bound.
- **Acceptance, falsifiable.** The owner selects stories, requests an article, and receives an
  editable article whose every paragraph cites sources from the selection; a source that
  could not be fetched appears in a fixed "not read" list and nowhere in the prose; a URL
  resolving to a private address is refused with a fixed code and no request is made; a
  non-owner is refused; cost and page counts are recorded as audit events; the key absent
  fails closed.
- **Known seams.** Source pages change; a recorded page is the regression fixture, not the
  live page.

### CAS-006: Debt, audits and dispositions

**Tracker:** `docs/tcu/CAS-006.md`, then its GitHub issue.

- **Objective.** The repository tells the truth about itself and carries no unreviewed
  production risk it has not named.
- **In scope.** `README.md` status rewritten to match `main`; an audit ledger listing every
  track with its exact audit state; the open release blockers 3, 5, 6 and 7 dispositioned;
  an owner disposition for each hackathon-only component (`@cas/graph-evidence`, the evidence
  and anomaly layer, `apps/payer-agent`, `packages/feed-api`, `packages/mcp-server`,
  `apps/sunday-agent`); the owner's decision on staying public under Apache-2.0 or going
  private; the owner-only GitHub settings (secret scanning, push protection, Dependabot
  alerts and security updates, branch protection on `main`); a verified restore of a Railway
  database backup; the Sheets doc's status line corrected once CAS-001 records the service
  account.
- **Out of scope.** New features.
- **Depends on.** Nothing; it occupies the second slot.
- **Decisions to close.** P-3 per component; public or private.
- **Acceptance, falsifiable.** The README status section names `main`'s commit and the exact
  audit state of each track; every blocker row has a disposition and evidence; any removed
  component is removed in its own reviewed commit that names every file; a backup was restored
  to a scratch database and its row counts matched.

### CAS-007: Reader access

**Tracker:** `docs/tcu/CAS-007.md`, then its GitHub issue.

- **Objective.** Anyone can request an account on the owner's instance with an email address
  alone; the owner approves each request; an approved reader holds the `reader` role and sees
  public incident metadata only.
- **What exists today.** Passwordless sign-in by one-time code over the Resend email provider
  (`apps/dashboard/src/server/auth/email-config.ts`); accounts provisioned by an admin only;
  an unknown address receives the same generic response as an unapproved one
  (`apps/dashboard/src/server/auth/email.ts`); roles `judge`, `editor`, `admin`
  (`apps/dashboard/src/server/auth/roles.ts`); throttling on sign-in.
- **In scope.** A sign-up request page: the address, then the code that proves the requester
  holds it, then a pending request record; rate limits on requests per address and per network
  source; a pending-approvals page for the admin with approve and deny, each an audit event; a
  `reader` role written out in full, starting from the judge role's sanitized read-only set;
  an approval email through the existing provider; account expiry rules for readers; a
  migration for sign-up requests; tests for a flood of requests, code brute force, approval by
  a non-admin, a reader reaching an editor or owner page, and source text never crossing the
  wire to a reader.
- **Also in scope: scrape and crawler protection.** Rate limits on every unauthenticated route
  and on reader reads per account; a `robots.txt` served by the instance that disallows known AI
  crawlers, a convention they may ignore, so the limits are the protection; the same limits on
  any public API if one is ever exposed. The cost drivers are the email provider, the model and
  the hosting bill.
- **Out of scope.** Payments; cards; any change to the owner's capabilities; changes to what
  editors see.
- **Depends on.** CAS-005, by the rule that nothing is built for other accounts before the
  owner's weekly flow works.
- **Decisions to close.** What a reader sees, page by page, within D6's allowlist; whether the
  `judge` role is retired into `reader` or kept, settled together with CAS-006's dispositions;
  reader account expiry.
- **Security necessity.** Sign-up is an unauthenticated entry point that sends email. Without
  per-address and per-source limits it is a mail cannon at the owner's cost; without generic
  responses it enumerates accounts; without a deny-by-default reader role it leaks editorial
  content. The existing sign-in discipline is the pattern.
- **Acceptance, falsifiable.** A stranger requests access with only an email address and
  learns nothing about whether it was known; the owner sees the request, approves it, and the
  reader signs in with a code and sees only the allowed pages; a burst of requests from one
  source is throttled with a fixed response; a reader requesting an editor or owner page is
  refused with a fixed code; a reader's page responses contain no source text.

### CAS-008: Supporter tier and donations

**Tracker:** `docs/tcu/CAS-008.md`, then its GitHub issue.

- **Objective.** Reading stays free. A paid supporter tier and one-off crypto donations exist,
  and neither gates anything a reader needs. Payment is a support mechanism, not access
  control, as `docs/SECURITY.md` section 5 already states for the hackathon's x402 gate.
- **In scope.** The fiat provider decision, made without vendor allegiance at S0, with
  provider-hosted checkout so no card data ever touches the service; webhook handling with
  signature verification, idempotency and append-only supporter status; a donation page that
  shows the owner's crypto addresses, pinned in a policy file the way the workbook digest is,
  so that changing an address is a reviewed commit and not a configuration edit; audit events;
  tests for a replayed webhook, a forged webhook, and a supporter and a free reader seeing the
  same content unless the owner decided a grant.
- **Out of scope.** Any on-chain contract; the hackathon's x402 payer agent, whose disposition
  is CAS-006's; cards.
- **Depends on.** CAS-007.
- **Decisions to close.** The fiat provider; what the tier grants, if anything, beyond support;
  which chains and addresses accept donations. Recommendation for donations, a cost judgment:
  static addresses with a QR code, verified as the owner's and pinned; no contract, no
  third-party donation widget.
- **Acceptance, falsifiable.** A reader starts a subscription through provider-hosted checkout
  and returns as a supporter after the webhook; a replayed webhook changes nothing; a forged
  webhook is refused and logged as a fixed code; the donation page shows the pinned addresses
  and nothing else; changing an address requires a commit.

### CAS-009: Shareable story cards (queued)

**Tracker:** `docs/tcu/CAS-009.md`, then its GitHub issue.

- **Objective.** A reader picks stories and receives a shareable card.
- **Admitted when.** CAS-007 is Complete and the owner opens this unit. The owner designs the
  creatives; this unit builds the functionality only.
- **Decisions before any build.** Which fields are public (D6's allowlist governs); how the
  card is rendered; whether third-party headlines may appear on a card; what is measured.
- **Nothing else is specified here.** The unit is a placeholder with its decisions listed so
  the idea is not lost.

## 6. Interruption tolerance

Every tracker step is resumable on its own. When a unit is suspended, the tracker records the
current state and the restart condition before anything else is picked up, so that a gap of
days costs a re-read, not a redo.

## 7. Teaching model

The owner performs the work. The issues are the step-by-step list. Each step gets a live
walk-through in a Claude session, in this shape:

1. The owner names the step.
2. Claude states what the step does in plain language, lists the files it will touch before
   touching any, and says what will be verified.
3. The owner runs the commands. Claude annotates each command, code block and diff with one
   plain-language line saying what it does.
4. The evidence (the command and its output, counts from the runner, the commit) goes into the
   tracker's evidence table.
5. At S9 the owner asks Codex for the independent review and links the report.

## 8. Open questions

| Question                                                                                                                                        | Owner | Closed in |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- |
| Model, settings and spend cap for the round-up (D9)                                                                                             | owner | CAS-004   |
| The rundown template's first version, as structure                                                                                              | owner | CAS-004   |
| Editorial week start, end and late-arrival rule (D10)                                                                                           | owner | CAS-003   |
| Does a labelled crypto weekly set exist, or is crypto recall unmeasured in v0?                                                                  | owner | CAS-002   |
| Scheduled run on Railway, or manual from the owner's machine?                                                                                   | owner | CAS-003   |
| Fetch-policy decisions O-1, O-2 and O-3 (`docs/FETCH-POLICY.md` section 6); the reporter register                                               | owner | CAS-005   |
| Disposition of each hackathon-only component                                                                                                    | owner | CAS-006   |
| Stay public under Apache-2.0, or go private now that the hackathon rule no longer applies? Versions already published stay licensed either way. | owner | CAS-006   |
| What a reader sees, page by page, within D6's allowlist; reader account expiry                                                                  | owner | CAS-007   |
| The fiat payment provider; what the supporter tier grants; which chains and addresses accept donations                                          | owner | CAS-008   |
