# Hackathon requirements

Requirement-to-evidence matrix for ETHOnline 2026. Sprint 0 state, corrected on 4 September
2026 during audit remediation and the final Sprint 0 correction.

## How to read this document

Two provenance markers say where a requirement comes from:

- `PLAN`: taken from the supplied project plan, the Sprint 0 charter, or a decision in
  `DECISIONS.md`.
- `EVENT`: taken from ETHGlobal event material. Pages read on 4 September 2026 (evening,
  America/Toronto) through an automated fetch that returns an extracted summary, not the raw
  page: the prizes page (`https://ethglobal.com/events/ethonline2026/prizes`), the rules
  page (`https://ethglobal.com/rules`) and the event information page
  (`https://ethglobal.com/events/ethonline2026/info/details`). The event schedule page
  (`https://ethglobal.com/events/ethonline2026`) returned HTTP 500 on two fetch attempts;
  its schedule was transcribed by the project owner from the official page and is recorded in
  decision D14. Quoted text is as extracted. The project owner should confirm each quotation
  against the live page before relying on it for a submission decision.

These are not equivalent. A `PLAN` requirement is what the project intends to satisfy; an
`EVENT` requirement is what the event states.

Two status columns, each using the charter's vocabulary:

- **Requirement verification:** `UNVERIFIED` or `VERIFIED FROM EVENT MATERIAL`.
- **Delivery:** `PLANNED`, `IMPLEMENTED` or `DEMONSTRATED`.

At Sprint 0 no technical requirement is `IMPLEMENTED` or `DEMONSTRATED`. The only
`IMPLEMENTED` rows are administrative facts about the repository itself, each with its
evidence. Row identifiers are stable and may have gaps where a row was withdrawn.

## Findings from earlier versions, and their state

1. **Submission deadline.** Resolved. The official schedule (D14) replaces the charter's
   14 and 16 September controls. Final submission is 13 September 2026 at 12:00 PM
   America/Toronto.
2. **Commit-history rule.** Clarified. The rules page states: "Any repositories with single
   commits of large files without proper history will be default assumed to be unqualified
   unless proven otherwise." Paraphrased: a repository consisting of a single large commit
   without proper development history may be presumed unqualified unless proven otherwise.
   This repository has a bootstrap commit, a foundation commit, a remediation commit and a
   final correction commit with dated history, and future sprint work adds auditable commits
   as it lands. No claim is made that the present history is disqualified, and no history is
   rewritten.
3. **Licence.** Resolved. Apache-2.0 (D12), canonical text at `LICENSE`.
4. **Pre-existing input data.** Open action for the submission. The rules page requires
   written disclosure of any pre-existing work "in all cases". The corpus is pre-existing
   input data, never committed, and `PRIOR_INPUTS.md` is the written basis. The submission
   must disclose it (row E4).
5. **Graph feedback assumption, withdrawn.** The first version carried an unverified
   assumption that The Graph required a feedback submission. It was investigated against the
   prizes page and withdrawn: no such requirement applies to the targeted Graph tracks. The
   two rows that carried it were removed from the matrices; their identifiers (A8, F4) are
   left as gaps.

## A. The Graph: Best AI Tooling or AI Use Case with The Graph (From Scratch), $5,000

| #   | Requirement                                                                                    | Source | Requirement verification     | Delivery                     | Planned evidence                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | "Use The Graph as a load-bearing part of the project" through Subgraphs, MCP, or Substreams    | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/graph-evidence` supplies live provider-backed signals that corroborate canonical incidents; query provenance logged (Sprints 1 and 4)   |
| A2  | "Consume live data from a Graph provider"; mocked or local datasets do not qualify             | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Sprint 1 proof gate (D11): live provider-backed results for at least five entities over one common query; `DataOrigin` `live` with provenance |
| A3  | Net-new work begun during the hackathon                                                        | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | First commit 4 Sept 2026 20:33 EDT, after hacking began at 12:00 PM; `PRIOR_INPUTS.md` separates pre-existing data from code                  |
| A4  | Open-source code                                                                               | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | Apache-2.0 `LICENSE` (D12), `"license": "Apache-2.0"` in `package.json`                                                                       |
| A5  | README                                                                                         | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Foundation README exists; judging README finalized in Sprint 9                                                                                |
| A6  | Public repository                                                                              | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | `gh repo view` on 4 Sept 2026: visibility `PUBLIC`                                                                                            |
| A7  | Demo video, 2 to 4 minutes                                                                     | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Sprint 9                                                                                                                                      |
| A9  | Reusable MCP tooling with `SKILL.md` and clean installation, complete at the 10 September gate | PLAN   | UNVERIFIED (decision D16)    | PLANNED                      | `@cas/mcp-server`, Sprint 6; fresh-clone installation verified in Sprints 6 and 7                                                             |

## B. The Graph: Best Use of Composable or Standardized Graph Products, $5,000

The track qualifies through **either** of two routes. The project's primary route is the
second; a second Graph product is not required.

| #   | Requirement                                                                                                                                                          | Source | Requirement verification     | Delivery    | Planned evidence                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Route 1: "compose two or more of The Graph's products"                                                                                                               | EVENT  | VERIFIED FROM EVENT MATERIAL | not pursued | Not required. Substreams stays optional and never a prerequisite; Graph Market access only if an optional path requires it (D11)                                                                  |
| B2  | Route 2: "build meaningfully on a standardized schema"; qualification includes making "the standards leverage clear"                                                 | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED     | Meaningful use of the Messari standardized schema: one common query and data model across at least five protocols or entities, documented so the schema leverage is explicit (D11)                |
| B3  | "Consume live data from a Graph provider, for example Subgraph Studio for Subgraphs or The Graph Market for Substreams"                                              | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED     | As A2                                                                                                                                                                                             |
| B4  | Sprint 1 proof gate: one common query and data model; at least five relevant protocols or entities; live provider-backed results; Ethereum mandatory; Base secondary | PLAN   | UNVERIFIED (decision D11)    | PLANNED     | `SPRINT_BOARD.md` Sprint 1, 5 September. Base is time-boxed to four hours and kept only if the same query contract yields sufficiently complete and fresh results; otherwise MVP is Ethereum only |
| B5  | Public repository and demo video, 2 to 4 minutes                                                                                                                     | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED     | As A6 and A7                                                                                                                                                                                      |

## C. Hedera: AI and Agentic Payments on Hedera, $6,000 (up to three teams)

Attempted in Sprint 8 only if the Graph release gate passes at the end of 10 September and
the remaining time budget allows. Testnet only (`SECURITY.md`).

| #   | Requirement                                                                                                    | Source | Requirement verification     | Delivery                     | Planned evidence                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| C1  | "Host a live x402-gated service on Hedera testnet or mainnet"                                                  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/feed-api` behind an x402 gate on testnet; depends on D8 hosting and Sprint 8       |
| C2  | "Build a platform or agent that consumes that service and completes at least one real paid request end to end" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/payer-agent` completes one paid request on testnet; transaction reference recorded |
| C3  | Public GitHub repository                                                                                       | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | As A6                                                                                    |
| C4  | Demo video, 5 minutes maximum                                                                                  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | One 2 to 4 minute video satisfies both this and the general rule (G1)                    |
| C5  | Hedera x402 integration only after the Graph release candidate passes                                          | PLAN   | UNVERIFIED (plan-level)      | PLANNED                      | Sprint 8 conditional entry in `SPRINT_BOARD.md`                                          |

## D. Bazantic: API and recipe tracks

Attempted in Sprint 8 under the same condition as section C. The plan does not fix which
Bazantic track is targeted; both non-continuity tracks are listed. The continuity track is
not applicable to a Start Fresh project.

| #   | Requirement                                                                                   | Source | Requirement verification     | Delivery | Planned evidence                                                          |
| --- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | -------- | ------------------------------------------------------------------------- |
| D1  | Create an account on bazantic.com and an x402 Gateway (both tracks)                           | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Human action in `ACCOUNT_READINESS.md`                                    |
| D2  | Best Recipe Using Sponsor APIs, $1,000: use multiple sponsor APIs in one working recipe flow  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | A recipe composing the project's feed with at least one other sponsor API |
| D3  | Agentify a New API, $1,000: add an API not previously in Bazantic and create a working recipe | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | The project's own incident feed API added to Bazantic                     |
| D4  | Screen recording demonstrating the recipe                                                     | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Sprint 8 or 9                                                             |

## E. Public repository and history requirements

| #   | Requirement                                                                                                                                                                                          | Source | Requirement verification     | Delivery                     | Evidence                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Classic track: "you must begin your project when hacking officially begins at event kick-off. Pre-existing project-specific code, designs, or assets are not allowed for Classic track submissions." | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Repository created 4 Sept 2026 20:33 EDT, after the 12:00 PM kick-off; first commit same time; corpus never committed                   |
| E2  | "you must also use version control for your code throughout the course of the event"                                                                                                                 | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Every change lands as a dated commit on a sprint branch; CI runs on each push                                                           |
| E3  | "Any repositories with single commits of large files without proper history will be default assumed to be unqualified unless proven otherwise."                                                      | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Finding 2 above. The history has four dated commits after Sprint 0 and grows with each sprint. No claim of disqualification, no rewrite |
| E4  | "In all cases, you must disclose any pre-existing work in writing to the ETHGlobal team and include full details in your submission (repo history, video, and description)."                         | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Disclose the pre-existing corpus as input data in the submission, on the basis of `PRIOR_INPUTS.md`; Sprint 9                           |
| E5  | Public libraries and starter kits are permitted                                                                                                                                                      | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Every dependency is a public package pinned in `pnpm-lock.yaml`                                                                         |
| E6  | Proof of work during the hackathon: "a GitHub Repo, Figma files, or equivalent"                                                                                                                      | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | Public repository with dated history                                                                                                    |
| E7  | Repository name fixed as `cs-ethonline-26`                                                                                                                                                           | PLAN   | UNVERIFIED (plan-level)      | IMPLEMENTED (administrative) | D5                                                                                                                                      |
| E8  | Open-source licence                                                                                                                                                                                  | PLAN   | UNVERIFIED (decision D12)    | IMPLEMENTED (administrative) | Apache-2.0 `LICENSE`                                                                                                                    |

## F. Required documentation

| #   | Requirement                             | Source | Requirement verification     | Delivery                     | Evidence                                                                                       |
| --- | --------------------------------------- | ------ | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| F1  | README (Graph AI track)                 | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | As A5                                                                                          |
| F2  | Architecture diagram                    | EVENT  | VERIFIED FROM EVENT MATERIAL | not required                 | The extracted material requires diagrams only for Arc and Privy tracks, which are not targeted |
| F3  | Written disclosure of pre-existing work | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | As E4; `PRIOR_INPUTS.md` is the written basis                                                  |
| F5  | Charter documents in `docs/`            | PLAN   | UNVERIFIED (plan-level)      | IMPLEMENTED (administrative) | This directory                                                                                 |

## G. Demo and video requirements

| #   | Requirement                                                                                                                       | Source | Requirement verification     | Delivery | Evidence                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| G1  | "2-4 minute demo video", minimum 720p, "no speeding up, mobile phone recordings, text-to-speech, or music with text descriptions" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Sprint 9                                                                                      |
| G2  | Hedera: 5 minutes maximum                                                                                                         | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As C4                                                                                         |
| G3  | Bazantic: screen recording of the recipe                                                                                          | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As D4                                                                                         |
| G4  | Demo labels the `DataOrigin` of every record shown: `live`, `fixture` or `replay`                                                 | PLAN   | UNVERIFIED (plan-level)      | PLANNED  | `ARCHITECTURE.md` section 7; the `DataOrigin` contract exists, the labelling feature does not |

## H. Live-data requirements

| #   | Requirement                                                         | Source | Requirement verification     | Delivery | Evidence                                                                              |
| --- | ------------------------------------------------------------------- | ------ | ---------------------------- | -------- | ------------------------------------------------------------------------------------- |
| H1  | Consume live data from a Graph provider; mocked or local data fails | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As A2 and B3                                                                          |
| H2  | Live x402-gated service on Hedera testnet                           | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As C1, conditional                                                                    |
| H3  | Live Graph access working before any dashboard polish               | PLAN   | UNVERIFIED (plan-level)      | PLANNED  | Standing rule in `SPRINT_BOARD.md`                                                    |
| H4  | Editorial imports of the current feed are also `live` data          | PLAN   | UNVERIFIED (plan-level)      | PLANNED  | `DataOrigin` semantics in `ARCHITECTURE.md` section 7; provenance carries source kind |

## I. Official schedule (America/Toronto)

| #   | Milestone                                        | Source | Requirement verification                                                        | Delivery | Evidence                                                                |
| --- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| I1  | Hacking began 4 September 2026, 12:00 PM         | EVENT  | VERIFIED FROM EVENT MATERIAL (transcribed by the project owner; fetch HTTP 500) | n/a      | Repository created 20:33 the same day                                   |
| I2  | Project Check-in #1: 7 September, 11:59 PM       | EVENT  | VERIFIED FROM EVENT MATERIAL (transcribed by the project owner; fetch HTTP 500) | PLANNED  | Sprint 3 exit gate                                                      |
| I3  | Project Check-in #2: 10 September, 11:59 PM      | EVENT  | VERIFIED FROM EVENT MATERIAL (transcribed by the project owner; fetch HTTP 500) | PLANNED  | Sprint 6 exit gate, with the Graph release gate                         |
| I4  | Final project submission: 13 September, 12:00 PM | EVENT  | VERIFIED FROM EVENT MATERIAL (also on the information page as "12:00 pm EDT")   | PLANNED  | Sprint 9 exit gate; 14 to 16 September are not build or submission time |
| I5  | Judging begins: 13 September, 3:00 PM            | EVENT  | VERIFIED FROM EVENT MATERIAL (transcribed by the project owner; fetch HTTP 500) | n/a      | none                                                                    |
| I6  | Team size                                        | EVENT  | UNVERIFIED                                                                      | n/a      | Not stated on the fetched pages                                         |
