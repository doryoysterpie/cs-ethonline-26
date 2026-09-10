# Data inputs

This document describes the editorial data the project consumes, its shape, its trust level
and the rules the importer obeys. Sections 1 to 13 record the requirements as written in
Sprint 0; section 14 records how the Sprint 2 importer enforces them (decision D20 in
`DECISIONS.md`).

## 1. The present manual workflow and the target runtime flow

**The present manual workflow**, as stated by the project owner, is background for
understanding the data and the labels. It is not the runtime design.

1. Make continuously aggregates many websites into a living RSS feed, maintained and exported
   through Excel. This one continuously growing file is the **living RSS ledger**. It is a
   single accumulating ledger, not a series of independent files.
2. The project owner manually reviews that living feed and creates an Excel cut-down of the
   possible cyberattack incidents and other stories of interest for one editorial week. The
   result is a **weekly candidate cut-down**.
3. The weekly cut-down is still an intermediate candidate list. It is not the complete source
   of truth for which stories become Cyberattack Sunday incidents.
4. Claude currently receives the weekly Excel export, reformats it and deduplicates the
   possible stories. The result is a **reformatted and deduplicated candidate draft**.
5. The project owner then performs further editorial selection, ordering and editing. Those
   are the **final editorial decisions**, and they happen after the candidate draft exists.
6. The report is published on Substack. The **published Substack report** is the closest
   available record of the final editorial outcome.

```
living RSS ledger → weekly candidate cut-down → reformatted and deduplicated candidate draft
   → owner's final editorial decisions → published Substack report
```

**What a weekly sheet is and is not.** CS79 and CS86 are weekly candidate cut-downs. They are
not weekly master RSS datasets, and the project does not hold eighty-eight independent weekly
master datasets: there is one living ledger and a number of candidate lists drawn from it.
A row retained in a weekly cut-down is a **possible** story, not a confirmed cyberattack
incident, and a weekly sheet is not final publication ground truth, because two editorial
stages still follow it. Any reading of the batch table in which each weekly import is a
separate corpus, or in which weekly inclusion equals incident truth, is wrong.

**No field in these files is a definitive incident label.** Publisher Category is the
publisher's own taxonomy, the ledger's `ch` column is the owner's working state on the living
feed, and weekly spreadsheet inclusion is a candidate decision. None of the three establishes
that a story became a published incident, and no code may treat any of them as if it did.

**The target runtime flow** (decision D15) removes the manual selection bottleneck from the
front of the pipeline and moves the human to the end, where review is of a queue rather than
of the whole feed:

1. Current master RSS, Excel or CSV feed.
2. Import and normalization.
3. Automated high-recall classification.
4. Include, exclude, or needs-review queue.
5. Incident clustering.
6. Canonical incident records.
7. Human review and editorial output.

```
current feed → import and normalization → automated high-recall classification
   → include / exclude / needs-review queue → incident clustering → canonical incident records
   → human review and editorial output
```

The CS79 and CS86 candidate cut-downs are calibration datasets for steps 3 to 6, with
one precise meaning: their spreadsheet review states measure retention against the owner's
**intermediate weekly candidate decisions**. They do not measure agreement with the final
published incident selection, because the final selection is made two stages later. They are
never a production filter or a prerequisite for processing a current feed, and the
deterministic rules of decision D21 are not trained on them: nothing in the classifier is
fitted, weighted or selected from a label, and the classifier never reads one. Decision D10,
which fixes the automated week boundary, the late-arriving-story rule and the publication
cutoff, remains unresolved; nothing in this section resolves it.

**What an end-to-end evaluation will require, and does not yet have.** Measuring the pipeline
against the real editorial outcome needs the published reports, not the candidate lists. That
work, when it is scheduled, must:

- pair weekly Excel cut-downs with their corresponding final Substack reports;
- reconstruct the final include, exclude and incident-grouping outcomes through an explicit,
  reviewed mapping process rather than by inference;
- preserve provenance from the living ledger through the candidate list to the publication;
- reserve an untouched group of paired weeks for holdout evaluation before the wider archive
  is exposed to development.

That split has not been made, and this correction pass does not invent it.
Live Graph signals run in parallel to this flow and attach corroborating evidence to canonical
incidents; they do not replace editorial ingestion (`ARCHITECTURE.md` section 3).

Four judgments remain distinct records and must not be collapsed into a single binary
classification problem: the machine's classification decision on a source, the human's
review state on a source, the clustering of sources into an incident, and the inclusion of
an incident in the issue.

## 2. Representative schemas

Column names are reproduced exactly, including capitalization and spaces.

**Master RSS export**

| Column         | Notes                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| `ch`           | Current working state. Not a stable label, not an incident label. See section 3. |
| `Date Posted`  | UTC timestamp in the inspected export. Raw value must be preserved.              |
| `Date Updated` | UTC timestamp in the inspected export. Raw value must be preserved.              |
| `Title`        | Publisher-supplied.                                                              |
| `Author`       | May be absent.                                                                   |
| `Description`  | May contain HTML, entities, links and long bodies. May be absent.                |
| `Summary`      | May contain HTML, entities, links and long bodies. May be absent.                |
| `URL`          | Original URL. Exact duplicates exist.                                            |
| `Category`     | Publisher-supplied, inconsistent. May be absent.                                 |

**Weekly snapshot sheet (CS79, CS86 and similar)**

| Column         | Notes                                                                       |
| -------------- | --------------------------------------------------------------------------- |
| `ch`           | Stable candidate label for that week, not an incident label. See section 3. |
| `Date Posted`  | As above.                                                                   |
| `Date Updated` | As above.                                                                   |
| `Title`        | As above.                                                                   |
| `Summary`      | As above.                                                                   |
| `URL`          | As above.                                                                   |
| `Category`     | As above.                                                                   |

Some exports include unnamed blank columns. The importer must ignore them safely, by name
rather than by position, and must not fail on their presence or absence. Section 14 records
the required and recognized header names the Sprint 2 importer enforces.

**Representative files inspected outside the repository**

| File                           | Records | Window                           | `TRUE` | `FALSE`    |
| ------------------------------ | ------- | -------------------------------- | ------ | ---------- |
| Living RSS ledger export       | 23,910  | 1 March 2025 to 4 September 2026 | 133    | not stated |
| CS79 weekly candidate cut-down | 157     | 21 to 27 June 2026               | 130    | 27         |
| CS86 weekly candidate cut-down | 181     | 9 to 15 August 2026              | 161    | 20         |

The two weekly rows are candidate cut-downs drawn from the same ledger, not independent weekly
master feeds, and their `TRUE` counts are candidate decisions rather than published
incidents.

These counts describe the inspected exports only. They are not permanent contractual values
and no code may depend on them.

## 3. Ledger working state versus weekly review labels

The same column name, `ch`, carries two different meanings.

**In a weekly candidate cut-down**, `ch` is a preserved label for that week's candidate
review:

- `TRUE` means the project owner kept the source as a possible cyberattack incident or a
  story of interest for that week.
- `FALSE` means the project owner set the source aside during that week's review.
- A kept source is a candidate, not a confirmed incident, and not an incident label.
- A kept source is not necessarily a unique incident. Several may describe the same one.
- A kept source is not guaranteed to appear in the published report at all: the owner's final
  selection, ordering and editing happen after the candidate draft is produced.

**In the living ledger export**, `ch` is the current working state of an ongoing review:

- In the inspected master export, all 133 `TRUE` records fall between 30 August and
  4 September 2026, the window under review at export time.
- Older sources that were `TRUE` in CS79 and CS86 appear as `FALSE` in the current ledger
  export, because the working state was reset once those weeks were published.
- Therefore a historical `FALSE` in the ledger export must never be treated as a negative
  classification label. It means only "not currently under review".

Stable candidate labels may come only from preserved weekly cut-downs or from another
explicitly versioned review record. Neither `ch` value, in either file, is an incident label,
and neither is Publisher Category, which is the publisher's own taxonomy. The authoritative
record of what became an incident is the published Substack report, which this project does
not yet hold in machine-readable form.

The system represents **human** review state as an explicit enum, `ReviewState`, defined in
`@cas/contracts`:

| Value        | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `selected`   | Retained in a versioned weekly review record.                |
| `rejected`   | Rejected in a versioned weekly review record.                |
| `unreviewed` | No versioned review record covers this source for this week. |

A context-free boolean is not an acceptable representation. Every review state must be
attached to the identity of the review record it came from (for example the snapshot's week
identifier) so that the state can be traced to its source. A snapshot's `TRUE` and `FALSE`
map to `selected` and `rejected` only inside a calibration or evaluation set; the master
export's `ch` never maps to a review state.

The **machine** decision of the automated classifier is a separate enum,
`ClassificationDecision`, also in `@cas/contracts`:

| Value     | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `include` | The classifier routes the source into incident clustering.               |
| `exclude` | The classifier drops the source from clustering; the record is retained. |
| `review`  | The classifier cannot decide; the source enters the needs-review queue.  |

A classification decision is never a review state and never implies one. Both are stored on
the record, each with its own provenance, and both are displayed separately. Contract tests
in `packages/contracts` prove the two enums share no value and are distinct types.

## 4. Classification, source selection, incident clustering and final publication

Four distinct judgments, each with its own record:

| Judgment                 | Unit              | Made by                                 | Record                                      |
| ------------------------ | ----------------- | --------------------------------------- | ------------------------------------------- |
| Automated classification | one source record | pipeline, `@cas/classification`         | `ClassificationDecision` with its rationale |
| Candidate selection      | one source record | project owner, weekly cut-down or queue | `ReviewState` in a versioned review record  |
| Incident clustering      | many sources      | pipeline, with editorial review         | canonical incident with members             |
| Final editorial outcome  | one incident      | project owner, before publishing        | published Substack report                   |

An included source may be clustered into an incident that is never published. An incident may
be published from sources some of which were individually unremarkable. A source the
classifier excluded may still be picked up by a human from the retained records. A source the
owner kept in a weekly candidate cut-down may be dropped during the final editorial pass.

Evaluation must therefore measure each judgment against its own record and never against a
different stage's: classification retention against the weekly candidate decisions, clustering
against the published grouping, and final inclusion against the published Substack report.
A retention figure computed against a candidate cut-down is evidence about a candidate filter.
It is not end-to-end editorial accuracy, not publication recall and not validated incident
truth, and it must never be reported as any of those.

## 5. Nullable and untrusted fields

- `Author`, `Category`, `Summary`, `Description` and other fields may be absent. Absence is a
  valid state and must be represented as such, not as an empty string that is later mistaken
  for content.
- `Category` is publisher-supplied, inconsistent across publishers and unsuitable as an
  authoritative taxonomy label. It may be stored as provenance. It may not seed
  `data/taxonomy` or drive classification on its own.
- Every text field is untrusted evidence. It can never be interpreted as an instruction by
  any component, prompt, agent or operator (`SECURITY.md` section 1).

## 6. HTML and embedded newlines

- CSV records contain embedded newlines inside quoted fields. The importer must use a
  standards-compliant CSV parser (RFC 4180 quoting rules) and must never process the file
  line by line.
- `Summary` and `Description` may contain HTML markup, HTML entities, links and long bodies.
  Some summaries exceed 48,000 characters. The importer must preserve the raw field, and any
  derived plain-text form must be stored separately and labelled as derived.
- No size assumption may be baked into a column type or a prompt without an explicit,
  tested truncation rule that records that truncation occurred.

## 7. URL canonicalization and duplicates

- The master export contains exact duplicate URLs. Duplicates must be detected and linked,
  not silently dropped, because each duplicate row may carry different timestamps or review
  state.
- URL canonicalization (scheme and host normalization, tracking-parameter removal and
  similar) may be applied to derive a matching key. The original URL must always be
  preserved unchanged alongside any canonical form.

## 8. Timestamps

`Date Posted` and `Date Updated` are UTC timestamps in the inspected exports. Their raw
string values must be preserved as received. A parsed UTC instant may be stored alongside.
The editorial week boundary (decision D10) is applied at query time, never by rewriting the
stored values.

## 9. Raw files are excluded from Git

The original exports and snapshot sheets include third-party text and must not be committed.
`.gitignore` excludes `*.csv`, `*.xlsx` and `*.xlsm` outside `data/fixtures`, and excludes
`data/raw` and `data/private` entirely. A pull request that adds any real export row is a
defect regardless of size.

## 10. Permitted use of local files

The project owner's local copies of the exports and snapshots may be used on the project
owner's machine for development, calibration and evaluation, under these conditions:

- They stay outside the repository tree or inside an ignored directory such as `data/raw`.
- Nothing derived from them is committed unless it is a count, a score, a hash or a
  provenance record approved for inclusion.
- Evaluation output that quotes source text is not committed.

## 11. Synthetic fixture requirements

Sprint 2 added `data/fixtures/editorial/` (described in `data/fixtures/README.md`), which
meets every requirement below. Fixtures under `data/fixtures` must:

- be synthetic, containing no real title, summary, description, URL body or row;
- reproduce the representative schemas above, including at least one unnamed blank column,
  embedded newlines inside quoted fields, HTML and entities in text fields, absent optional
  fields, exact duplicate URLs and at least one very long summary;
- carry the `fixture` data origin from `@cas/contracts`;
- retain the full provenance field set the pipeline preserves for real records, so that
  provenance handling is exercised by tests.

## 12. Provenance retention through transformation

Every transformation, from import through canonicalization, classification, clustering,
evidence-state assignment and drafting, must retain a link back to the originating source
records: the file or snapshot identifier, the row identity, the original URL, the raw
timestamps, the classification decision with its rationale, and the review record that
supplied any review state. A derived record that cannot
be traced to its sources is a provenance failure and must be reported as an explicit error
(`SECURITY.md` section 7), never as a successful result.

## 13. Decisions that govern this document

- **D7a** Input format: standards-compliant CSV exports from the existing Excel RSS workflow
  are the hackathon baseline. Provisionally decided; confirmed accepted by D20.
- **D7b** Transport: manual upload, watched local export or direct authenticated workbook
  access. Superseded by D20: manual, on-demand import through a command-line interface.
- **D15** Classification before selection: the runtime flow in section 1. Accepted.
- **D16** Gate-aligned implementation sequence: import and normalization are Sprint 2,
  classification and the review queue Sprint 3. Accepted.
- **D20** Sprint 2 inputs: CSV baseline, manual on-demand CLI import, explicit `DataOrigin`
  with no default, and the failure and preservation rules enforced in section 14. Accepted.
- **D21** Sprint 3 classification: a deterministic, versioned rule-based high-recall
  classifier; CS79 and CS86 are calibration datasets, never a filter and never holdouts;
  historical selections never enter the classifier. Accepted; section 15 records what the
  classifier may read.

A file-based CSV import is the required reliable baseline. Direct Excel or cloud-workbook
synchronization must not become a prerequisite for the Graph release candidate.

## 14. Sprint 2 importer: rules as enforced

Implemented in `@cas/worker` and `@cas/database` (`ARCHITECTURE.md` section 10) and proven on
the synthetic fixtures and the three real exports (`SPRINT-2-REPORT.md`).

**Headers.** Fields are recognized by exact header name after Unicode NFC normalization and
trimming, never by position. Known names: `ch`, `Date Posted`, `Date Updated`, `Title`,
`Author`, `Description`, `Summary`, `URL`, `Category`. Required: `ch`, `Date Posted`,
`Date Updated`, `Title`, `URL`. Blank headers are accepted at any position and their cells
are kept in the ordered raw cell list without ever being mapped to a field. Unknown non-blank
headers are kept in the raw named fields and reported only as a count. A duplicated non-blank
header or a missing required header rejects the file.

**Whole-file rejection, before any write:** invalid UTF-8; a NUL character (PostgreSQL text
cannot hold it); a quoting fault; an inconsistent column count; no header; a duplicated
non-blank header; a missing required header. The parser's own message is never surfaced,
only its error code and line number.

**Row issues** (stable codes; `error` quarantines the row, `warning` leaves it accepted):

| Code                     | Field                       | Severity | Meaning                                                               |
| ------------------------ | --------------------------- | -------- | --------------------------------------------------------------------- |
| `title_missing`          | Title                       | error    | empty or whitespace-only title                                        |
| `url_missing`            | URL                         | error    | empty URL                                                             |
| `url_invalid`            | URL                         | error    | URL cannot be parsed                                                  |
| `url_scheme_not_allowed` | URL                         | error    | scheme is not `http` or `https`                                       |
| `timestamp_missing`      | Date Posted or Date Updated | error    | empty timestamp                                                       |
| `timestamp_invalid`      | Date Posted or Date Updated | error    | not a strict timezone-aware ISO 8601 value (naive values are invalid) |
| `review_value_unknown`   | ch                          | error    | weekly `ch` is not `TRUE`, `FALSE` or blank; no review state written  |
| `ch_token_unrecognized`  | ch                          | warning  | master `ch` is not `TRUE`, `FALSE` or blank; stored as working state  |

A quarantined row keeps every raw cell, its issues, and, for a weekly file with a recognized
token, its review entry. Issue messages are fixed strings and never carry source content.

**Storage.** Every cell is stored exactly as read (`raw_cells`), every named column exactly
as read (`raw_fields`), and the known columns again in dedicated raw columns. Parsed UTC
instants, the normalized title, the derived plain text of `Summary` and `Description` (with
the transformation label `html-to-text@1`) and the canonical URL are separate columns.
Derived empties are `null`; raw empties stay empty strings. Nothing is truncated: the real
master export's 48,329-character field is stored whole. Each row carries a deterministic
SHA-256 of its exact cells.

**Duplicates.** Every row is stored; rows whose canonical URL is equal reference the same
`url_groups` record. Canonicalization (matching key only, the original URL untouched):
lowercase scheme and host, default port, fragment and userinfo removed, tracking parameters
removed (`utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `mc_cid`,
`mc_eid`, `igshid`, `yclid`, `ttclid`, `twclid`, `li_fat_id`, `_hsenc`, `_hsmi`, `mkt_tok`,
`oly_anon_id`, `oly_enc_id`, `vero_id`, `s_kwcid`), remaining parameters sorted by name then
value, path and trailing slash preserved. No URL is ever fetched.

**Review state.** Weekly imports create one `review_snapshots` row carrying the label given
on the command line and one `review_entries` row per source row with a recognized token:
`TRUE` selected, `FALSE` rejected, blank unreviewed. Master imports never create a snapshot;
the master `ch` value is stored raw only. Nothing applies a week boundary (D10).

**Batches and idempotency.** A batch stores the explicit origin, the source kind, the weekly
label, the file's basename only, its SHA-256 and byte length, the ordered header cells, the
importer version, status, parsed, accepted and quarantined counts, start and completion
times, and an idempotency key over the file hash, source kind, origin, label, importer
version and text-transform version. Repeating an import with the same key identifies the
original batch and writes nothing; a different origin or label is a different batch. A batch
is written in one transaction and rolled back entirely on any failure or interrupt, so the
only stored statuses are `completed` and `completed_with_issues`.

## 15. What the clustering engine may read (Sprint 4)

The clustering engine reads only what it needs to associate and compare eligible classified
sources: the source-row identifier and hash, the classification result and run identifiers,
the batch identifier and origin, the classification decision, the canonical URL-group
identifier, the posted timestamp and the three derived text fields. It is a closed allowlist,
so nothing else is admitted under any name.

It may never read a human `ReviewState`, a weekly spreadsheet label, a publication status,
Publisher Category, the ledger's `ch` value, a raw cell or field, a batch label, an inferred
editorial week or any connection value. None of those is an incident label, and the engine's
output is a provisional grouping rather than a claim about what was published.

## 16. What the classifier may read (Sprint 3)

Decision D21 fixes the classifier's input boundary, and `@cas/classification` enforces it in
the type system and again at runtime.

**Permitted:** the source-row identifier, the row hash, the ingestion status (`accepted` or
`quarantined`), the normalized title, the derived summary text and the derived description
text. Nothing else is loaded from the database for classification.

**Prohibited, and refused by name:** the human `ReviewState`; the weekly `TRUE` and `FALSE`
selections and the snapshot they came from; the master feed's `ch` working state; the
publisher-supplied `Category`, which section 5 already forbids as a classification input; the
original and canonical URL; raw cells and raw named fields; the batch's review label; and any
connection value.

The consequence is the property section 3 requires: a historical selection cannot influence a
machine decision. Classification runs first over an explicit batch; calibration is a separate
step that joins completed results to a weekly snapshot afterwards and returns counts only. A
regression test proves that removing, replacing or flipping every label leaves every decision
byte-identical, and a database test proves two batches with identical text under opposite
labels produce identical decisions.

Machine decisions live in their own tables. Nothing in the classification path writes to
`review_snapshots` or `review_entries`, and the needs-review queue is derived from a
classification run rather than copied into the human review records.

## 17. What the evidence layer may read (Sprint 5)

The correlator's input carries the incident, clustering-run and batch identifiers, an
explicitly recorded chain, an explicitly recorded protocol slug, the earliest reported instant
and the claim identifiers. **It carries no text field of any kind** — no title, no summary, no
description, no body — so no headline can produce a link no matter what words it contains.

An incident's chain and protocol identity is recorded by a named person through
`evidence subject`. Nothing extracts it from text, and an incident whose subject nobody
recorded never correlates. That is the intended behaviour, not a gap: a rule that read a
headline for a protocol name would be the mechanism by which a report quietly becomes a
confirmed on-chain fact.

The recorded slug must be the provider-returned identity the Sprint 1 gate validated, and it is
compared with a stored signal by equality. A near miss is a refusal, never a fuzzy match.

The evidence layer may never read a human `ReviewState`, a weekly spreadsheet label, a
publication status, Publisher Category, the ledger's `ch` value, a raw cell or field, a batch
label, an inferred editorial week or any connection value.

## 18. Graph signal snapshots (Sprint 5)

A snapshot is a set of normalized TVL-delta observations for the seven identities decision D23
retained. It is untrusted input like any editorial file, and it is validated against a closed
set of fields before a single row is written.

| Field                                                         | Rule                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `gatewayHost`                                                 | a bare hostname; no scheme, userinfo, path or query      |
| `querySha256`                                                 | 64 lower-case hexadecimal characters                     |
| `chain`                                                       | `ethereum` or `base`                                     |
| `protocolSlug`                                                | lower-case provider slug                                 |
| `subgraphDeploymentId`                                        | alphanumeric, or absent                                  |
| `blockNumber`                                                 | a non-negative integer, or absent                        |
| `blockHash`                                                   | `0x` and 64 lower-case hexadecimal characters, or absent |
| `observedAt`, `baselineObservedAt`                            | parseable instants                                       |
| `currentTvlUsd`, `baselineTvlUsd`, `deltaUsd`, `deltaPercent` | plain decimals; no exponent, no `NaN`, no `Infinity`     |

An unknown key at either level is refused, and a snapshot naming one target twice is refused.
The host and digest patterns admit no credential, and there is no column anywhere for a
provider payload, an Authorization header or an API key.

The data origin is a required argument with no default and no inference. It is stored on the
signal run and on every signal, printed on every anomaly line, and it scopes the history query,
so a replayed series can never enter a live target's baseline and a fixture demonstration can
never present itself as a live observation.
