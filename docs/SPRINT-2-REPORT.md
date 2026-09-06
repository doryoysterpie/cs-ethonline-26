# Sprint 2 report: PostgreSQL data foundation and manual CSV ingestion

Result: **COMPLETE, corrected after three Codex audits, pending Codex Desktop re-audit**
(section 13). Every exit condition of the Sprint 2 charter
passed on the final code: a fresh local PostgreSQL database migrated safely and a second run
was a no-op; synthetic data carrying every known source hazard round-tripped exactly; the
three real exports parsed structurally and every logical row was stored; CS79's invalid rows
were quarantined with stable issue codes; re-importing the same files wrote nothing; raw
source data, provenance, review state and normalized fields sit in separate columns and
tables; and no real row, credential, generated output or database dump entered Git. All times
America/Toronto unless marked UTC. Count-only throughout: no title, URL, summary,
description, cell, connection detail or absolute path appears here.

**How to read this report.** Sections 1 to 12 record the original implementation and its
verification at `2f2e673b578034adabd796d436449bc05cdba913`, the commit Codex audited. They
are historical evidence and are preserved unedited except for these labels; where they give
test totals or a migration count they describe that commit, not the current code. Sections
13 and 14 carry the corrections and the verification of the current final code, including
the current test totals and the second migration.

| Item                 | Value                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository           | `doryoysterpie/cs-ethonline-26`, public                                                                                                                                                                                                                                                                                               |
| Branch               | `sprint-2/data-foundation`, created from the accepted Sprint 1 SHA                                                                                                                                                                                                                                                                    |
| Starting SHA         | `56bc95c400bc6b394f00bccde49330e7a9fcb74a` (Sprint 1, audited PASS)                                                                                                                                                                                                                                                                   |
| Decision commit      | `bb6872aa5cd37ef6cba7d72cbb23a152ccdfa1cf`, `docs: resolve Sprint 2 input decisions` (D20)                                                                                                                                                                                                                                            |
| Foundation commit    | `df9ee29203790cdbe2d283c6cf4c51db6ed9d84e`, `feat(data): add Postgres ingestion foundation`                                                                                                                                                                                                                                           |
| Proof commit         | `522f5b17eeb3fc34b5771ca4c93ce28e6260b43e`, `docs: record Sprint 2 ingestion proof`, the commit that introduced this document                                                                                                                                                                                                         |
| Evidence-capture fix | `2f2e673b578034adabd796d436449bc05cdba913`, `fix(data): silence nested pnpm banners in ingestion commands`. Adds `-s` to the nested pnpm call in the root scripts so that `corepack pnpm -s` keeps the path argument out of captured output, as section 10 states. Audited by Codex with changes required                             |
| Audit correction     | `210193412c234a10b3f0665603b982800cf874da`, `fix(data): enforce provenance and output integrity`, and `07dd53bb85db329563e5073213f570bc1fab59e7`, `docs: record Sprint 2 audit correction`. Section 13 records the output-forgery and provenance findings, migration 0002 and the evidence. Re-audited by Codex with changes required |
| Re-audit correction  | `b19d0891ac23545faeef8c774538792875dcc61a`, `fix(data): enforce database credential redaction policy`, and `3a12891cd5d22400da6e6900389643cde0457828`, `docs: correct final Sprint 2 audit evidence`. Section 13 records the credential policy. Re-audited by Codex Desktop with changes required                                     |
| Boundary correction  | `fix(worker): validate configured database URL before dispatch` and `docs: record Sprint 2 boundary correction`; SHAs in the handoff. Section 13, finding 4, records the boundary gap and its closure                                                                                                                                 |
| Final SHA            | in the handoff                                                                                                                                                                                                                                                                                                                        |
| `main`               | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                                                                                                                                                                                                                                                                               |
| Real inputs          | the three exports named in the charter, read from the project owner's download folder, outside the repository; never copied, never committed, not deleted                                                                                                                                                                             |

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

> **Historical evidence from `2f2e673b`.** This section describes the schema as first built,
> with one migration. Migration `0002_provenance_integrity.sql` was added by the audit
> correction and is described in section 13; the current code has two migrations.

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

> **Historical evidence from `2f2e673b`.** The totals in this section describe the original
> Sprint 2 implementation, before the Codex audit corrections. They are **not** verification
> of the current code. The current totals are in section 13.

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

Verification of the original implementation, run at `2f2e673b` (the clean-checkout rerun of
that commit is reported in its handoff). **These figures are historical.** They record one
applied migration, 179 offline tests and 17 PostgreSQL tests, which is the state before the
Codex audit corrections; the current code has two migrations and the totals in section 13.

| #   | Command                                                          | Exit |
| --- | ---------------------------------------------------------------- | ---: |
| 1   | `corepack pnpm install --frozen-lockfile`                        |    0 |
| 2   | `corepack pnpm format:check`                                     |    0 |
| 3   | `corepack pnpm lint`                                             |    0 |
| 4   | `corepack pnpm typecheck`                                        |    0 |
| 5   | `corepack pnpm test` (179 tests at that commit)                  |    0 |
| 6   | `corepack pnpm build`                                            |    0 |
| 7   | `corepack pnpm verify`                                           |    0 |
| 8   | fresh migration (step 1 above)                                   |    0 |
| 9   | second migration, no-op (step 2 above)                           |    0 |
| 10  | `corepack pnpm test:db` (17 tests at that commit)                |    0 |
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

## 13. Codex-audit correction (6 September 2026)

Codex audited `2f2e673b578034adabd796d436449bc05cdba913` and returned CHANGES REQUIRED with
two findings and a hygiene item. Both findings are closed on this branch. Migration
`0001_editorial_ingestion.sql` was not touched; its SHA-256 is still
`6ccf4b05cdcd255b326029e99097c73ec220fa77d38d767e86a40175abc8b936`, and a unit test pins
that value so it cannot drift. Nothing in sections 1 to 12 is rewritten; this section
records what changed and the evidence produced after the change.

### Finding 1: output-forgery boundary

Four pieces of untrusted metadata reached printed lines by direct interpolation: the
validation basename, the batch basename, the batch review label and the snapshot review
label. Codex reproduced `forged_line=true` and `contains_ansi=true`: a filename or label
carrying a newline, carriage return, ANSI escape, C0 or C1 control, or a Unicode line or
paragraph separator could forge a status, batch, reconciliation or issue line in terminal
output and in captured evidence.

Corrected:

- New worker-local module `apps/worker/src/editorial/display.ts`, equivalent to the proven
  approach in `packages/graph-evidence/src/display.ts` and with no dependency between the
  two packages. Its character class is built from code points, so the source contains no
  control byte. `toSingleLine` escapes C0, DEL, C1 (CSI included), the ANSI introducer and
  U+2028 and U+2029 as visible escapes; `safeDisplay` additionally bounds the length at 200
  characters with a visible `…[+N chars]` marker.
- `output.ts` redacts each untrusted value **before** escaping it, so a secret that itself
  contains a control character still matches the redactor, then renders it through
  `safeDisplay`. Each composed line is redacted again and passed through `toSingleLine`, so
  every returned entry is exactly one physical line. The command-line interface applies the
  same guard to every line it emits, including usage and error lines.
- The base redactor now covers the whole `DATABASE_URL` and its raw and percent-decoded
  password, through the existing `connectionSecrets` helper, rather than the connection
  string alone.
- Review labels are validated before any file or database access: non-empty after trimming,
  at most 64 characters, and free of control and line-separator characters, checked on the
  raw value because JavaScript's `trim` would otherwise silently remove a trailing newline.
  A file basename is validated the same way, at most 255 characters. Ordinary names with
  spaces and punctuation are untouched: `Content @latestincyber - CS79.csv` imports as
  before.
- Validation mode handles a hostile basename by rendering it safely rather than refusing
  it, so a file can still be inspected; import and report mode refuse it, because the name
  would be stored.

Tests: `display.test.ts` (8 cases) and `output-safety.test.ts` (40 cases) drive the real
formatters with the real redactor over twelve hostile values, covering newline, carriage
return, tab, ANSI escape and full sequence, C1 CSI, DEL, U+2028, U+2029, a 4,000-character
name, a synthetic database password in the basename and the same password split by control
characters, each in a basename and in a review label. Every case asserts that no emitted
entry contains a physical line break, an ANSI introducer, a Unicode separator or the
password, that the count of status-shaped lines equals exactly the number the formatter
itself produced, and that hostile content is escaped rather than dropped. `import.test.ts`
adds label and basename rejection cases; `cli.test.ts` adds an end-to-end hostile-basename
validation run, an ordinary spaced filename, refusal of a hostile import, a non-UUID batch
id, and password-only redaction.

### Finding 2: relational provenance integrity

Migration 0001 used independent single-column foreign keys, so the database permitted five
contradictions: a source row whose origin differed from its batch; an issue naming one batch
while its row belonged to another; a snapshot whose label or origin differed from its batch;
a review entry joining one batch's snapshot to another batch's source row; and a row whose
canonical URL disagreed with its URL group. Count-only reconciliation would not necessarily
have detected any of them.

Corrected by the new forward-only migration
`packages/database/migrations/0002_provenance_integrity.sql`, which adds composite unique
keys on the parents and composite foreign keys on the children:

| Contradiction                                | Prevented by                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| source-row origin differing from its batch   | `import_batches (id, data_origin)` unique; `source_rows (batch_id, data_origin)` foreign key                                  |
| issue naming a different batch from its row  | `source_rows (id, batch_id)` unique; `row_issues (source_row_id, batch_id)` foreign key                                       |
| snapshot label or origin differing           | `import_batches (id, review_label, data_origin)` unique; `review_snapshots (batch_id, review_label, data_origin)` foreign key |
| review entry crossing batches                | new `review_entries.batch_id`, with foreign keys to `review_snapshots (id, batch_id)` and `source_rows (id, batch_id)`        |
| canonical URL disagreeing with its URL group | `url_groups (id, canonical_url)` unique; `source_rows (url_group_id, canonical_url)` foreign key                              |

`review_entries.batch_id` is added nullable, backfilled deterministically from each entry's
snapshot, then made `NOT NULL`. Check constraints bound the source basename (255) and the
review label (64) and reject control and line-separator characters in both; the character
class is written with `\x` and `\u` escapes so the migration file holds no control byte.
Raw editorial columns are untouched, and a test proves a title with newlines and an ANSI
escape and a 50,000-character summary still store unchanged. `insertReviewEntries` and
`NewReviewEntry` carry the batch id; every other operation is unchanged.

Every constraint validates existing rows as it is added, so a database whose rows already
contradict each other fails the migration and is left exactly as it was; nothing is
rewritten silently.

Tests, all in `packages/database/src/provenance.db.test.ts` unless noted: each of the five
contradictions is attempted directly, by insert and by update, and PostgreSQL rejects it
with SQLSTATE 23503; a normal weekly batch and a normal master batch still succeed; a
quarantined row still keeps its review entry; hostile basenames and labels are rejected with
SQLSTATE 23514 while an ordinary spaced basename is accepted; raw fields stay exempt. In
`migrate.db.test.ts`: a fresh schema applies both migrations and reruns as a no-op; a schema
holding valid Sprint 2 data upgrades from 0001 with identical counts and a correct backfill;
a schema holding a contradiction refuses the upgrade, keeps `schema_migrations` at version 1
and does not add the new column; migration 0002 participates in checksum-drift detection;
the advisory lock still applies each migration exactly once under two concurrent runners.

### Finding 3: repository hygiene

- The literal U+0001 delimiter in `validate.ts` is replaced by
  `JSON.stringify([code, field, severity])`.
- A scan of every tracked and newly added non-CSV file reports zero prohibited control
  characters: no C0, DEL, C1, U+2028 or U+2029 code point occurs in any of them. The scan
  decodes each file as UTF-8 and examines code points, because a UTF-8 continuation byte can
  numerically fall in the range `0x80` to `0x9F` without being a C1 control character.
- New `.gitattributes` marks only `data/fixtures/editorial/weekly-synthetic.csv` as
  `-text whitespace=cr-at-eol`, so Git keeps its bytes exactly as committed and stops
  reporting its intentional carriage returns as trailing whitespace. The fixture is
  unchanged and the tests still exercise real CRLF behaviour.
- `git diff --check` over the whole committed range `56bc95c4..HEAD`, not merely the
  worktree, now passes.

### Verification of the correction

Fresh database `cas_sprint2_fix`, created for this correction, migrated through both
migrations, then all three real exports validated, imported as `replay`, re-imported and
reconciled. Every command exited 0.

| File                         |       Bytes |     Stored |   Accepted | Quarantined | Status                  |
| ---------------------------- | ----------: | ---------: | ---------: | ----------: | ----------------------- |
| Cyberattack Sundays (master) | 119,643,204 |     23,910 |     23,910 |           0 | `completed`             |
| CS79 (weekly)                |     155,199 |        157 |        154 |           3 | `completed_with_issues` |
| CS86 (weekly)                |     149,523 |        181 |        181 |           0 | `completed`             |
| **Total**                    |             | **24,248** | **24,245** |       **3** |                         |

Unchanged from section 8: master `ch` 133 TRUE, 23,775 FALSE, 2 blank; duplicate excess 270
by exact and canonical URL in 23,640 groups; longest stored field 48,329 characters; CS79
issue counts `timestamp_missing` 2 and 2, `title_missing` 2, `url_missing` 2, `url_invalid`
1, with review entries 130 selected and 27 rejected, 3 on quarantined rows; CS86 161
selected and 20 rejected. Re-importing the master and CS79 wrote nothing and returned the
original batch ids. All three batches reconcile. An independent row-hash check over all
24,248 stored rows found **0 mismatches**. Count-only integrity queries on the result return
0 for every contradiction: origin mismatches, issue-batch mismatches, snapshot label or
origin mismatches, cross-batch review entries, URL-group mismatches and null entry batches.

Upgrade of the existing populated verification database `cas_sprint2_verify`, which held the
Sprint 2 data under migration 0001 only: `db:migrate` applied `0002` alone
(`applied=1 alreadyApplied=1 total=2`), a rerun was a no-op, and the counts were identical
before and after (3 batches, 24,248 source rows, 9 row issues, 23,640 URL groups, 2
snapshots, 338 review entries). The backfill left no null batch id and no mismatch against
either the snapshot or the source row, all three batches still reconcile, and an attempted
origin change is now rejected by `source_rows_batch_origin_fk`.

### Finding 3 of the re-audit: short database passwords bypassed redaction

Codex re-audited the correction and reproduced, through the real worker formatter,
`short_password_visible=true` with `full_url_visible=false` on `file=accidental-abc.csv`.
The cause: `connectionSecrets()` returns the configured password, but `createRedactor()`
deliberately ignores secret values shorter than four characters, because such a value would
match ordinary words and blank out unrelated output. A configured password of `abc`
therefore stayed visible wherever it appeared independently, such as inside a filename. That
contradicts the security contract, which states that every configured database password is
protected.

Corrected by refusing the credential rather than weakening the redactor. The generic
four-character safeguard in `createRedactor()` is unchanged. `assertCredentialPolicy()` in
`packages/database/src/config.ts` now enforces:

| Configuration                                    | Result                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| No password (`postgresql://127.0.0.1:5432/cas`)  | accepted; local development needs no password                    |
| Empty password after a colon (`…//app:@host/db`) | accepted; a colon with nothing after it is no password           |
| Password decoding to 1, 2 or 3 characters        | rejected, `must be at least 4 characters after percent-decoding` |
| Password whose percent-encoding is malformed     | rejected, `is not valid percent-encoding`                        |
| Password decoding to 4 or more characters        | accepted, and redacted in its raw and decoded forms              |

`parseDatabaseConfig()` calls the policy, so every database entry point inherits it:
migration, check, import and report all build their handle from it. The command-line
interface additionally applies the policy to a configured `DATABASE_URL` before any command
runs, including validation, which needs no database, so no command can print output while
such a credential is set. Both rejection messages are fixed sentences that name only the
rule: they carry no URL, username, hostname, raw password, decoded password or fragment of
one. No dependency was added, and no ingestion, normalization, idempotency or provenance
behaviour changed.

Tests: `config.test.ts` grew to 13 cases covering passwordless URLs, raw passwords of one,
two and three characters, percent-encoded passwords decoding to one, two and three
characters, malformed encodings, accepted passwords of four or more decoded characters, the
rule reaching every entry point, and non-PostgreSQL values being left to the surrounding
validation. Each rejection is asserted to equal its fixed sentence exactly, which is the
strongest available proof that no input reached the message. `redact.test.ts` grew to 5
cases, proving an accepted encoded password is redacted in both its raw and decoded forms
and that every password the configuration accepts is long enough for the redactor to
protect. `cli.test.ts` grew, at that stage, to 14 cases, including the reproduction: with the
three-character password configured, every command, validation included, exits 2 with the
fixed message and prints neither the filename nor the URL; and with an accepted encoded
password, a filename containing its decoded form prints as `file=report-[REDACTED].csv`. The
pre-existing connection-failure redaction tests still pass unchanged.

### Finding 4 of the Codex Desktop audit: the boundary check was credential-only

The previous correction applied `assertCredentialPolicy()` at the command-line boundary.
That function deliberately ignores values whose scheme is not `postgres:` or `postgresql:`,
leaving them to `parseDatabaseConfig()`, the surrounding structural validator. Every command
that opens a database reaches that validator, but `editorial validate` does not, so a
non-empty `DATABASE_URL` with another scheme bypassed the boundary entirely. A synthetic
HTTPS, MySQL or Redis URL carrying a password too short for the redactor therefore let
validation run and print that password through a filename.

Reproduced against the compiled CLI at `3a12891c` with a synthetic three-character password
and a temporary copy of a synthetic fixture: exit code 0, eight normal validation lines, the
password visible in the printed basename.

Corrected in `apps/worker/src/cli.ts` alone, by one substitution: the boundary now calls
`parseDatabaseConfig(env)` whenever `DATABASE_URL` is non-empty, instead of the
credential-only check. That is the complete structural validation, so the boundary rejects a
non-URL value, a non-PostgreSQL scheme, malformed password percent-encoding and a password
decoding to fewer than four characters, before any file access, database access or normal
output. An absent or empty value is still not a configuration, so `editorial validate` keeps
working without a database. `assertCredentialPolicy()` keeps its intended responsibility and
is unchanged, as are `createRedactor()`'s four-character threshold, both migrations, the
ingestion path and every dependency.

Regression tests through the real command-line path, in `cli.test.ts`: three invalid
configured URLs (HTTPS, MySQL and Redis) carrying synthetic passwords of one, two and three
characters, each with the password in the copied fixture's basename, assert exit code 2,
empty standard output, exactly one error line, and that line equal to the fixed scheme
message, with the basename, URL, hostname and fixture content absent; a non-URL value
asserts the fixed not-a-URL message; and validation still succeeds with `DATABASE_URL`
absent, empty, whitespace, passwordless, or carrying an accepted password of four or more
decoded characters, raw or encoded.

Independent compiled-CLI reproduction after the fix, run from `apps/worker/dist/cli.js` with
synthetic credentials and temporary fixture copies, recording counts and Boolean checks only
(the probe and its output are not committed):

| Scheme | Password length | Exit | Standard output | Error lines | Error exactly the fixed message | Basename, URL, host, file content present |
| ------ | --------------: | ---: | --------------- | ----------: | ------------------------------- | ----------------------------------------- |
| https  |               1 |    2 | empty           |           1 | yes                             | none                                      |
| mysql  |               2 |    2 | empty           |           1 | yes                             | none                                      |
| redis  |               3 |    2 | empty           |           1 | yes                             | none                                      |

Exact-message equality is the meaningful check for the one and two-character cases: a
one-character password matches ordinary English letters inside any fixed sentence, so a
substring search would report a false positive. The same compiled CLI still exits 0 with
eight lines for an absent, passwordless or accepted-password configuration, and still exits
2 on a three-character PostgreSQL password with the fixed credential message.

### Test totals after the corrections

Taken from the test runner, not estimated. Offline tests need no database and no secret and
run in continuous integration; PostgreSQL tests run only through `test:db`.

| Package               | Unit (no database) | PostgreSQL integration |
| --------------------- | -----------------: | ---------------------: |
| `@cas/contracts`      |                  7 |                        |
| `@cas/database`       |                 24 |                     22 |
| `@cas/graph-evidence` |                102 |                        |
| `@cas/worker`         |                116 |                      8 |
| **Total**             |            **249** |                 **30** |

Per file, for the files this correction touched or added:

| File                                              | Tests |
| ------------------------------------------------- | ----: |
| `packages/database/src/config.test.ts`            |    13 |
| `packages/database/src/redact.test.ts`            |     5 |
| `packages/database/src/errors.test.ts`            |     3 |
| `packages/database/src/migrate.test.ts`           |     3 |
| `packages/database/src/migrate.db.test.ts`        |     7 |
| `packages/database/src/database.db.test.ts`       |     5 |
| `packages/database/src/provenance.db.test.ts`     |    10 |
| `apps/worker/src/cli.test.ts`                     |    17 |
| `apps/worker/src/editorial/display.test.ts`       |     8 |
| `apps/worker/src/editorial/output-safety.test.ts` |    40 |
| `apps/worker/src/editorial/import.test.ts`        |     5 |
| `apps/worker/src/editorial/import.db.test.ts`     |     8 |

### Verification of the final code

Run after the final edit, on the current code. Migration checksums confirmed unchanged:
`0001_editorial_ingestion.sql` is
`6ccf4b05cdcd255b326029e99097c73ec220fa77d38d767e86a40175abc8b936` and
`0002_provenance_integrity.sql` is
`4139f25cd5ca24746208c40cc3b65076c2bd9cccbc287e08880d508691d71b8d`; neither file was
modified by this correction, and the weekly CRLF fixture keeps the blob it had at the
starting SHA. The full 24,248-row real-export import was not repeated, because this
correction changes no ingestion semantics; the real-export evidence in section 13 stands.

| Command                                       | Exit |
| --------------------------------------------- | ---: |
| `corepack pnpm install --frozen-lockfile`     |    0 |
| `corepack pnpm format:check`                  |    0 |
| `corepack pnpm lint`                          |    0 |
| `corepack pnpm typecheck`                     |    0 |
| `corepack pnpm test` (249 tests)              |    0 |
| `corepack pnpm build`                         |    0 |
| `corepack pnpm verify`                        |    0 |
| `corepack pnpm audit`                         |    0 |
| `corepack pnpm test:db` (30 tests)            |    0 |
| `git diff --check 56bc95c4..HEAD`             |    0 |
| `git fsck --full`                             |    0 |
| `git status --short` (clean after committing) |    0 |

## 14. Reproduction for Codex

1. Check out `sprint-2/data-foundation` at the final SHA in the handoff and run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` (no database, no
   secret).
2. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env` naming a database
   created for the purpose: `set -a && . ./.env && set +a`, then `corepack pnpm db:migrate`
   twice (applied 2, then no-op), `corepack pnpm db:check`, and `corepack pnpm test:db`
   (30 tests; only `cas_test_*` schemas are created and dropped). To reproduce the upgrade
   path, point `DATABASE_URL` at a database that already has migration 0001 applied with
   valid rows and run `db:migrate` once: it applies `0002` alone and leaves every count
   unchanged.
3. Validate and import the three exports from wherever they live outside the repository, as
   in section 10 steps 4 to 12, and compare the printed counts with section 8. Repeat one
   import to see `already imported`. Run `corepack pnpm editorial:report` and confirm
   `reconciled=yes` on every batch. Pass `-s` to pnpm to keep the path argument out of the
   captured output.
4. Confirm with `git ls-files` that the only CSV files tracked are the seven synthetic
   fixtures under `data/fixtures/editorial/`, and that no `.env`, dump or generated output is
   tracked.
