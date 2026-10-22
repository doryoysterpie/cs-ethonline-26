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
