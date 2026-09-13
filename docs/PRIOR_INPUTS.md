# Prior inputs

This document records what existed before ETHOnline 2026 began, what role it plays, and what
may and may not enter the repository. It exists so that the Start Fresh requirement can be
audited: all project code begins on or after 4 September 2026, and the material described
here is input data, not code.

## The corpus

The project owner reports an 88-week corpus of Cyberattack Sunday material produced through
the editorial workflow described in `DATA_INPUTS.md`. Its complete local inventory has not
yet been verified by the implementer. This document therefore describes the corpus as
user-reported pre-existing material. It does not assert file names, per-week counts or storage
locations beyond what was supplied, and it does not claim that any single file contains
88 weeks of stable manual labels.

Three kinds of artefact are known to exist:

1. **The master RSS export.** A longstanding Excel-based aggregation of incoming cyber and
   adjacent technology stories. The representative export inspected outside the repository
   holds 23,910 logical records from 1 March 2025 through 4 September 2026. Its `ch` column is
   current working state, not a stable historical label (`DATA_INPUTS.md`).
2. **Weekly snapshot sheets.** Manually curated sheets that preserve the project owner's
   source-level selection for one weekly window. Two representative snapshots were inspected:
   CS79 (157 source records, 21 to 27 June 2026, 130 `TRUE` and 27 `FALSE`) and CS86
   (181 source records, 9 to 15 August 2026, 161 `TRUE` and 20 `FALSE`). These counts
   describe the inspected exports only and are not contractual values.
3. **Published Substack issues.** The final editorial outputs. They may later support
   evaluation of grouping, inclusion and format, since they record which sources were merged
   into which stories and how the issue was structured.

## Intended uses

- Three past editions may later be used to derive structural and voice rules for the draft
  generator. Which three, and how, is a later decision.
- Weeks 61 to 74 are proposed for development and calibration.
- Weeks 75 to 88 are proposed as the untouched holdout.

The split is a proposal. It becomes a plan only once the corresponding weekly snapshots, or
equivalent explicitly versioned labelled artefacts, are confirmed to exist for those weeks.
Without a preserved snapshot, a week has no stable selection labels, because the master
export's `ch` column cannot supply them.

Every use of the corpus is calibration or evaluation. The CS79 and CS86 selections, and any
other confirmed weekly snapshot, are labels against which the automated classifier and the
clustering are measured. They are never a production filter, a prerequisite for processing a
current feed, or an input the runtime pipeline waits on (decision D15).

## Disclosure to the event

ETHGlobal's rules, read on 4 September 2026, state that "in all cases, you must disclose any
pre-existing work in writing to the ETHGlobal team and include full details in your
submission (repo history, video, and description)." The corpus is pre-existing input data,
not project code, and this document is the written basis for that disclosure. The submission
must state it explicitly (`HACKATHON_REQUIREMENTS.md`, row E4).

## What may not enter the repository

- The master export, in any format.
- Any weekly snapshot sheet.
- Any complete third-party article text, summary, description or body.
- Any complete publication text.
- Private editorial notes.

None of the supplied CSVs and no complete publication text is added to the repository, in
Sprint 0 or later. `.gitignore` excludes `*.csv`, `*.xlsx` and `*.xlsm` everywhere except
`data/fixtures`, and excludes `data/raw` and `data/private` outright.

## What may enter the repository

- Synthetic fixtures that imitate the export schemas without copying any real row
  (`data/fixtures/README.md`).
- Normalized provenance records: URLs, publisher names, timestamps and hashes of retrieved
  content, where the project owner has approved their inclusion.
- Evaluation results that report counts and scores without reproducing source text.

## Sprint 0 statement

Sprint 0 adds no pre-event project code to the submission. The repository's first commit
was created on 4 September 2026 at 20:33 America/Toronto and contains only a one-line
README. Every later file was written during the event.
