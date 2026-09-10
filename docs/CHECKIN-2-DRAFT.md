# Project Check-in #2 draft

**Status: draft, not submitted.** Submission is a human action on the ETHGlobal platform.
Due **Thursday 10 September 2026**; the cutoff time is **unconfirmed** and must be read from
the portal rather than assumed. This draft was prepared on 8 September 2026 and updated on
10 September 2026. It describes only work that is complete and verified in the repository.

Check-in #1 was submitted and confirmed by the project owner on 8 September 2026.

Project: **Cyberattack Sunday: Onchain Incident Intelligence** (working name CAS Chainwatch).
Repository: `https://github.com/doryoysterpie/cs-ethonline-26`, public, Apache-2.0.

## What the project does

It imports the editorial cybersecurity news feed, classifies every source automatically with
high recall into include, exclude or needs-review, groups the surviving sources into
provisional incidents, and reads live onchain data from The Graph in parallel to attach
corroborating signals. A human reviews a queue instead of the whole feed, and the output is an
editable draft of the weekly issue.

## The editorial workflow being automated

```
living RSS ledger → weekly candidate cut-down → reformatted and deduplicated candidate draft
   → owner's final editorial decisions → published Substack report
```

1. Make continuously aggregates many websites into a living RSS feed, maintained and exported
   through Excel. One continuously growing ledger, not a series of weekly datasets.
2. The owner reviews that living feed and cuts it down to the possible cyberattack incidents
   and other stories of interest for one editorial week. That cut-down is a candidate list.
3. Claude reformats the weekly export and deduplicates the candidate stories.
4. The owner then performs further editorial selection, ordering and editing.
5. The report is published on Substack. That published report is the closest available record
   of the final editorial outcome.

The project automates steps 1 to 3 and hands the owner a shorter, better-ordered queue. It
does not decide step 4.

## Progress since Check-in #1

**Sprint 3, classification and the needs-review queue. Passed independent audit.** Codex
Desktop audited the branch independently and issued a pass at
`71394c9b8e732bc7508b6276eafcbbac414c3a07`, after two audit rounds and two correction passes
covering database schema binding, an immutable classified source set, and a classifier whose
stored ruleset hash covers the behaviour it actually executes. A deterministic, versioned,
rule-based classifier assigns every imported row a machine decision with stable rationale
codes: all 24,248 rows classified, one result per row, each run reconciled against its batch.

**Sprint 4, clustering and canonical incident construction. Passed independent audit.** A
deterministic, model-free engine consolidates exact URL duplicates, detects syndication and
groups separate reports into provisional incidents, driven by a versioned executable contract.
Across the three classification runs, 24,193 eligible results became 23,596 provisional
incidents, every eligible result covered exactly once, no excluded result covered at all, and
every run reconciled. A human can merge and split incidents through an append-only review
layer that never rewrites what the machine produced.

Codex Desktop audited it on 9 September and returned seven findings, with an eighth on
re-audit: a cluster bound that did not hold over a whole component, a membership that could
name another classification run of the same batch, review idempotency that accepted a changed
payload, notes validated only at the command line, a default test that opened a socket, a
contradictory check-in status, an inaccurate complexity claim and a stale test count. All eight
were corrected and the auditor accepted the result at
`4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`.

**Sprint 5, Graph evidence, anomaly feed and drafting. Implementation finished, not audited.**
It carries the Graph-correlation, evidence-state and anomaly-feed work D22 deferred from
Sprint 4, and adds the deterministic drafting pipeline (decision D25, migration 0008).

An incident correlates with a Graph signal only on a chain and protocol identity a person
recorded, inside a declared window, at a movement of at least five percent. **Nothing reads
text anywhere in that path**: the correlator's input has no title, summary or body field, so no
headline can produce a link whatever words it contains. A machine suggestion is not evidence
either: it stays a suggestion until a named person accepts it, and the database refuses a
corroboration that rests on nothing. Absence of a signal never counts against a claim — every
incident with no accepted evidence resolves to `reported_only`, and no rule anywhere has "no
signal found" as its condition.

The anomaly feed the 10 September gate requires produces both halves on real data: chain
movements against a rolling baseline, and reporting-volume movements against explicitly bounded
prior windows. Too little history, a gap in a series and a reading past the freshness limit are
each reported as themselves and none of them is ever a spike, because a spike is a statement
about data that exists. Every entry carries its data origin and a fixed sentence saying what it
does not establish.

The drafter is deterministic and calls no model. Two drafts were generated from real imported
weeks, each marked unpublished and requiring human review, each with a machine-readable
provenance record beside every claim, and neither committed. Because nothing extracts a victim
name, every claim is marked as reported and every name is withheld.

**Sprint 5 has not been audited.** Codex Desktop audits this project independently, and no
result has been issued for Sprint 5.

**Graph scope decision, being recorded now.** Seven protocol identities are proven live on the
standardized TVL lane, and that lane is the project's live Graph capability. The separately
planned ten-protocol _administrative-event_ watchlist is not delivered: the live query reads
protocol identity, total value locked and daily financial snapshots, and reads no
administrative event. Rather than present one capability as the other, the project owner has
removed that watchlist from hackathon scope by an explicit deviation and moved it to the
post-event roadmap, to protect the 10 September Graph release gate.

## Numbers, as measured

| Measure                                 | Value                                     |
| --------------------------------------- | ----------------------------------------- |
| Source rows imported and classified     | 24,248 across three batches               |
| Machine decisions                       | include 13,015, exclude 55, review 11,178 |
| Eligible results clustered              | 24,193                                    |
| Provisional incidents                   | 23,596                                    |
| Live Graph protocol identities proven   | 7                                         |
| Evidence states resolved on real data   | 23,596, all `reported_only`               |
| Automated tests, no database or network | 482                                       |
| PostgreSQL integration tests            | 173                                       |

**What the evidence counts are and are not.** Every real incident resolves to
`reported_only`, and zero associations were suggested, because no real incident has a recorded
chain and protocol subject and nothing in the system extracts one from text. That is the
correct output of the input available, not a shortfall: a pipeline that produced links here
would be producing them from headlines, which is precisely what this design refuses to do. The
correlation, review and resolution path is proven end to end against synthetic data in
PostgreSQL, and this draft claims no real-data demonstration of it.

**What the clustering counts are and are not.** They are structural: the pipeline covered its
input exactly and grouped it into that many provisional incidents. They do not establish
clustering accuracy or agreement with any published issue, because the project holds no
machine-readable record of the final editorial outcome yet. Establishing that needs weekly
Excel cut-downs paired with their published Substack reports through an explicit reviewed
mapping, with a group of paired weeks held back untouched as a holdout. That work has not been
scheduled and no such comparison is claimed.

## What is deliberately not built yet

No model is called: decision D9, which fixes the model, its settings and its spending cap, is
unresolved, so the classifier and the clustering engine are both deterministic. Decision D10,
which fixes the automated editorial week boundary and publication cutoff, is also unresolved,
so every operation names an explicit batch or run rather than inferring a week.

Decisions D3, which fixes where a draft is written, and D4, which fixes the naming policy, are
still provisional. Both are implemented as configurable policies at their conservative
settings, and neither is presented here as decided.

The dashboard and the MCP server have not begun. They follow, with the Graph release gate at
the end of 10 September.

## HUMAN ACTION REQUIRED

**The project owner must review this draft and submit it through the ETHGlobal portal on
Thursday 10 September 2026.** The cutoff time is unconfirmed here; check it in the portal.
Nothing in this repository submits anything, and no part of this draft should be read as
saying Check-in #2 has been submitted.
