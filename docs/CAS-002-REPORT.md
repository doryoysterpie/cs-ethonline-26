# CAS-002 report: categories

Unit tracker: `docs/tcu/CAS-002.md`; live status: issue #4. Branch `cas-002/categories` from
`cas-001/sheets-intake` at `2ad714d`, stacked on pull request 14 so that its migration number
follows the one that unit adds. This report grows one section per step. Nothing in it marks a
test as passed until the runner's own counts are recorded here. Audit state: not audited.

## 1. Design note, S0, written before the database code (step 3)

Written 22 October 2026 from the code on `cas-001/sheets-intake` at `2ad714d`. Every claim
below names its file or the command that showed it.

### 1.1 What a category is, in one paragraph

A category is one question the classifier answers about every imported story, together with
the vocabulary, thresholds and weights that answer it. `cyberattack` asks "Is this a
cybersecurity incident story?" and is bound, by reference and not by copy, to the signal
policy Sprint 3 shipped, `classification-signal-policy@1`. `crypto` asks "Is this a crypto
story?" and carries a new policy, `crypto-signal-policy@1`. A classification run answers one
category's question over one batch and records which category that was. The engine, the input
allowlist, the text assembly, the matching rules and the ordered decision rules are the same
for every category; only the policy differs. Adding a category is therefore adding a policy
and its tests, which a fixture-only category proves.

### 1.2 The category contract, in `@cas/taxonomy`

`packages/taxonomy/src/categories.ts` declares the closed vocabulary `CATEGORIES`
(`cyberattack`, `crypto`) and one `CategoryPolicy` per category: the identifier, the question,
the policy version, the term signals, the pattern signals, the two include thresholds, the
tier weights and a `calibrated` flag. The cyberattack policy is assembled from the Sprint 3
exports (`CLASSIFICATION_SIGNALS`, the CVE pattern, `POLICY_THRESHOLDS`, `SIGNAL_WEIGHTS`), so
there is one copy of that vocabulary in the repository. The crypto policy adds eleven decisive
signals (currencies, stablecoins, DeFi, chains, exchanges, theft vocabulary), eight contextual
signals, and shares the general out-of-scope vocabulary; its thresholds are one decisive hit
or two distinct contextual hits, the same shape as cyberattack. `calibrated` is `false` for
crypto: retention recall is unmeasured until the owner names a labelled set (step 2), and the
policy says so in code rather than implying otherwise.

### 1.3 The contract and its hash, in `@cas/classification`

`buildContract(policy)` in `packages/classification/src/contract.ts` builds the executable
behaviour contract for one policy, frozen, with the identity fields, the allowlist, the text
assembly, the matching rules, the thresholds, the decision rules and the scoring. Built for the
cyberattack policy it reproduces the Sprint 3 contract byte for byte: the ruleset hash is
`c396ff1dd2da2b800965fc6a4816545b6939c813e57914e0591e19534d6ae58a`, the hash every earlier
run recorded, which a test asserts against the literal. `packages/classification/src/categories.ts`
builds one contract per category at module load (`CATEGORY_CONTRACTS`, `contractFor`,
`categoryRulesetHash`). The crypto contract hashes to
`4443e5c92bcb304ddd1b151d811ed67aab11257123cc861234a2beb24e56d9db`. Because a run's
idempotency key includes the ruleset hash (`computeRunIdempotencyKey`), the two categories are
two distinct runs on the same batch by construction, and repeating either is idempotent.

### 1.4 The result shape: one run per category, recorded beside the run

The plan's wording is "a migration that stores the category with each result". The unit
stores it once per run rather than once per result, on this ground: every result already
belongs to its run by `run_id` (migration 0003), the run already records the ruleset hash that
fixes the contract it was decided under, and a category is a name for that hash. One row per
run gives every result its category by a join, leaves the results table (24,608 rows per run
on the living feed) exactly as migration 0003 defined it, and adds no column to a table whose
append-only guard already stands. Had the category been a column on results, a row could in
principle disagree with its run; stored beside the run and bound to the run's hash, it cannot.

The review queue and the calibration evaluator take a run, and a run has one category, so
"the queue shows one category at a time" holds without a filter: `classification queue --run`
on the crypto run is the crypto queue. The report prints the category on its second line.

### 1.5 Runs that predate categories

Every run written before this unit answered the cyberattack question under the hash above.
Nothing is backfilled and no row is invented for them: the report prints
`category: none recorded` with the instruction to identify the run by its ruleset hash, and
the read returns `null`. This follows the rule the plan sets for earlier records, validated and
never reinterpreted: a reader who needs to know what an old run was compares the hash the run
itself recorded with the hash the cyberattack policy builds to today, and that comparison is a
test in `categories.test.ts`.

### 1.6 Migration: 0013, not 0012

The tracker, written in September, named this unit's migration 0012. CAS-001 took 0012 for the
Sheets import provenance on its branch, which this branch is stacked on, so this unit's
migration is `0013_classification_categories.sql`. It adds one table,
`classification_run_categories` (`run_id` primary key, `batch_id`, `data_origin`, `category`,
`policy_version`, `policy_hash`, `created_at`), with the composite foreign keys migration 0003
and 0002 declared (run and batch, batch and origin), and one guard,
`classification_run_category_guard`, which refuses a row whose policy hash is not the ruleset
hash its run recorded, whose origin is not its run's, or whose run does not exist, and refuses
every update and delete. Migrations 0001 to 0012 are unchanged. The function is created
through `pg_catalog.format` with quoted identifiers, stores `search_path = pg_catalog,
<schema>, pg_temp`, and is not `SECURITY DEFINER`, like every guard before it.

### 1.7 Files touched, and not touched

Touched: `packages/taxonomy/src/categories.ts` (new) and its index;
`packages/classification/src/contract.ts` (`buildContract`), `categories.ts` (new),
`categories.test.ts` (new) and its index; `packages/database/migrations/0013_classification_categories.sql`
(new), `packages/database/src/classification.ts` (`insertClassificationRunCategory`,
`getClassificationRunCategory`) and its index; `apps/worker/src/classification/run.ts`
(`category` on the request and the outcome, the category row written in the run's
transaction), `report.ts` (`category` on the report), `output.ts` (one word on the run line,
one line on the report), `apps/worker/src/cli.ts` (`--category`); the migration-count tests;
`README.md` and `docs/ARCHITECTURE.md`.

Not touched: the classifier engine (`classifier.ts`, `input.ts`, `text.ts`), the Sprint 3
signal policy file, every applied migration, the results table, the review tables, the
dashboard, clustering, drafting, the importers. The runtime input guard is unchanged: the same
six keys cross into the classifier, whatever the category.

### 1.8 Decisions this design needs, and who takes them

- Step 1, deterministic rules or a model, is the owner's. This unit proceeds on the plan's
  recommendation, deterministic per-category rules, because the cyberattack rules exist and
  calibrate. If the owner decides on a model, the category contract and migration 0013 stand
  as they are (the category record does not depend on how a decision is made), the run's
  `mode` would take a new value, and D9's parameters reopen.
- Step 2, whether a labelled crypto weekly set exists, is the owner's. Until answered, crypto
  recall is unmeasured in v0, in those words, and `calibrated: false` says so in code.
- No new decision is recorded in `docs/DECISIONS.md` by this unit; the two above are the
  owner's to record once answered.

### 1.9 Verification plan for this unit

Offline: the cyberattack hash regression guard; per-category decisions; the fixture-only third
category; the output lines. PostgreSQL: the guard's three refusals and append-only behaviour in
the database package, at the point the migration makes its claims; in the worker, the default
run recorded as cyberattack with the Sprint 3 hash, and a second category on the same batch
as a distinct, reconciled, idempotent run with its own hash. The full verify loop and all four
database suites in this checkout, then CI on the exact commit under review.

## 2. Contracts and the pure classifier, S3, with their tests (step 5)

Built 22 October 2026. `buildContract` replaced the single hand-assembled contract object with
a builder over a policy; `CONTRACT = contractFromPolicy(CYBERATTACK_POLICY)` keeps the Sprint 3
export, and the test `builds byte for byte to the contract every earlier run recorded` asserts
the literal hash. `classify(input, contract)` was already contract-parameterised after the
Sprint 3 audit, so the engine did not change. From the runner: `@cas/classification` 62 tests
pass (6 of them new, in `categories.test.ts`), `@cas/taxonomy` 7 pass.

## 3. Migration, operations, worker and command line, S2 to S6 (steps 4, 6 and 7)

### 3.1 What was built

Migration 0013 as designed in 1.6; checksum
`0e46fd5280e2bedeebdddad4138cf455a1c110a89cab7efc975f34b4e46f5f5d`. Two database operations,
insert and read. In the worker, `classifyBatch` takes `category` (default `cyberattack`),
selects the contract and hash for it, and writes the category row immediately after the run
row, inside the same repeatable-read transaction, so a run and its category commit or roll
back together. `reportRun` reads the category; the run line and the report carry it. The
command line takes `--category <cyberattack|crypto>` on `classification run`, refuses any
other value as a configuration error naming the allowed values, and `report`, `queue` and
`calibrate` need no flag because the run they name carries its category.

### 3.2 Deviations from the design note, recorded

None in substance. One test adjustment: the two regression tests that prove migration 0007
refuses violating data build their state on a schema stopped at 0006, where the category table
does not exist. They now seed the classification run through the database operations, with
the same pure classifier, instead of through `classifyBatch`, which records the category and
therefore needs the current schema. The helper is in `apps/worker/src/clustering/run.db.test.ts`
and says why it exists.

### 3.3 Tests, from the runner

In this checkout on 22 October 2026, `corepack pnpm verify` exits 0 (format, lint, typecheck,
every offline suite, the tool tests, the repository checks and the build), and
`corepack pnpm test:db` against a local PostgreSQL 17 exits 0:

| Suite                         | Result             |
| ----------------------------- | ------------------ |
| `@cas/classification` offline | 62 passed          |
| `@cas/taxonomy` offline       | 7 passed           |
| `@cas/worker` offline         | 270 passed (1 new) |
| `@cas/database` PostgreSQL    | 96 passed (4 new)  |
| `@cas/worker` PostgreSQL      | 112 passed (2 new) |
| `@cas/dashboard` PostgreSQL   | 20 passed          |
| `@cas/mcp-server` PostgreSQL  | 49 passed          |

### 3.4 Not done here

The dashboard queue page per category (step 8), calibration on real data (step 9), the
owner's two decisions (steps 1 and 2), the clean-clone verification and CI run (step 11), and
the independent review (step 12). Migration 0013 is applied nowhere outside test schemas: it
reaches the production database only through Railway's deploy step after this unit merges,
which in turn follows the merge of pull request 14.

## 4. The dashboard read path, S5 (step 8)

Built 22 October 2026. The command-center read (`commandCenter` in
`apps/dashboard/src/server/dal/read.ts`) now joins the category rows of the runs it lists in
one statement, through `listClassificationRunCategories`, bounded like the other paged reads;
the per-run read (`reviewQueue`) reads its run's category row. Both DTOs carry
`category: string | null`, `null` for a run that predates migration 0013. The queue index page
shows a Category column, offers one filter link per category present in the listed runs, and
filters the already bounded list on the server. The filter value is compared and never echoed;
the only category names the page renders come from the database, where a check constraint
bounds their alphabet. The per-run queue page prints the category in its header line. No
capability changed: both pages read through the same `view:queue` guard as before. The
command-center page is unchanged; its DTO carries the field for a later column.

From the runner, the same day: `verify` exit 0; PostgreSQL suites database 96 (one new test for
the batched read), worker 112, dashboard 20 (two assertions added to the existing
command-center and queue tests), mcp-server 49.

## 5. Verification in a clean clone and on CI, S8 (step 11)

22 October 2026, commit `36c07ee` (the head before this section was added; the commit that
adds it changes documentation only). A fresh `git clone` of the branch into an empty
directory, Node 24.21.0, pnpm 11.10.0:

| Step                                                  | Result                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `corepack pnpm install --frozen-lockfile`             | exit 0                                                                   |
| `corepack pnpm verify`                                | exit 0; 1,066 offline tests, 30 tool tests                               |
| `corepack pnpm test:db` against a local PostgreSQL 17 | exit 0; 277 tests (database 96, worker 112, dashboard 20, mcp-server 49) |

CI on pull request 19 at the same commit: Verify, PostgreSQL integration, Supply chain,
CodeQL and Analyze all pass. The diff is narrated in the hand-back that asks for the review.
