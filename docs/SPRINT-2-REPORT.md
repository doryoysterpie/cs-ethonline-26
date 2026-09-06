# Sprint 2 report: PostgreSQL data foundation and manual CSV ingestion

Result: **COMPLETE, pending Codex audit.** Every exit condition of the Sprint 2 charter
passed on the final code: a fresh local PostgreSQL database migrated safely and a second run
was a no-op; synthetic data carrying every known source hazard round-tripped exactly; the
three real exports parsed structurally and every logical row was stored; CS79's invalid rows
were quarantined with stable issue codes; re-importing the same files wrote nothing; raw
source data, provenance, review state and normalized fields sit in separate columns and
tables; and no real row, credential, generated output or database dump entered Git. All times
America/Toronto unless marked UTC. Count-only throughout: no title, URL, summary,
description, cell, connection detail or absolute path appears here.

| Item                 | Value                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository           | `doryoysterpie/cs-ethonline-26`, public                                                                                                                                                                                                                                                       |
| Branch               | `sprint-2/data-foundation`, created from the accepted Sprint 1 SHA                                                                                                                                                                                                                            |
| Starting SHA         | `56bc95c400bc6b394f00bccde49330e7a9fcb74a` (Sprint 1, audited PASS)                                                                                                                                                                                                                           |
| Decision commit      | `bb6872aa5cd37ef6cba7d72cbb23a152ccdfa1cf`, `docs: resolve Sprint 2 input decisions` (D20)                                                                                                                                                                                                    |
| Foundation commit    | `df9ee29203790cdbe2d283c6cf4c51db6ed9d84e`, `feat(data): add Postgres ingestion foundation`                                                                                                                                                                                                   |
| Proof commit         | `522f5b17eeb3fc34b5771ca4c93ce28e6260b43e`, `docs: record Sprint 2 ingestion proof`, the commit that introduced this document                                                                                                                                                                 |
| Evidence-capture fix | `fix(data): silence nested pnpm banners in ingestion commands`; SHA in the handoff. Adds `-s` to the nested pnpm call in the root scripts so that `corepack pnpm -s` keeps the path argument out of captured output, as section 10 states; also adds this row and the matching deviation note |
| Final SHA            | in the handoff                                                                                                                                                                                                                                                                                |
| `main`               | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                                                                                                                                                                                                                                       |
| Real inputs          | the three exports named in the charter, read from the project owner's download folder, outside the repository; never copied, never committed, not deleted                                                                                                                                     |

## 1. Scope

Decision D20 fixed the inputs before implementation: CSV is the accepted baseline format,
import is manual and on demand through a command-line interface, every import declares its
`DataOrigin` explicitly, structural faults reject the whole file before any write, semantic
faults quarantine the row, nothing is dropped, and the master sheet's `ch` is working state
only. This sprint built exactly that, in two packages:

- `@cas/database`: connection configuration, a forward-only checksummed migration runner,
  the first migration, and parameterized ingestion operations. The only package that talks
  to PostgreSQL.
- `@cas/worker`: streaming CSV reading and validation, pure row evaluation, URL
  canonicalization, derived plain text through a maintained HTML parser, the import
  orchestration, count-only reporting and the command-line interface.

Not built, by instruction: classification, embeddings, clustering, model calls, the
dashboard, drafting, sponsor integrations, watched directories, schedulers, cloud-drive
access, and any editorial week boundary. D10 stays unresolved. No new workspace package was
introduced. Four shared enums were added to `@cas/contracts` (`ARCHITECTURE.md` section 4).

## 2. Dependencies

Four direct dependencies were added through the pnpm catalog, exactly pinned, with
`minimumReleaseAge: 1440` unchanged and no range loosened. Each was verified against its
registry record and source repository on 6 September 2026 before it landed.

| Package       | Version | Licence | Published (UTC) | Age at selection | Source repository                 | Rationale                                                                                                                                                                                             |
| ------------- | ------- | ------- | --------------- | ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg`          | 8.23.0  | MIT     | 2026-08-08      | 28 days          | `brianc/node-postgres`            | The maintained PostgreSQL driver for Node; parameterized queries, pooling, transactions, startup options for `search_path`. Chosen over an ORM to keep migrations as transparent SQL.                 |
| `@types/pg`   | 8.23.1  | MIT     | 2026-08-17      | 19 days          | `DefinitelyTyped/DefinitelyTyped` | Type declarations for `pg`; development dependency only.                                                                                                                                              |
| `csv-parse`   | 7.0.2   | MIT     | 2026-08-02      | 34 days          | `adaltas/node-csv`                | Streaming, RFC 4180 parser with strict quoting, embedded newlines, unlimited field size and strict column counts; no dependencies of its own.                                                         |
| `htmlparser2` | 12.0.0  | MIT     | 2026-03-20      | 169 days         | `fb55/htmlparser2`                | Maintained tolerant HTML parser used only to derive plain text; entities decoded, script and style content dropped, nothing executed. Chosen instead of regular expressions, as the charter requires. |

Transitive additions recorded in the lockfile (212 added lines, nothing removed or changed):
`pg-cloudflare` 1.4.0, `pg-connection-string` 2.14.0, `pg-int8` 1.0.1, `pg-pool` 3.14.0,
`pg-protocol` 1.16.0, `pg-types` 2.2.0, `pgpass` 1.0.5, `postgres-array` 2.0.0,
`postgres-bytea` 1.0.1, `postgres-date` 1.0.7, `postgres-interval` 1.2.0, `split2` 4.2.0,
`xtend` 4.0.2 (all MIT or ISC); `dom-serializer` 3.1.1 (MIT), `domelementtype` 3.0.0,
`domhandler` 6.0.1, `domutils` 4.0.2, `entities` 8.0.0 (BSD-2-Clause). `corepack pnpm audit`
on the final lockfile: no known vulnerabilities. `pg`'s optional peer `pg-native` is not
installed; the pure JavaScript client is used.

## 3. Migrations and schema

One migration: `packages/database/migrations/0001_editorial_ingestion.sql`. The runner
(`packages/database/src/migrate.ts`) applies numbered `NNNN_name.sql` files in order, stores
each file's SHA-256 in `schema_migrations`, compares every stored checksum with the file on
disk on every run and stops on any difference, renamed file or missing file before changing
anything, runs and records each migration in its own transaction, holds a session advisory
lock keyed on the current schema so concurrent runners serialize, and reports a rerun with
nothing pending as a no-op. There is no down migration and no reset. Identifiers are
application-generated UUIDs; no extension is required.

| Table              | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_batches`   | UUID, explicit `data_origin`, `source_kind` (`master` or `weekly`), `review_label` (present exactly when weekly, by constraint), `source_basename` (no path separator, by constraint), `file_sha256`, `byte_length`, ordered `header_cells` (JSONB array), `importer_version`, unique `idempotency_key`, `status` (`completed` or `completed_with_issues`, tied to the quarantined count by constraint), parsed, accepted and quarantined counts (sum enforced), `started_at`, `completed_at`                                                                                               |
| `url_groups`       | UUID and unique `canonical_url`; a matching key only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `source_rows`      | UUID, batch, `row_number` (unique per batch), `data_origin`, `status`, exact `raw_cells` (JSONB array, blank-header positions included), `raw_fields` (JSONB object of every non-blank header, unknown columns included), `raw_ch`, `raw_date_posted`, `raw_date_updated`, `raw_title`, `raw_author`, `raw_description`, `raw_summary`, `raw_url`, `raw_category`, parsed `posted_at` and `updated_at`, `normalized_title`, `derived_summary_text`, `derived_description_text`, `text_transform`, `canonical_url`, `url_group_id` (present exactly when a canonical URL exists), `row_hash` |
| `row_issues`       | UUID, batch, row, `issue_code`, `field`, `severity`, fixed `message`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `review_snapshots` | UUID, batch (unique), `review_label`, `data_origin`, `created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `review_entries`   | UUID, snapshot, source row (unique), `raw_value`, `review_state` (`selected`, `rejected`, `unreviewed`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

All text columns are `TEXT`; nothing truncates. No incident, classification, embedding,
draft or publication table exists.

## 4. Ingestion design

- **Two passes.** The structural pass streams the whole file without writing: strict UTF-8
  decoding, NUL rejection, byte-order-mark handling, RFC 4180 parsing with strict column
  counts, header resolution, row count, byte length and SHA-256. Only then is the idempotency
  key (SHA-256 over file hash, source kind, origin, trimmed label, importer version and
  text-transform version) looked up. The import pass streams the file again inside one
  transaction, evaluating rows and flushing them in chunks of 100 through multi-row
  parameterized inserts; the header and hash seen in the second pass must equal the first,
  or the batch is rolled back as `file_changed`.
- **Rejection versus quarantine.** Structural faults (invalid UTF-8, NUL, quoting fault,
  inconsistent column count, no header, duplicated non-blank header, missing required header)
  reject the file with exit code 3 and no write. Semantic faults quarantine the row with the
  codes in `DATA_INPUTS.md` section 14; a quarantined row keeps every cell, its issues and,
  for weekly files with a recognized token, its review entry.
- **Fields by name.** Known headers are recognized by exact normalized name; required are
  `ch`, `Date Posted`, `Date Updated`, `Title`, `URL`. Blank headers are accepted at any
  position (CS79 has two trailing ones) and their cells stay in the ordered raw cell list.
- **Timestamps.** Only `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` with a real calendar date
  parses; naive or lenient values are `timestamp_invalid`. The raw string is always stored.
- **URLs.** Canonical form for matching only (`DATA_INPUTS.md` section 14 lists the rules and
  the tracking parameters). The original URL is stored byte for byte. Nothing is fetched.
- **Derived text.** `Summary` and `Description` are converted with htmlparser2 and labelled
  `html-to-text@1` on every row; raw HTML is stored inert.
- **Review state.** Weekly `TRUE` and `FALSE` become `selected` and `rejected` entries in a
  snapshot carrying the label given on the command line; a blank weekly token is
  `unreviewed` and tested; an unknown token quarantines the row and writes no entry. A
  master import never creates a snapshot; its `ch` is stored raw.
- **Output safety.** Every printed line is built from basenames, hashes, counts, ids,
  statuses, durations, issue codes, known header names and fixed messages, then passed
  through a redactor for the connection string. Driver messages are never copied; parser
  messages are never copied. Unknown header names are printed as a count.
- **Exit codes.** 0 success (a `completed_with_issues` import retained every row), 2
  configuration, 3 structural input, 4 database, 5 unexpected, 130 interrupted. SIGINT and
  SIGTERM abort the import, which rolls back and closes its connection.

## 5. Tests

| Package               | Unit (no database, no secret, in CI) | PostgreSQL integration (`test:db`, local only) |
| --------------------- | ------------------------------------ | ---------------------------------------------- |
| `@cas/contracts`      | 7 (was 5)                            |                                                |
| `@cas/database`       | 14                                   | 9                                              |
| `@cas/graph-evidence` | 102 (unchanged)                      |                                                |
| `@cas/worker`         | 56 (was 1)                           | 8                                              |
| **Total**             | **179**                              | **17**                                         |

Unit coverage: structural parsing and BOM handling; raw-cell preservation; repeated blank
headers; unknown fields; embedded newlines; a 48,400-character field without truncation;
strict timestamp behaviour including offsets and fraction handling; URL canonicalization;
duplicate preservation and grouping counts; master `ch` isolation; weekly review mapping
including blank and unknown tokens; explicit-origin enforcement and label rules; safe
logging (no path, no content, no credential, even on a connection failure); hostile strings
carried through unchanged; parser and driver error mapping without copied text; migration
file loading and checksums; connection-string parsing and redaction.

Integration coverage, each test in a schema named `cas_test_<random>` that it creates and
drops: migration of a fresh schema producing the seven tables; rerun as a no-op; checksum
drift and missing-file drift refused; two concurrent runners serialized by the advisory
lock; transaction rollback on a thrown callback; SQL-looking values stored verbatim while
the table survives; query failures classified without the driver text; every connection
scoped to the isolated schema; exact raw round trip of the master fixture (every stored
cell list equals the independently parsed file); accepted and quarantined rows both
retained with their issues; weekly review entries separate, traceable to the label, and
present on quarantined rows; a master import of a `ch`-bearing file creating no snapshot;
duplicate URL rows kept separate and sharing a group; idempotent re-import writing nothing
while a different origin creates a new batch; a structural failure causing no write; a
simulated flush failure and an interrupt each rolling the whole batch back; no absolute path
stored in any batch.

## 6. Local PostgreSQL

PostgreSQL 17.10 (Homebrew) on the project owner's development machine, reached over
loopback TCP without a password and without SSL, as the local development role. A database
named for this sprint's verification was created with `createdb` on 6 September and is the
target of `DATABASE_URL` in the ignored `.env` (value never printed; `db:check` reports
`transport=loopback-tcp; passwordPresent=no; ssl=no`). The integration tests used the same
database and left no `cas_test_*` schema behind (count 0 after the run). The verification
database was not dropped, so Codex can inspect it on the same machine.

## 7. Synthetic fixture results

`data/fixtures/editorial/` holds seven deterministic synthetic files
(`data/fixtures/README.md`). Count-only results, asserted by the unit and integration
tests:

| Fixture                 | Rows | Accepted | Quarantined | Issue codes                                                                                                                | Review entries (weekly)                                     | URL groups                    |
| ----------------------- | ---: | -------: | ----------: | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| `master-synthetic.csv`  |   12 |        7 |           5 | `timestamp_invalid` 2, `title_missing` 1, `url_invalid` 1, `url_scheme_not_allowed` 1, `ch_token_unrecognized` 1 (warning) | none (master)                                               | 10 rows in 8 groups, excess 2 |
| `weekly-synthetic.csv`  |    8 |        5 |           3 | `review_value_unknown` 1, `timestamp_invalid` 1, `url_invalid` 1                                                           | selected 4, rejected 2, unreviewed 1; 2 on quarantined rows | 7 rows in 6 groups, excess 1  |
| five `structural-*.csv` |    – |        – |           – | rejected before any write: quoting, duplicate header, missing required header, inconsistent columns, empty file            |                                                             |                               |

The round-trip test reads the master fixture independently and compares every stored
`raw_cells` array, the unknown `Editor Note` field, the 48,400-character summary (raw and
derived), the embedded newline, the SQL-looking description, the prompt-injection-looking
title, the offset-converted and microsecond timestamps, and the canonical URL of the
mixed-case, default-port, fragment-bearing, unsorted-query row.

## 8. Real-export results

Validation (no database) and import (into the verification database) of the three exports,
all as `replay`, with review labels `CS79` and `CS86`. All commands exited 0.

| File                         |       Bytes | Header cells (named, blank) | Logical rows | Accepted | Quarantined | Status                  | Longest cell |
| ---------------------------- | ----------: | --------------------------- | -----------: | -------: | ----------: | ----------------------- | -----------: |
| Cyberattack Sundays (master) | 119,643,204 | 9 (9, 0)                    |       23,910 |   23,910 |           0 | `completed`             |       48,329 |
| CS79 (weekly)                |     155,199 | 9 (7, 2)                    |          157 |      154 |           3 | `completed_with_issues` |       11,850 |
| CS86 (weekly)                |     149,523 | 7 (7, 0)                    |          181 |      181 |           0 | `completed`             |        9,439 |

Against the charter's audit expectations:

- **Master.** 23,910 logical rows parsed and 23,910 stored; structurally valid; no issue.
  `ch` tokens: `TRUE` 133, `FALSE` 23,775, blank 2, none written as review state (no
  snapshot exists for the batch). Duplicate excess by exact URL 270 and by canonical URL
  270: 23,910 rows reference 23,640 URL groups; every duplicate is a separate stored row.
  The 48,329-character field is stored whole (`max(length(raw_summary))` = 48,329). Import
  took 21.1 s.
- **CS79.** 157 rows parsed and 157 stored; structurally valid; completed with issues, not
  rejected. Issue counts: `timestamp_missing` on Date Posted 2 and on Date Updated 2,
  `title_missing` 2, `url_missing` 2, `url_invalid` 1. Two rows are missing every required
  value (title, both timestamps, URL) and one further row has a URL without a scheme: three
  quarantined rows, three invalid-URL outcomes, two rows missing required values or usable
  timestamps, overlapping as the charter allowed. Review entries: `selected` 130, `rejected`
  27, of which 3 sit on quarantined rows and remain traceable to the `CS79` snapshot. The
  validation's exact-URL duplicate excess of 1 is the pair of rows with an empty URL cell,
  which share the empty string; their canonical excess is 0 because an empty URL has no
  canonical form and no group. 154 rows reference 154 groups.
- **CS86.** 181 rows parsed and 181 stored; clean, no issue. Review entries: `selected` 161,
  `rejected` 20. No duplicate.
- **Idempotency.** Re-importing CS86 and the master with the same configuration returned
  `already imported` with the original batch ids and wrote nothing; the report shows three
  batches only.
- **Reconciliation.** `editorial:report` shows every batch reconciled: stored rows equal the
  recorded parsed count, and stored accepted and quarantined counts equal the recorded
  ones. Total logical input rows 24,248 = stored accepted 24,245 + quarantined 3.
- **Raw round trip on the real files.** A count-only check recomputed SHA-256 of the exact
  cell list for every logical row of each file independently and compared it with the stored
  `row_hash` in row order: 24,248 rows, 0 mismatches, row numbers contiguous from 1 in every
  batch.
- **Cross-file linkage (observation).** Every canonical URL in CS79 and CS86 already had a
  group from the master import, so the total number of URL groups stayed at 23,640.

## 9. Provenance proof

Count-only reads of the verification database after the imports: every source row carries
`data_origin = replay` (24,248 of 24,248); the three batches carry `replay` with kinds
`master`, `weekly CS79` and `weekly CS86`; no batch basename contains a path separator; the
two snapshots carry their labels and origin with 157 and 181 entries; `source_rows` has no
review column at all (review state exists only in `review_entries`); every row's
`text_transform` is `html-to-text@1`; every quarantined row has at least one error issue.
Each batch also stores the file's SHA-256, byte length, ordered header cells and importer
version, so a later stage can trace any record to its file, row number and raw cells.

## 10. Commands and exit codes

Real-export sequence on the verification database, 6 September 2026 (UTC times in the
batch records are 08:49 to 08:50):

| Step | Command                                                                                          | Exit |
| ---- | ------------------------------------------------------------------------------------------------ | ---: |
| 1    | `corepack pnpm db:migrate` on the fresh database (applied 1)                                     |    0 |
| 2    | `corepack pnpm db:migrate` again (applied 0, no-op)                                              |    0 |
| 3    | `corepack pnpm db:check` (applied 1, pending 0, drift 0)                                         |    0 |
| 4    | `corepack pnpm editorial:validate --file <master> --kind master`                                 |    0 |
| 5    | `corepack pnpm editorial:validate --file <CS79> --kind weekly`                                   |    0 |
| 6    | `corepack pnpm editorial:validate --file <CS86> --kind weekly`                                   |    0 |
| 7    | `corepack pnpm editorial:import --file <master> --kind master --origin replay`                   |    0 |
| 8    | `corepack pnpm editorial:import --file <CS79> --kind weekly --origin replay --review-label CS79` |    0 |
| 9    | `corepack pnpm editorial:import --file <CS86> --kind weekly --origin replay --review-label CS86` |    0 |
| 10   | step 9 repeated (already imported, nothing written)                                              |    0 |
| 11   | step 7 repeated (already imported, nothing written)                                              |    0 |
| 12   | `corepack pnpm editorial:report` (3 batches, all reconciled)                                     |    0 |

Verification after the final edit, on the final code (the clean-checkout rerun after the
commits is reported in the handoff):

| #   | Command                                                          | Exit |
| --- | ---------------------------------------------------------------- | ---: |
| 1   | `corepack pnpm install --frozen-lockfile`                        |    0 |
| 2   | `corepack pnpm format:check`                                     |    0 |
| 3   | `corepack pnpm lint`                                             |    0 |
| 4   | `corepack pnpm typecheck`                                        |    0 |
| 5   | `corepack pnpm test` (179 tests)                                 |    0 |
| 6   | `corepack pnpm build`                                            |    0 |
| 7   | `corepack pnpm verify`                                           |    0 |
| 8   | fresh migration (step 1 above)                                   |    0 |
| 9   | second migration, no-op (step 2 above)                           |    0 |
| 10  | `corepack pnpm test:db` (17 tests)                               |    0 |
| 11  | validation of each real export (steps 4 to 6)                    |    0 |
| 12  | full import of each real export (steps 7 to 9)                   |    0 |
| 13  | idempotent re-import (steps 10 and 11)                           |    0 |
| 14  | count-only reconciliation (step 12 and the row-hash check)       |    0 |
| 15  | `git diff --check`                                               |    0 |
| 16  | `git fsck --full`                                                |    0 |
| 17  | secret scan (key, connection string, password: 0 hits)           |    0 |
| 18  | forbidden-file scan (no `.env`, dump, raw export)                |    0 |
| 19  | tracked-file type scan (only fixture CSVs under `data/fixtures`) |    0 |
| 20  | `git status --short` clean after commit                          |    0 |

Also checked on the real-run logs: zero occurrences of `http://`, `https://`, any HTML tag,
the Graph key, the connection string or the home directory in the commands' own output.
pnpm's script banner echoes the command line including the path argument the operator
typed; `corepack pnpm -s` suppresses it when capturing evidence.

## 11. Deviations from the charter text

- Batch status has only `completed` and `completed_with_issues`. A rejected file creates no
  batch and a batch is written in one transaction, so no `failed` or `in_progress` row can
  exist; the charter's "status" field is satisfied with those two values.
- Both `Date Posted` and `Date Updated` are required and strictly parsed; each is an
  independent `timestamp_missing` or `timestamp_invalid` issue. The charter named "usable
  timestamps" without fixing which column; both are treated alike.
- A master `ch` token other than `TRUE`, `FALSE` or blank records a `warning`
  (`ch_token_unrecognized`) and leaves the row accepted, so the only `warning` severity in
  use is exercised; no such token exists in the real master.
- Fraction digits beyond six in a parsed timestamp are cut in the derived UTC instant, because
  PostgreSQL keeps microseconds; the raw string is untouched. The real exports carry three.
- A NUL character rejects the file structurally, because PostgreSQL text cannot store it;
  the charter listed decoding faults without naming this case.
- The tracking-parameter list is broader than the charter's minimum (`DATA_INPUTS.md`
  section 14 lists it); `www.` prefixes and AMP variants are not normalized.
- The integration tests use the same `DATABASE_URL` as the commands and isolate themselves
  by schema rather than by a second database; the charter allowed either.
- No CI PostgreSQL service was added; database tests stay behind `test:db`, as the charter
  preferred over adding a mutable container tag or a reusable secret.
- A fourth, narrowly scoped commit follows the three the charter named. The clean-checkout
  rerun after `522f5b17` showed that `corepack pnpm -s` silenced only the outer pnpm
  banner; the nested `pnpm --filter` call still echoed its command line with the path
  argument. The root scripts now pass `-s` to that nested call, and the clean-checkout run
  was repeated on the fixed SHA. The commands' own output never contained a path.

## 12. Unresolved risks

- The `search_path` isolation relies on PostgreSQL startup options sent by the driver; a
  test proves every pooled connection reports the isolated schema, but a different driver
  configuration would need the same proof.
- Row hashes are deterministic over exact cells and are not unique: two identical rows in
  one file share a hash and are still stored twice, by design. Any later deduplication must
  use the URL group and the review record, never the hash alone.
- The derived-text rules (block elements, whitespace collapse) are a judgment and are
  versioned as `html-to-text@1`; changing them requires a new version and a re-import to
  refresh derived columns.
- Weekly labels are free text supplied on the command line and are not unique across
  batches; a corrected export imported under the same label creates a second snapshot with
  that label, which is intended but must be handled by the Sprint 3 calibration reader.
- A large import is one transaction (21 s for the master); an interrupt rolls it all back,
  which is the intended safety property but means a partial import can never be resumed.
- The importer version is a constant; any change to parsing, validation or canonicalization
  rules must bump it, or an old batch and a new one would share an idempotency key.
- D10 remains unresolved; nothing here applies a week boundary, and the Sprint 3 calibration
  reader must not infer one from `posted_at`.

## 13. Reproduction for Codex

1. Check out `sprint-2/data-foundation` at the final SHA in the handoff and run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` (no database, no
   secret).
2. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env` naming a database
   created for the purpose: `set -a && . ./.env && set +a`, then `corepack pnpm db:migrate`
   twice (applied 1, then no-op), `corepack pnpm db:check`, and `corepack pnpm test:db`
   (17 tests; only `cas_test_*` schemas are created and dropped).
3. Validate and import the three exports from wherever they live outside the repository, as
   in section 10 steps 4 to 12, and compare the printed counts with section 8. Repeat one
   import to see `already imported`. Run `corepack pnpm editorial:report` and confirm
   `reconciled=yes` on every batch. Pass `-s` to pnpm to keep the path argument out of the
   captured output.
4. Confirm with `git ls-files` that the only CSV files tracked are the seven synthetic
   fixtures under `data/fixtures/editorial/`, and that no `.env`, dump or generated output is
   tracked.
