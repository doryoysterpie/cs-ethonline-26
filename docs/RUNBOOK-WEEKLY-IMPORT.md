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
