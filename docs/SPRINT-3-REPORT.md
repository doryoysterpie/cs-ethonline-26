# Sprint 3 report: high-recall classification and the needs-review queue

Result: **COMPLETE, pending Codex Desktop audit.** Nothing in this document declares Sprint 3
accepted. All times America/Toronto unless marked UTC. Count-only throughout: no title, URL,
summary, description, cell, connection detail or absolute path appears here.

**How to read this report.** Each section is labelled by the kind of evidence it carries:
**design** is a claim about how the code is built, **tests** is automated evidence that runs
offline, **PostgreSQL** is integration evidence against a live database, and **real data** is
count-only evidence from the three imported real exports. Historical figures from earlier
sprints are marked as such.

| Item               | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| Repository         | `doryoysterpie/cs-ethonline-26`, public                                              |
| Branch             | `sprint-3/classification-review-queue`, created from the audited Sprint 2 SHA        |
| Starting SHA       | `000c3410848a531bed23d93e6cabc73cc3942a1b` (Sprint 2, audited PASS by Codex Desktop) |
| Final SHA          | in the handoff                                                                       |
| `main`             | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                              |
| Decision           | D21, appended 7 September 2026                                                       |
| Migration added    | `packages/database/migrations/0003_classification.sql`                               |
| Migrations 1 and 2 | unchanged; checksums verified against the accepted values                            |
| Model calls        | none; no Anthropic SDK, no model path, no credential read                            |

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
| Classifier version | `rules-classifier@2`                                               |
| Ruleset version    | `classification-behavior-contract@1`                               |
| Engine version     | `classification-engine@1`                                          |
| Mode               | `rules`                                                            |
| Ruleset hash       | `af7e15d184293ce28ff10ee891f27d7fac41325a41e0953139578600466b202f` |

The ruleset hash is the SHA-256 of a canonical JSON document covering every component that can
change an outcome: the versions and mode, the allowed input keys, the whole text-assembly rule
set (field order, separator, null and empty handling, Unicode normalization form, case and
whitespace normalization, the input character limit and whether truncation occurs), the
matching rules (word-boundary policy, boundary character class, term ordering, duplicate
handling, case sensitivity and the pattern signals), the thresholds, the ordered decision
rules, the rationale-code vocabulary, the scoring formula with its weights and bounds, and the
entire signal policy with its terms sorted. Any change to any of them changes the hash, and
the hash is stored on every run.

The classifier reads its behaviour from that document at run time rather than from constants
that merely happen to agree with it, so a component that is not covered by the hash cannot
silently change a decision. This is the correction to audit finding 3; the rejected version
hashed the signal policy and the decision rules only, and the audit demonstrated that changing
the text-assembly or matching behaviour left the hash unchanged.

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

**Rationale codes.** A fixed vocabulary, stored per result, never a source excerpt:
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
| `@cas/classification` |      55 |            |
| `@cas/database`       |      24 |         59 |
| `@cas/graph-evidence` |     102 |            |
| `@cas/worker`         |     126 |         21 |
| **Total**             | **321** |     **80** |

Per file, for the files this sprint added or changed:

| File                                                   | Tests |
| ------------------------------------------------------ | ----: |
| `packages/taxonomy/src/signal-policy.test.ts`          |     7 |
| `packages/classification/src/classifier.test.ts`       |    20 |
| `packages/classification/src/contract.test.ts`         |    11 |
| `packages/classification/src/input.test.ts`            |    13 |
| `packages/classification/src/calibration.test.ts`      |     7 |
| `packages/classification/src/label-invariance.test.ts` |     4 |
| `packages/database/src/migrate.test.ts`                |     3 |
| `packages/database/src/classification.db.test.ts`      |    37 |
| `packages/database/src/migrate.db.test.ts`             |     7 |
| `apps/worker/src/cli.test.ts`                          |    20 |
| `apps/worker/src/classification/output.test.ts`        |     7 |
| `apps/worker/src/classification/run.db.test.ts`        |    13 |

The counts above are the corrected totals. The rejected candidate had 33 classification tests,
13 in `classification.db.test.ts` and 9 in `run.db.test.ts`; section 12 lists what the
correction added.

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

**Calibration, CS79.** Labelled rows 157: selected 130, rejected 27, unreviewed 0.

| Decision | selected | rejected |
| -------- | -------: | -------: |
| include  |      104 |        6 |
| exclude  |        1 |        0 |
| review   |       25 |       21 |

Selected-retention recall **0.992307**, target 0.98, met. Strict include recall 0.8. Include
precision against selected 0.945454. Needs-review 46, rate 0.292993. Automation rate 0.707006.

**Calibration, CS86.** Labelled rows 181: selected 161, rejected 20, unreviewed 0.

| Decision | selected | rejected |
| -------- | -------: | -------: |
| include  |      117 |        6 |
| exclude  |        0 |        0 |
| review   |       44 |       14 |

Selected-retention recall **1.0**, target 0.98, met. Strict include recall 0.726708. Include
precision against selected 0.951219. Needs-review 58, rate 0.320441. Automation rate 0.679558.

**Provenance.** The human review tables were identical before and after classification: 2
snapshots, 338 entries, 291 selected, 47 rejected. The master `ch` column is not read by any
classification query. Every stored result carries the batch and run that produced it.

## 8. Judgment calls and deviations

- **One selected CS79 row was classified `exclude`.** Its stored rationale codes are
  `no_signal_match` and `out_of_scope_signal`, and the only matched policy signal is `sport`,
  meaning the text carried explicit sports vocabulary and no security vocabulary of any tier.
  Retention still exceeds the target at 0.992307. The rules were **not** changed in response:
  tightening exclusion after seeing which labelled row it cost would be fitting the classifier
  to the calibration set, which decision D21 forbids. A future ruleset version may require two
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
- **Continuous integration runs no database.** The 80 PostgreSQL tests run only through
  `test:db` with a local `DATABASE_URL`. Continuous integration proves the 321 offline tests
  and nothing about the schema. Every constraint and trigger added by migration 0004,
  including the whole immutability matrix, is therefore unproven by continuous integration and
  must be re-proven by any reviewer with a local database.
- **Calibration is not a holdout.** CS79 and CS86 are calibration sets. The recall figures
  describe them, not unseen weeks, and no holdout evaluation has been run; that is Sprint 7.
- **Precision is not a Sprint 3 target.** The classifier includes 6 rejected rows in each
  calibration week, and the needs-review queue holds about 30 percent of a weekly batch and
  11,074 rows of the master feed. That is the intended high-recall posture, but the queue is
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
   `corepack pnpm db:migrate` twice (four applied, then no-op), `db:check`, and `test:db`
   (80 tests, which create and drop only `cas_test_*` schemas).
4. For the real-data evidence, point `DATABASE_URL` at a clean database, import the three
   exports as in the Sprint 2 report, then run `classify:run`, `classify:report`,
   `classify:queue` and `classify:calibrate` for each batch. Compare with section 7. Re-run
   `classify:run` to see `already classified`.
5. Confirm the review tables are untouched by comparing `review_snapshots` and
   `review_entries` counts before and after a run.
6. For the immutability matrix, connect with `psql` and attempt the statements listed in
   section 12 against a completed run. Every one must be refused.

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
changed contract rather than ignoring it. The corrected identity is `rules-classifier@2` with
ruleset `classification-behavior-contract@1` and hash
`af7e15d184293ce28ff10ee891f27d7fac41325a41e0953139578600466b202f`.

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

### What this correction does not establish

The correction has not been audited. Codex Desktop's verdict on the rejected candidate stands
until it reviews these commits. Sprint 3 is not accepted, and Check-in #1 has not been
submitted.
