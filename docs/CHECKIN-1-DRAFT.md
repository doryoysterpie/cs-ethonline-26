# Project Check-in #1 draft

**Status: draft, not submitted.** Submission is a human action on the ETHGlobal platform.
Deadline: **7 September 2026, 11:59 PM America/Toronto**. This draft was prepared on
7 September 2026 and describes only work that is complete and verified in the repository.

Project: **Cyberattack Sunday: Onchain Incident Intelligence** (working name CAS Chainwatch).
Repository: `https://github.com/doryoysterpie/cs-ethonline-26`, public, Apache-2.0.

## What the project does

It imports the editorial cybersecurity news feed, classifies every source automatically with
high recall into include, exclude or needs-review, and reads live onchain data from The Graph
in parallel to attach corroborating signals. A human reviews a queue instead of the whole
feed, and the output is an editable draft of the weekly issue.

## The editorial workflow this project automates

The existing workflow has five stages, and each produces a different kind of record:

```
living RSS ledger → weekly candidate cut-down → reformatted and deduplicated candidate draft
   → owner's final editorial decisions → published Substack report
```

1. Make continuously aggregates many websites into a living RSS feed, maintained and exported
   through Excel. This is one continuously growing ledger, not a series of weekly datasets.
2. The owner manually reviews that living feed and produces an Excel cut-down of possible
   cyberattack incidents and other stories of interest for one editorial week.
3. That weekly cut-down is a candidate list. It is not the final word on which stories become
   Cyberattack Sunday incidents.
4. Claude receives the weekly export, reformats it and deduplicates the candidate stories.
5. The owner then performs further editorial selection, ordering and editing before publishing
   the report on Substack. The published report is the closest available record of the final
   editorial outcome.

## Progress so far

**Sprint 1, live Graph proof. Audited.** One common GraphQL query over the Messari
standardized schema returns live provider-backed data for five Ethereum lending deployments
and two on Base, each validated against the provider's own returned identity, with complete
request and response provenance and a deterministic 24-hour TVL-delta signal.

**Sprint 2, editorial data foundation. Audited and operational.** A local PostgreSQL schema
with forward-only checksummed migrations and a manual CSV import. Three real exports imported
as `replay` data, one from the living ledger and two weekly candidate cut-downs: 24,248
logical rows stored, every row retained, invalid rows quarantined with stable issue codes
rather than dropped, human review state kept in its own tables, duplicate URLs kept as
separate rows, and a repeated import writing nothing. Relational constraints make a provenance
contradiction impossible.

**Sprint 3, classification and the needs-review queue. Implemented, under independent audit.**
A deterministic, versioned, rule-based high-recall classifier assigns every imported row a
machine decision with stable rationale codes. All 24,248 rows are classified, one result per
row, each run reconciled against its batch, and the needs-review queue is derived per run.

Sprint 3 has **not** passed audit. Codex Desktop is reviewing it independently and has
returned findings twice. The correction now on the branch closes database-integrity findings
(every integrity function bound to its own schema, a classified batch's source set made
immutable), a concurrency finding (a completed run can no longer be left uncovered by a
later change to its batch), and a classifier-versioning finding (the stored ruleset hash now
covers the behaviour the classifier actually executes). Machine decisions are unchanged across
every version. The sprint stays open until the auditor issues a pass.

## Numbers, as measured

| Measure                                 | Value                                     |
| --------------------------------------- | ----------------------------------------- |
| Source rows imported and classified     | 24,248 across three batches               |
| Machine decisions                       | include 13,015, exclude 55, review 11,178 |
| Needs-review queue                      | 11,178 rows                               |
| Candidate-retention, CS79               | 0.992307 against a 0.98 target            |
| Candidate-retention, CS86               | 1.0 against a 0.98 target                 |
| Automated tests, no database or network | 322                                       |
| PostgreSQL integration tests            | 100                                       |

**What the two retention figures mean, and what they do not.** CS79 and CS86 are weekly
candidate cut-downs, so those figures measure how much of the owner's _intermediate_ candidate
list the classifier keeps. They are technical calibration evidence for a high-recall filter.
They are not end-to-end editorial accuracy, not publication recall, and not validated incident
truth: a row kept in a weekly cut-down is a possible story, not a confirmed cyberattack
incident, and the final selection happens after that list is drafted.

## What is deliberately not built yet

No model is called. Decision D9, which fixes the model, its settings and its spending cap, is
unresolved, so Sprint 3 shipped the rule-based high-recall pass the sprint board names as the
fallback. The weekly candidate decisions are calibration data only: they never reach the
classifier, nothing is fitted or weighted from them, and a regression test proves that
removing, replacing or flipping them leaves every decision unchanged. Decision D10, which
fixes the automated week boundary and publication cutoff, is also unresolved.

Clustering, incident construction and the final drafting pipeline are the next work, with the
dashboard and the MCP server, before the Graph release gate at the end of 10 September.

Proper end-to-end evaluation needs a record this project does not yet hold. The plan is to
pair weekly Excel cut-downs with their corresponding published Substack reports and
reconstruct the final include, exclude and incident-grouping outcomes through an explicit,
reviewed mapping, keeping provenance from the living ledger through the candidate list to the
publication. A group of paired weeks will be reserved untouched for holdout evaluation before
the wider archive is opened to development. That split has not been made yet.

## HUMAN ACTION REQUIRED

**The project owner must paste this check-in into the ETHGlobal submission portal today,
before 7 September 2026, 11:59 PM America/Toronto.** Nothing in this repository submits
anything, and no part of this draft should be read as saying the check-in was submitted.
