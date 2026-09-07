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
| Classifier version | `rules-classifier@1`                                               |
| Ruleset version    | `classification-signal-policy@1`                                   |
| Text assembly      | `classification-text-assembly@1`                                   |
| Mode               | `rules`                                                            |
| Ruleset hash       | `6aae18f3f7e6433615be7de68b5120b6956f377cba4d7b71f013e5c2db1ea04c` |

The ruleset hash is the SHA-256 of a canonical JSON document containing the classifier
version, the mode, the text-assembly version, the ordered decision rules and the entire signal
policy with its terms sorted. Any change to a term, a tier or a threshold changes the hash,
and the hash is stored on every run.

**Allowed classifier inputs.** Exactly six fields: the source-row identifier, the row hash,
the ingestion status (`accepted` or `quarantined`), the normalized title, the derived summary
text and the derived description text.

**Prohibited inputs**, refused by the type and again at runtime by name: human review state,
weekly selected or rejected labels, the master `ch` working state, publisher category, URLs in
any form, raw cells or raw fields, batch labels, snapshot identifiers, and any database
connection value. A caller that widens the object with any of these gets a
`ClassificationInputError` naming the field, not the value.

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
before its results. The orchestration therefore makes two bounded passes over the batch: the
first counts decisions without retaining them so the run can be written with true counts, and
the second writes the results. The classifier is pure, so the second pass reproduces the first
exactly, and both run inside one transaction on one snapshot. This keeps memory bounded at one
page and keeps every foreign key immediate rather than deferred.

## 4. Database access (design)

`fetchClassificationInputs` selects only the six permitted fields, orders by the row's stable
logical number, and continues with a keyset cursor bounded to at most 1,000 rows a page, so
the master batch's large derived text is never all in memory at once. It joins no review
table. `fetchCalibrationMatrix` is the only query that touches a decision and a human label
together; it runs after classification and returns counts grouped by decision and review
state. `countReviewState` provides a count-only fingerprint used to prove classification
changed nothing.

## 5. Command-line interface (design)

| Command                                           | Root script          |
| ------------------------------------------------- | -------------------- |
| `classification run --batch <uuid>`               | `classify:run`       |
| `classification report --run <uuid>`              | `classify:report`    |
| `classification queue --run <uuid> [--limit <n>]` | `classify:queue`     |
| `classification calibrate --run <uuid>`           | `classify:calibrate` |

Every command validates its UUID before any database access, inherits the existing database
configuration validation, and prints through the existing redactor and single-line guard.
There is no implicit "latest run" anywhere: `report`, `queue` and `calibrate` each require an
explicit run identifier. `calibrate` refuses a batch with no weekly review snapshot. Output
carries identifiers, versions, hashes, counts, statuses, durations and fixed vocabulary only.

## 6. Tests (tests)

Offline tests need no database, no secret and no network, and run in continuous integration.

| Package               | Offline | PostgreSQL |
| --------------------- | ------: | ---------: |
| `@cas/contracts`      |       7 |            |
| `@cas/taxonomy`       |       7 |            |
| `@cas/classification` |      33 |            |
| `@cas/database`       |      24 |         35 |
| `@cas/graph-evidence` |     102 |            |
| `@cas/worker`         |     126 |         17 |
| **Total**             | **299** |     **52** |

Per file, for the files this sprint added or changed:

| File                                                   | Tests |
| ------------------------------------------------------ | ----: |
| `packages/taxonomy/src/signal-policy.test.ts`          |     7 |
| `packages/classification/src/classifier.test.ts`       |    22 |
| `packages/classification/src/calibration.test.ts`      |     7 |
| `packages/classification/src/label-invariance.test.ts` |     4 |
| `packages/database/src/migrate.test.ts`                |     3 |
| `packages/database/src/classification.db.test.ts`      |    13 |
| `packages/database/src/migrate.db.test.ts`             |     7 |
| `apps/worker/src/cli.test.ts`                          |    20 |
| `apps/worker/src/classification/output.test.ts`        |     7 |
| `apps/worker/src/classification/run.db.test.ts`        |     9 |

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

Run on 7 September 2026 against the dedicated local verification database established in
Sprint 2, which already held the three imported batches under migrations 0001 and 0002.
`DATABASE_URL` was never printed.

**Upgrade.** `db:migrate` applied `0003` alone (`applied=1 alreadyApplied=2 total=3`), a rerun
was a no-op, and `db:check` reported three applied migrations and no drift. Counts before and
after the upgrade were identical: 3 import batches, 24,248 source rows, 9 row issues, 23,640
URL groups, 2 review snapshots, 338 review entries. A fresh database separately applied all
three migrations in order and reran as a no-op, producing the nine expected tables.

**Classification of the three explicit batches.**

| Batch  | Rows expected | Rows classified |    include | exclude |     review | Reconciled |
| ------ | ------------: | --------------: | ---------: | ------: | ---------: | ---------- |
| master |        23,910 |          23,910 |     12,782 |      54 |     11,074 | yes        |
| CS79   |           157 |             157 |        110 |       1 |         46 | yes        |
| CS86   |           181 |             181 |        123 |       0 |         58 | yes        |
| Total  |    **24,248** |      **24,248** | **13,015** |  **55** | **11,178** |            |

Every run stored exactly one result per source row: 24,248 results, and a query for any
(run, row) pair with a count other than one returns zero. The three CS79 quarantined rows all
received `review` with the single rationale code `row_quarantined`. The needs-review queue is
non-empty for every run. Re-running the master and CS79 batches with the same ruleset returned
the original run identifiers and wrote nothing. `calibrate` on the master run exited 2 with
`no_review_snapshot`, as required.

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
- **Two bounded passes per run** rather than one, for the foreign-key ordering reason in
  section 3. The cost is classifying each row twice; the master batch takes about 15 seconds.
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
- **Continuous integration runs no database.** The 52 PostgreSQL tests run only through
  `test:db` with a local `DATABASE_URL`. Continuous integration proves the 299 offline tests
  and nothing about the schema.
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
`test --force`, `build`, `verify`, `audit`; then against the dedicated verification database
`db:migrate` twice, `db:check` and `test:db`; then `classify:run`, `classify:report`,
`classify:queue` and `classify:calibrate` against the three explicit batches; then
`git diff --check`, `git fsck --full` and `git status --short`.

## 11. Reproduction for Codex Desktop

1. Check out `sprint-3/classification-review-queue` at the final SHA, run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` and
   `corepack pnpm test --force`. No database, secret or network is needed.
2. Confirm the ruleset hash independently: build the workspace and evaluate `rulesetHash()`
   from `@cas/classification`, or hash the canonical ruleset document yourself. It must equal
   the value in section 2.
3. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env`, run
   `corepack pnpm db:migrate` twice (three applied, then no-op), `db:check`, and `test:db`
   (52 tests, which create and drop only `cas_test_*` schemas).
4. For the real-data evidence, point `DATABASE_URL` at a database holding the Sprint 2 import,
   read the three batch identifiers from `import_batches`, and run `classify:run`,
   `classify:report`, `classify:queue` and `classify:calibrate` for each. Compare with
   section 7. Re-run `classify:run` to see `already classified`.
5. Confirm the review tables are untouched by comparing `review_snapshots` and
   `review_entries` counts before and after a run.
