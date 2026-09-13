# Sprint 3 report: high-recall classification and the needs-review queue

Result: **CORRECTED TWICE, pending Codex Desktop verification.** Two independent audits have
returned CHANGES REQUIRED. Section 12 records the first five findings, section 13 records the
re-audit's four and the corrections made for them, and section 14 is the audit history. No
finding is closed until Codex Desktop says so: the claims in this document are this
implementation's claims, not a verdict. Nothing here declares Sprint 3 accepted. All times America/Toronto unless marked UTC. Count-only throughout: no title, URL,
summary, description, cell, connection detail or absolute path appears here.

**How to read this report.** Each section is labelled by the kind of evidence it carries:
**design** is a claim about how the code is built, **tests** is automated evidence that runs
offline, **PostgreSQL** is integration evidence against a live database, and **real data** is
count-only evidence from the three imported real exports. Historical figures from earlier
sprints are marked as such.

| Item              | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Repository        | `doryoysterpie/cs-ethonline-26`, public                                              |
| Branch            | `sprint-3/classification-review-queue`, created from the audited Sprint 2 SHA        |
| Starting SHA      | `000c3410848a531bed23d93e6cabc73cc3942a1b` (Sprint 2, audited PASS by Codex Desktop) |
| Rejected SHA      | `974ec047620bd54dd6f66f25c576377d4a488241` (CHANGES REQUIRED, five findings)         |
| Final SHA         | in the handoff                                                                       |
| `main`            | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                              |
| Decision          | D21, appended 7 September 2026                                                       |
| Migrations added  | `0003_classification.sql`, then `0004_classification_integrity.sql` in correction    |
| Migrations 1 to 3 | unchanged; checksums verified against the applied values                             |
| Model calls       | none; no Anthropic SDK, no model path, no credential read                            |

## 1. Scope and approach (design)

Decision D21 fixed the approach before implementation: a deterministic, versioned, rule-based
high-recall classifier, which is the fallback the sprint board's Sprint 3 kill criterion
names, taken because D9 is unresolved. The work is split along the existing package
boundaries:

- `@cas/taxonomy` holds the versioned **classification signal policy**, and nothing else. It
  is explicitly not the incident taxonomy: the project has no authoritative taxonomy
  specification, `data/taxonomy` is still empty, and none was invented.
- `@cas/classification` holds the pure classifier and the pure calibration evaluator. No
  database, network, environment, model, clock or randomness.
- `@cas/database` gains migration 0003 and the run and result operations. It remains the only
  package that talks to PostgreSQL.
- `@cas/worker` composes the two and provides the command-line interface. It contains no
  classification logic.

Not built, by instruction: clustering, incidents, embeddings, model calls, the dashboard,
drafting and any Sprint 4 work. D9 and D10 both remain unresolved; no editorial week is
inferred anywhere.

## 2. The classifier (design)

| Property           | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Classifier version | `rules-classifier@3`                                               |
| Ruleset version    | `classification-behavior-contract@2`                               |
| Engine version     | `classification-engine@2`                                          |
| Mode               | `rules`                                                            |
| Ruleset hash       | `c396ff1dd2da2b800965fc6a4816545b6939c813e57914e0591e19534d6ae58a` |

The ruleset hash is the SHA-256 of the canonical form of the behaviour contract, and the
contract is what the classifier executes. It carries five identity fields, which are the four
versions and the mode, and then only fields the engine reads: the allowed input keys with the
shape each must have, the text-assembly rules (field order, separator, null and empty
handling, Unicode normalization form, case and whitespace normalization, and the character
limit), the matching rules (boundary character class, term ordering, case sensitivity, the
whole signal taxonomy and the pattern signals), the thresholds, the ordered decision rules with
their conditional rationale emissions and their scores, and the scoring weights with both
bounds.

The re-audit found the previous version of this claim overstated. Reversing the decision
rules, rewriting a rationale mapping, zeroing `scoring.maximum` and emptying
`allowedInputKeys` each changed the hash while the compiled classifier returned exactly the
same result, because the engine hard-coded its precedence and its mapping, imported the
taxonomy directly and cached its matchers from the default contract. The engine now reads all
of them, and every hashed behaviour field is proven by an input chosen so that changing that
field must change the decision, the rationale codes, the matched signals or the score. Fields
that could not be connected to execution were deleted rather than kept for appearance: the
prose descriptions of the word boundary, duplicate handling, truncation and the scoring
formula, the text-assembly version string, the rationale-code vocabulary and the separate
signal-policy blob.

Two residues remain and are stated rather than hidden. The identity fields cannot be executed
by anything; they are the run's identity and are hashed deliberately. And `engineVersion`
stands for the code that builds the alternation, de-duplicates matches and sorts the matched
identifiers, which no declaration can express.

**Allowed classifier inputs.** Exactly six fields: the source-row identifier, the row hash,
the ingestion status (`accepted` or `quarantined`), the normalized title, the derived summary
text and the derived description text.

**Everything else is prohibited**, and the boundary is a closed allowlist rather than a list
of known-bad names. The input must be a plain object whose prototype is `Object.prototype` or
null, carrying exactly those six own keys, no symbol keys and no accessor properties. Any
other own key is refused whatever it is called, so human review state, weekly selected or
rejected labels, the master `ch` working state, publisher category, URLs in any form, raw
cells or raw fields, batch labels, snapshot identifiers and database connection values are all
refused by construction, together with names nobody has thought of yet. A rejected input
raises a `ClassificationInputError` carrying a fixed reason code; neither the offending key
nor its value is ever echoed. This is the correction to audit finding 4; the rejected version
denied a fixed list of prohibited names, and the audit passed `analystDisposition` and
`hiddenSnapshotToken` straight through it.

**Text handling.** The three fields are joined in a fixed order with a newline, so a phrase
cannot form across a field boundary, then normalized to Unicode NFC, lower-cased and
whitespace-collapsed. Nothing is truncated: a 48,000-character summary is matched end to end.
Matching uses one alternation per tier with Unicode-aware lookarounds, longest phrase first,
so `hack` does not match inside `hackathon` and `malware` does not match inside
`malwarebytes`.

**Decision rules, in order.** A quarantined row is `review`. A row with no usable text is
`review`. Otherwise the three signal tiers are matched: a row is in scope on one decisive
signal or two distinct contextual signals. In-scope text that also carries out-of-scope
vocabulary is conflicting and goes to `review`. In scope and unconflicted gives `include`.
`exclude` requires at least one out-of-scope signal and no security signal of any tier.
Everything else, including a single contextual signal and no match at all, is `review`.
Uncertainty never becomes exclusion.

**Rationale codes.** A fixed vocabulary, stored per result in the order the fired rule emits
them, never a source excerpt:
`row_quarantined`, `text_absent`, `decisive_signal`, `contextual_signals`,
`contextual_signal_single`, `out_of_scope_signal`, `signals_conflicting`, `no_signal_match`.
Results also store the matched policy signal identifiers, which are the policy's own
vocabulary, and an integer `signal_score` (decisive signals weigh 3, contextual 1,
out-of-scope 0). The score is a deterministic count, documented as carrying no probability or
confidence meaning.

## 3. Migration 0003 (design)

`packages/database/migrations/0003_classification.sql`, SHA-256
`60d24e6ce016db85d6ff6f8f0066d5cad4641f156f3cb56fed1e452c0ac17dc6`. Forward-only. Migrations
0001 and 0002 are untouched and keep their accepted checksums.

`classification_runs` holds an application UUID, the batch, the batch's origin, the classifier
and ruleset versions, the ruleset hash, the mode fixed to `rules`, a unique idempotency key,
the status, the expected and classified row counts, the three decision counts, and the start
and completion times. Check constraints require the decision counts to sum to the classified
count and the classified count to equal the expected count, so a short write cannot be
recorded as complete. A composite foreign key ties the run's batch and origin to
`import_batches (id, data_origin)`.

`classification_results` holds an application UUID, the run, the batch, the source row, the
decision, the rationale codes and matched signals as JSON arrays, the score, the row hash and
the creation time. It is unique per run and source row. Two composite foreign keys carry the
batch through: `(run_id, batch_id)` must name a run of that batch, and `(source_row_id,
batch_id)` must name a row of that batch. A cross-batch combination is therefore impossible
rather than merely unlikely.

Nothing in the migration references `review_snapshots` or `review_entries`. The needs-review
queue is derived from a run by query; it is never copied into the human review tables.

**Idempotency.** A run's key is the SHA-256 of the batch, classifier version, ruleset version,
ruleset hash and mode. Re-running the same batch with the same rules returns the original run
and writes nothing. A changed rule changes the hash and so produces a distinct run.

**Ordering note.** Result foreign keys are checked immediately, so the run row must exist
before its results. The rejected version met that requirement with two bounded passes over the
batch, the first counting decisions and the second writing them, and claimed both passes read
one snapshot. That claim was false. The transaction began with a plain `BEGIN`, so it ran at
READ COMMITTED and each statement took a fresh snapshot; the two passes could therefore see
different data and the run could commit counters that did not describe its own results. The
corrected orchestration is described in section 12 and makes a single pass under an explicit
`REPEATABLE READ` snapshot, inserting the run in a `running` state first and deriving its
counters from the rows it actually stored.

## 4. Database access (design)

`fetchClassificationInputs` selects only the six permitted fields, orders by the row's stable
logical number, and continues with a keyset cursor bounded to at most 1,000 rows a page, so
the master batch's large derived text is never all in memory at once. It joins no review
table. `fetchCalibrationMatrix` is the only query that touches a decision and a human label
together; it runs after classification and returns counts grouped by decision and review
state. `countReviewState` provides a count-only fingerprint used to prove classification
changed nothing.

## 5. Command-line interface (design)

| Command                                 | Root script          |
| --------------------------------------- | -------------------- |
| `classification run --batch <uuid>`     | `classify:run`       |
| `classification report --run <uuid>`    | `classify:report`    |
| `classification queue --run <uuid>`     | `classify:queue`     |
| `classification calibrate --run <uuid>` | `classify:calibrate` |

Every command validates its UUID before any database access, inherits the existing database
configuration validation, and prints through the existing redactor and single-line guard.
There is no implicit "latest run" anywhere: `report`, `queue` and `calibrate` each require an
explicit run identifier. `calibrate` refuses a batch with no weekly review snapshot. Output
carries identifiers, versions, hashes, counts, statuses, durations and fixed vocabulary only.

`queue` prints one line, `classification_queue count=<integer>`, and nothing else. It has no
paging flag, so no page of entries can be requested, and the count is an aggregate query
rather than a fetched page. This is the correction to audit finding 5; the rejected version
printed a source-row identifier, a row number, a signal score and the rationale codes for
every queue entry. Per-row queue access remains available as a typed database operation for
the authenticated review interface Sprint 6 will build; no compiled command calls it.

## 6. Tests (tests)

Offline tests need no database, no secret and no network, and run in continuous integration.

| Package               | Offline | PostgreSQL |
| --------------------- | ------: | ---------: |
| `@cas/contracts`      |       7 |            |
| `@cas/taxonomy`       |       7 |            |
| `@cas/classification` |      56 |            |
| `@cas/database`       |      24 |         71 |
| `@cas/graph-evidence` |     102 |            |
| `@cas/worker`         |     126 |         29 |
| **Total**             | **322** |    **100** |

Per file, for the files this sprint added or changed:

| File                                                   | Tests |
| ------------------------------------------------------ | ----: |
| `packages/taxonomy/src/signal-policy.test.ts`          |     7 |
| `packages/classification/src/classifier.test.ts`       |    20 |
| `packages/classification/src/contract.test.ts`         |    12 |
| `packages/classification/src/input.test.ts`            |    13 |
| `packages/classification/src/calibration.test.ts`      |     7 |
| `packages/classification/src/label-invariance.test.ts` |     4 |
| `packages/database/src/migrate.test.ts`                |     3 |
| `packages/database/src/classification.db.test.ts`      |    43 |
| `packages/database/src/schema-security.db.test.ts`     |     6 |
| `packages/database/src/migrate.db.test.ts`             |     7 |
| `apps/worker/src/cli.test.ts`                          |    20 |
| `apps/worker/src/classification/output.test.ts`        |     7 |
| `apps/worker/src/classification/run.db.test.ts`        |    21 |

The counts above are the totals after both corrections. The originally rejected candidate had
33 classification tests, 13 in `classification.db.test.ts` and 9 in `run.db.test.ts`. Section
12 lists what the first correction added and section 13 what the second added.

**Unit coverage** includes all three decisions; uncertain and quarantined input routed to
review; stable rationale codes; deterministic ruleset hashing; repeated-run determinism over
25 calls; Unicode normalization and case folding; whole-word boundaries next to non-ASCII
letters; the longest-phrase rule; conflicting signals; empty, whitespace-only and absent
derived fields; oversized input matched at both ends without truncation; prompt-like and
SQL-like source text remaining inert; no title, URL or text leaking through a formatted line;
rejection of every prohibited field at the classifier's type boundary; label invariance; the
absence of any dataset, calibration-week or row-identifier special case; and idempotency keys
changing correctly with the ruleset version, the ruleset hash and the classifier version.

**PostgreSQL coverage** includes a fresh migration applying 0001, 0002 and 0003; a no-op
rerun; drift detection for both 0002 and 0003; an upgrade from a populated Sprint 2 schema
with identical counts; one result per source row; quarantined rows receiving review; run
reconciliation; same-run idempotency; distinct runs for a changed ruleset; rollback on failure
with no partial run; every cross-batch run, result and source-row contradiction rejected;
explicit-run queue scoping; calibration separated from classification; and the review
snapshots and entries never mutating.

**Label invariance** is proven three ways: the input type carries no label field and the
runtime guard rejects one; classifying the same allowed fields while labels are removed,
replaced, flipped or made uniform yields byte-identical results; and, in the database, two
batches with byte-identical text under opposite historical labels produce identical decision
distributions and identical per-row decisions.

## 7. Real-data evidence (real data)

All figures below are from the corrected implementation, re-run on 7 September 2026 after the
audit. They come from a clean local PostgreSQL 17.10 database that applied migrations 0001 to
0004 in order, reran them as a no-op, and re-imported the three real exports as `replay` data
before classifying them. The upgrade and immutability evidence in section 12 comes from the
working database established in Sprint 2, which already held the same three batches under
migrations 0001 to 0003. `DATABASE_URL` was never printed.

**A note on the word "master".** The importer's `--kind master` names the source kind of the
living RSS ledger export, and the batch and run rows below inherit it. It is not a claim that
the project holds weekly master datasets: there is one living ledger, and CS79 and CS86 are
weekly candidate cut-downs drawn from it (`DATA_INPUTS.md` section 1).

**Import into the clean database.** 23,910 master rows accepted with no issues; 157 CS79 rows
with 3 quarantined and 5 issue codes; 181 CS86 rows accepted with no issues. Review snapshots:
CS79 with 130 selected and 27 rejected, CS86 with 161 selected and 20 rejected. These match
the Sprint 2 import evidence exactly.

**Classification of the three explicit batches.**

| Batch  | Rows expected | Rows classified |    include | exclude |     review | Reconciled |
| ------ | ------------: | --------------: | ---------: | ------: | ---------: | ---------- |
| master |        23,910 |          23,910 |     12,782 |      54 |     11,074 | yes        |
| CS79   |           157 |             157 |        110 |       1 |         46 | yes        |
| CS86   |           181 |             181 |        123 |       0 |         58 | yes        |
| Total  |    **24,248** |      **24,248** | **13,015** |  **55** | **11,178** |            |

Every run stored exactly one result per source row: 24,248 results, and a query for any
(run, row) pair with a count other than one returns zero. The three CS79 quarantined rows all
received `review` with the single rationale code `row_quarantined`. Re-running a batch with
the same ruleset returned the original run identifier and wrote nothing. `calibrate` on the
master run exited 2 with `no_review_snapshot`, as required.

**Queue command output.** `classification_queue count=11074` for the master run,
`classification_queue count=46` for CS79 and `classification_queue count=58` for CS86. That is
the whole output: one line each, no identifier, row number, score or rationale code.

**Rationale-code distribution.**

| Code                       | master | CS79 | CS86 |
| -------------------------- | -----: | ---: | ---: |
| `decisive_signal`          |  8,607 |   82 |   85 |
| `contextual_signals`       | 10,293 |   82 |   99 |
| `contextual_signal_single` |  4,000 |   15 |   20 |
| `no_signal_match`          |  7,085 |   29 |   38 |
| `out_of_scope_signal`      |    125 |    1 |    0 |
| `signals_conflicting`      |     43 |    0 |    0 |
| `row_quarantined`          |      0 |    3 |    0 |

**Calibration, CS79.** A weekly candidate cut-down: 157 rows carrying candidate decisions,
130 kept, 27 set aside, 0 unreviewed. Every figure below measures agreement with that
candidate stage.

| Decision | selected | rejected |
| -------- | -------: | -------: |
| include  |      104 |        6 |
| exclude  |        1 |        0 |
| review   |       25 |       21 |

Candidate-retention **0.992307**, target 0.98, met. Strict include recall 0.8. Include
precision against kept candidates 0.945454. Needs-review 46, rate 0.292993. Automation rate
0.707006.

**Calibration, CS86.** A weekly candidate cut-down: 181 rows, 161 kept, 20 set aside, 0
unreviewed.

| Decision | selected | rejected |
| -------- | -------: | -------: |
| include  |      117 |        6 |
| exclude  |        0 |        0 |
| review   |       44 |       14 |

Candidate-retention **1.0**, target 0.98, met. Strict include recall 0.726708. Include
precision against kept candidates 0.951219. Needs-review 58, rate 0.320441. Automation rate
0.679558.

**What these two figures are evidence of.** CS79 and CS86 are weekly _candidate_ cut-downs,
produced at the second of five editorial stages. A retention figure computed against them
says how much of the owner's intermediate candidate list a high-recall filter keeps. It is not
end-to-end editorial accuracy, not publication recall, and not validated incident truth,
because the owner's final selection, ordering and editing all happen after the candidate draft
is produced, and the published Substack report is the record of that outcome. This project
does not yet hold those reports in machine-readable form, so no end-to-end figure exists and
none is claimed.

**Provenance.** The human review tables were identical before and after classification: 2
snapshots, 338 entries, 291 kept, 47 set aside. The ledger's `ch` column is not read by any
classification query. Every stored result carries the batch and run that produced it.

## 8. Judgment calls and deviations

- **One selected CS79 row was classified `exclude`.** Its stored rationale codes are
  `no_signal_match` and `out_of_scope_signal`, and the only matched policy signal is `sport`,
  meaning the text carried explicit sports vocabulary and no security vocabulary of any tier.
  Retention still exceeds the target at 0.992307. The rules were **not** changed in response:
  tightening exclusion after seeing which labelled row it cost would be fitting the classifier
  to the calibration set, which decision D21 forbids. It would also be fitting it to a
  candidate decision rather than to a published outcome. A future ruleset version may require two
  distinct out-of-scope signals for exclusion; that would be a general change, would alter the
  ruleset hash and would produce a new run.
- **One pass per run under a repeatable-read snapshot.** The rejected candidate made two
  bounded passes; section 12 explains why that was wrong and what replaced it. The corrected
  master run classifies 23,910 rows in about 9 seconds.
- **`@cas/taxonomy` now holds a classification signal policy**, not an incident taxonomy. The
  distinction is stated in the package, in the policy file and here, and `data/taxonomy`
  remains empty.
- **The signal policy is a judgment.** Its terms are general security and non-security
  vocabulary chosen by the implementer. A test asserts no term names a dataset, a calibration
  week, an identifier or a publisher, but the vocabulary itself has not been reviewed by the
  project owner.
- **No new dependency.** The lockfile changed only to record workspace links and existing
  catalog versions for the two packages that gained tests; no new external package appears.

## 9. Limitations and unresolved risks

- **D9 remains unresolved.** No model, settings or spending cap is chosen, and no Anthropic
  credential was present or read. The classifier is the fallback, not the intended final
  design.
- **D10 remains unresolved.** No editorial week is inferred; classification is always scoped
  to an explicit batch.
- **Local PostgreSQL only.** All database evidence comes from PostgreSQL 17.10 on the project
  owner's machine over a loopback connection. There is no hosted database, and D8 is still
  open.
- **Continuous integration runs no database.** The 100 PostgreSQL tests run only through
  `test:db` with a local `DATABASE_URL`. Continuous integration proves the 322 offline tests
  and nothing about the schema. Every constraint and trigger added by migrations 0004 and
  0005, including the whole immutability matrix, the schema-capture regressions and the
  source-set freeze, is therefore unproven by continuous integration and must be re-proven by
  any reviewer with a local database.
- **Calibration is not a training set, and there is no holdout yet.** The weekly candidate
  cut-downs supply labels the deterministic rules are measured against, never fitted
  to. A holdout will come from withholding whole paired weeks from development, not from
  partitioning the living ledger, and none has been withheld yet.
- **Calibration is not a holdout, and it is not the editorial outcome.** CS79 and CS86 are
  weekly candidate cut-downs used as calibration sets. Their figures describe the candidate
  stage on those two weeks, not unseen weeks and not what was published. No end-to-end
  evaluation has been run, and none can be until weekly cut-downs are paired with their
  published Substack reports.
- **The end-to-end evaluation is specified but not scheduled.** It will pair weekly Excel
  cut-downs with their final Substack reports, reconstruct the include, exclude and
  incident-grouping outcomes through an explicit reviewed mapping, preserve provenance from
  the living ledger through the candidate list to the publication, and reserve an untouched
  group of paired weeks as a holdout before the wider archive is opened to development. That
  split has not been made and was not invented here.
- **Precision is not a Sprint 3 target.** The classifier includes 6 rejected rows in each
  calibration week, and the needs-review queue holds about 30 percent of a weekly batch and
  11,074 rows of the ledger batch. That is the intended high-recall posture, but the queue is
  large enough that the Sprint 6 review workflow will need ordering.
- **Check-in #1 has not been submitted.** `docs/CHECKIN-1-DRAFT.md` is ready; submitting it is
  a human action, due 7 September 2026 at 11:59 PM America/Toronto.

## 10. Verification

Every command run after the final edit. Exit codes in the handoff.

`corepack pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`,
`test --force`, `build`, `verify`, `audit`; then against a local database `db:migrate` twice,
`db:check` and `test:db`; then `classify:run`, `classify:report`, `classify:queue` and
`classify:calibrate` against the three explicit batches; then `git diff --check`,
`git fsck --full` and `git status --short`.

**One unexplained test failure, recorded rather than hidden.** On the first full offline run in
a fresh clone of the correction, `packages/database/src/migrate.test.ts` reported its first
case failing while the other 23 database tests passed. It has not recurred in six subsequent
full-suite runs across two fresh clones, twenty-five consecutive runs of that file alone, or
the continuous integration run of the pushed branch, and the assertion diff was not captured
before the log was filtered. The test reads the migrations directory and compares each file's
checksum against a fresh read of the same bytes; nothing in the build or the test suite writes
to that directory. The cause is unknown. It is recorded here because an unreproduced failure
is still evidence, and a reviewer who sees it again should treat it as a real defect in the
loader rather than as noise.

## 11. Reproduction for Codex Desktop

1. Check out `sprint-3/classification-review-queue` at the final SHA, run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` and
   `corepack pnpm test --force`. No database, secret or network is needed.
2. Confirm the ruleset hash independently: build the workspace and evaluate `rulesetHash()`
   from `@cas/classification`, or hash the canonical behaviour contract yourself. It must
   equal the value in section 2.
3. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env`, run
   `corepack pnpm db:migrate` twice (five applied, then no-op), `db:check`, and `test:db`
   (100 tests, which create and drop only `cas_test_*` schemas). One of those files creates a
   schema named after the connecting role, to reproduce the capture the re-audit used, and
   drops it again.
4. For the real-data evidence, point `DATABASE_URL` at a clean database, import the three
   exports as in the Sprint 2 report, then run `classify:run`, `classify:report`,
   `classify:queue` and `classify:calibrate` for each batch. Compare with section 7. Re-run
   `classify:run` to see `already classified`.
5. Confirm the review tables are untouched by comparing `review_snapshots` and
   `review_entries` counts before and after a run.
6. For the immutability matrix, connect with `psql` and attempt the statements listed in
   section 12 against a completed run. Every one must be refused.
7. For the schema-capture and freeze evidence, follow section 13: create a schema named after
   the connecting role, put shadow tables in it, and repeat the two bypasses; then attempt a
   source-row mutation on a frozen batch.

## 12. Audit correction (correction)

Codex Desktop reviewed `974ec047620bd54dd6f66f25c576377d4a488241` on
`sprint-3/classification-review-queue` and returned CHANGES REQUIRED with five findings. This
section records what was wrong, why, and what replaced it. The corrections are additive
commits on the same branch; nothing was amended, rebased or force-pushed, and migrations
0001, 0002 and 0003 are byte-identical to the versions already applied.

### Finding 1. A result's fingerprint was not bound to its source row

**What was wrong.** `classification_results.row_hash` was only shape-checked as 64 hexadecimal
characters. Any syntactically valid SHA-256 could be stored against any row, and a source
row's hash could be changed afterwards without the stored result noticing. Separately, nothing
stopped a direct `UPDATE` or `DELETE` from rewriting a completed run's decisions, rationales,
counters or provenance, so the audit trail was advisory rather than enforced.

**Root cause.** The integrity claim lived in TypeScript, which wrote the correct value, rather
than in the schema, which permitted any value. Sprint 2 made exactly the opposite choice for
batches and rows, and Sprint 3 did not carry it forward.

**Correction.** Migration `0004_classification_integrity.sql`, SHA-256
`89763968c272d178a6a40c8f83ed5b28907c7e727393901ff99681b7b13ec719`, publishes
`(id, batch_id, row_hash)` on `source_rows` and adds a composite foreign key from
`classification_results (source_row_id, batch_id, row_hash)` to it. A wrong hash is now
impossible on insert and on update, a referenced source row cannot be re-hashed, and it cannot
be deleted. Two triggers make a completed run immutable: `classification_run_guard` refuses
every update and delete on a completed run and every provenance change on a running one, and
`classification_result_guard` refuses any insert, update or delete of a result whose run is
completed, taking a share lock on the parent run first so it cannot race a concurrent
completion.

### Finding 2. Two passes under READ COMMITTED could commit stale counters

**What was wrong.** The orchestration counted decisions in one pass and wrote them in a
second, inside a transaction opened with a plain `BEGIN`. That is READ COMMITTED, where each
statement takes a fresh snapshot, so the two passes could see different data and the run could
commit counters that did not describe its own stored results. The report claimed both passes
read one snapshot; that claim was false and has been corrected in section 3.

**Root cause.** The design assumed a transaction implies a stable snapshot. In PostgreSQL that
is true only from REPEATABLE READ upwards.

**Correction.** One pass, under an explicit snapshot, with the counters derived from what was
actually stored:

1. `BEGIN ISOLATION LEVEL REPEATABLE READ`, issued as the transaction's first statement.
2. Insert the run as `running` with zero counters and no completion time. The unique
   idempotency key is the concurrency gate: a second identical invocation blocks here.
3. Page the batch deterministically by the row's stable logical number, classify and persist.
4. Derive the counters from `classification_results` for that run.
5. Reconcile the stored results against the batch inside the same snapshot.
6. Transition to `completed` as the final database operation.

The transition is validated by the database, not by the caller. The trigger re-derives the
total and each decision count from the stored results, verifies the run covers every row of
its batch and holds no result from another batch, and refuses the transition otherwise. A run
can no longer be inserted as already complete.

### Finding 3. The ruleset hash did not cover everything that changes a decision

**What was wrong.** The hash covered the signal policy and the decision rules. Text assembly,
Unicode normalization, case folding, whitespace collapsing, field order and separator,
word-boundary policy, the input character limit, the scoring weights and the quarantine score
were all outside it, so changing any of them changed decisions while the hash, and therefore
the run's identity and idempotency key, stayed the same.

**Root cause.** The hash described the data the classifier used, not the behaviour it
implemented.

**Correction.** `packages/classification/src/contract.ts` declares the whole behaviour
contract, and the classifier reads its thresholds, weights, matching rules and text-assembly
rules from it rather than from constants that merely agree with it. The hash is the SHA-256 of
that document in canonical form. Twenty-seven single-component mutations are each proven to
change the hash, with no two colliding, and five tests prove the classifier actually honours a
changed contract rather than ignoring it. The identity this correction produced was
`rules-classifier@2` with ruleset `classification-behavior-contract@1` and hash
`af7e15d184293ce28ff10ee891f27d7fac41325a41e0953139578600466b202f`.

The re-audit did not accept this as closed. It showed that four of those twenty-seven
mutations changed the hash without changing what the compiled classifier returned, because
several declared fields were never read. Section 13, finding 3, records the correction; the
identity above is superseded.

### Finding 4. The input boundary denied known names instead of admitting known names

**What was wrong.** The runtime guard rejected a fixed list of prohibited field names. The
audit passed `analystDisposition` and `hiddenSnapshotToken` and both reached the classifier,
because neither was on the list.

**Root cause.** A denylist cannot enumerate what has not been thought of.

**Correction.** `assertClassificationInput` now admits exactly six own keys and nothing else.
The value must be a plain object whose prototype is `Object.prototype` or null; symbol keys,
accessor properties, inherited or polluted prototypes, and any additional own key are refused
whatever they are called. Rejections carry a fixed reason code and never echo the offending
key or its value.

### Finding 5. The queue command printed per-row detail

**What was wrong.** `classification queue` printed a source-row identifier, a row number, a
signal score and the rationale codes for every entry, and accepted a `--limit` up to 1,000.
That is a bulk per-row export from a compiled command, beyond the Sprint 3 output contract.

**Root cause.** The command was written for the implementer's convenience during calibration.

**Correction.** The command prints one line, `classification_queue count=<integer>`, from an
aggregate query. The paging flag is gone, so a page of entries cannot be requested at all. The
typed per-row operation remains in `@cas/database` for the authenticated review interface
Sprint 6 will build, and no compiled command calls it.

### Tests added by the correction

| Area                                               | Tests |
| -------------------------------------------------- | ----: |
| Behaviour contract and hash coverage               |    11 |
| Closed input allowlist                             |    13 |
| Source-row hash integrity (PostgreSQL)             |     4 |
| Completed-run and result immutability (PostgreSQL) |    12 |
| Completion correctness and derived counters        |     9 |
| Concurrent interference during a run (PostgreSQL)  |     4 |

The concurrency tests drive a second connection through a test-only seam that runs before each
page is fetched, so the interleaving is deterministic and no test sleeps. The seam cannot
change what is written; production callers never pass it. They prove that a row inserted
mid-run leaves the run's counters describing exactly its own results and the extra row
reported as uncovered rather than hidden; that a source row cannot be re-hashed while a
result of the running transaction references it, the tampering statement failing with
`23503`; that a row re-hashed before it is read makes the whole run fail, observed as `40001`,
rather than storing a fingerprint that has moved on; and that two identical concurrent
invocations produce exactly one run and one set of results.

### Real-data evidence for the correction

Migration 0004 was applied to the Sprint 2 working database, which held 24,248 source rows,
24,248 results and three completed runs from the rejected implementation. It applied cleanly,
validating every existing row: no result carried a hash its source row did not have. Counts
after the upgrade were identical, and `db:check` reported four applied migrations and no
drift.

Four tamper attempts were then made with `psql` against a real completed run:

| Statement                                      | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| `UPDATE classification_results SET decision`   | refused: results of a completed run are immutable         |
| `DELETE FROM classification_runs`              | refused: completed classification run is immutable        |
| `UPDATE classification_runs SET include_count` | refused: completed classification run is immutable        |
| `UPDATE source_rows SET row_hash`              | refused: foreign key `classification_results_row_hash_fk` |

Nothing changed: 24,248 results, three runs, and the master run's include count still 12,782.

The classification evidence in section 7 was then produced on a clean database, so it carries
one run per batch at the corrected ruleset hash. The corrected implementation reproduces the
rejected implementation's decisions exactly on all three batches: identical include, exclude
and review counts, identical rationale-code distributions, identical calibration. That is the
expected result. Every one of the five findings concerned integrity, identity, boundary or
output, not classification behaviour.

### What the first correction did not establish

Codex Desktop re-audited it and returned CHANGES REQUIRED. Of the five findings above, it
closed two and reopened three: the input allowlist and the count-only queue passed, while the
guard path proved bypassable, a completed run could still become unreconciled, and the hash
was still not bound to the whole executable behaviour. Section 13 records that second
correction.

## 13. Re-audit correction (correction)

Codex Desktop reviewed `4e9245b01f5f57bb1970c9e4e562823e14ab9c72` and returned CHANGES
REQUIRED with three implementation findings and one documentation finding. The corrections are
additive commits on the same branch: `cbcc402`, `a1ff07d`, `8aeba72` and `0c6222c`, the last
of which removes a constant the executable contract replaced. The complete final
implementation SHA is `0c6222c799145b1646a557a8d1f7169c308c373e`; the documentation SHA is the
branch head, given in the handoff, because a commit cannot contain its own identifier.
Migrations 0001 to 0004 are byte-identical and keep their applied checksums.

### Finding 1. Guard and migration checks could be redirected by search-path capture

**What was wrong.** Migration 0004 created both guard functions unqualified with `SET
search_path FROM CURRENT`, which in a default connection stores `"$user", public`. The
database helper set no search path at all when no test schema was requested, so a production
connection inherited the same default. A role that can create a schema named after itself
could therefore place shadow `classification_results`, `source_rows` and `schema_migrations`
tables in front of the real ones.

**Reproduced by the auditor.** A run holding zero results completed against a batch holding
one row, reported as `completed|real_source_rows=1|stored_results=0`. The same shadow schema
made `db:check` create and read a shadow migration table and report `applied=0 pending=4`
instead of the four real migrations.

**Root cause.** Integrity was written in terms of names the caller could rebind. A guard that
resolves its own tables through the caller's search path is not a guard.

**Correction.** Migration `0005_classification_schema_security.sql`, SHA-256
`f94c3342c1e2eb4d0d884a98b8afb8909d49d217fc0c3fdb094a3359004ae4de`, computes the schema it is
being applied in, refuses to proceed unless that schema actually holds the application tables,
and rebuilds every function and trigger through `pg_catalog.format` with quoted identifiers.
Each function stores `search_path = pg_catalog, <schema>, pg_temp`: built-ins first so a
shadowing function cannot displace one, the application schema next, and `pg_temp` last so the
session's temporary schema is searched after the application's tables rather than before them.
Every relation inside every function is named by schema. None is `SECURITY DEFINER`, so no
owner privilege is introduced.

Alongside it, `openDatabase` now always sets one explicit application schema, defaulting to
`public` rather than to the server's role-controlled default, and the migration runner names
`schema_migrations` by schema in every statement and keys its advisory lock on the handle's
schema rather than on `current_schema()`.

**Evidence.** Against a database carrying a schema named after the connecting role and shadow
`schema_migrations`, `classification_results` and `source_rows` tables:

| Probe                                                  | Result                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| compiled `db migrate`                                  | `applied=5` into the real schema          |
| compiled `db check`                                    | `applied=5 pending=0 drift=0`             |
| shadow `schema_migrations` rows afterwards             | 0                                         |
| real `public.schema_migrations` rows                   | 5                                         |
| complete a run holding no results, shadow schema first | refused: does not cover every row         |
| the same through `pg_temp` shadow tables               | refused: does not cover every row         |
| source-row deletion on a frozen batch                  | refused: source rows of a frozen batch    |
| completed runs in the real schema afterwards           | 0                                         |
| stored `search_path` of all five integrity functions   | `pg_catalog, public, pg_temp`, no `$user` |

### Finding 2. A completed run could become unreconciled after its batch changed

**What was wrong.** The classifier reconciled against its own repeatable-read snapshot, while
the permanent completed record is defined over the live batch. The auditor inserted a source
row from a second connection after the snapshot was established; the run committed, and the
database then held `source_rows=2, stored_results=1, uncovered=1, run_status=completed`. The
checked-in test accepted exactly that outcome.

**Root cause.** A stable snapshot answers "what did I read", not "what is this record about".
Nothing made the source set itself immutable, so the record could be outlived by its subject.

**Correction.** A batch's source set is frozen before the classifier reads a single row, and
the freeze is the transaction's first statement, so it also establishes the snapshot and takes
the batch row's write lock. Every source-row mutation passes through one statement that
updates the same batch row, which does two jobs at once: it refuses the mutation when the
batch is already frozen, and because it is a real update it makes a classifier holding an
older snapshot fail with a serialization error instead of missing the row. The two orderings
are therefore both safe:

- a mutation that commits before the freeze is inside the classified source set;
- a mutation still in flight is refused when it reaches its own update, and its rows roll back
  with it;
- a mutation that commits while the freeze waits for the lock makes the whole run fail with
  `batch_source_set_changed`, leaving no run and no results.

A run may no longer complete at all until its batch is frozen, so a completed record is
permanently reconciled by construction. Once frozen, a batch refuses source-row insertion,
deletion, rehashing, title, summary, description and status changes, batch reassignment,
origin reassignment, truncation, and deletion of the batch itself; the freeze marker cannot be
moved or cleared.

**Existing data.** Migration 0005 verifies that every existing completed run reconciles before
freezing anything, and fails transactionally rather than making an unreconciled run permanent.
It then freezes every batch that carries a completed run. Historical rejected and superseded
runs keep their records and remain individually addressable.

**Evidence.** Eight interference cases are driven from a second real connection through seams
inside the classifier's transaction, with no sleeps. Seven start after the freeze and must be
refused: insert, delete, rehash, title change, summary change, status change, batch
reassignment and origin reassignment. Two more cover the pre-freeze window: one commits before
the freeze and must be classified, and one commits while the freeze is waiting, which must
leave no run at all. The waiting case coordinates on `pg_stat_activity` reporting a session
blocked on a lock, so the interleaving is exact rather than timed. Every returned completed
run is then re-checked in the live database for `reconciled=true`, equal source and result
counts, zero uncovered rows, zero duplicate coverage and counters equal to the stored results.

### Finding 3. The hash was not bound to the whole executable behaviour

**What was wrong.** Reversing `decisionRules`, rewriting the in-scope rationale mapping,
setting `scoring.maximum` to zero and emptying `allowedInputKeys` each produced a distinct
hash while the compiled classifier returned the same `include`, the same `decisive_signal` and
the same score of 3 for the same input.

**Root cause.** The contract described the engine instead of driving it. Precedence and
rationale mapping were hard-coded, the taxonomy was imported directly, and the matcher cache
was built once from the default contract.

**Correction.** `classify(input, contract)` now reads admission and field shapes, text
assembly, matching including the taxonomy and pattern signals, thresholds, rule order and
precedence, rationale emission and its order, quarantine handling and scoring with both
bounds, all from the supplied contract. Matchers are built from the supplied contract and
cached only for one that is deeply frozen, so a mutable contract is rebuilt on every call and
two contracts can never share an entry; the production contract is deep-frozen after
construction. Rationale codes are stored in emission order, which makes that order behaviour
rather than decoration. Fields that could not be executed were removed.

**Evidence.** Twenty-six behaviour mutations, each paired with an input chosen so the mutation
must change an observable result, covering decision precedence, the conflict rule, rationale
mapping and emission order, quarantine handling, admission and field shape, taxonomy terms,
tiers and patterns, boundary class, term ordering, case sensitivity, field order, separator,
null handling, Unicode form, case and whitespace normalization, truncation, all three
thresholds, and the scoring weights, minimum and maximum. Two of them, field order and the two
case fields, are proven against an explicit baseline contract because they are only observable
in combination; the pair still isolates the single field. Four identity mutations are proven
to change the hash and, deliberately, not the behaviour. Key order and pretty-printing are
proven not to change the hash, while array order is proven to change it. Matcher isolation is
proven by interleaving two contracts and by editing a mutable one between calls.

### Finding 4. The documentation overstated closure

Section 14 is the audit history the re-audit asked for, and the closure language throughout
this document now names what an auditor has verified rather than what this implementation
believes.

### Real-data evidence for the second correction

Applied to the same dedicated local database, which held 24,248 source rows and six completed
runs from the two earlier generations.

| Measure            | Before | After  |
| ------------------ | ------ | ------ |
| Import batches     | 3      | 3      |
| Source rows        | 24,248 | 24,248 |
| Row issues         | 9      | 9      |
| URL groups         | 23,640 | 23,640 |
| Review snapshots   | 2      | 2      |
| Review entries     | 338    | 338    |
| Applied migrations | 4      | 5      |

Every pre-existing completed run reconciled before the freeze, so migration 0005 proceeded and
froze all three batches. A rerun was a no-op and `db:check` reported no drift. Four tamper
attempts against the historical runs and two against the frozen source rows were all refused,
and the counts above did not move.

Three new runs were then created at the corrected identity.

| Batch  | Rows expected | Rows classified |    include | exclude |     review | Uncovered | Duplicated | Reconciled |
| ------ | ------------: | --------------: | ---------: | ------: | ---------: | --------: | ---------: | ---------- |
| master |        23,910 |          23,910 |     12,782 |      54 |     11,074 |         0 |          0 | yes        |
| CS79   |           157 |             157 |        110 |       1 |         46 |         0 |          0 | yes        |
| CS86   |           181 |             181 |        123 |       0 |         58 |         0 |          0 | yes        |
| Total  |    **24,248** |      **24,248** | **13,015** |  **55** | **11,178** |     **0** |      **0** |            |

All three CS79 quarantined rows are `review` with the single code `row_quarantined`. Repeating
a run returned the same run identifier and wrote nothing. `calibrate` on the master run exited
2 with `no_review_snapshot`. The queue command printed `classification_queue count=11074`,
`count=46` and `count=58`, one line each. The human review tables were unchanged throughout:
2 snapshots, 338 entries, 291 selected, 47 rejected.

Calibration, recomputed from the final runs: CS79 candidate-retention **0.992307**, strict
include recall 0.8, include precision against kept candidates 0.945454, queue rate 0.292993;
CS86 candidate-retention **1.0**, strict include recall 0.726708, include precision 0.951219,
queue rate 0.320441. Both meet the 0.98 target. Both measure the weekly candidate stage only,
as section 7 explains.

These figures match the two earlier generations exactly, which is the expected result: none of
the four findings concerned classification behaviour. That the counts are unchanged is proven
from the final runs rather than assumed, by the per-run integrity query above.

## 14. Audit history

| Stage                      | Complete SHA                               | Ruleset hash                                                       |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| Original candidate         | `974ec047620bd54dd6f66f25c576377d4a488241` | `6aae18f3f7e6433615be7de68b5120b6956f377cba4d7b71f013e5c2db1ea04c` |
| First correction candidate | `4e9245b01f5f57bb1970c9e4e562823e14ab9c72` | `af7e15d184293ce28ff10ee891f27d7fac41325a41e0953139578600466b202f` |
| Superseded intermediate    | never committed; see below                 | `46668bccc130c4c8a43ad6b341db8ae19273ee15b85cebf3bc91ebac6d7dd115` |
| Second correction          | `8aeba7290bd1b555a092acbe63cb5b0be7276fde` | `c396ff1dd2da2b800965fc6a4816545b6939c813e57914e0591e19534d6ae58a` |

**The superseded intermediate.** During the first correction the classifier was rewritten to
read its thresholds and weights from the contract, and that rewrite silently dropped the
in-scope rationale codes from conflicting rows: `decisive_signal` and `contextual_signals` no
longer accompanied `signals_conflicting`. It was caught by comparing the corrected run against
the rejected one row by row, and corrected before any commit. Commit
`7b912c7` on this branch, which introduced the rewrite, already carries the restored
emissions, so the loss exists in no commit on any branch. It exists only as three completed
runs in the dedicated local database, written from the uncommitted working tree, and their
ruleset hash is the one above. On the master batch they differ from the corrected runs by 16
`decisive_signal` and 41 `contextual_signals` codes across the 43 conflicting rows; every
decision, every matched signal and every score is identical.

**Status of the historical runs.** The dedicated database now holds nine completed runs: three
at the original hash, three at the superseded intermediate hash, and three at the current one.
All nine are immutable, all nine remain individually addressable by run identifier, and their
batches are frozen. They are superseded historical evidence, not current results. No command
selects any of them implicitly: every classification command requires an explicit batch or run
identifier and there is no "latest" default anywhere.

**What the audits closed and reopened.** The first correction closed the exact input allowlist
and the count-only queue output; the re-audit verified both independently and left them
closed. The re-audit reopened result-hash binding, counter correctness and hash coverage
because each was reachable through the search path, the mutable batch or the unexecuted
contract. Those three are what section 13 corrects.

**What remains open.** Every claim in sections 13 and 14 is this implementation's claim and is
pending Codex Desktop verification. Decisions D9 and D10 remain unresolved. Check-in #1 has
not been submitted, and nothing here should be read as saying it was; only the project owner
can confirm a submission. Sprint 4 has not begun.
