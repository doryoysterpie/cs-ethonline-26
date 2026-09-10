# Sprint 5 report: Graph evidence, the anomaly feed and deterministic drafting

Status: **complete and pending independent audit by Codex Desktop.** Nothing in this document
is an audit result, and nothing here may be read as one. All times America/Toronto unless
marked UTC.
Count-only throughout: no title, URL, summary, description, organisation, publisher, cell,
connection detail or absolute path appears here.

**How to read this report.** Each section is labelled by the kind of evidence it carries:
**design** is a claim about how the code is built, **tests** is automated evidence that runs
offline, **PostgreSQL** is integration evidence against a live database, and **real data** is
count-only evidence from the three imported real batches.

| Item              | Value                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Repository        | `doryoysterpie/cs-ethonline-26`, public                                  |
| Branch            | `sprint-5/evidence-drafting`, created from the accepted Sprint 4 SHA     |
| Starting SHA      | `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b` (Sprint 4, accepted)          |
| `main`            | unchanged                                                                |
| Decision          | D25, appended 10 September 2026                                          |
| Migration added   | `packages/database/migrations/0008_graph_evidence.sql`                   |
| Migrations 1 to 7 | unchanged; checksums verified against the accepted values                |
| Model calls       | none; no SDK, no model path, no credential read                          |
| D3, D4, D9, D10   | all still PROVISIONAL or unresolved; none is marked owner-confirmed here |

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

1. **Snapshot ingestion.** A set of normalized TVL-delta observations for the seven identities
   decision D23 retained becomes a completed signal run and a row per observation. The origin
   is an explicit required argument.
2. **Correlation.** One clustering run and one signal run produce suggested associations, on
   recorded identity and declared window alone.
3. **Review.** A named person accepts or rejects a suggestion, with a reason code and an
   optional bounded rationale.
4. **Resolution.** Every incident of the clustering run gets one of four evidence states,
   derived from accepted associations only.
5. **Anomaly feed and drafting.** Chain movements and reporting movements side by side, and a
   Markdown draft with a machine-readable provenance sidecar.

Three properties hold across all five, and each is enforced somewhere a mistake cannot skip.

- **No text is read anywhere in the evidence path.** `IncidentSubject` carries identifiers, a
  chain, a protocol slug and a timestamp. It has no title field, no summary field and no body
  field, so no amount of the words "hack", "attack" or "crypto" in a headline can produce a
  link. An incident whose subject nobody recorded never correlates.
- **A suggestion is not evidence.** `correlation.suggestionIsEvidence` is `false`. A suggestion
  is written with relation `context` and status `suggested`; the resolver counts only
  `accepted`; and a database CHECK refuses a `corroborated` or `contradicted` row whose
  accepted-association count is zero or whose claim is absent.
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

## 4. Migration 0008 (design)

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

A corroboration with nothing behind it, and a corroboration about nothing in particular, are
both unwritable by any code path including a direct `INSERT`.

The rationale policy from migration 0007 is applied again here: 1 to 280 characters, and no C0
control, DEL, C1 control, U+2028 or U+2029.

## 5. Recording a subject (design)

Sprint 5 implements no extraction. Nothing reads a headline to decide which protocol an
incident is about, because a rule that did would be exactly the mechanism by which a report
becomes a confirmed on-chain fact without anyone deciding it should.

That leaves a gap the sprint has to close deliberately rather than by accident: without a way
to record a subject, the evidence layer would correlate nothing, ever. `evidence subject`
records one, by a named actor, with a reason code. It is append-only, one per incident, and a
second recording that disagrees with the first is a conflict rather than an overwrite, because
the row is what somebody asserted.

The recorded slug is the provider-returned identity the Sprint 1 gate validated, so it is
compared with a stored signal by equality. A near miss is a refusal.

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

Neither sentence is composed from input, so nothing downstream can soften it.

## 7. Drafting (design)

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
source that carried it. It extracts no victim name, no attack type, no date and no figure,
because repeating a report is not the same as asserting a fact. The visible consequence is
deliberate: every claim is `reported`, no claim proposes a name, and the naming policy
therefore withholds every name. A person supplies the facts and the names; the machine supplies
the shape, the sources and the evidence state.

Decision D3 is provisional and its conservative reading is implemented: a dated file under an
ignored `output/drafts/` directory, written with the exclusive flag so an existing draft is
never overwritten and the refusal is the filesystem's rather than a check another writer could
slip between. Decision D4 is provisional and implemented as a configurable policy at its
conservative setting. **Neither is owner-confirmed.**

The crypto section is separated by recorded on-chain subject alone, never by reading text for
the word "crypto".

## 8. Command-line interface (design)

```
evidence ingest   --file <path> --origin <live|fixture|replay>
evidence subject  --run <uuid> --incident <uuid> --chain <ethereum|base> --protocol <slug> --reason <code> [--actor <name>]
evidence resolve  --clustering-run <uuid> --signal-run <uuid>
evidence report   --run <uuid>
evidence signal   --id <uuid>
evidence decide   --run <uuid> --association <uuid> --operation <accept|reject> --relation <supports|conflicts|context> --reason <code> --actor <name> [--claim <uuid>] [--note <text>]
evidence review-count --run <uuid>
evidence anomaly  --signal-run <uuid> [--as-of <iso>] [--clustering-run <uuid> --window <isoStart..isoEnd> ...]
drafting generate --evidence-run <uuid> --window <isoStart..isoEnd> [--out <directory>]
```

Every value is validated before a database handle is opened. Output is count-only and
identifier-only, redacted for the connection string, and rendered as one physical line per
entry. `--as-of` exists because replaying dated data against the wall clock calls every
observation stale, which is true of the clock and useless as a demonstration; it is never
defaulted from the data, so a live run cannot quietly acquire one.

A snapshot file is untrusted input. It is validated against a closed set of fields before a row
is written: a bare hostname, a hexadecimal digest, decimal amounts. The host pattern admits no
scheme, no userinfo section, no path and no query, so a credential cannot be smuggled through
it. No provider payload, Authorization header or API key is stored, and no column exists to
store one in.

## 9. Tests (tests)

**482 offline tests**, no database, no secret, no network:

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
| `@cas/worker`         |   146 |

**173 PostgreSQL integration tests**: 81 in `@cas/database`, 92 in `@cas/worker`. Every test
creates a schema whose exact name it generated and drops only that schema.

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

All 482 pass under it. The profile denies UNIX-domain sockets too, so `pnpm test:db` cannot run
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

The three imported real batches are unchanged. Every figure below is a count.

**Snapshot ingestion.** Twelve replay snapshots ingested as twelve completed signal runs,
70 signals, all origin `replay`. Re-ingesting a snapshot returns the original run and writes
nothing. The same bytes read under a second origin are a separate run and a separate series;
they are never merged into one history.

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
nobody has made any. The evidence layer therefore suggests nothing, and 23,596 real incidents
resolve to `reported_only`. A pipeline that produced links here would be producing them from
text, which is the thing this design refuses to do.

**Anomaly feed**, master clustering run, four explicit weekly windows, as-of
`2026-09-04T09:11:23Z`:

```
evidence:anomaly: entries=9 chainTargets=7 reportingWindows=4
labels: spikes=3 insufficientHistory=1 stale=1 missing=1 bounded=0
```

The reporting half, from real rows: the last window carries 302 source stories against a
threshold of 384.27, so `normal`; concentration 1.02 stories per incident against a threshold
of 3, so `normal`. Both halves of the gate requirement produce output on real data.

**Drafting.** Two drafts generated and written, neither committed (`output/` is ignored):

| Draft            | Evidence run | Incidents | Claims written | Names withheld | Crypto |
| ---------------- | ------------ | --------: | -------------: | -------------: | -----: |
| CS86             | `3ec67fa8…`  |       180 |            181 |            181 |      0 |
| CS79 calibration | `f7095f00…`  |       154 |            154 |            154 |      0 |

Every claim is `reported`, every naming decision is `withheld_insufficient_sourcing`, and every
evidence state is `reported_only`. The sidecar has no field for a victim name at all, which is
a stronger property than every name happening to be empty. Writing to an existing draft path
was probed directly and refused with `EEXIST`.

The crypto section is empty on both because no real incident carries a recorded on-chain
subject. That is the honest output of an empty input, not a missing feature.

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
5. **`evidence subject` was added.** Without it the evidence layer could never correlate
   anything. Section 5 explains why no extraction stands in its place.
6. **`--as-of` was added to the anomaly command.** Section 8 explains why.
7. **Two edits to Sprint 4 test files.** A stale assertion listed the pending migrations
   exhaustively and broke when 0008 arrived; it now asserts that 0007 is the head of the
   pending list, which stays correct as later migrations are added behind it. And the Sprint 3
   race probes attached their rejection handler after the classifier returned, leaving a window
   in which Node saw an unhandled rejection and failed the whole run; the refusal is now caught
   where the promise is made and asserted exactly as before. Neither edit weakens an assertion.
8. **The clustering test timeout was raised to 120 seconds.** Three Sprint 4 tests cluster
   large synthetic corpora and take seven to twenty-two seconds while the rest of the workspace
   builds beside them, against a five-second default. They failed about one full run in three
   on machine load alone. The budget is raised; the corpora are unchanged, because a mutation
   sweep that stops short proves less than one that finishes.

## 13. Limitations and unresolved risks

1. **No real incident has a recorded subject**, so the correlation, review and resolution path
   is proven end to end only against synthetic data in PostgreSQL. Every real figure in section
   11 is a zero-suggestion run. This is a property of the input, not a defect, but it means the
   accept path has no real-data demonstration and this report does not claim one.
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
   origin. Sprint 1's live capability is unchanged, and this sprint neither extends nor
   re-proves it.
7. **The anomaly baseline is short.** Twelve daily observations is enough to exercise every
   label and not enough to characterise a protocol. No claim here rests on the baseline being
   representative.
8. **Nothing in this sprint has been audited.** Sprint 5 is pending an independent Codex
   Desktop audit, and no part of this document is an audit result.

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

The replay demonstration, from a migrated database, with no credential of any kind:

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

To resolve and draft against a clustering run of your own:

```
corepack pnpm -s --filter @cas/worker cli evidence resolve \
  --clustering-run <uuid> --signal-run <uuid>
corepack pnpm -s --filter @cas/worker cli drafting generate \
  --evidence-run <uuid> --window 2026-08-09T00:00:00Z..2026-08-16T00:00:00Z
```

The draft is written under `output/drafts/`, which is ignored by git and never committed.

**Sprint 5 remains pending until Codex Desktop issues PASS.**
