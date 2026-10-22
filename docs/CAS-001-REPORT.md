# CAS-001 report: hosting and intake

Unit tracker: `docs/tcu/CAS-001.md`; live status: issue #3. Branch `cas-001/sheets-intake`
from `main` at `ce8e367`. This report grows one section per step. Nothing in it marks a test
as passed until the runner's own counts are recorded here. Audit state: not audited.

## 1. Design note, S0, written before code (step 6)

Written 17 September 2026 from the code on `main` and the live reads of 16 September
(issue #3, evidence comment). Every claim below names its file or the command that showed it.

### 1.1 What the command does, in one paragraph

`sheets import --tab "Cyberattack Sundays"` reads the living feed tab of the authorized
workbook once, in memory, computes a digest of exactly what it read, and writes one import
batch through the same row evaluation and write path the CSV importer uses, with
`DataOrigin` `live`. Repeating the command while the tab is unchanged writes nothing and
reports the original batch. The tab's editorial stage is declared by a committed policy file,
never inferred. No URL is fetched, no cell is printed, and the spreadsheet identifier appears
in no output.

### 1.2 Which tab is the feed, and how it is declared

The inventory of 16 September reported 83 tabs. Tab 0, `Cyberattack Sundays`, declares 24,613
rows and carries the nine headers of the master export exactly: `ch`, `Date Posted`,
`Date Updated`, `Title`, `Author`, `Description`, `Summary`, `URL`, `Category`. The timestamp
report read 24,608 rows from it, all usable, and the dry-run as `rss_source_corpus` would emit
all 24,608 with no blank row and no duplicate identity. Every other tab is a weekly
candidate cut-down and is out of this unit's scope.

The connector's rule is that a tab's lineage stage is never inferred
(`packages/sheets-intake/src/reader.ts`, `TabMapping.stage`). The configuration reads a
`GOOGLE_SHEETS_TAB_MAP` path (`packages/sheets-intake/src/config.ts`) but nothing parses such
a file yet; the dry-run takes the stage from a command-line flag. This unit therefore adds the
approved mapping as a committed policy file, `data/policy/sheets-tab-map.json`, beside the
workbook digest, so that declaring a tab is a reviewed commit and not a flag anyone can pass:

```json
{
  "title": "Cyberattack Sundays",
  "stage": "rss_source_corpus",
  "firstDataRow": 2,
  "columns": 9,
  "timestampColumns": [2, 3],
  "sourceKind": "master"
}
```

The import command refuses a tab that is not in the file, and refuses a file whose `stage`
is not `rss_source_corpus`, because only the source corpus is intake. The tab title is the
owner's product name and is not a secret; the file holds no identifier and no digest of one.

### 1.3 Header mapping

None is needed. The feed tab's headers are, cell for cell, the names the importer recognizes
after NFC normalization and trimming (`docs/DATA_INPUTS.md` section 14;
`apps/worker/src/editorial/headers.ts`, `resolveHeaderLayout`). The five required headers are
present. The header row is read as row 1 and passed to the existing layout resolver
unchanged; a header that has moved or been renamed rejects the whole read before any write,
exactly as a CSV with a changed header does.

### 1.4 Cell rendering, and the one transformation this unit adds

The connector requests values as `UNFORMATTED_VALUE` with dates as `SERIAL_NUMBER`
(`packages/sheets-intake/src/client.ts`), so text arrives as text, `ch` arrives as the text of
a boolean, and a timestamp arrives as a serial number counted from 30 December 1899 in the
workbook's declared zone, which the inventory reported as `America/New_York`. The CSV importer
accepts a timestamp only as a strict timezone-aware ISO 8601 string
(`apps/worker/src/editorial/timestamps.ts`).

This unit therefore adds one versioned transformation, `sheets-serial-to-instant@1`: for the
columns the policy file names as `timestampColumns`, the serial is converted with the
connector's existing `serialToInstant` (`packages/sheets-intake/src/values.ts`) using the
workbook's zone, and the resulting UTC instant is the cell handed to the row evaluator. The
serial's own text is kept in the batch's Sheets provenance record (1.6), not discarded. The
transformation's identifier is part of the batch's importer version, so a later change to the
rule is a different batch, never a silent edit.

`TabMapping` accepts one `timestampColumn` today; the feed has two. The mapping type gains an
optional `timestampColumns` array; the single field keeps working.

### 1.5 Read once, digest what was read

The CSV importer reads its file twice, validating first and importing second, and rejects
the import if the file's hash changed between passes (`apps/worker/src/editorial/import.ts`).
A spreadsheet can change between two reads too, and a second read cannot prove it read the
same thing. This unit reads the tab exactly once with `collectRows: true`, holds the rows in
memory, and computes the batch digest over what it holds:

- per row, the connector's content digest, length-framed per cell as `sourceRowKey` already
  does (`packages/sheets-intake/src/values.ts`);
- per batch, SHA-256 over a fixed label, the workbook digest, the tab digest, the framed
  header cells and every row content digest in order.

Bounds: the connector's limits already cap the read at 100,000 rows and 64 columns per tab,
50,000 characters per cell and 250,000 rows per run (`packages/sheets-intake/src/limits.ts`);
the resource limits of `@cas/contracts` cap retained bytes at 512 MiB. The feed measured
about 119 MB as a CSV export in September, so the in-memory read has roughly four times
headroom under the existing bound. The read is one page of 500 rows at a time; 24,608 rows
were 50 pages on 16 September.

### 1.6 Batch identity and the batch record

The idempotency key reuses `computeIdempotencyKey` unchanged, with the batch digest of 1.5 in
the place of the file hash, `sourceKind` `master`, `origin` `live`, no review label,
`importerVersion` `editorial-sheets-import@1` (which names the serial transformation), and the
existing text-transform version. An unchanged tab yields the same key and the outcome
`already_imported`; a tab with one new row yields a new batch holding every row, exactly as a
fresh CSV export of the ledger does today. That parity is deliberate for v0 and is a named
seam: each full import of the ledger adds about the size of the ledger to the database, so an
incremental import that skips rows whose hash is already stored is the next design question
for CAS-003, not this unit. The acceptance criterion that records database size after the
first real import is what makes that question answerable with a measurement.

The `import_batches` row is filled as follows, within the constraints of migrations 0001 and
0002: `source_basename` is the tab title (255 characters, no slash, no control characters; the
feed's title passes); `file_sha256` is the batch digest; `byte_length` is the UTF-8 length of
every cell read; `header_cells` is the header row as read; `importer_version` is
`editorial-sheets-import@1`. The importer version already distinguishes the transport, so no
column is added to `import_batches` and no existing row is reinterpreted.

### 1.7 Migration: yes, one additive table

Provenance a CSV batch never had needs a home: the workbook digest, the tab digest and title,
the workbook's zone, the read's start and end instants, rows read, and the serial text of each
converted timestamp. Migration `0012_sheets_import_provenance.sql` adds one table,
`sheets_import_reads`, keyed by the batch and bound to it by the composite foreign key
`(batch_id, data_origin)` the repository's provenance pattern uses, with a check that
`data_origin` is `live`, and one table `sheets_import_timestamps` holding
`(batch_id, data_origin, source_row_id, row_hash, column_index, serial_text, instant)` bound
to `source_rows` by its composite key. Both tables are append-only through the repository's
guard-function pattern. Migrations 0001 to 0011 are untouched; existing rows are neither
changed nor reinterpreted.

### 1.8 Data origin

The command has no `--origin` flag. A batch read from the workbook is `live` by construction,
the way live Graph evidence comes only from the Graph client (D26). Fixture and replay batches
come only from files through the CSV importer, as today. Tests reach the Sheets path through
the connector's injected client with recorded values, never through the command.

### 1.9 Files touched, and not touched

Touched:

- `packages/sheets-intake/src/reader.ts`: `timestampColumns` on `TabMapping`; nothing else.
- `packages/sheets-intake/src/policy.ts` or a new `tab-map.ts`: the policy-file reader and
  its schema.
- `data/policy/sheets-tab-map.json`: the committed mapping.
- `apps/worker/src/editorial/import.ts`: the write path from `insertImportBatch` through
  `flushChunk` extracted into one function that takes evaluated rows, so the CSV importer
  and the Sheets importer share it. A refactor with no behaviour change, proven by the
  existing CSV tests passing unchanged.
- `apps/worker/src/sheets/import.ts`, new: read once, digest, convert timestamps, evaluate,
  write.
- `apps/worker/src/sheets/output.ts`: the count-only import summary.
- `apps/worker/src/cli.ts` and the root `package.json`: `sheets import` and `sheets:import`.
- `packages/database/migrations/0012_sheets_import_provenance.sql` and the matching
  operations in `packages/database/src`.
- Tests beside each file; `docs/RUNBOOK-WEEKLY-IMPORT.md`; `README.md`, `docs/ARCHITECTURE.md`,
  `docs/SHEETS-INTAKE.md`, `docs/DECISIONS.md`.

Not touched: the CSV importer's behaviour and every existing test of it; `classification`,
`clustering`, `evidence`, `drafting`; the dashboard; migrations 0001 to 0011; the credential
loader; the Graph client.

### 1.10 Decisions this design needs, and who takes them

| Decision                                                        | Taken by | Status                                                                                           |
| --------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| The feed tab is declared by a committed policy file, not a flag | engineer | proposed here; cost judgment, so that "never inferred" is a reviewed commit                      |
| Serial timestamps become UTC instants under a versioned rule    | engineer | proposed here; security necessity for provenance, since the importer would otherwise reject them |
| Read once and digest what was read, instead of two passes       | engineer | proposed here; a second read cannot prove sameness                                               |
| Full-snapshot batches in v0, incremental import deferred        | engineer | proposed here; parity with the CSV importer; seam named, measured at step 11                     |
| Migration 0012 as one additive provenance table                 | engineer | proposed here; no existing row reinterpreted                                                     |
| Whether the owner wants the tab mapping reviewed before code    | owner    | open; one word                                                                                   |

### 1.11 Verification plan for this unit

Step 7 proves the mechanism offline against a synthetic fixture with the feed's shape. Step 8
adds the failure modes and the PostgreSQL tests. Step 11 runs the first real import against
the Railway database and records counts, duration and `pg_database_size`. The acceptance list
of the tracker is the falsification list; nothing here is marked done.

## 2. Reference implementation, S3, and its first tests (step 7)

Written 21 October 2026. Files: `apps/worker/src/sheets/import.ts` (the pure bridge) and
`apps/worker/src/sheets/import.test.ts` (the synthetic fixture). No network, no database, no
real text: the fixture is nine headers in the feed's exact order and four rows of invented
values whose timestamps are serial numbers.

What the module proves, each as a test that would fail if the design note were wrong:

- A mapping is refused unless its stage is `rss_source_corpus` and its kind `master`; a
  timestamp column outside the declared width, or repeated, is refused.
- The feed's nine headers resolve through the importer's own resolver with nothing unknown
  and nothing blank; a header wider than the mapping is refused.
- A serial in the workbook's zone becomes the UTC instant the importer accepts: 46277.5 in
  `America/New_York` evaluates to `2026-09-12T16:00:00.000Z` with no issue; without a zone the
  same serial reads as 12:00 UTC; a strict ISO text passes through; a text value in a
  timestamp column is left to the evaluator, which quarantines the row with
  `timestamp_invalid`.
- A boolean `ch` reaches the evaluator as `TRUE` or `FALSE` and raises no warning; a row
  without a title is quarantined and counted; a short row is padded; a row wider than the
  mapping is refused; the byte length is the UTF-8 length of every cell read.
- The batch digest is the same for the same read twice, changes when one cell changes or two
  rows swap, is computed over the connector-normalized cells before conversion, and is bound
  to the workbook and tab digests; the idempotency key is the importer's own key over that
  digest under `editorial-sheets-import@1`, and differs from the CSV importer's key for the
  same digest.

Runner counts, 21 October 2026: the new file is 17 tests; the worker's default suite is 253
tests in 23 files, all passing. Typecheck, lint and formatting pass on the two files; the
hygiene, secrets and forbidden-file scans pass over the tree.

Not done here, by design: no PostgreSQL test, no command, no migration, no policy file. Those
are steps 8 and 9. The write path is still the CSV importer's private functions; step 9
extracts the shared write function the design note names.
