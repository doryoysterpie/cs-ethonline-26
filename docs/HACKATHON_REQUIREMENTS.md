# Hackathon requirements

Requirement-to-evidence matrix for ETHOnline 2026. Sprint 0 state.

## How to read this document

Two provenance markers say where a requirement comes from:

- `PLAN`: taken from the supplied project plan and Sprint 0 charter.
- `EVENT`: taken from ETHGlobal event material. Two pages were read on 4 September 2026
  (evening, America/Toronto) through an automated fetch that returns an extracted summary,
  not the raw page: the prizes page
  (`https://ethglobal.com/events/ethonline2026/prizes`) and the rules page
  (`https://ethglobal.com/events/ethonline2026/info/details`). Quoted text is as extracted.
  The project owner should confirm each quotation against the live page before relying on
  it for a submission decision.

These are not equivalent. A `PLAN` requirement is what the project intends to satisfy; an
`EVENT` requirement is what the event states.

Two status columns, each using the charter's vocabulary:

- **Requirement verification:** `UNVERIFIED` or `VERIFIED FROM EVENT MATERIAL`.
- **Delivery:** `PLANNED`, `IMPLEMENTED` or `DEMONSTRATED`.

At Sprint 0 no technical requirement is `IMPLEMENTED` or `DEMONSTRATED`. The only
`IMPLEMENTED` rows are administrative facts about the repository itself, each with its
evidence.

## Findings that need the project owner's attention

1. **Submission deadline conflict.** The rules page states the submission deadline as
   "Sunday, September 13th, 2026 at 12:00 pm EDT". The charter fixes a feature freeze on
   14 September and a submission buffer on 16 September, which fall after that deadline.
   The charter's controls are recorded unchanged in `SPRINT_BOARD.md`; the implementer has
   not altered them. Reconcile before Sprint 1 planning.
2. **Commit-history rule.** The rules page states that "submissions with large single
   commits or missing histories may be disqualified." Sprint 0 lands as one foundation
   commit because the charter specifies one commit. Later sprints must commit in small,
   dated steps. Whether to split the foundation commit is the project owner's call.
3. **No licence file.** The Graph tracks require open-source code. The repository has no
   `LICENSE` file, and the choice of licence is a decision the implementer will not make.
4. **Pre-existing assets.** The Start Fresh rule excludes "prior project-specific code,
   designs, or assets". The plan treats the Cyberattack Sunday corpus as input data that is
   never committed (`PRIOR_INPUTS.md`). That reading is the project owner's to confirm.

## A. The Graph: Best AI Tooling or AI Use Case (From Scratch), $5,000

| #   | Requirement                                       | Source | Requirement verification     | Delivery                     | Planned evidence                                                                                                        |
| --- | ------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A1  | The Graph is a "load-bearing part of the project" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/graph-evidence` supplies the anomaly signals that start the pipeline; live query provenance logged (Sprints 1, 3) |
| A2  | Net-new work begun during the hackathon           | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | First commit 4 Sept 2026 20:33 EDT; `PRIOR_INPUTS.md` separates pre-existing data from code                             |
| A3  | Open-source code                                  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Licence file to be added once the project owner chooses a licence                                                       |
| A4  | README                                            | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Foundation README exists; judging README finalized in Sprint 9                                                          |
| A5  | Public repository                                 | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | `gh repo view` on 4 Sept 2026: visibility `PUBLIC`                                                                      |
| A6  | Demo video, 2 to 4 minutes                        | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Sprint 9                                                                                                                |
| A7  | Detect anomalies from live The Graph data         | PLAN   | UNVERIFIED (plan-level)      | PLANNED                      | Vertical slice item 1, Sprint 3                                                                                         |
| A8  | Feedback submission to The Graph                  | EVENT  | UNVERIFIED                   | PLANNED                      | The extracted summary lists a Graph feedback requirement in its general section but not in the track text; confirm      |

## B. The Graph: Best Use of Composable or Standardized Graph Products, $5,000

| #   | Requirement                                                                                          | Source | Requirement verification     | Delivery | Planned evidence                                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | -------- | ------------------------------------------------------------------------------------- |
| B1  | "Either compose two or more of The Graph's products, or build meaningfully on a standardized schema" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Sprint 1 decides which second Graph product, if any, the project composes; unresolved |
| B2  | "Consume live data from a Graph provider"                                                            | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Same evidence as A1 and A7                                                            |
| B3  | Public repository and demo video, 2 to 4 minutes                                                     | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As A5 and A6                                                                          |

## C. Hedera: AI and Agentic Payments on Hedera, $6,000 (up to three teams)

Attempted only if the Graph release gate passes (Sprint 8). Testnet only (`SECURITY.md`).

| #   | Requirement                                                                                                    | Source | Requirement verification     | Delivery                     | Planned evidence                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| C1  | "Host a live x402-gated service on Hedera testnet or mainnet"                                                  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/feed-api` behind an x402 gate on testnet; depends on D8 hosting and Sprint 8       |
| C2  | "Build a platform or agent that consumes that service and completes at least one real paid request end to end" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | `@cas/payer-agent` completes one paid request on testnet; transaction reference recorded |
| C3  | Public GitHub repository                                                                                       | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | As A5                                                                                    |
| C4  | Demo video, 5 minutes maximum                                                                                  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | One 2 to 4 minute video satisfies both this and the general rule (G1)                    |
| C5  | Hedera x402 integration only after the Graph release candidate passes                                          | PLAN   | UNVERIFIED (plan-level)      | PLANNED                      | Sprint 8 gate in `SPRINT_BOARD.md`                                                       |

## D. Bazantic: API and recipe tracks

Attempted only if the Graph release gate passes (Sprint 8). The plan does not fix which
Bazantic track is targeted; both non-continuity tracks are listed. The continuity track is
not applicable to a Start Fresh project.

| #   | Requirement                                                                                   | Source | Requirement verification     | Delivery | Planned evidence                                                          |
| --- | --------------------------------------------------------------------------------------------- | ------ | ---------------------------- | -------- | ------------------------------------------------------------------------- |
| D1  | Create an account on bazantic.com and an x402 Gateway (both tracks)                           | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Human action in `ACCOUNT_READINESS.md`                                    |
| D2  | Best Recipe Using Sponsor APIs, $1,000: use multiple sponsor APIs in one working recipe flow  | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | A recipe composing the project's feed with at least one other sponsor API |
| D3  | Agentify a New API, $1,000: add an API not previously in Bazantic and create a working recipe | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | The project's own incident feed API added to Bazantic                     |
| D4  | Screen recording demonstrating the recipe                                                     | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Sprint 8 or 9                                                             |

## E. Public repository requirements

| #   | Requirement                                                                                                                                                   | Source | Requirement verification     | Delivery                     | Evidence                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| E1  | Start Fresh: "All work on your project must begin after the hackathon officially starts. Any prior project-specific code, designs, or assets are not allowed" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Repository created 4 Sept 2026 20:33 EDT; first commit same time; corpus never committed (finding 4 above) |
| E2  | Public libraries and starter kits are permitted                                                                                                               | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Every dependency is a public package pinned in `pnpm-lock.yaml`                                            |
| E3  | Version control history required; "submissions with large single commits or missing histories may be disqualified"                                            | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | Finding 2 above; granular commits from Sprint 1                                                            |
| E4  | Proof of work during the hackathon: "a GitHub Repo, Figma files, or equivalent"                                                                               | EVENT  | VERIFIED FROM EVENT MATERIAL | IMPLEMENTED (administrative) | Public repository with dated history                                                                       |
| E5  | Repository name fixed as `cs-ethonline-26`                                                                                                                    | PLAN   | UNVERIFIED (plan-level)      | IMPLEMENTED (administrative) | D5                                                                                                         |

## F. Required documentation

| #   | Requirement                                            | Source | Requirement verification     | Delivery                     | Evidence                                                                                       |
| --- | ------------------------------------------------------ | ------ | ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| F1  | README (Graph AI track)                                | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED                      | As A4                                                                                          |
| F2  | Architecture diagram                                   | EVENT  | VERIFIED FROM EVENT MATERIAL | not required                 | The extracted material requires diagrams only for Arc and Privy tracks, which are not targeted |
| F3  | Documentation of pre-existing work (continuity tracks) | EVENT  | VERIFIED FROM EVENT MATERIAL | not required                 | Not a Start Fresh requirement; `PRIOR_INPUTS.md` documents the input data regardless           |
| F4  | Feedback document for The Graph                        | EVENT  | UNVERIFIED                   | PLANNED                      | As A8                                                                                          |
| F5  | Charter documents in `docs/`                           | PLAN   | UNVERIFIED (plan-level)      | IMPLEMENTED (administrative) | This directory                                                                                 |

## G. Demo and video requirements

| #   | Requirement                                                                                                                       | Source | Requirement verification     | Delivery | Evidence                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| G1  | "2-4 minute demo video", minimum 720p, "no speeding up, mobile phone recordings, text-to-speech, or music with text descriptions" | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | Sprint 9                                                                                  |
| G2  | Hedera: 5 minutes maximum                                                                                                         | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As C4                                                                                     |
| G3  | Bazantic: screen recording of the recipe                                                                                          | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As D4                                                                                     |
| G4  | Demo shows live Graph data visibly distinct from fixtures or replay                                                               | PLAN   | UNVERIFIED (plan-level)      | PLANNED  | `ARCHITECTURE.md` section 7; `DataOrigin` contract exists, the labelling feature does not |

## H. Live-data requirements

| #   | Requirement                                           | Source | Requirement verification     | Delivery | Evidence                           |
| --- | ----------------------------------------------------- | ------ | ---------------------------- | -------- | ---------------------------------- |
| H1  | Consume live data from a Graph provider               | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As A1, B2                          |
| H2  | Live x402-gated service on Hedera testnet             | EVENT  | VERIFIED FROM EVENT MATERIAL | PLANNED  | As C1, conditional                 |
| H3  | Live Graph access working before any dashboard polish | PLAN   | UNVERIFIED (plan-level)      | PLANNED  | Standing rule in `SPRINT_BOARD.md` |

## I. Event window and deadlines

| #   | Requirement                                                        | Source | Requirement verification     | Delivery | Evidence                                                                   |
| --- | ------------------------------------------------------------------ | ------ | ---------------------------- | -------- | -------------------------------------------------------------------------- |
| I1  | Event window 4 to 16 September 2026                                | PLAN   | UNVERIFIED                   | n/a      | Neither fetched page stated the hacking period                             |
| I2  | Submission deadline "Sunday, September 13th, 2026 at 12:00 pm EDT" | EVENT  | VERIFIED FROM EVENT MATERIAL | n/a      | Finding 1 above: conflicts with the charter's 14 and 16 September controls |
| I3  | Team size                                                          | EVENT  | UNVERIFIED                   | n/a      | Not stated on the fetched pages                                            |
