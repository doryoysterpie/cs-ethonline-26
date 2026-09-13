# Sprint 5 report: Graph evidence, the anomaly feed and deterministic drafting

Status: **corrected after an independent audit, and pending re-audit by Codex Desktop.**
Candidate `6fad82c3b03325101940d9ca25575d94550e7d25` was audited on 10 September 2026 and
returned CHANGES REQUIRED with five findings; section 16 records each finding and its
correction. Nothing in this document is an audit result, and nothing here may be read as one.
All times America/Toronto unless marked UTC.
Count-only throughout: no title, URL, summary, description, organisation, publisher, cell,
connection detail or absolute path appears here.

**How to read this report.** Each section is labelled by the kind of evidence it carries:
**design** is a claim about how the code is built, **tests** is automated evidence that runs
offline, **PostgreSQL** is integration evidence against a live database, and **real data** is
count-only evidence from the three imported real batches. Where a figure was produced at the
rejected candidate and has since been re-verified, the section says so; where it was produced
only at the candidate, it is labelled historical.

| Item               | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| Repository         | `doryoysterpie/cs-ethonline-26`, public                                              |
| Branch             | `sprint-5/evidence-drafting`, created from the accepted Sprint 4 SHA                 |
| Starting SHA       | `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b` (Sprint 4, accepted)                      |
| Rejected candidate | `6fad82c3b03325101940d9ca25575d94550e7d25` (10 September 2026, five findings)        |
| `main`             | unchanged at `3011b5b50189a79181a9cf2d0c95724c019e5e74`                              |
| Decisions          | D25, appended 10 September 2026; D26, appended with the correction                   |
| Migrations added   | `0008_graph_evidence.sql` (candidate) and `0009_evidence_integrity.sql` (correction) |
| Migrations 1 to 8  | unchanged by the correction; checksums verified against the audited values           |
| Model calls        | none; no SDK, no model path, no credential read                                      |
| D3, D4, D9, D10    | all still PROVISIONAL or unresolved; none is marked owner-confirmed here             |

## 1. Sprint 4's status

Sprint 4 is **accepted** at `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`, the SHA this branch was
created from, after one audit, two correction passes and a re-audit covering eight findings.
Its record is `docs/SPRINT-4-REPORT.md`. Sprint 5 changes nothing in it: migrations 0001 to
0007 are byte-identical, the clustering contract keeps its accepted hash
`f0fc48b986959feb341b2762760a0e570186c84e8dfbf73c8d6eaf17bc0f8967`, and no Sprint 4 assertion
is weakened.

One Sprint 4 test file is edited, for two reasons that are both about the test rather than the
behaviour, and section 12 records them: a stale assertion that listed the pending migrations
exhaustively, and a latent unhandled rejection in the race probes that failed the run about
once in three on a loaded machine.

## 2. What Sprint 5 builds (design)

Five things, in a line from a stored signal to an editable draft.

1. **Signal ingestion.** A set of normalized TVL-delta observations for the seven identities
   decision D23 retained becomes a completed signal run and a row per observation. A file
   carries a `fixture` or `replay` origin and nothing else; a `live` run comes only from
   validated Graph-client evaluations, through a separate function that takes no path.
2. **Correlation.** One clustering run and one signal run produce suggested associations, on
   recorded identity and declared window alone.
3. **Review.** A named person accepts or rejects a suggestion, with a reason code, an optional
   bounded rationale and, for `supports` or `conflicts`, a recorded claim.
4. **Resolution.** Every incident of the clustering run gets one of four evidence states,
   derived from accepted associations only.
5. **Anomaly feed and drafting.** Chain movements and reporting movements side by side, and a
   Markdown draft with a machine-readable provenance sidecar, published as a pair under one
   authorised root.

Four properties hold across all five, and each is enforced somewhere a mistake cannot skip.

- **No text is read anywhere in the evidence path.** `IncidentSubject` carries identifiers, a
  chain, a protocol slug and a timestamp. It has no title field, no summary field and no body
  field, so no amount of the words "hack", "attack" or "crypto" in a headline can produce a
  link. An incident whose subject nobody recorded never correlates.
- **A suggestion is not evidence.** `correlation.suggestionIsEvidence` is `false`. A suggestion
  is written with relation `context` and status `suggested`; the resolver counts only
  `accepted`; and a database CHECK refuses a `corroborated` or `contradicted` row whose
  accepted-association count is zero or whose claim is absent.
- **A claim is a record, not a UUID.** A `supports` or `conflicts` decision names a row in
  `incident_claims`, which cites a source row the database proves is a member of the incident
  under the clustering run, with that row's hash, batch and origin. Migration 0009 refuses any
  citation of a claim that does not exist or belongs to another incident, run, batch or origin.
- **Absence is never evidence against.** The ordered resolution rules end in a rule whose
  condition is `always` and whose state is `reported_only`. There is no rule anywhere whose
  condition is "no signal found".

## 3. The evidence contract (design)

`packages/evidence/src/contract.ts` holds one deep-frozen object, canonicalized and hashed:

```
resolver     evidence-resolver@1
contract     evidence-behavior-contract@1
policy       graph-correlation-policy@1
hash         faabdade6fb05e0fd8a3f7dcf92807731da126642954e4ddcd9db28ac8dec873
```

| Group              | Field                               | Value                                                                                                             |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `correlation`      | `matchRule`                         | `explicit_chain_and_protocol`                                                                                     |
|                    | `windowBeforeHours`                 | 48                                                                                                                |
|                    | `windowAfterHours`                  | 72                                                                                                                |
|                    | `minimumAbsoluteDeltaPercent`       | 5                                                                                                                 |
|                    | `suggestionIsEvidence`              | `false`                                                                                                           |
|                    | `maximumSuggestions`                | 500                                                                                                               |
| `resolutionRules`  | ordered                             | conflicting → `contradicted`; supporting → `corroborated`; context → `onchain_observed`; always → `reported_only` |
| `anomaly`          | `observationIntervalHours`          | 24                                                                                                                |
|                    | `minimumBaselineObservations`       | 7                                                                                                                 |
|                    | `baselineMethod`                    | `median-absolute-deviation`                                                                                       |
|                    | `thresholdDeviations`               | 4                                                                                                                 |
|                    | `minimumAbsoluteDeltaPercent`       | 5                                                                                                                 |
|                    | `zeroDenominatorBehaviour`          | `absolute-threshold-only`                                                                                         |
|                    | `missingObservationBehaviour`       | `missing_observation`                                                                                             |
|                    | `freshnessLimitHours`               | 36                                                                                                                |
| `reportingAnomaly` | `minimumBaselineWindows`            | 3                                                                                                                 |
|                    | `thresholdDeviations`               | 3                                                                                                                 |
|                    | `storiesPerIncidentThreshold`       | 3                                                                                                                 |
|                    | `multiSourceConcentrationThreshold` | 0.25                                                                                                              |

Every hashed field changes observable behaviour, and a mutation test pins each one: 26
behaviour mutations, each of which must change a produced result, and 3 identity mutations,
each of which must change the hash. This is the lesson the Sprint 3 and Sprint 4 audits taught
twice — a decorative field inside a hash makes the hash look stronger than the code is — and
the reason four of those mutations needed a purpose-built fixture before they discriminated at
all.

The median absolute deviation is the shipped baseline method because one large spike barely
moves it, which is the property a spike detector needs. The mean and standard deviation are
implemented and selectable so that the choice is visible and testable rather than assumed.

The contract is unchanged by the correction; its hash is the one the audit recorded.

## 4. Migrations 0008 and 0009 (design)

`0008_graph_evidence.sql`, checksum
`548c810d925d113f2d5ab74f399d3dff9b22f9e144bd2202072489a030344449`. Seven tables and five guard
functions. Every function is created through `pg_catalog.format` with `%1$I` quoted
identifiers, carries `SET search_path = pg_catalog, <schema>, pg_temp`, is not `SECURITY
DEFINER`, and schema-qualifies every relation it reads — the pattern migration 0005 established
after Codex Desktop's `$user` capture.

| Table                          | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `graph_signal_runs`            | one ingestion, with origin, gateway host and query digest |
| `graph_signals`                | one observation, with block context and response digest   |
| `evidence_runs`                | one resolution of a clustering run against a signal run   |
| `incident_subjects`            | the chain and protocol a person recorded for an incident  |
| `incident_signal_associations` | one suggested link, decided by review                     |
| `evidence_review_actions`      | one accept or reject, append-only                         |
| `incident_evidence_states`     | one resolved state per incident per evidence run          |

The composite keys are the mechanism rather than a formality. An evidence run has
`UNIQUE (id, clustering_run_id, batch_id, signal_run_id)`, and an association's foreign key
names all four columns together, so an association can only reach the incidents of its own
clustering run and the signals of its own signal run. A cross-run, cross-batch or cross-chain
substitution is not rejected by a check at write time; it cannot be written at all.

Two CHECK constraints carry the sprint's central claim into the schema:

```sql
CHECK (state IN ('reported_only','onchain_observed') OR accepted_association_count > 0)
CHECK (state IN ('reported_only','onchain_observed') OR claim_id IS NOT NULL)
```

The rationale policy from migration 0007 is applied again here: 1 to 280 characters, and no C0
control, DEL, C1 control, U+2028 or U+2029.

### 4.1 Migration 0009 (correction)

`0009_evidence_integrity.sql`, checksum
`b553eac744dedfed97e5eb247d0f82781daeb03455fba7a34203caca1cdec13a`. Additive over 0008, written
to the same rule: one transaction, `pg_catalog.format` with quoted identifiers, a stored
`search_path` of `pg_catalog, <schema>, pg_temp`, no `SECURITY DEFINER`, every relation
schema-qualified. It closes the two things 0008 documented but did not make unwritable.

**Origin is bound, not labelled.** `evidence_runs` gains two composite foreign keys, `(signal_run_id,
data_origin)` against `graph_signal_runs` and `(clustering_run_id, batch_id, data_origin)` against
a new parent key on `clustering_runs`. An evidence run whose origin differs from either parent
cannot be inserted, whatever the column says. A live signal run may not name a reserved-domain
gateway host — `.example`, `.invalid`, `.test`, `localhost` — because fixtures live there and
nothing live ever did.

**A claim is a record, not a UUID.** The new `incident_claims` table holds, per claim: the
clustering run, batch, incident and origin; the source row and its immutable `row_hash`; a kind
from a closed set (`reported_headline`, `recorded_statement`); a statement under the note
character policy; a canonical fingerprint unique within the incident; the actor, reason code and
time. Its composite foreign key to a new parent key on `incident_memberships` —
`(clustering_run_id, incident_cluster_id, batch_id, data_origin, source_row_id, row_hash)` — is the
database's own proof that the cited row is a member of the cited incident under the cited run.
`incident_signal_associations` and `incident_evidence_states` bind their `claim_id` to a claim of
the same incident, run and batch by foreign key; the `evidence_claim_guard` trigger checks the
same for `evidence_review_actions`, which carry no incident columns, and checks the evidence run's
origin for all three. An accepted `supports` or `conflicts` must name a claim. Claims are
append-only under the same guard as review actions.

**Existing rows are validated before each constraint is added**, and a contradiction fails the
whole migration in its transaction. Any existing citation of a claim — there can be no record
for one yet — is counted and reported, and the row is left exactly as it was. No claim record is
fabricated to legitimise historical data.

The migration was applied to the dedicated populated database on 10 September 2026: one applied,
then a no-op, then `db:check` connected; every row count before and after is identical
(24,248 source rows; 70,788 incident clusters; 72,579 memberships; 70 signals in 12 runs; 3
evidence runs; 23,596 states; 0 associations, actions, subjects and claims).

## 5. Recording a subject and a claim (design)

Sprint 5 implements no extraction. Nothing reads a headline to decide which protocol an
incident is about, or what claim it makes, because a rule that did would be exactly the
mechanism by which a report becomes a confirmed on-chain fact without anyone deciding it should.

That leaves two gaps the sprint closes deliberately rather than by accident. Without a way to
record a subject, the evidence layer would correlate nothing, ever: `evidence subject` records
one, by a named actor, with a reason code. Without a way to record a claim, nothing could be
corroborated or contradicted: `evidence claim` records one, by a named actor, with a kind, a
bounded statement, a reason code and the source row it rests on. Both are append-only, and a
second recording that disagrees with the first is a conflict rather than an overwrite, because
the row is what somebody asserted.

The recorded protocol slug is the provider-returned identity the Sprint 1 gate validated, so it
is compared with a stored signal by equality. A near miss is a refusal. The recorded claim's
source row is read from the membership table, never from the request: a row that is not a
member of the incident under the run is refused by the service with a fixed message and, past
the service, by the foreign key.

## 6. The anomaly feed (design)

Both halves the September 10 gate needs, from stored rows only. Neither half calls a provider.

The chain half labels each target's most recent observation against a rolling baseline of the
observations before it, in this order: freshness first, then history length, then gaps, then
the threshold. The order is the point — an old reading cannot be called a spike whatever its
value, because nothing recent is known.

The reporting half labels the most recent window against the windows before it, and reports
story concentration separately from story volume so that "many outlets covered one incident"
cannot be mistaken for "there were more incidents". A window is two instants the caller
supplied. **No editorial week is inferred anywhere.** D10 has not fixed one, and no weekly
candidate decision is read as a feature or a label.

Every entry carries its data origin and a fixed sentence stating what it does not establish:

> a value movement is circumstantial telemetry and does not establish that a cyberattack
> occurred

> a reporting-volume movement describes coverage, not incidents, and establishes nothing about
> any claim

Neither sentence is composed from input, so nothing downstream can soften it. The feed reads
signal history scoped by origin, so a replayed series never enters a live baseline.

## 7. Drafting and publication (design)

`packages/drafting` is pure and deterministic: no SDK, no model, no key, no clock, no
randomness. Its contract is executable and hashed the same way the evidence contract is:

```
drafter      deterministic-drafter@1
contract     drafting-behavior-contract@1
hash         f89382d6794e77a90eb11df841de234421dee2a75651d1cb95187b29b6ddade3
```

Decision D9 is unresolved, so nothing here is model-generated and no document may
describe the output as AI-generated. Every draft says so in its own first four lines, and
carries `Status: unpublished. This draft requires human review before anything is published.`

The assembler reads each source row's reported headline and offers it as a claim, with every
source that carried it, and includes any claim a person recorded for the incident. It extracts
no victim name, no attack type, no date and no figure, because repeating a report is not the
same as asserting a fact. The visible consequence is deliberate: every claim is `reported`, no
claim proposes a name, and the naming policy therefore withholds every name. A person supplies
the facts and the names; the machine supplies the shape, the sources and the evidence state.

Decision D3 is provisional and its conservative reading is implemented by the worker's
publisher: a draft is published under one authorised root, never through a symbolic link, and
never overwritten. The root is `output/drafts/` at the repository root, fixed by the worker and
ignored by Git; no command-line flag names another. Every existing component of the root's path
is inspected with `lstat` and must be a real directory, so a symbolic link anywhere in it — the
root included — refuses publication rather than being followed. The draft identifier
(`^[a-z0-9][a-z0-9-]{3,63}$`) and the period's calendar date (an exact `YYYY-MM-DD` that is a
real date) are validated in `@cas/drafting` before they become the single path component
`cyberattack-sunday-<date>-<id>`. Both files, `draft.md` and `provenance.json`, are created
exclusively with mode 0600 in a fresh staging directory, written in full, flushed and closed;
only then is the staging directory renamed onto the final one, atomically. A failure between the
two writes publishes neither file and removes the staging directory; a destination that is
already occupied, by anything, is refused. Decision D4 is provisional and implemented as a
configurable policy at its conservative setting. **Neither is owner-confirmed.**

The crypto section is separated by recorded on-chain subject alone, never by reading text for
the word "crypto".

## 8. Command-line interface (design)

```
evidence ingest   --file <path> --origin <fixture|replay>
evidence claim    --run <uuid> --incident <uuid> --source-row <uuid> --kind <reported_headline|recorded_statement> --statement <text> --reason <code> [--actor <name>]
evidence subject  --run <uuid> --incident <uuid> --chain <ethereum|base> --protocol <slug> --reason <code> [--actor <name>]
evidence resolve  --clustering-run <uuid> --signal-run <uuid>
evidence report   --run <uuid>
evidence signal   --id <uuid>
evidence decide   --run <uuid> --association <uuid> --operation <accept|reject> --relation <supports|conflicts|context> --reason <code> --actor <name> [--claim <uuid>] [--note <text>]
evidence review-count --run <uuid>
evidence anomaly  --signal-run <uuid> [--as-of <iso>] [--clustering-run <uuid> --window <isoStart..isoEnd> ...]
drafting generate --evidence-run <uuid> --window <isoStart..isoEnd>
```

Every value is validated before a database handle is opened. Output is count-only and
identifier-only, redacted for the connection string, and rendered as one physical line per
entry. `--as-of` exists because replaying dated data against the wall clock calls every
observation stale, which is true of the clock and useless as a demonstration; it is never
defaulted from the data, so a live run cannot quietly acquire one.

`evidence ingest` takes `fixture` or `replay` and nothing else. Given `live` it exits 2 with a
fixed message — **a file can be ingested as fixture or replay only; live evidence comes from the
Graph client, never from a file** — before the path is opened, before a database handle exists
and before any ordinary line is printed. Live ingestion is the worker function
`ingestLiveEvaluations`, which takes validated Graph-client evaluations and no path; it has no
command-line surface in this correction (section 12 explains why). `drafting generate` has no
destination flag.

A snapshot file is untrusted input. It is validated recursively against a closed shape before a
row is written: a plain object or plain array, no symbol keys, own property names equal to the
allowlist, every property a plain enumerable data property, no proxy, and then a bare hostname,
a hexadecimal digest and decimal amounts. An accessor is refused without being invoked. No
provider payload, Authorization header or API key is stored, and no column exists to store one
in.

## 9. Tests (tests)

**532 offline tests**, no database, no secret, no network:

| Package               | Tests |
| --------------------- | ----: |
| `@cas/taxonomy`       |     7 |
| `@cas/contracts`      |     9 |
| `@cas/database`       |    24 |
| `@cas/classification` |    56 |
| `@cas/clustering`     |    50 |
| `@cas/evidence`       |    69 |
| `@cas/drafting`       |    19 |
| `@cas/graph-evidence` |   102 |
| `@cas/worker`         |   196 |

**186 PostgreSQL integration tests**: 81 in `@cas/database`, 105 in `@cas/worker`. Every test
creates a schema whose exact name it generated and drops only that schema.

`apps/worker/src/hygiene/scan.ts` refuses an invisible character in any TypeScript or SQL
source: every C0 control except tab and newline, DEL, every C1 control and the two Unicode line
separators — the same set migration 0007 refuses in a stored note. It decodes each line as
UTF-8 and walks it by code point. `repository-hygiene.test.ts` scans the repository as it is,
and then proves the scanner against a disposable tree: fifteen representative code points, each
produced from its numeric value and injected at a known line, must be reported at exactly that
file and line, and the whole documented set is swept. Section 12 records the two defects that
prompted it, including the one it caught during this correction.

The offline suite is demonstrated to be offline rather than believed to be.
`tools/offline-sandbox.sb` is a macOS sandbox profile that denies every network operation and
nothing else. The denial is shown to be active in the same session by attempting a connection
under the same profile and requiring it to fail, because a profile that silently did nothing
would let the whole run pass and prove the opposite of what it looks like:

```
$ sandbox-exec -f tools/offline-sandbox.sb node -e "…net.connect(443,'1.1.1.1')…"
denial active: EPERM
$ sandbox-exec -f tools/offline-sandbox.sb corepack pnpm test --force
Tasks:    16 successful, 16 total
```

All 532 pass under it. The profile denies UNIX-domain sockets too, so `pnpm test:db` cannot run
beneath it, which is the intended asymmetry.

## 10. Replay fixtures (tests)

`data/fixtures/evidence/` holds synthetic fixtures that are regenerable byte-for-byte. The
gateway host is a reserved `.example` name, the deployment identifiers and block hashes are
invented, and no value is copied or derived from a provider response, an export or a
publication. `data/fixtures/README.md` documents every file and its expected result.

Twelve daily snapshots over the seven identities, replayed against a fixed as-of instant,
produce one of every anomaly label:

| Target                   | Produces               | Why                                                |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| `ethereum:aave-v3`       | `normal`               | ordinary movement, `0.29%`                         |
| `ethereum:spark-lend`    | `positive_spike`       | `31.5%` against ordinary noise                     |
| `ethereum:compound-v3`   | `negative_spike`       | `-27.8%` against ordinary noise                    |
| `ethereum:makerdao`      | `positive_spike`       | flat baseline, so only the 5% floor decides        |
| `ethereum:liquity`       | `insufficient_history` | two prior observations, fewer than seven           |
| `base:seamless-protocol` | `missing_observation`  | a 72-hour hole, reported rather than smoothed over |
| `base:moonwell`          | `stale_observation`    | last reading past the 36-hour freshness limit      |

Five reporting scenarios separate a volume spike, a story concentration, a high incident count
that raises nothing, too few windows, and a flat baseline. The correlation fixture covers all
four evidence states and all five refusal reasons.

## 11. Real-data proof (real data)

The three imported real batches are unchanged. Every figure below is a count. The resolutions
and the anomaly feed were produced at the rejected candidate `6fad82c3…`; after migration 0009
was applied to the same database, every row count is unchanged (section 4.1) and each
resolution, re-run, returned `already resolved` with its original identifier and counts, so
these figures are current evidence rather than historical. The drafts were re-published with
the corrected publisher.

**Snapshot ingestion.** Twelve replay snapshots ingested as twelve completed signal runs,
70 signals, all origin `replay`. Re-ingesting a snapshot returns the original run and writes
nothing. The same bytes read under a second origin are a separate run and a separate series;
they are never merged into one history. No live run exists in the dedicated database.

**Resolution.** Three real clustering runs at the accepted Sprint 4 contract:

| Batch  | Clustering run | Incidents | Pairs considered and refused | Suggestions | Resolved states        |
| ------ | -------------- | --------: | ---------------------------: | ----------: | ---------------------- |
| CS79   | `89ccd524…`    |       154 |                          924 |           0 | 154 `reported_only`    |
| CS86   | `31804d66…`    |       180 |                        1,080 |           0 | 180 `reported_only`    |
| master | `16253b31…`    |    23,262 |                      139,572 |           0 | 23,262 `reported_only` |

All three reconcile: the database re-derived every counter from the rows actually stored and
agreed with what the run claimed.

Zero suggestions is the correct result and is worth stating plainly. No real incident has a
recorded subject, because recording one is an assertion a person makes about a real report and
nobody has made any. No real incident has a recorded claim, for the same reason. The evidence
layer therefore suggests nothing, and 23,596 real incidents resolve to `reported_only`. A
pipeline that produced links here would be producing them from text, which is the thing this
design refuses to do. **Recorded reporting is not a corroborated claim**: every real state is
the former, and none is the latter.

**Anomaly feed**, master clustering run, four explicit weekly windows, as-of
`2026-09-04T09:11:23Z`:

```
evidence:anomaly: entries=9 chainTargets=7 reportingWindows=4
labels: spikes=3 insufficientHistory=1 stale=1 missing=1 bounded=0
```

The reporting half, from real rows: the last window carries 302 source stories against a
threshold of 384.27, so `normal`; concentration 1.02 stories per incident against a threshold
of 3, so `normal`. Both halves of the gate requirement produce output on real data. The chain
half is **replay evidence**: it rests on the synthetic snapshots, not on a live Graph query,
and this report claims no live Graph evidence for this sprint.

**Drafting.** The CS86 draft was published again with the corrected publisher, as a directory
pair under the authorised root, neither file committed (`output/` is ignored):

| Draft            | Evidence run | Incidents | Claims written | Names withheld | Crypto |
| ---------------- | ------------ | --------: | -------------: | -------------: | -----: |
| CS86             | `3ec67fa8…`  |       180 |            181 |            181 |      0 |
| CS79 calibration | `f7095f00…`  |       154 |            154 |            154 |      0 |

The CS79 row is historical: it was produced at the candidate as a flat file pair and has not
been re-published. Every claim is `reported`, every naming decision is
`withheld_insufficient_sourcing`, and every evidence state is `reported_only`. The sidecar has
no field for a victim name at all, which is a stronger property than every name happening to be
empty.

The crypto section is empty on both because no real incident carries a recorded on-chain
subject. That is the honest output of an empty input, not a missing feature. **These counts are
structural.** They say the pipeline covered its input and grouped, resolved and rendered it;
they say nothing about whether any incident, grouping or claim is editorially correct, because
the project holds no reviewed record of the editorial outcome to compare against.

## 12. Judgment calls and deviations

1. **`@cas/evidence` is a separate package from `@cas/clustering`.** Clustering's contract was
   audited and accepted at a fixed hash. Keeping them apart means a change to one cannot move
   the other's identity.
2. **A resolution's identity includes the human judgement behind it.** Writing the tests
   exposed a defect: decisions bound to one run's association rows, and re-resolving was
   idempotent on the clustering run, the signal run and the contract, so the second resolution
   returned the first run and the stored state stayed `reported_only` for good. The review
   layer was decorative. The idempotency key now covers a digest of every decision bearing on
   the clustering run, and a decision is matched to an incident and a signal rather than to a
   row, so the judgement survives into the new run. Nothing is copied or rewritten.
3. **The chain feed covers every target of the run's origin, not only the named run's
   targets.** A target that stops reporting is exactly the case `stale_observation` exists for,
   and scoping the query to one run dropped it from the feed instead of flagging it.
4. **Signal history filters on origin.** The history query matched chain and protocol but not
   origin, so a fixture ingested for a demonstration would have entered a live target's
   baseline. A replayed series and a live series are different histories of the same target.
5. **`evidence subject` and `evidence claim` were added.** Without them the evidence layer could
   never correlate or corroborate anything. Section 5 explains why no extraction stands in
   their place.
6. **`--as-of` was added to the anomaly command.** Section 8 explains why.
7. **Two edits to Sprint 4 test files.** A stale assertion listed the pending migrations
   exhaustively and broke when 0008 arrived; it now asserts that 0007 is the head of the
   pending list, which stays correct as later migrations are added behind it. And the Sprint 3
   race probes attached their rejection handler after the classifier returned, leaving a window
   in which Node saw an unhandled rejection and failed the whole run; the refusal is now caught
   where the promise is made and asserted exactly as before. Neither edit weakens an assertion.
8. **Five raw NUL bytes were written into a TypeScript source file**, where they framed the
   fields of the decision digest, and nothing caught them. They are legal inside a JavaScript
   string, Prettier reformatted around them, ESLint passed, and every test went green because
   the digest was self-consistent; a reviewer reading the diff would have seen ordinary spaces.
   The separator is now an explicit `\u0000` escape, which keeps the framing property and
   leaves the source readable, and the hygiene scanner refuses the whole prohibited set in every
   TypeScript and SQL file. The digest itself is unchanged for every run recorded in section 11,
   because with no decisions the loop body never executes and the digest is that of the empty
   string; all three real resolutions returned `already resolved` with their original
   identifiers after the fix.
9. **The clustering test timeout was raised to 120 seconds.** Three Sprint 4 tests cluster
   large synthetic corpora and take seven to twenty-two seconds while the rest of the workspace
   builds beside them, against a five-second default. They failed about one full run in three
   on machine load alone. The budget is raised; the corpora are unchanged, because a mutation
   sweep that stops short proves less than one that finishes.
10. **The hygiene scanner caught the same slip again during this correction.** The claim
    fingerprint's field separator was typed as a raw NUL; the repository scan failed with the
    exact file and line, and the separator was spelled out as an escape before the commit. That
    is the guard doing what section 16 says it must, and the reason the falsification test
    exists.
11. **The live ingestion path has no command-line command.** Wiring `evidence ingest-live` to
    the Graph client would make `@cas/graph-evidence` a workspace dependency of the worker, and
    this correction was instructed to make no dependency change without stopping to explain
    first. The path therefore exists at the service level, `ingestLiveEvaluations`, with a
    closed input type that is structurally the Graph client's validated evaluation and a
    re-check of every invariant the client establishes, proven in PostgreSQL with synthetic
    evaluations. The owner decides whether to add the workspace link; no third-party package is
    involved either way.
12. **A repository located under a symbolic link cannot publish drafts.** The publisher refuses
    a symbolic link in any component of the root's path, as the audit's required correction
    asks. On this machine the repository path has none. If the repository is ever checked out
    under one, publication refuses with `draft_root_symlink` rather than following it, and the
    root is moved rather than the check relaxed.
13. **Two claim kinds, both human-recorded.** `reported_headline` for a claim that repeats what
    a source's headline reports, and `recorded_statement` for a falsifiable assertion a person
    makes about the incident. No kind is machine-created, because that would be extraction by
    another name.

## 13. Limitations and unresolved risks

1. **No real incident has a recorded subject or claim**, so the correlation, review and
   resolution path is proven end to end only against synthetic data in PostgreSQL. Every real
   figure in section 11 is a zero-suggestion run. This is a property of the input, not a
   defect, but it means the accept path has no real-data demonstration and this report does not
   claim one.
2. **The crypto section has never rendered a real incident**, for the same reason.
3. **D3 and D4 are provisional.** The draft destination and the naming rule are implemented as
   configurable policies at conservative settings. Neither is owner-confirmed and neither is
   presented here as decided.
4. **D9 is unresolved.** Nothing is model-generated. If a model is introduced later, every
   claim in section 7 has to be revisited.
5. **D10 is unresolved.** No command infers an editorial week, so a caller who supplies the
   wrong bounds gets a correct answer to the wrong question. The bounds are echoed on every
   line so the question is visible.
6. **No live Graph call is made in this sprint.** The snapshots ingested here are `replay`
   origin. The live ingestion path is proven with synthetic evaluations, not with a provider
   response, and has no command-line surface (section 12, item 11). Sprint 1's live capability
   is unchanged, and this sprint neither extends nor re-proves it.
7. **The anomaly baseline is short.** Twelve daily observations is enough to exercise every
   label and not enough to characterise a protocol. No claim here rests on the baseline being
   representative.
8. **The correction has not been re-audited.** Sprint 5 is pending an independent Codex
   Desktop re-audit, and no part of this document is an audit result.

## 14. Verification

Run in this order, from a clean checkout, with a local PostgreSQL 17 and `DATABASE_URL` set:

```
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test --force
corepack pnpm build
corepack pnpm db:migrate
corepack pnpm db:migrate      # second run must report a no-op
corepack pnpm db:check
corepack pnpm test:db
```

`pnpm test` needs no database, secret or network, and is the suite continuous integration runs.
To confirm that for yourself:

```
sandbox-exec -f tools/offline-sandbox.sb corepack pnpm test --force
```

## 15. Reproduction for Codex Desktop

The replay demonstration, from a migrated database (nine migrations), with no credential of any
kind:

```
for day in 01 02 03 04 05 06 07 08 09 10 11 12; do
  corepack pnpm -s --filter @cas/worker cli evidence ingest \
    --file "$PWD/data/fixtures/evidence/snapshots/replay-$day.json" --origin replay
done

corepack pnpm -s --filter @cas/worker cli evidence anomaly \
  --signal-run <the twelfth run id> --as-of 2026-09-04T09:11:23Z
```

That prints nine entries and one of every label, as section 10's table says it should. The
`--file` argument must be an absolute path: the command runs from the worker package, so a
repository-relative path resolves somewhere else and is refused as unreadable.

The origin boundary, on the compiled command:

```
corepack pnpm -s --filter @cas/worker cli evidence ingest \
  --file "$PWD/data/fixtures/evidence/snapshots/replay-01.json" --origin live
```

exits 2 with `error[configuration/origin_not_file_backed]` and prints nothing else, whether or
not `DATABASE_URL` is set and whether or not the file exists.

To record a claim, resolve and draft against a clustering run of your own:

```
corepack pnpm -s --filter @cas/worker cli evidence claim \
  --run <clustering run> --incident <uuid> --source-row <uuid> \
  --kind recorded_statement --statement "<what the source states>" --reason stated_in_disclosure
corepack pnpm -s --filter @cas/worker cli evidence resolve \
  --clustering-run <uuid> --signal-run <uuid>
corepack pnpm -s --filter @cas/worker cli drafting generate \
  --evidence-run <uuid> --window 2026-08-09T00:00:00Z..2026-08-16T00:00:00Z
```

The draft is published as `output/drafts/cyberattack-sunday-<date>-<id>/draft.md` beside
`provenance.json`, under the repository root, ignored by Git and never committed. There is no
flag that names another destination.

## 16. Audit correction (correction)

Codex Desktop audited candidate `6fad82c3b03325101940d9ca25575d94550e7d25` on 10 September 2026
and returned CHANGES REQUIRED with five findings. The auditor changed no repository file. Every
finding is corrected on this branch, additively, in commits after the candidate; the migration
is 0009 and migrations 0001 to 0008 are byte-identical to the audited ones. The correction has
not been re-audited.

| ID  | Severity | Finding                                                                                                                                 | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | High     | A replay file could be ingested with `--origin live`; the schema did not bind an evidence run's origin to its signal or clustering run. | File ingestion is `ingestSnapshotFile` with a `FileOrigin` type of `fixture` and `replay` only, refused for `live` at the command line and at the service before the file is opened or a database handle is used. Live ingestion is `ingestLiveEvaluations`, a separate function over validated Graph-client evaluations, with no path and no origin argument. Migration 0009 binds `evidence_runs` to `graph_signal_runs (id, data_origin)` and `clustering_runs (id, batch_id, data_origin)` by composite foreign key and refuses a live run served from a reserved-domain host. |
| F2  | High     | A `supports` or `conflicts` decision could name any UUID; nothing proved a claim existed or belonged to the incident.                   | `incident_claims` records a claim with its source row, row hash, incident, clustering run, batch and origin, proven a member by composite foreign key to `incident_memberships`. Associations and states bind to a claim by foreign key; the `evidence_claim_guard` trigger binds review actions and checks origin for all three. The service refuses a nonexistent or incompatible claim before hashing, and the claim's identity is part of the decision's idempotency key. `evidence claim` records claims.                                                                     |
| F3  | Medium   | The draft writer followed a symlinked output directory and accepted traversal in the identifier.                                        | The publisher confines output to one authorised root fixed by the worker (`--out` removed), refuses a symbolic link in any path component, validates the identifier and calendar date against strict allowlists in `@cas/drafting`, writes both files exclusively with mode 0600 into a fresh staging directory, flushes and closes them, and publishes by atomic rename only after both succeed; a failure publishes neither and removes the staging directory.                                                                                                                   |
| F4  | Low      | The snapshot validator accepted inherited, symbol, non-enumerable and accessor properties, and invoked a getter.                        | The validator is a closed boundary applied recursively: plain prototype, no symbols, own names equal to the allowlist, every property an enumerable data descriptor inspected before any read, no proxy; the same rules on every nested object and array element.                                                                                                                                                                                                                                                                                                                  |
| F5  | Low      | The hygiene test scanned the current tree but never proved detection.                                                                   | The scanner is a root-configurable unit that decodes by code point; the test keeps the clean-tree assertion and adds a disposable-tree injection that must report the exact file and line for fifteen representative code points, sweeps the whole documented set, and reports invalid UTF-8 as itself.                                                                                                                                                                                                                                                                            |

**Closure evidence, by finding.** Offline unless marked.

- **F1.** `cli.test.ts` › _evidence ingestion origin boundary_: `--origin live` with a missing
  file exits 2, prints no ordinary line, one error line naming `origin_not_file_backed`, and the
  database seam is never opened; `fixture` and `replay` reach the seam. `signals.test.ts` ›
  _file ingestion input boundary_: the service refuses `live` before `readFile` and before any
  database use. PostgreSQL, `run.db.test.ts`: a live run is ingested from synthetic Graph-client
  evaluations with no path and no flag; eight invalid evaluation inputs (not valid, stale,
  mismatch, replay provenance, another query, another host, reserved host, credential in base)
  are refused; a direct `INSERT` of a live evidence run over a replay signal run, and of a
  replay evidence run over the live signal run, both fail with SQLSTATE 23503; a direct `INSERT`
  of a live signal run on `gateway.fixture.example` fails with 23514; resolving a replay
  clustering run against the live signal run fails by foreign key. Compiled command: section 15.
- **F2.** PostgreSQL, `run.db.test.ts`: a claim is recorded once on a member row and returned
  unchanged on repeat; a claim on a non-member row is refused by the service
  (`source_row_not_member`) and by the foreign key (23503); the statement policy and emptiness
  are refused; claims are append-only (P0001 on update and delete); a decision naming a
  nonexistent claim fails `claim_not_found`, a claim of another incident fails
  `claim_incompatible`, a claim from a second batch of origin `fixture` under its own clustering
  run fails `claim_incompatible`, and past the service the guard refuses the action (P0001) and
  the foreign key or guard refuses the state; an accepted `supports` without a claim is refused
  by the service (`claim_required`) and by the guard on a direct `INSERT`; a replay with the same
  claim is `already_recorded`, a changed actor or rationale is a conflict, and a different real
  claim is a new revision; corroboration and contradiction resolve to the real claim's
  identifier. `generate.db.test.ts` records real claims before deciding.
- **F3.** `generate.test.ts` (offline, disposable tree): thirteen identifier attacks and nine
  date attacks refused as `draft_identity_invalid`; a symbolic link as the root and as an
  intermediate directory refused as `draft_root_symlink` with nothing written to the link
  target; a file at the root refused; an existing draft, a plain file and a symbolic link at the
  destination refused as `draft_exists` with the original bytes untouched; a failure injected
  between the two writes leaves no staging directory and no partial pair, and the identifier is
  free afterwards; a missing root is created with mode 0700 at every level; after every case the
  tree is walked and no file exists outside the root and no incomplete pair inside it.
  `generate.db.test.ts` (PostgreSQL) publishes real pairs and refuses a repeat.
- **F4.** `signals.test.ts`: inherited fields at both levels, a class instance, a symbol key at
  both levels, a non-enumerable extra and a non-enumerable expected field, an accessor with a
  counter, a getter that throws, an element getter, a proxy at each of three levels with a
  counting trap, a widened nested object, a widened array, an array subclass and a narrowed
  observation are all refused, and the counters stay at zero; a null-prototype object is
  accepted; the value, length and range checks still hold.
- **F5.** `repository-hygiene.test.ts`: the repository scan is clean; the disposable tree
  passes clean, reports each of fifteen injected code points at `src/a/injected.ts:2`, sweeps
  the full set of 65 code points and refuses none of seven permitted ones, reports two invalid
  UTF-8 lines as themselves, orders offenders across files stably, and scans only the documented
  extensions.

**What this correction does not do.** It does not touch migrations 0001 to 0008, the evidence
or drafting contracts, the real imported batches, the fixtures or any earlier sprint's
behaviour. It adds no dependency. It does not mark D3, D4, D9 or D10 resolved. It does not
begin Sprint 6.

**Sprint 5 remains pending until Codex Desktop issues PASS.**
