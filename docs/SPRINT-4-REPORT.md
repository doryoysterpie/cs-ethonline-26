# Sprint 4 report: deterministic clustering and canonical incident construction

Result: **ACCEPTED by Codex Desktop at `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`**, on
9 September 2026. Candidate `4da687164d09d8845abae51af6151986fe4405c2` was rejected the same
day with seven findings and an eighth followed on re-audit; section 13 records the corrections.
The acceptance is the auditor's, recorded here; nothing in this document is a self-assessment.
All times America/Toronto unless marked UTC.
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
| Engine version   | `clustering-engine@2`                                              |
| Contract version | `clustering-behavior-contract@2`                                   |
| Mode             | `deterministic`                                                    |
| Contract hash    | `f0fc48b986959feb341b2762760a0e570186c84e8dfbf73c8d6eaf17bc0f8967` |

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
blocking passes builds an inverted index in O(G·K), which yields at most G·K blocking keys. A
block holding more than B items is skipped whole, so every scanned block holds at most B items
and costs at most B(B−1)/2 pair iterations. Pair work is therefore bounded by **O(G·K·B²)**.

The earlier claim of O(G·C) was wrong and is withdrawn (audit finding F7). C bounds only how
many of those iterations become admitted comparisons: an exhausted per-item budget skips the
comparison, it does not stop the scan, so the loop keeps running to the end of the block. With
K and B fixed by the contract the cost still grows linearly in G and is never quadratic in N,
but the work inside one block is quadratic in B, and that is what the bound now says.
`stats.pairIterations` counts the iterations actually performed, and two regressions hold the
engine to the bound: one asserts the iteration count equals what K and B permit for a
constructed corpus, and one drives the comparison budget to zero and shows iterations continue,
which is the behaviour O(G·C) would have denied. Blocking keys are chosen in a fixed hash order rather than by global
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

## 4. Migrations 0006 and 0007 (design)

`packages/database/migrations/0006_incident_clustering.sql`, SHA-256
`cb88b6a9ba6891cb211372f3542cf1fae78a11fdb3dfe442ae1ce777b0d860b2`.

`packages/database/migrations/0007_clustering_integrity.sql`, SHA-256
`1f066032ae936ce2b68be05c7d76e5c781e4d9277255bee0f5fd3da6e22d1449`, adds the three invariants the audit found
unenforced: the composite identity binding a membership to its clustering run's exact
classification run (F2), the review-note character and length policy (F4), and the
database-computed canonical payload digest that makes review identity complete (F3). It
validates every existing row before adding each constraint, so a database holding a
contradiction fails the whole migration rather than acquiring a constraint it violates. Like
migration 0005 it is executed through `pg_catalog.format` with quoted identifiers, binds every
function to the schema being migrated with `search_path = pg_catalog, <schema>, pg_temp`, names
every relation by schema and introduces no `SECURITY DEFINER`.

Forward-only. Migrations 0001 to 0006 are untouched and keep their accepted checksums, and all
seven are pinned by a unit test, so editing an applied migration is a test failure rather than
silent drift on every existing database.

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
membership.

**Idempotency is payload-complete** (audit finding F3). An action's identity is its whole
canonical payload: the operation, the run, the reason, the actor, the note, the revision the
caller declared and both identifier lists, with absence distinguished from emptiness, the
identifier lists counted and ordered so neither order nor case can change the identity, and the
note length-prefixed in UTF-8 bytes so its content cannot imitate a field boundary. Replaying an
identical request returns the action it already created. A request that reuses an existing
identity while differing anywhere in that payload fails with the fixed `review_action_conflict`:
it does not return the earlier action, it does not write a second one, and the message echoes no
actor, note, reason or identifier, because the caller supplying the second payload is not
entitled to read the first. The stored idempotency key is encoded from the same fields in the
same way, so a request differing only in identifier order or case still finds its own action.

`expectedRevision` is optional. Omitted, the current revision stands, which is what the command
line does. Given, it must match the current revision, it is stored, and it becomes part of the
identity, so a replay declaring a different revision is a conflict rather than a repeat.

**A review note has one policy** (F4), in `apps/worker/src/clustering/note.ts`: 1 to 280
characters; absence is `null` and an empty string is refused rather than silently stored as
absence; no normalization, so a stored note is exactly what the reviewer wrote; and every C0
control, DEL, C1 control, U+2028 and U+2029 refused. `mergeIncidents`, `splitIncident` and the
command line all apply it, and migration 0007 enforces the same condition in the database.
Validation runs before the payload is hashed and before a database handle is opened, so a
refused note reaches no digest, no round trip and no printed line.

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
bounded at 280 characters and refused if it carries a control character, by the shared policy of
section 5 rather than by a validator the command line owns alone. Every value a review command
takes, the note among them, is parsed before a database handle is opened. Output carries
counts, identifiers, versions, hashes, statuses and fixed vocabulary only, through the same
redactor and single-line guard as every earlier command. A newly created review action is
reported by identifier, because the caller needs to be able to refer to it.

## 7. Tests (tests)

Offline tests need no database, no secret and no network, and run in continuous integration.

| Package               | Offline | PostgreSQL |
| --------------------- | ------: | ---------: |
| `@cas/contracts`      |       7 |            |
| `@cas/taxonomy`       |       7 |            |
| `@cas/clustering`     |      50 |            |
| `@cas/classification` |      56 |            |
| `@cas/database`       |      24 |         80 |
| `@cas/graph-evidence` |     102 |            |
| `@cas/worker`         |     144 |         61 |
| **Total**             | **390** |    **141** |

Per file, for the packages this sprint touched: `@cas/clustering` is 31 engine, 9 contract and
10 input tests; `@cas/worker` offline is 40 output-safety, 21 command line, 11 review policy and
payload, 6 documentation and 66 across the earlier editorial and classification files; the
PostgreSQL suites are 80 in `@cas/database` over six files and 61 in `@cas/worker`, of which 32
are the clustering and correction file.

**Correction coverage**, added by this pass, includes a 501-report chain proven to form one
component when the bound is lifted and proven to be refused under it; a component of exactly 500
admitted with no bound recorded; two components of 300 and 201 whose union would be 501 refused,
with both clusters marked `cluster_bound_reached`; those refusals repeated under reversed and
interleaved input orders; a 501-row exact-URL group rejecting the run with the fixed condition,
the numeric bound and nothing else in the message; the invariant that no returned cluster
exceeds the maximum; exact pair-iteration counts for admitted blocks of 40, 90 and 120; the
comparison budget driven to one while iterations stay identical; every prohibited note character
through the worker APIs, the compiled command line and a direct `INSERT`; each idempotency
payload field changed independently; identifier order and case normalized; the worker's
canonical payload digest held to the digest migration 0007 generated for the same row; a trap on
the socket, TLS and name-lookup entry points proving five database commands reach none of them;
and a documentation consistency check over the current check-in and sprint claims.

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

**PostgreSQL coverage** includes migrations 0006 and 0007 applied fresh and as an upgrade from
0001, a no-op rerun, drift detection, the schema-shadow resistance suite extended with the new
guard functions, the payload-digest function and shadow clustering tables, and migration 0007
refusing to apply over a pre-existing cross-classification-run membership or a pre-existing
invalid stored note, in each case leaving no constraint, column or function behind; one membership per eligible result and
none for an excluded one; every cross-batch, cross-run, cross-cluster, wrong-hash and
wrong-result contradiction refused; completion refused for missing coverage, an ineligible
member and counters that describe something else; a run refused if inserted already completed;
duplicate idempotency keys and duplicate fingerprints refused; completed runs, clusters,
memberships and links immutable; idempotent reruns; distinct identity for a changed contract
or engine; two identical concurrent runs producing exactly one run; merge and split
transactions; stale revisions, cyclic merges, cross-run actions and over-wide splits refused;
split coverage preserved; append-only review history; and a deterministic effective view.

## 8. Real-data structural proof (real data)

Recomputed on 9 September 2026, after the correction, against the dedicated local PostgreSQL
database holding the Sprint 2 import and the accepted Sprint 3 classification runs.
`DATABASE_URL` was never printed. No new material was ingested. Every figure below is queried
from the corrected runs rather than carried over.

**Upgrade.** `db:migrate` applied `0007` on top of the existing six, a rerun was a no-op, and
`db:check` reported seven applied migrations and no drift. Migration 0007 validated every
existing membership and note before adding its constraints and found no contradiction. Counts
before and after were identical: 3 import batches, 24,248 source rows, 2 review snapshots, 338
review entries, 9 classification runs, 72,744 classification results. The Sprint 3 source-set
freeze still refuses a source-row mutation.

**Clustering of the three accepted classification runs**, at the corrected contract hash
`f0fc48b9…`, as runs `16253b31-bd51-499d-93a1-5e2533ab8570` (ledger),
`89ccd524-ec13-43a5-940d-e9ab2fbb3c96` (CS79) and `31804d66-daf4-4296-b4cc-056d9e5196bb`
(CS86). Six earlier runs remain in the database at two superseded hashes, `752f2bb3…` and
the rejected candidate's `60656e87…`. They are historical evidence: they stay immutable, a
direct `UPDATE` and `DELETE` against one were both refused during this verification, and no
command selects them implicitly.

| Batch  | Eligible | Ineligible | Duplicate groups | Syndication groups | Incidents | Singleton | Multi-source | Largest | Ambiguous links |
| ------ | -------: | ---------: | ---------------: | -----------------: | --------: | --------: | -----------: | ------: | --------------: |
| Ledger |   23,856 |         54 |           23,586 |             23,505 |    23,262 |    22,813 |          449 |      25 |    50,000 (cap) |
| CS79   |      156 |          1 |              156 |                155 |       154 |       152 |            2 |       2 |              72 |
| CS86   |      181 |          0 |              181 |                181 |       180 |       179 |            1 |       2 |              95 |

Cluster kinds: the ledger run holds 22,813 singletons, 169 exact-duplicate groups, 66
syndicated groups and 214 multi-report incidents; CS79 holds 152 singletons, 1 syndicated
group and 1 multi-report incident; CS86 holds 179 singletons and 1 multi-report incident.

**Structural integrity, per run.** Eligible results and memberships are equal (23,856; 156;
181, summing to 24,193 against 24,193 memberships), uncovered eligible results are zero,
duplicate coverage is zero, memberships attached to an excluded result are zero, and every run
reports `reconciled=yes`. No cluster anywhere in the database exceeds the 500-member bound; the
largest is 25. No membership names a classification run other than its clustering run's, which
is now a relational impossibility as well as a fact. Re-running any of the three returns the
original run identifier and writes nothing. Review workload, count-only: 11,074, 46 and 58
memberships still marked `review`, alongside the ambiguous links above.

The ledger run's 50,000 ambiguous links are the contract's retention cap, not a count: the cap
bounds what is kept and reported, never what is compared or clustered, so that figure is a
truncated lower bound.

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
- **Continuous integration runs no database.** The 141 PostgreSQL tests run only through
  `test:db` with a local `DATABASE_URL`, so every constraint and trigger in migrations 0006 and
  0007 is unproven by continuous integration and must be re-proven by a reviewer with a
  database. This was true of the rejected candidate and is still true: the correction did not
  add PostgreSQL coverage to the workflow, because that is a continuous-integration change
  outside the scope of an audit correction.
- **Sprint 4 is pending an independent re-audit.** Every finding is closed in this
  implementation's own judgement, which is exactly the judgement an audit exists to test.
- **Sprint 5 has not been started**, and neither has the Google Sheets integration.
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

## 13. Audit correction (correction)

Codex Desktop audited candidate `4da687164d09d8845abae51af6151986fe4405c2` on 9 September 2026
and returned CHANGES REQUIRED with seven findings. This section records what was wrong and
what replaced it. The corrections are additive commits on the same branch; nothing was
amended, rebased or force-pushed, and migrations 0001 to 0006 are byte-identical.

**None of this has been audited.** The findings are closed in the implementation's own
judgement only, and Sprint 4 stays rejected until Codex Desktop says otherwise.

### F1 (High). The cluster bound did not hold over a component

The contract declared `maximumClusterSize: 500` while the engine checked only the pair in
front of it. The audit chained 501 unique URL groups into one 501-member cluster with
`boundsReached: 0`.

The union-find now carries each component's size, counted in source rows by the new
`bounds.clusterSizeUnit`, and `canUnion` is consulted before every union in both the
syndication and the incident stage. A refused union leaves both components standing,
increments `boundsReached` and marks the resulting clusters `cluster_bound_reached`, so a
cluster the bound stopped is distinguishable from one that never had a reason to grow.

An exact-URL duplicate group already larger than the bound is not a merge decision at all:
those rows carry the same canonical URL, so splitting them would publish one report as several
and admitting them would publish a cluster past the declared bound. The new
`bounds.oversizedDuplicateGroupBehaviour` decides, and the shipped value `reject-run` refuses
the whole run with a fixed `exact_duplicate_group_exceeds_limit` condition and the numeric
bound. The worker converts it inside the transaction that inserted the `running` row, so the
run rolls back and no partial cluster, membership or link survives. The message carries the
condition and the bound and nothing else.

Both new fields are hashed, so the policy is part of the contract's identity.

### F2 (High). A membership could name another classification run of the same batch

The audit built two completed classification runs over one batch and had a clustering run for
run A accept a membership naming run B's result. Every coverage and counter check stayed
green, because nothing related the two.

Migration 0007 adds `clustering_runs_classification_identity` as a unique key on
`(id, classification_run_id, batch_id)` and a matching composite foreign key from
`incident_memberships (clustering_run_id, classification_run_id, batch_id)`. The Sprint 4 key
binding a membership to its exact classification result, source row, hash and batch is kept, so
both hold at once. Existing rows are counted before the constraint is added, so a database
holding the contradiction fails the migration with a named invariant rather than a constraint's
internals.

### F3 (Medium). Idempotency accepted a different payload

A replay carrying a different actor and note was answered with the original action, concealing
a changed attribution.

There is now one canonical semantic payload covering the operation, the run, the reason, the
actor, the note, the declared revision and both identifier lists, with absence distinguished
from emptiness, identifier lists counted and ordered, and the note length-prefixed so its
content cannot imitate a field boundary. A request that matches an existing key is compared
field by field against the action already stored; any difference raises a fixed
`review_action_conflict` that echoes nothing the caller supplied and writes nothing. The same
string is computed in SQL by `clustering_review_payload_digest` and stored as a generated
column, unique per run, so the identity is the database's rather than whichever fields the
application chose. A test holds the two implementations to the same digest.

Changing a field inside the stored key is not a replay at all and is refused on its own terms.

### F4 (Low). Notes were validated only at the command line

`splitIncident` persisted a note carrying a newline; only the CLI refused it.

`apps/worker/src/clustering/note.ts` is now the single policy, applied by `mergeIncidents`, by
`splitIncident` and by the CLI, and enforced independently by the
`clustering_actions_note_policy` CHECK constraint in migration 0007. One to 280 characters;
absence is `null` and an empty string is refused rather than silently treated as absence; no
normalization, so a stored note is exactly what was written; and every C0 control, DEL, every
C1 control, U+2028 and U+2029 refused. Validation runs before the payload is hashed, so a
refused note never reaches a digest, a database round trip or a printed line. Both messages are
fixed and neither echoes the note.

### F5 (Low). The default suite opened a socket

`cli.test.ts` pointed a connection string at a closed loopback port. In the audit's environment
that returned `EPERM` rather than `ECONNREFUSED`, so the assertion failed and `pnpm verify` was
red in a clean room.

The failure is now injected at the driver seam through a `connect` option on `DatabaseOptions`
and an `openDatabase` seam on `CliOptions`, both defaulting to the real driver. The real
`Database`, the real error classification and the real redaction stay in the path; only the
network leaves it, and the assertion still requires the fixed redacted database failure. The
test additionally traps `node:net`, `node:tls` and `node:dns` and fails if anything reaches
them, so the path is proven offline rather than believed to be. The whole default suite was also
run under Node's permission model with `--permission` and no `--allow-net`, on vitest's threads
pool so the restriction applies to the code under test; a control in the same configuration
confirms `net.connect` is refused with `ERR_ACCESS_DENIED`.

### F6 (Low). The check-in documentation contradicted itself

`HACKATHON_REQUIREMENTS.md` still called Check-in #1's submission "still outstanding" while
four other documents recorded the owner's confirmation. The I2 row now records the submission
and the owner's confirmation of 8 September 2026, and preserves the limitation that no
submission time and no receipt identifier is known. The I3 row records Check-in #2 as drafted,
not submitted, with an unconfirmed cutoff.

`apps/worker/src/documentation.test.ts` reads the current documents together and fails if
Check-in #1 is described as outstanding, if a receipt or portal timestamp is invented, if
Check-in #2 is described as submitted, if any document claims the sprint has already passed
its audit,
or if the pending and Sprint 5 statements go missing. It reads Markdown only.

### F7 (Low). The complexity claim was wrong

`candidatePairs` keeps scanning a block after a per-item comparison budget is exhausted; it
merely stops admitting comparisons. The O(G·C) claim is withdrawn and section 3 now documents
**O(G·K·B²)**, with `stats.pairIterations` counting the iterations actually performed and two
regressions holding the loop to that bound.

The 50,000 ambiguous-link cap remains reporting-only: it caps what is retained and reported,
never what is compared or clustered, and the ledger figure below is a truncated lower bound.

### What the correction changed in the record

| Item             | Before                                                             | After                                                              |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Engine version   | `clustering-engine@1`                                              | `clustering-engine@2`                                              |
| Contract version | `clustering-behavior-contract@1`                                   | `clustering-behavior-contract@2`                                   |
| Contract hash    | `60656e877783929ce635233c02da4484e84fb4217ea90035ee91bf8c274baa2a` | `f0fc48b986959feb341b2762760a0e570186c84e8dfbf73c8d6eaf17bc0f8967` |
| Migrations       | six                                                                | seven                                                              |
| Offline tests    | 363 claimed, 362 passing                                           | 390 passing                                                        |
| PostgreSQL tests | 123                                                                | 141                                                                |

Because the bound policy changes executable behaviour, the versions advanced and the hash
moved, so the corrected engine creates new runs rather than reusing the rejected ones. The
runs at the superseded hashes are left exactly as they were: they are historical evidence, they
remain immutable, and no command selects them implicitly.

## 14. Verification

Every command run after the final edit; exit codes in the handoff.
`corepack pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`,
`test --force`, `build`, `verify`, `audit`; then against a dedicated local database
`db:migrate` twice, `db:check` and `test:db`; then every clustering command and the synthetic
merge and split demonstration; then `git diff --check`, `git fsck --full` and
`git status --short`.

## 15. Reproduction for Codex Desktop

1. Check out `sprint-4/clustering-incidents` at the final SHA, run
   `corepack pnpm install --frozen-lockfile`, then `corepack pnpm verify` and
   `corepack pnpm test --force`. No database, secret or network is needed.
2. Confirm the contract hash independently: build the workspace and evaluate `contractHash()`
   from `@cas/clustering`, or hash the canonical contract yourself. It must equal section 3.
3. With a local PostgreSQL 17 and `DATABASE_URL` in an ignored `.env`, run
   `corepack pnpm db:migrate` twice (seven applied, then no-op), `db:check`, and `test:db`
   (141 tests: 80 in `@cas/database` and 61 in `@cas/worker`, which create and drop only
   `cas_test_*` schemas). One file creates a schema
   named after the connecting role to reproduce the Sprint 3 capture, and drops it again.
4. For the real-data evidence, point `DATABASE_URL` at a database holding the Sprint 2 import
   and the accepted Sprint 3 classification runs, then run `clustering run` for each
   classification run and compare with section 8. Re-run to see `already clustered`.
5. For the human layer, follow section 9 against a synthetic fixture batch.
6. The dedicated database holds nine clustering runs: three at the corrected contract hash and
   six at the two superseded hashes described in section 3. Every command names its run
   explicitly, so none of them is ever selected implicitly.
7. `apps/worker/src/documentation.test.ts` runs in the default suite and needs nothing but the
   repository's own Markdown.
8. Codex Desktop audited this work independently and accepted it at
   `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`. Sprint 5 builds on that SHA and carries the
   Graph-correlation, evidence-state and anomaly-feed work D22 deferred.

---

Sprint 4 was accepted by Codex Desktop at `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`.
Sprint 5 is in progress and has not been audited.
