# Sprint 4 report: deterministic clustering and canonical incident construction

Result: **IMPLEMENTED, pending independent Codex Desktop audit.** Nothing in this document
declares Sprint 4 accepted or audited. All times America/Toronto unless marked UTC.
Count-only throughout: no title, URL, summary, description, organisation, cell, connection
detail or absolute path appears here.

**How to read this report.** Each section is labelled by the kind of evidence it carries:
**design** is a claim about how the code is built, **tests** is automated evidence that runs
offline, **PostgreSQL** is integration evidence against a live database, and **real data** is
count-only evidence from the three imported real batches.

| Item              | Value                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| Repository        | `doryoysterpie/cs-ethonline-26`, public                                 |
| Branch            | `sprint-4/clustering-incidents`, created from the accepted Sprint 3 SHA |
| Starting SHA      | `71394c9b8e732bc7508b6276eafcbbac414c3a07` (Sprint 3, accepted)         |
| `main`            | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                 |
| Decision          | D22, appended 8 September 2026                                          |
| Migration added   | `packages/database/migrations/0006_incident_clustering.sql`             |
| Migrations 1 to 5 | unchanged; checksums verified against the accepted values               |
| Model calls       | none; no SDK, no model path, no credential read                         |
| Watchlist         | administrative-event lane deferred by accepted scope deviation (D23)    |

## 1. Sprint 3's status

Sprint 3 is **accepted** at `71394c9b8e732bc7508b6276eafcbbac414c3a07`, the SHA this branch
was created from, after two independent Codex Desktop audits and two correction passes. Its
record is `docs/SPRINT-3-REPORT.md`; its audit history is section 14 of that document. Sprint 4
changes nothing in it: migrations 0001 to 0005 are byte-identical, the source-set freeze,
schema binding, classification immutability, credential redaction, exact-input allowlist and
count-only output are all preserved, and the Sprint 3 tests are unweakened.

## 2. What Sprint 4 builds (design)

Eligible classified sources become provisional canonical incidents through three separate
stages, and a human can correct the result without ever overwriting what the machine produced.

| Stage                | Question it answers                                           | Decided by                                            |
| -------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| Exact URL duplicates | Is this the same page?                                        | Sprint 2's canonical URL group, never recomputed      |
| Syndication          | Is this the same reporting behind another URL?                | Shingle similarity, which is sensitive to rewriting   |
| Incident grouping    | Do these separate reports describe the same underlying event? | Shared **rare** distinctive tokens and time proximity |

Only `include` and `review` classification results are eligible. An `exclude` result keeps its
decision and rationale and receives no membership at all.

**Conservative by construction.** A merge must be positively supported. Generic security
vocabulary is removed before anything is compared, so two reports never merge because both say
"attack". Corpus-relative rarity is required on top of that, because journalistic boilerplate
is distinctive against a stop list yet meaningless as evidence: without it, "officials",
"services" and "outage" would merge a Portland hospital with a Denver clinic. Where the
evidence is close to a threshold the reports stay separate and the relationship is recorded as
an ambiguous link for a human. False splits are preferred to unsupported false merges.

Not built, by instruction: the dashboard, the drafting system, the evidence-state resolver and
the anomaly feed.

## 3. The clustering engine (design)

| Property         | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Engine version   | `clustering-engine@1`                                              |
| Contract version | `clustering-behavior-contract@1`                                   |
| Mode             | `deterministic`                                                    |
| Contract hash    | `60656e877783929ce635233c02da4484e84fb4217ea90035ee91bf8c274baa2a` |

`@cas/clustering` is pure: no database, no network, no environment variable, no model call, no
clock and no randomness. The contract hash is the SHA-256 of the canonical form of an
executable contract, and every behaviour field in it is read by `clusterEligible(inputs,
contract)` at run time.

**Fields that could not be executed were removed rather than hashed.** Sprint 3's re-audit
rejected a contract whose hash moved while behaviour stood still, so the same test applies
here: a field survives only if changing it changes an observable result. Four candidates
failed that test and were deleted: a stage-order list the engine did not read, a field
separator, null and empty handling, and a whitespace rule. All four are unable to change a
decision for the same reason: tokenization ignores every character that is not part of a
token, so a joiner, an absent field, an empty field and a run of spaces all contribute exactly
no tokens however they are treated. Whitespace collapsing, the joiner and the stage order are
fixed engine behaviour, pinned by `engineVersion`.

**Input boundary.** An exact allowlist of twelve own keys with declared shapes: source-row
identifier and hash, classification result and run identifiers, batch identifier and origin,
the classification decision, the canonical URL-group identifier, the posted timestamp, and the
three derived text fields. A human `ReviewState`, a weekly spreadsheet label, a publication
status, a publisher category, the ledger's `ch` value, a raw cell, a batch label, an inferred
week and any connection value are refused by construction, not by being listed. Symbol keys,
accessor properties and foreign prototypes are refused, descriptors are inspected before any
value is read, and no rejection echoes a key or a value.

**Complexity bound.** Let N be the eligible inputs, G the duplicate groups, K the contract's
`blocking.keysPerItem`, B its `maximumBlockSize` and C its `maximumComparisonsPerItem`.
Assembly, tokenization and grouping are O(N) in the bounded token count. Each of the two
blocking passes builds an inverted index in O(G·K) and compares at most min(B, block size)
candidates per key, with a hard cap of C comparisons per item, so pair work is O(G·C) and
never quadratic in N. Blocking keys are chosen in a fixed hash order rather than by global
rarity, because rarity alone selects the tokens unique to one item, which are exactly the ones
that can never bring two items together. A token carried by more than the contract's
document-frequency share is not a key at all, and a block larger than the bound is skipped and
counted.

**Source text is hostile evidence.** It is normalized, split into tokens and hashed. It is
never interpreted, never executed and never concatenated into a query.

**One superseded contract hash.** An earlier build carried two literal control characters that
had been written into the source by mistake, one of them as the contract's shingle-component
separator. The repository-hygiene scan caught them before the branch was committed, and they
were replaced with ordinary characters. Because the separator is a hashed field, the contract
hash changed from `752f2bb301ffb414bc715183be5bc252e5b942924110916c0924d8893383867b` to the
value above, and the three clustering runs written under the old hash remain in the dedicated
database as superseded, immutable historical records. The separator is a join character that
no token can contain, so every grouping decision was identical under both: the two generations
produce the same eligible counts, the same duplicate, syndication and incident counts, the
same cluster kinds and the same memberships, and differ only in the fingerprint strings the
separator is part of. No committed file carries a prohibited control code point.

## 4. Migration 0006 (design)

`packages/database/migrations/0006_incident_clustering.sql`, SHA-256
`cb88b6a9ba6891cb211372f3542cf1fae78a11fdb3dfe442ae1ce777b0d860b2`. Forward-only. Migrations
0001 to 0005 are untouched and keep their accepted checksums.

Five tables. `clustering_runs` holds the run, its explicit classification run, batch and
origin, the engine and contract identity, a deterministic idempotency key, the lifecycle
status and every counter. `incident_clusters` holds one provisional incident: a deterministic
fingerprint, the kind the engine derived, member and group counts, stable reason codes and a
deterministically selected representative. `incident_memberships` links one eligible result to
one incident and carries the whole provenance chain. `clustering_ambiguous_links` records the
relationships the engine refused to act on. `clustering_review_actions` is the append-only
human layer.

**No prose is stored as canonical incident truth.** A cluster row carries identifiers,
fingerprints, counts and fixed vocabulary, and nothing else.

Composite foreign keys make a provenance contradiction impossible rather than unlikely: a
membership's cluster must belong to the same run and batch, its source row must belong to that
batch and carry that exact row hash, its classification result must be that result of that
classification run for that row and batch, and its origin must be the batch's origin.

**Completion is validated by the database.** A run is inserted `running` and may only become
`completed` through a transition in which the guard re-derives every counter from the stored
output and refuses the run unless every eligible result of the classification run has exactly
one membership, no ineligible result has any, the cluster sizes sum to the memberships, and
every counter matches. A completed run, its clusters, its memberships and its links are then
immutable.

Every function is created through `pg_catalog.format` with quoted identifiers, bound to the
schema being migrated, stores `search_path = pg_catalog, <schema>, pg_temp`, names every
relation by schema, and is not `SECURITY DEFINER` — the Sprint 3 pattern, applied to the new
tables.

## 5. The human merge and split layer (design)

Human corrections are append-only actions over a completed run. They never rewrite the base
output, so the machine record stays exactly what the engine produced, whatever the reviewer
later decides.

An action records its operation, the incidents or memberships it affects, a fixed reason code,
an optional bounded note, an actor, the revision it was prepared against, the revision it
produces, and a deterministic idempotency key. One linear history per run is enforced by a
unique key on `(clustering_run_id, resulting_revision)`, so two actions cannot claim the same
revision: the second is refused by the database, not by a check in the application. An action
requires a completed run, and cannot name a run or batch other than its own.

The effective view is a replay of the base memberships plus the accepted actions in revision
order. A merge reassigns every membership of the named incidents to the action's identifier; a
split reassigns the named memberships. The replay is deterministic, so the effective view is
reproducible from the record alone, and the machine layer and the human layer can always be
told apart.

Validation refuses a merge that names an incident twice, a merge or split naming anything that
is not a current effective incident of that run, including one belonging to another run, a
split whose memberships do not belong to that incident, and a split that would take every
membership. Replaying an identical request returns the action it already created rather than
recording a second one.

## 6. Command-line interface (design)

| Command                                                                                | Purpose                    |
| -------------------------------------------------------------------------------------- | -------------------------- |
| `clustering run --classification-run <uuid>`                                           | base clustering run        |
| `clustering report --run <uuid>`                                                       | count-only run report      |
| `clustering review-count --run <uuid>`                                                 | count-only review workload |
| `clustering effective --run <uuid>`                                                    | count-only effective view  |
| `clustering merge --run <uuid> --incidents <uuid,uuid> --reason <code>`                | append a merge action      |
| `clustering split --run <uuid> --incident <uuid> --members <uuid,...> --reason <code>` | append a split action      |

Every command requires explicit identifiers, validated before any database access. There is no
"latest" behaviour anywhere. Identifier lists are bounded, so a review command cannot become a
bulk edit. A reason code is fixed vocabulary matching `^[a-z][a-z0-9_]{2,63}$`; a note is
bounded at 280 characters and refused if it carries a control character. Output carries
counts, identifiers, versions, hashes, statuses and fixed vocabulary only, through the same
redactor and single-line guard as every earlier command. A newly created review action is
reported by identifier, because the caller needs to be able to refer to it.

## 7. Tests (tests)

Offline tests need no database, no secret and no network, and run in continuous integration.

| Package               | Offline | PostgreSQL |
| --------------------- | ------: | ---------: |
| `@cas/contracts`      |       7 |            |
| `@cas/taxonomy`       |       7 |            |
| `@cas/clustering`     |      41 |            |
| `@cas/classification` |      56 |            |
| `@cas/database`       |      24 |         80 |
| `@cas/graph-evidence` |     102 |            |
| `@cas/worker`         |     126 |         43 |
| **Total**             | **363** |    **123** |

**Unit coverage** includes exact URL duplicates; different URLs carrying identical reporting;
two reports of one incident; similar wording about different incidents staying apart; generic
cyber vocabulary never carrying a merge; the time window at, inside and outside its boundary;
missing timestamps under both declared behaviours; Unicode form and case normalization;
whitespace insensitivity; input-order invariance over three orderings; repeated-run
determinism over ten runs; prompt-like and SQL-like source text remaining inert; a
200,000-character field; a corpus-wide token never becoming a blocking key; a block larger
than the bound being skipped and counted; the exact runtime allowlist; every rejection reason;
stable reason codes; deterministic representative selection under both rules; and uncertain
links staying separate and reviewable.

**Contract coverage** is 37 behaviour mutations, each paired with a corpus chosen so the
mutation must change an observable result, plus two identity mutations proven to change the
hash and deliberately not the behaviour. Key order and pretty-printing are proven not to
change the hash; array order is proven to change it. The production contract is deep-frozen,
and two contracts used in sequence are proven not to contaminate each other. There is no
matcher cache: every index is built inside one call, which is why interleaving is safe.

**PostgreSQL coverage** includes migration 0006 applied fresh and as an upgrade from 0001 to
0005, a no-op rerun, drift detection, and the schema-shadow resistance suite extended with the
three new guard functions and shadow clustering tables; one membership per eligible result and
none for an excluded one; every cross-batch, cross-run, cross-cluster, wrong-hash and
wrong-result contradiction refused; completion refused for missing coverage, an ineligible
member and counters that describe something else; a run refused if inserted already completed;
duplicate idempotency keys and duplicate fingerprints refused; completed runs, clusters,
memberships and links immutable; idempotent reruns; distinct identity for a changed contract
or engine; two identical concurrent runs producing exactly one run; merge and split
transactions; stale revisions, cyclic merges, cross-run actions and over-wide splits refused;
split coverage preserved; append-only review history; and a deterministic effective view.

## 8. Real-data structural proof (real data)

Run on 8 September 2026 against the dedicated local PostgreSQL database holding the Sprint 2
import and the accepted Sprint 3 classification runs. `DATABASE_URL` was never printed. No
new material was ingested.

**Upgrade.** `db:migrate` applied `0006` alone (`applied=1 alreadyApplied=5 total=6`), a rerun
was a no-op, and `db:check` reported six applied migrations and no drift. Counts before and
after were identical: 3 import batches, 24,248 source rows, 9 row issues, 23,640 URL groups,
2 review snapshots, 338 review entries, 9 classification runs, 72,744 classification results.
The Sprint 3 source-set freeze still refuses a source-row mutation.

**Clustering of the three accepted classification runs**, at contract hash `60656e87…`. Three
earlier runs at the superseded hash `752f2bb3…` remain in the database, as section 3 records;
their counts are identical.

| Batch  | Eligible | Ineligible | Duplicate groups | Syndication groups | Incidents | Singleton | Multi-source | Largest | Ambiguous links |
| ------ | -------: | ---------: | ---------------: | -----------------: | --------: | --------: | -----------: | ------: | --------------: |
| Ledger |   23,856 |         54 |           23,586 |             23,505 |    23,262 |    22,813 |          449 |      25 |    50,000 (cap) |
| CS79   |      156 |          1 |              156 |                155 |       154 |       152 |            2 |       2 |              72 |
| CS86   |      181 |          0 |              181 |                181 |       180 |       179 |            1 |       2 |              95 |

Cluster kinds: the ledger run holds 22,813 singletons, 169 exact-duplicate groups, 66
syndicated groups and 214 multi-report incidents; CS79 holds 152 singletons, 1 syndicated
group and 1 multi-report incident; CS86 holds 179 singletons and 1 multi-report incident.

**Structural integrity, per run.** Eligible results and memberships are equal (23,856; 156;
181), uncovered eligible results are zero, duplicate coverage is zero, memberships attached to
an excluded result are zero, and every run reports `reconciled=yes`. Re-running any of the
three returns the original run identifier and writes nothing. Review workload, count-only:
11,074, 46 and 58 memberships still marked `review`, alongside the ambiguous links above.

**The human review tables are unchanged**: 2 snapshots, 338 entries, 291 kept, 47 set aside.

**What these counts are not.** They are structural. They say the pipeline covered its input
exactly and grouped it into that many provisional incidents. They do **not** establish
clustering precision, recall or agreement with any published issue, because the project holds
no machine-readable record of the final editorial outcome. Establishing that needs weekly
Excel cut-downs paired with their published Substack reports through the explicit reviewed
mapping recorded in the 2026-09-07 amendment to D21. No such comparison was attempted and
none is claimed.

## 9. Human merge and split demonstration (PostgreSQL, synthetic)

On a synthetic 16-row fixture batch, classified and clustered through the compiled commands:

| Step | Action                                              | Result                                                                |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | base run                                            | 16 eligible, 16 duplicate groups, 14 syndication groups, 13 incidents |
| 2    | merge a multi-source incident with a singleton      | action recorded, revision 1, 12 effective incidents, largest 5        |
| 3    | replay the identical merge                          | already recorded, same action identifier, still revision 1            |
| 4    | split two memberships out of the merged incident    | action recorded, revision 2, 13 effective incidents, largest 3        |
| 5    | merge naming an incident the earlier merge consumed | refused: `incident_not_effective`                                     |
| 6    | merge naming one incident twice                     | refused: `incident_repeated`                                          |
| 7    | merge naming an incident of another run             | refused: `incident_not_effective`                                     |
| 8    | split taking every membership                       | refused                                                               |
| 9    | update or delete a review action                    | refused: review actions are append-only                               |
| 10   | update a base membership                            | refused: output of a completed run is immutable                       |

Base memberships stayed at 16 throughout, and every effective view accounted for all 16 with
no membership lost or duplicated.

## 10. The administrative-event watchlist: accepted scope deviation (D23)

**Resolved on 8 September 2026.** The project owner selected the explicit scope deviation. It
is recorded as decision D23 and is no longer a Sprint 4 blocker.

**The requirement, as it stood.** D20 obliged Sprint 4 either to expand Plan 2.0's
ten-protocol **administrative-event** watchlist with verified contracts and event sources, or
to record an explicit scope deviation, and stated that the standardized-TVL watchlist "does
not satisfy and does not silently replace" it. That requirement is preserved here as history:
it was planned, and it is not being quietly written out.

**Why expansion was not the honest answer.** The gap was never three missing entries. It was a
missing lane. The live query document reads the Messari standardized lending schema: protocol
identity, total value locked and daily financial snapshots. It emits no administrative event
of any kind, so no number of additional deployments on it could satisfy an administrative-event
requirement, and adding three to reach ten would have been exactly the conflation D20 forbids.
Building the lane needs verified official contract addresses, administrative event signatures,
a provider that indexes them and deployment provenance for each; none of that exists in the
repository, and inventing entries to reach a count was never an option.

**What the deviation says.** The hackathon build retains the seven protocol identities already
proven live on the standardized TVL lane: Aave v3, Spark, MakerDAO, Compound v3 and Liquity on
Ethereum; Seamless and Moonwell on Base. The TVL lane and an administrative-event lane are
different capabilities, and no document, submission or demo may present one as the other. In
particular, the live lane does not read `Upgraded`, `OwnershipTransferred`, `Paused` or
token-outflow events, and nothing in this project claims it does. The ten-protocol
administrative-event watchlist is removed from the hackathon must-ship scope and moved to the
post-event roadmap. No fabricated protocol entry, contract event or live-proof claim is added,
and no third-party administrative-event infrastructure is introduced during the remaining gate
period.

**Why.** Schedule protection. Building and validating the lane now would jeopardise the Graph
release gate at the end of 10 September and the primary Cyberattack Sunday deliverable.

**What it does not change.** The seven-protocol live Graph evidence from Sprint 1 stands
exactly as recorded. The clustering implementation, the database schema, the classification
results and every real-data figure in this report are untouched: this is a scope and
documentation decision, not a code change. A future administrative-event implementation must
independently verify each protocol's official contracts, its deployment provenance, the events
those contracts actually emit and live Graph coverage for them before any watchlist claim is
made.

## 11. Judgment calls and deviations

- **Corpus-relative rarity is required for an incident merge.** Two shared distinctive tokens
  are not enough if the corpus carries them everywhere. This is what keeps journalistic
  boilerplate from merging unrelated incidents, and it means the engine deliberately refuses
  to merge anything in a corpus too small for rarity to mean something.
- **A fragment shorter than one shingle supports nothing.** Two identical four-word titles are
  not called the same reporting, because a single degenerate shingle is not evidence.
- **The ambiguous-link list is capped.** The ledger run hit the contract's 50,000-link bound.
  The links that were recorded are real, but the list is not exhaustive, and the count should
  be read as "at least".
- **Blocking keys are chosen by hash order, not rarity.** Rarity alone selects tokens unique
  to one item, which can never pair anything. The document-frequency ratio still excludes
  corpus-wide tokens.
- **`@cas/clustering` gained a dependency on `@cas/contracts` only**, and `@cas/worker` gained
  a workspace dependency on `@cas/clustering`. No external package was added.

## 12. Limitations and unresolved risks

- **No clustering ground truth exists.** Section 8 says what this means. Sprint 4 reports
  structure, not accuracy.
- **The needs-review workload is large.** 11,074 review memberships and at least 50,000
  ambiguous links on the ledger batch. That is the intended conservative posture, but the
  queue needs ordering before a human can use it; that is Sprint 6's problem.
- **Singletons dominate.** 22,813 of 23,262 ledger incidents have one member. Over a
  fifteen-month ledger that is expected, but it has not been checked against any editorial
  record, and it may equally indicate that the thresholds are too strict.
- **Continuous integration runs no database.** The 123 PostgreSQL tests run only through
  `test:db` with a local `DATABASE_URL`, so every constraint and trigger in migration 0006 is
  unproven by continuous integration and must be re-proven by a reviewer with a database.
- **D9 and D10 remain unresolved.** No model is chosen; no editorial week is inferred.
- **No administrative-event lane exists.** The owner accepted the scope deviation recorded as
  D23, so the ten-protocol administrative-event watchlist is out of hackathon scope and on the
  post-event roadmap. The live Graph capability is the standardized TVL lane with seven proven
  identities, and it reads no administrative event.
- **Check-in #1 was submitted**, confirmed by the project owner on 8 September 2026. No
  timestamp or receipt identifier is recorded, because none was supplied. Check-in #2 is due
  on Thursday 10 September 2026 at a cutoff this project has not verified in the portal; its
  draft is `docs/CHECKIN-2-DRAFT.md` and it has not been submitted.
- **The migration-loader first-run failure disclosed in Sprint 3 remains unexplained.** It did
  not recur during Sprint 4 verification.

## 13. Verification

Every command run after the final edit; exit codes in the handoff.
`corepack pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`,
`test --force`, `build`, `verify`, `audit`; then against a dedicated local database
`db:migrate` twice, `db:check` and `test:db`; then every clustering command and the synthetic
merge and split demonstration; then `git diff --check`, `git fsck --full` and
`git status --short`.

## 14. Reproduction for Codex Desktop

1. Check out `sprint-4/clustering-incidents` at the final SHA, run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` and
   `corepack pnpm test --force`. No database, secret or network is needed.
2. Confirm the contract hash independently: build the workspace and evaluate `contractHash()`
   from `@cas/clustering`, or hash the canonical contract yourself. It must equal section 3.
3. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env`, run
   `corepack pnpm db:migrate` twice (six applied, then no-op), `db:check`, and `test:db`
   (123 tests, which create and drop only `cas_test_*` schemas). One file creates a schema
   named after the connecting role to reproduce the Sprint 3 capture, and drops it again.
4. For the real-data evidence, point `DATABASE_URL` at a database holding the Sprint 2 import
   and the accepted Sprint 3 classification runs, then run `clustering run` for each
   classification run and compare with section 8. Re-run to see `already clustered`.
5. For the human layer, follow section 9 against a synthetic fixture batch.
6. The dedicated database holds six clustering runs: three at the current contract hash and
   three at the superseded one described in section 3. Every command names its run explicitly,
   so none of them is ever selected implicitly.
7. Nothing in this document has been audited. Sprint 4 is not accepted.
