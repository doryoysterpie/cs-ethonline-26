# CAS-003 report: weekly run and sift table

Unit tracker: `docs/tcu/CAS-003.md`; live status: issue #5. Branch `cas-003/weekly-run` from
`main` at `742ada1`. This report grows one section per step. Nothing in it marks a test as
passed until the runner's own counts are recorded here. Audit state: not audited.

## 1. Design note, S0, written before code (step 4)

Written 22 October 2026 from the code on `main` at `742ada1` and the owner's decisions of the
same day: the D10 resolution, D37 and D38 in `docs/DECISIONS.md`. Every claim below names its
file or the record it rests on.

### 1.1 What the command does, in one paragraph

`week run --window <isoStart>..<isoEnd>` runs one editorial week: it imports the living feed
tab (or takes a batch already imported, `--batch`), classifies that batch once per registered
category, clusters each classification run, and records a manifest that names the window, the
batch and every child run with its outcome. Every child is idempotent on its own identity
(content digest, ruleset hash, clustering contract), so a second execution over the same window
and the same tab content reuses every child and reports the manifest it already wrote. The
window is validated against D10 before anything runs. Output is counts and identifiers; no
cell, title or URL is printed.

### 1.2 The window, D10, and how it is validated

A window is `<isoStart>..<isoEnd>` as the existing `parseWindows` accepts it, then checked
against the resolved D10: both bounds fall on a Saturday at 23:59 in `America/Toronto`, and the
end is the next Saturday after the start (seven days in that zone, DST-aware, computed with
`Intl.DateTimeFormat`, no dependency). The freeze is the end; the publication cutoff is the
following Sunday 23:59 in the zone, derived and recorded on the manifest, never typed. A window
that fails the rule is refused before any child runs with the fixed code `window_outside_rule`;
a missing window is `window_required`. No week is ever inferred from the clock.

### 1.3 The child sequence, and what is idempotent

1. **Import.** `importSheetsTab` over the committed tab map (CAS-001), origin `live`. Its own
   idempotency, a digest of exactly what was read, decides whether a batch is created or
   reused. With `--batch <uuid>` the import is not run and the named batch is used; the
   manifest records the child as `provided`. This is the path the tests use (no network) and
   the path for a batch imported earlier in the day.
2. **Classification**, one run per registered category (CAS-002), in registry order, each
   idempotent on (batch, category, classifier, ruleset, hash). `--categories <a,b>` restricts
   the set; a name that is not registered is refused as `category_invalid` before anything
   runs.
3. **Clustering**, one run per classification run (Sprint 4), idempotent on the classification
   run and the clustering contract.

The import runs before the manifest exists, because the manifest names the batch and an import
that fails leaves nothing to name: an import failure is reported with the import's own code and
no week run is written, which is "nothing partial" by construction. From the manifest onward,
every child outcome is recorded.

### 1.4 The manifest record: migration 0014

Two append-only tables, in the repository's schema-security pattern (`pg_catalog.format`,
quoted identifiers, `search_path = pg_catalog, <schema>, pg_temp`, no SECURITY DEFINER).

`week_runs`: `id`, `data_origin`, `batch_id` (composite key to `import_batches`), `time_zone`,
`window_start`, `window_end`, `freeze_at` (= `window_end`), `publication_cutoff_at`, the
sorted `categories` the run covered (jsonb array of identifiers), `idempotency_key` (SHA-256
of the canonical JSON of window, zone, batch and categories), `status` (`running`,
`completed`, `failed`), `failure_code`, `started_at`, `completed_at`. Checks bind status to
completion and failure to a code. A guard permits exactly one transition, `running` to
`completed` or `failed`, setting the completion fields and nothing else, and refuses every
other update and every delete, like `classification_run_guard`. Completed manifests are unique
per key through a partial unique index (`WHERE status = 'completed'`), so a failed attempt
stays as history and a retry over the same window and batch can proceed; two concurrent
attempts resolve as the classification runner does, the loser reporting the winner.

`week_run_children`: `week_run_id`, `position`, `kind` (`import`, `classification`,
`clustering`), `category` (null for the import), `batch_id`, `classification_run_id`,
`clustering_run_id`, `outcome` (`created`, `reused`, `provided`, `failed`), `error_code`,
`created_at`. Exactly one identifier column is set per kind (a check), each a composite
foreign key to its table; `(week_run_id, position)` and `(week_run_id, kind, category)` are
unique. Append-only.

### 1.5 Failure behaviour

A child that throws ends the run: the children recorded so far stay recorded, the manifest
transitions to `failed` with the child's fixed code, the command exits with that child's exit
code, and nothing claims completion. The child runs that did complete are real, reconciled runs
in their own tables; the manifest simply does not vouch for the week. A rerun creates a new
manifest, reuses the completed children, and continues from the one that failed.

### 1.6 The selection record, D38: migration 0014

`issue_selections`: `id`, `week_run_id`, `clustering_run_id`, `batch_id`, `incident_id`
(composite key to `incident_clusters (id, clustering_run_id, batch_id)`, which migration 0006
declared), `category`, `state` (`selected`, `unselected`), `revision` (one more than the last
record for the same manifest and incident; unique per manifest, incident and revision),
`actor_account_id` (to `accounts`), `note` (nullable, bounded), `created_at`. Append-only:
unselecting is a new record, the table reads the latest revision per incident.

`issue_selection_members`: the incident's member rows at the time of selection, as references:
`selection_id`, `membership_id` with `clustering_run_id` (composite key to
`incident_memberships (id, clustering_run_id)`), `source_row_id`, `batch_id`, `row_hash`
(composite key to `source_rows`). No text is copied. Append-only. This is the provenance D38
asks for: a selection traces to its incident and to every source row behind it.

### 1.7 The sift table

Pages: `/week`, the manifests latest first with their window, categories and status; and
`/week/<id>?category=<c>`, the table for one week and one category at a time, read through a
new data-access function under the existing `view:incidents` capability. Rows are the
incidents of that category's clustering run which belong to the week:

- **In the window:** at least one member row posted inside `(window_start, window_end]` and
  first seen no later than the freeze.
- **Carried:** no member posted inside the window, but at least one posted before
  `window_start` and first seen inside `(window_start, window_end]`; shown with a `carried`
  flag, per the D10 resolution. A row first seen after the freeze belongs to a later week.
- **First seen** is the completion time of the earliest import read that contained the row's
  hash (`sheets_import_reads.read_completed_at`, joined by hash across batches); for a batch
  with no Sheets read (a CSV import) it is the batch's completion time.

Columns: incident, kind, members, representative title (through the existing `Text`
component, only for a principal with `view:source_text`), posted range, carried, selection
state with who and when. Filter by category (one at a time), search on the representative
title (server side, bounded, escaped like every other text), sort by posted time or member
count, both whitelisted values. Selection is a form per row posting to a server action under
the existing same-origin and session-bound token checks, requiring the new capability
`select:stories`, granted to editor and admin in `roles.ts` and to no one else; the action
appends one `issue_selections` record with its member references and writes an audit event
`story_selected` (success or refusal, never content). A judge sees no control and a direct
request is refused with the fixed code `forbidden`.

### 1.8 Files touched, and not touched

Touched: `packages/database/migrations/0014_weekly_run.sql` (new), `packages/database/src/week.ts`
(new) and its index; `apps/worker/src/week/run.ts`, `output.ts` and tests (new),
`apps/worker/src/cli.ts` (the `week run` command, `--window`, `--batch`, `--categories`), the
root script `week:run`; `apps/dashboard/src/server/auth/roles.ts` (`select:stories`),
`store.ts` (the audit kind), `dal/dto.ts`, `dal/read.ts`, `dal/mutate.ts`, the two pages and
one action file; migration-count tests; `docs/RUNBOOK-WEEKLY-IMPORT.md` (the weekly step),
`README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, this report.

Not touched: the importers, the classifier, the clustering rules (out of scope by the plan),
every applied migration, the review tables, the drafting package.

### 1.9 Decisions this design takes within the contract

- The import runs before the manifest, for the reason in 1.3.
- `--batch` is accepted so that tests, fixture data and an already-imported batch run the week
  without the network; the manifest says `provided`.
- Completed manifests are unique per key; failed ones are history.
- "First seen" is defined by the import read, the only timestamp that records when the
  pipeline first held a row; the owner's late-arrival rule needs nothing else.
- No scheduled service (D37); the runbook gains the weekly step.

### 1.10 Verification plan

Offline: window validation against D10 across DST boundaries and the three refusals; the
manifest key; the child plan. PostgreSQL: a complete week over a fixture batch with two
categories (two classification runs, two clustering runs, a completed manifest with five
children), the same window again (every child reused, the manifest reported as already run), a
failing child (manifest `failed`, children recorded, exit code preserved, rerun continues), the
selection record and its member references, the latest-revision read, the capability
refusals, the carried flag on a row first seen after a freeze. Then the full verify loop and
the four database suites, a clean clone, and CI.

## 2. The data contract, S2 (step 5)

Built 22 October 2026. Migration `0014_weekly_run.sql`, checksum
`5cec97eb0c28bcbba5bd030dcf1355041c204bd342e0dfbddc33be3953a67bf3`, as designed in sections 1.4
and 1.6, plus one addition the build needed: `audit_events.kind` is a closed list, so the
migration extends it with `story_selected` the way migration 0011 added `otp_requested`.
Operations in `packages/database/src/week.ts`: the manifest's insert, its one transition, the
completed-key lookup, the list; the children's insert and list; the selection's insert with its
member references, the last revision and the latest-per-incident read; the incident's member
references; and the sift-table read `listWeekIncidents`, which computes first seen as the
earliest import read holding the row's hash (a batch's completion when no Sheets read exists),
and the in-window and carried rules of section 1.7 in one statement. Guard tests in
`week.db.test.ts`: the running-only insert, the one transition, append-only on both tables, the
completed-key uniqueness with a failed attempt as history, and the child identity checks.

## 3. The window, the orchestrator and the command, S3 to S5 (steps 6 to 8)

`resolveWeekWindow` accepts `<isoStart>..<isoEnd>` and checks both bounds are a Saturday at
23:59:00 in the zone and seven local days apart, then derives the freeze and the publication
cutoff; the autumn clock change is a test (a 169-hour window passes, a 168-hour one is refused).
`runWeek` runs the sequence of section 1.3, records every child, marks a failed manifest with
the child's code and rethrows the child's error with the manifest's identifier, and reports
`already ran` with the manifest when the completed key exists; a concurrent completion that
loses the partial unique index reports the winner. The command `week run` composes the feed
import from the committed tab map so the orchestrator never sees the workbook; `--batch` and
`--categories` are checked, with the window, before any connection is opened. Root script
`week:run`.

PostgreSQL tests in `apps/worker/src/week/run.db.test.ts`: a complete week over a provided
batch with two categories (five children in order), the same window again (reused, same
manifest, the key independent of category order), the four refusals before any child, a
failing child through a test seam (manifest `failed`, three children recorded, the rethrown
code carrying the manifest id, a retry that reuses the classification and completes), the sift
query (in window, carried, excluded after the freeze and without a posted time; search; sort;
no title without text), and the selection record (revision sequence, latest read, the wrong
clustering run and the wrong member refused, append-only, the run's hash the category's).
Command-line tests: the three refusals before any connection, no credential echoed.

## 4. The sift table and the selection, S5 (step 9)

`/week` lists the manifests; `/week/<id>?category=<c>&q=<text>&sort=<order>` is the table of
section 1.7, read through `weekTable` under `view:incidents`: the category must be one the week
covered, the search is bounded text compared in the database and never echoed, the sort is one
of two fixed orders, titles cross only with `view:source_text` and notes only with `view:notes`,
and the latest selection per incident names who recorded it. `selectStory` under the new
capability `select:stories` (editor and admin, in `roles.ts`) appends one record with the next
revision and the incident's member references inside one transaction, reports a concurrent
revision as a conflict, and writes `story_selected` to the audit log, success or refusal; the
page's form passes the existing same-origin and session-bound token checks. Because the record
names its actor by foreign key, selection needs the PostgreSQL account store; the memory store of
a local run is refused with `persistent_accounts_required` rather than failing opaquely, and
`Stores` now declares its kind.

Found and fixed on the way: `listAccounts` in `@cas/database` ordered by `pg_catalog.coalesce`,
which is not a function (`coalesce` is a SQL construct), so the PostgreSQL account store's
`list` had raised `42883` since it was written and nothing had read it until the week table
named its selectors. The ordering is now `coalesce(username, normalized_email), id`, and the
store test lists accounts. Data-access tests: the list to every role; the table for editor and
judge; search; the whitelisted sort and category; the selection through a PostgreSQL-store
runtime with real accounts and sessions, its revisions, the judge's refusal, the three wrong
identifiers; and that selection leaves the machine tables' fingerprint unchanged.

## 5. Security baseline, S6, and the counts from the runner (step 11 in part)

No new dependency. No new outbound boundary: the week reads the workbook through CAS-001's
connector and nothing else. The window and the categories are refused before any connection;
the command prints counts and identifiers only. The selection is append-only with its actor
and session by foreign key and an audit event without content; the search never reaches a
page or a log; the category and sort are whitelisted; the capability is held by editor and
admin and by no one else, and `MUTATION_CAPABILITIES` enumerates it for the judge-refusal
tests. No scheduled service and no secret on the hosting platform (D37).

Working checkout, 22 October 2026: `corepack pnpm verify` exit 0, 1,077 offline tests
(worker 274, dashboard 84, database 32), 31 tool tests; `corepack pnpm test:db` exit 0, 296
(database 102, worker 119, dashboard 26, mcp-server 49). Pull request 23.
