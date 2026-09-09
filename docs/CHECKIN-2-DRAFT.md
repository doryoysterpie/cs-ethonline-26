# Project Check-in #2 draft

**Status: draft, not submitted.** Submission is a human action on the ETHGlobal platform.
Due **Thursday 10 September 2026**; the cutoff time is **unconfirmed** and must be read from
the portal rather than assumed. This draft was prepared on 8 September 2026 and describes only
work that is complete and verified in the repository.

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

**Sprint 4, clustering and canonical incident construction. Built, pending audit.** A
deterministic, model-free engine consolidates exact URL duplicates, detects syndication and
groups separate reports into provisional incidents, driven by a versioned executable contract.
Across the three classification runs, 24,193 eligible results became 23,596 provisional
incidents, every eligible result covered exactly once, no excluded result covered at all, and
every run reconciled. A human can merge and split incidents through an append-only review
layer that never rewrites what the machine produced. Sprint 4 has **not** been audited and is
not accepted; Codex Desktop reviews it next.

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
| Automated tests, no database or network | 363                                       |
| PostgreSQL integration tests            | 123                                       |

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

Sprint 5 has not begun. The drafting pipeline, the dashboard, the evidence-state resolver, the
anomaly feed and the MCP server follow, before the Graph release gate at the end of
10 September.

## HUMAN ACTION REQUIRED

**The project owner must review this draft and submit it through the ETHGlobal portal on
Thursday 10 September 2026.** The cutoff time is unconfirmed here; check it in the portal.
Nothing in this repository submits anything, and no part of this draft should be read as
saying Check-in #2 has been submitted.
