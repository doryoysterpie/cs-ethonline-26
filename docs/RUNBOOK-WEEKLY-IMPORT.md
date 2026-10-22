# Runbook: the weekly import from Google Sheets

The one command that brings the living feed tab of `Cyberattack Sunday - RSS Intake` into
PostgreSQL, what it needs, what it prints, and what each exit code means. CAS-001, step 10.
Audit state of the import path: not audited.

## 1. What the command does

`sheets import` reads the declared feed tab once, in memory, fingerprints exactly what it read,
and writes one import batch through the same row evaluation and write path the CSV importer
uses, with origin `live`. Repeating it while the tab is unchanged writes nothing and reports
the batch an identical read already produced. Every batch holds the whole tab: the ledger is
imported as a snapshot each time, exactly as a CSV export of it is (`docs/CAS-001-REPORT.md`,
section 1.6, names incremental import as the seam).

The tab it may read is declared in `data/policy/sheets-tab-map.json`. A tab that file does not
name is refused, and changing the file is a reviewed commit.

## 2. What it needs

| Need                             | Where it comes from                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GOOGLE_SHEETS_SPREADSHEET_ID`   | the environment; the workbook whose digest is pinned in `data/policy/authorized-workbook.json`            |
| `GOOGLE_APPLICATION_CREDENTIALS` | the environment; an absolute path to the service-account key, outside the repository, owner-only, no link |
| `DATABASE_URL`                   | the environment; the target database, migrated to the current migration                                   |
| a built worker                   | `corepack pnpm install --frozen-lockfile`, then the command builds what it needs                          |

The command reads only the shell environment. Load a local `.env` into the shell first:

```bash
set -a; . ./.env; set +a
```

No value from the environment is ever printed: the spreadsheet identifier and the credential
are registered with the output redactor before the first line is written.

## 3. The command

```bash
corepack pnpm db:migrate
```

Applies any pending migration and verifies checksums; a no-op when the database is current.

```bash
corepack pnpm sheets:import --tab "Cyberattack Sundays"
```

Reads and imports the feed tab. Count-only output; no cell, URL or headline appears.

## 4. What success prints

Two blocks. The first names the read, the second the batch exactly as a CSV import reports one.
Recorded from the local run of 21 October 2026, digests shortened as the command prints them:

```text
sheets:import: workbook=eb8c5fd7a7d7 tab=Cyberattack Sundays tabDigest=a8459fa99eeb rowsRead=28596 pages=58 serials: converted=0 unconvertible=0 read=...
editorial:import: imported batch=<uuid> status=completed kind=master origin=live label=- file=Cyberattack Sundays sha256=<64 hex> bytes=134922672
rows: parsed=28596 accepted=28596 quarantined=0; stored total=28596 accepted=28596 quarantined=0
issues: none
review snapshot: none (master import)
url groups: rowsWithGroup=28596 distinctGroups=28228 duplicateExcess=368
timing: started=... completed=... durationMs=29237
```

A second run over the unchanged tab prints `already imported as batch=<uuid>; no rows written`
and the same counts. `serials: converted=0` is expected for this workbook: its timestamp cells
are text in strict ISO 8601 form, which the importer accepts as it is; the serial-to-instant
rule applies only to a cell that is a day count.

## 5. Exit codes

| Code | Meaning                                                                                                       | What to do                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 0    | Imported, or already imported.                                                                                | Nothing. Record the batch id if the run is evidence.                                  |
| 2    | Configuration: a variable missing, the tab not declared or not found, the key unreadable, a policy malformed. | Fix the environment or the policy file. Nothing was read from the database.           |
| 3    | Structural: a header changed, the tab is empty or not a grid, a row wider than the declaration, a bound hit.  | Inspect the workbook with `sheets:inventory`; nothing was written.                    |
| 4    | Database: the connection failed or a statement was refused.                                                   | Check `DATABASE_URL` and `db:check`; the batch was rolled back.                       |
| 5    | Unexpected: an invariant the importer checks failed, such as a stored row not matching its evaluation.        | Report it with the fixed error line; the batch was rolled back.                       |
| 124  | The command deadline expired.                                                                                 | The batch was rolled back; rerun, or raise nothing: the deadline is a resource limit. |
| 130  | Interrupted.                                                                                                  | The batch was rolled back; rerun.                                                     |

## 6. After the import

- The batch's provenance is in `sheets_import_reads` (one row per batch: digests, tab, zone,
  read times, pages) and `sheets_import_timestamps` (one row per converted serial, bound to
  its source row). Both are append-only.
- The next stages read the batch like any other: `classify:run`, then clustering, as the
  weekly run of CAS-003 will chain them.
- Database size grows by roughly the size of the ledger per import; record
  `pg_database_size` after each real run until CAS-003 decides incremental import.

## 7. The weekly run (CAS-003, D37: manual, from the owner's machine)

One command runs the editorial week over the window D10 resolved: from one Saturday at 23:59 to
the next Saturday at 23:59, `America/Toronto`. The command imports the living feed tab (the same
read as section 3), classifies the batch once per registered category, clusters each
classification run, and records a manifest naming every child run. Nothing is scheduled; the
owner runs it after the Saturday close.

```bash
corepack pnpm week:run --window 2026-10-18T03:59:00Z..2026-10-25T03:59:00Z
```

The window is given as instants; both must fall on a Saturday at 23:59 in the editorial zone
(03:59 UTC in October, 04:59 UTC once clocks change) and seven local days apart, or the command
refuses with `window_outside_rule` before anything runs. `--batch <uuid>` runs the week over a
batch imported earlier the same day instead of reading the workbook again; `--categories a,b`
restricts the categories (every registered category by default).

Success prints the manifest identifier, the window with its freeze and publication cutoff, the
categories, one line per child with its kind, category, identifier and outcome (`created`,
`reused`, `provided`), and the timing. Counts and identifiers only. A second execution over the
same window and the same tab content prints `already ran` with the same manifest.

Exit codes are section 5's. A child that fails ends the run with that child's exit code; the
manifest is recorded as `failed` with the child's code and stays as history, the children that
completed stay recorded, and the same command run again continues from the one that failed.

The sift table is then at `/week` on the dashboard: one row per week run, the table for one
week and one category at a time, selection per incident for an account that holds
`select:stories` (editor or admin). Selection needs the PostgreSQL account store, the deployed
configuration; a local run with the memory store refuses it with `persistent_accounts_required`.

## 8. The round-up (CAS-004: the owner, from the dashboard)

After the selection for a week and a category is made, the round-up page is linked from the sift
table (`/week/<week run>/roundup?category=cyberattack`, or `crypto`). It shows the template's
version and hash, the month's model spend against the USD 25 cap, and the selected incident
count. "Generate round-up" is shown to the `owner` role only and only while no revision exists;
it sends the selected stories' recorded fields to the model D9 resolved and stores the
deterministic draft as revision 0 and the generation as revision 1, with the cost. The page then
shows the latest revision as copy-ready Markdown; the owner edits it in place and saves the next
revision, then copies the text into Substack by hand. Nothing is published by the dashboard.

The generation needs the PostgreSQL account store and `ANTHROPIC_API_KEY` in the dashboard's
environment; without the key the control reports `model_key_missing` and writes nothing, and
without the store it refuses with `persistent_accounts_required`. A second generation for the
same week and category is refused (`roundup_already_generated`); edit instead. When the month's
recorded spend plus the request's worst case would pass the cap, the request is refused
(`spend_cap_exceeded`) and recorded as such; the cap resets with the calendar month.
