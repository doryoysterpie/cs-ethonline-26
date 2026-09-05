# Sprint board

Sprints 0 to 9 for ETHOnline 2026 (4 to 16 September). The charter fixes the controls in
the first table. The per-sprint calendar in the second table is **proposed** by the
implementer within those controls; the project owner may re-cut it. Gates are states, not
dates: a sprint closes when its gate passes, and the calendar shifts rather than the gate
weakening.

## Fixed controls

| Control                                                                                                  | Date                 |
| -------------------------------------------------------------------------------------------------------- | -------------------- |
| Graph release gate: must-ship items 1 to 6 of the vertical slice pass                                    | end of 10 September  |
| If items 1 to 6 do not pass that gate, Hedera and Bazantic are dropped                                   | decided 10 September |
| Feature freeze                                                                                           | 14 September         |
| Submission buffer                                                                                        | 16 September         |
| No new dashboard polish while live Graph access, clean MCP installation or evidence provenance is broken | standing rule        |

## Conflict flagged, not resolved

The event rules page, read on 4 September 2026 through an automated fetch, states the
submission deadline as "Sunday, September 13th, 2026 at 12:00 pm EDT"
(`HACKATHON_REQUIREMENTS.md`, finding 1). The freeze and buffer dates above are recorded
exactly as the charter fixes them; the implementer has not changed them. If the project owner
confirms the 13 September deadline, the calendar below must be re-cut. One **proposed**
re-cut, offered for decision only: Graph gate unchanged at the end of 10 September, Sprint 7
on 11 September, Sprint 8 on 11 to 12 September, feature freeze at the end of 12 September,
submission on the morning of 13 September.

## Sprints

| Sprint | Objective                                                                                                                                       | Dependency                                                                  | Planned dates | Status                         | Hard exit gate                                                                                                                                                                | Kill criterion                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 0      | Charter and readiness: buildable monorepo foundation, CI, charter documents, unresolved decisions recorded                                      | public repository with an initial `main`                                    | 4 to 5 Sept   | COMPLETE, awaiting Codex audit | Frozen-lockfile install, format, lint, typecheck, test and build pass in a clean checkout; documents present; branch pushed                                                   | none                                                                                                              |
| 1      | Live Graph access; chain confirmation (D1); watchlist ranked by live indexed-data availability and comparability (D2); database schema baseline | Graph Studio key; Postgres local; D1 confirmed by the project owner         | 5 to 6 Sept   | NOT STARTED                    | A live query against a Graph provider returns indexed data for each chosen chain with provenance recorded; ranked watchlist with evidence delivered for human selection       | No live Graph access by end of 6 Sept: escalate immediately; nothing downstream can start                         |
| 2      | Editorial input ingestion baseline: CSV import of master export and weekly snapshots (D7a), review-state model, provenance retention            | D7b decided; Sprint 1 schema                                                | 6 to 7 Sept   | NOT STARTED                    | A synthetic fixture with every hazard in `DATA_INPUTS.md` section 11 round-trips through import with provenance and review state intact; real local files parse without error | Import cannot preserve provenance or review-record identity: stop and redesign before continuing                  |
| 3      | Anomaly detection from live Graph data (item 1)                                                                                                 | Sprint 1                                                                    | 7 to 8 Sept   | NOT STARTED                    | At least one anomaly signal produced from live data, with request, response and block context retained                                                                        | Signals cannot be reproduced from retained provenance: the detector is not shippable                              |
| 4      | Signal-to-reporting linkage and classification (item 2)                                                                                         | Sprints 2 and 3; Anthropic ready and D9 resolved                            | 8 to 9 Sept   | NOT STARTED                    | A live signal is linked to a selected source with an evidence state and the linkage evidence stored                                                                           | Classification cannot run deterministically enough to audit: ship linkage without model classification            |
| 5      | Clustering into canonical incidents and evidence states with complete provenance (items 3 and 4)                                                | Sprint 4                                                                    | 9 Sept        | NOT STARTED                    | Every incident carries an evidence state whose provenance chain reaches Graph responses and source rows; no orphaned incident                                                 | Provenance chain broken anywhere: fix before any further feature work                                             |
| 6      | Editable draft generation (item 5) and MCP tooling (item 6); Graph release candidate                                                            | Sprint 5; D3 and D4 confirmed                                               | 10 Sept       | NOT STARTED                    | Graph release gate: items 1 to 6 pass end to end from live data; MCP tools install cleanly from a fresh clone; draft written to the D3 destination without overwriting        | Gate fails at end of 10 Sept: Hedera and Bazantic are dropped and Sprints 7 and 9 absorb the remaining Graph work |
| 7      | Hardening and the dashboard vertical slice with data origin labelled; Graph submission readiness                                                | Sprint 6 gate; D8 decided for any hosted component                          | 11 to 12 Sept | NOT STARTED                    | Clean MCP installation, live Graph access and evidence provenance all intact; dashboard shows origin on every record                                                          | Any of the three standing-rule items broken: dashboard polish stops until fixed                                   |
| 8      | Hedera x402-gated feed, payer agent completing one real paid request on testnet, Bazantic recipe (item 7)                                       | Sprint 6 gate passed; Hedera testnet, Blocky402 and Bazantic accounts ready | 12 to 13 Sept | CONDITIONAL                    | One end-to-end paid request on Hedera testnet against the live feed; one working Bazantic recipe recorded                                                                     | Not attempted if the Graph gate failed; abandoned on 13 Sept if not working, to protect the freeze                |
| 9      | Feature freeze, demo video, final README and submission                                                                                         | Sprint 7; Sprint 8 if attempted                                             | 14 to 16 Sept | NOT STARTED                    | Submission complete before the 16 Sept buffer with video, public repository and documentation per `HACKATHON_REQUIREMENTS.md`                                                 | none; submission is mandatory                                                                                     |

## Standing rules

- Sponsor integrations (Sprint 8) begin only after the Graph release candidate passes.
- No dashboard polish while live Graph access, clean MCP installation or evidence provenance
  is broken.
- No sprint begins Sprint 1 work, or any later work, before the Codex audit of Sprint 0 is
  answered.
