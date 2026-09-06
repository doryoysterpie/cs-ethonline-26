# Data inputs

This document describes the editorial data the project consumes, its shape, its trust level
and the rules the importer obeys. Sections 1 to 13 record the requirements as written in
Sprint 0; section 14 records how the Sprint 2 importer enforces them (decision D20 in
`DECISIONS.md`).

## 1. The present manual workflow and the target runtime flow

**The present manual workflow**, as stated by the project owner, is background for
understanding the data and the labels. It is not the runtime design.

1. A longstanding Excel-based RSS aggregation collects the broad universe of incoming cyber
   and adjacent technology stories. This is the **master feed**.
2. The project owner manually reviews one weekly window and marks each story for retention or
   rejection. This is **weekly manual selection**.
3. A weekly sheet, such as CS79 or CS86, preserves that source-level selection. Claude then
   reformats the selected material and consolidates duplicate reporting. This is **incident
   clustering and editorial transformation**.
4. The project owner turns that output into the published weekly post. This is the
   **published issue**.

```
master feed → weekly manual selection → incident clustering and editorial transformation → published issue
```

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

The historical CS79 and CS86 selections are calibration and evaluation labels for steps 3
to 6. They are never a production filter or a prerequisite for processing a current feed.
Live Graph signals run in parallel to this flow and attach corroborating evidence to canonical
incidents; they do not replace editorial ingestion (`ARCHITECTURE.md` section 3).

Four judgments remain distinct records and must not be collapsed into a single binary
classification problem: the machine's classification decision on a source, the human's
review state on a source, the clustering of sources into an incident, and the inclusion of
an incident in the issue.

## 2. Representative schemas

Column names are reproduced exactly, including capitalization and spaces.

**Master RSS export**

| Column         | Notes                                                               |
| -------------- | ------------------------------------------------------------------- |
| `ch`           | Current working state. Not a stable label. See section 3.           |
| `Date Posted`  | UTC timestamp in the inspected export. Raw value must be preserved. |
| `Date Updated` | UTC timestamp in the inspected export. Raw value must be preserved. |
| `Title`        | Publisher-supplied.                                                 |
| `Author`       | May be absent.                                                      |
| `Description`  | May contain HTML, entities, links and long bodies. May be absent.   |
| `Summary`      | May contain HTML, entities, links and long bodies. May be absent.   |
| `URL`          | Original URL. Exact duplicates exist.                               |
| `Category`     | Publisher-supplied, inconsistent. May be absent.                    |

**Weekly snapshot sheet (CS79, CS86 and similar)**

| Column         | Notes                                                |
| -------------- | ---------------------------------------------------- |
| `ch`           | Stable selection label for that week. See section 3. |
| `Date Posted`  | As above.                                            |
| `Date Updated` | As above.                                            |
| `Title`        | As above.                                            |
| `Summary`      | As above.                                            |
| `URL`          | As above.                                            |
| `Category`     | As above.                                            |

Some exports include unnamed blank columns. The importer must ignore them safely, by name
rather than by position, and must not fail on their presence or absence. Section 14 records
the required and recognized header names the Sprint 2 importer enforces.

**Representative files inspected outside the repository**

| File              | Records | Window                           | `TRUE` | `FALSE`    |
| ----------------- | ------- | -------------------------------- | ------ | ---------- |
| Master RSS export | 23,910  | 1 March 2025 to 4 September 2026 | 133    | not stated |
| CS79              | 157     | 21 to 27 June 2026               | 130    | 27         |
| CS86              | 181     | 9 to 15 August 2026              | 161    | 20         |

These counts describe the inspected exports only. They are not permanent contractual values
and no code may depend on them.

## 3. Master-feed state versus weekly snapshot labels

The same column name, `ch`, carries two different meanings.

**In a weekly snapshot sheet**, `ch` is a preserved label for that week's review:

- `TRUE` means the project owner retained the source as a story of interest or potential
  Cyberattack Sunday material.
- `FALSE` means the project owner rejected the source during that week's review.
- A retained source is not necessarily a unique incident. Several retained sources may
  describe the same underlying incident.
- A retained source is not guaranteed to appear separately in the final publication.

**In the master RSS export**, `ch` is the current working state of an ongoing review:

- In the inspected master export, all 133 `TRUE` records fall between 30 August and
  4 September 2026, the window under review at export time.
- Older sources that were `TRUE` in CS79 and CS86 appear as `FALSE` in the current master
  export, because the working state was reset once those weeks were published.
- Therefore a historical `FALSE` in the master export must never be treated as a negative
  classification label. It means only "not currently under review".

Stable selection labels may come only from preserved weekly snapshots or from another
explicitly versioned review record.

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

| Judgment                 | Unit              | Made by                               | Record                                      |
| ------------------------ | ----------------- | ------------------------------------- | ------------------------------------------- |
| Automated classification | one source record | pipeline, `@cas/classification`       | `ClassificationDecision` with its rationale |
| Source selection         | one source record | project owner, weekly review or queue | `ReviewState` in a versioned review record  |
| Incident clustering      | many sources      | pipeline, with editorial review       | canonical incident with members             |
| Final publication        | one incident      | project owner, at publication         | published issue                             |

An included source may be clustered into an incident that is not published. An incident may
be published from sources some of which were individually unremarkable. A source the
classifier excluded may still be selected by a human from the retained records. Evaluation
of the pipeline must measure each judgment against its own record, never against a different
stage's record: classification recall against snapshot selections, clustering against the
published grouping, inclusion against the published issue.

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
