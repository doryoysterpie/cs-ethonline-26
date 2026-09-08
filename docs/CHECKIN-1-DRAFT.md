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

## Progress so far

**Sprint 1, live Graph proof. Audited.** One common GraphQL query over the Messari
standardized schema returns live provider-backed data for five Ethereum lending deployments
and two on Base, each validated against the provider's own returned identity, with complete
request and response provenance and a deterministic 24-hour TVL-delta signal.

**Sprint 2, editorial data foundation. Audited.** A local PostgreSQL schema with forward-only
checksummed migrations and a manual CSV import. The three real exports imported as `replay`
data: 24,248 logical rows stored, every row retained, invalid rows quarantined with stable
issue codes rather than dropped, weekly review state kept in its own tables, duplicate URLs
kept as separate rows, and a repeated import writing nothing. Relational constraints make a
provenance contradiction impossible.

**Sprint 3, classification and the needs-review queue. Corrected twice, pending verification.** A deterministic, versioned, rule-based high-recall classifier assigns every
imported row a machine decision with stable rationale codes. All 24,248 rows are classified,
one result per row, reconciled against the batch. The needs-review queue is derived per run.
Two independent audits have returned findings: five on the first candidate, of which two were
later confirmed closed, and four on the second. The corrections cover database schema binding,
an immutable classified source set, an executable behaviour contract, the input boundary and
command output. Decisions are unchanged across every generation. The sprint is not accepted
until the auditor issues a pass, and this draft has not been submitted.

## Numbers, as measured

| Measure                                 | Value                                     |
| --------------------------------------- | ----------------------------------------- |
| Source rows imported and classified     | 24,248 across three batches               |
| Machine decisions                       | include 13,015, exclude 55, review 11,178 |
| Needs-review queue                      | 11,178 rows                               |
| Selected-retention recall, CS79         | 0.992307 against a 0.98 target            |
| Selected-retention recall, CS86         | 1.0 against a 0.98 target                 |
| Automated tests, no database or network | 299                                       |
| PostgreSQL integration tests            | 52                                        |

## What is deliberately not built yet

No model is called. Decision D9, which fixes the model, its settings and its spending cap, is
unresolved, so Sprint 3 shipped the rule-based high-recall pass the sprint board names as the
fallback. The historical weekly selections are calibration data only: they never reach the
classifier, and a regression test proves that removing, replacing or flipping them leaves
every decision unchanged. Clustering, the drafting pipeline, the dashboard and the MCP server
follow in Sprints 4 to 6, before the Graph release gate at the end of 10 September.

## Human action required

Submit this check-in through the ETHGlobal platform before 7 September 2026, 11:59 PM
America/Toronto. Nothing in this repository submits anything.
