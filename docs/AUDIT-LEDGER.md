# Audit ledger

One row per track and per production commit: the exact commit, who reviewed it, the verdict
in the reviewer's own words, the date, and where the record is. "Not audited" means no
independent reviewer has issued a verdict on that commit; it is written in those words
wherever it is true. Correction commits are listed under the verdict they answered; a
corrected commit is not audited until a reviewer says so about that commit.

Vault records are in the engineering vault under `03_Audits/cs-ethonline-26/`, named by
date. Sprint 0 and Sprint 1 predate the vault's records; their verdicts are recorded in the
repository's own reports and the sprint board. CAS-006 step 1, 22 October 2026.

| Track or commit                            | Commit                     | Reviewer                       | Verdict                                                | Date             | Record                                                   |
| ------------------------------------------ | -------------------------- | ------------------------------ | ------------------------------------------------------ | ---------------- | -------------------------------------------------------- |
| Sprint 0, charter readiness                | `39891492`                 | Codex                          | audited                                                | 5 Sept 2026      | `docs/SPRINT-0-REPORT.md`, `docs/SPRINT_BOARD.md`        |
| Sprint 1, live Graph proof                 | `56bc95c4`                 | Codex                          | PASS, after two corrections                            | 6 Sept 2026      | `docs/SPRINT-1-REPORT.md`, `docs/SPRINT_BOARD.md`        |
| Sprint 2, data foundation                  | `000c3410`                 | Codex Desktop                  | PASS, after three corrections                          | 6 to 7 Sept 2026 | `2026-09-06-sprint-2-documentation-final-audit.md`       |
| Sprint 3, classification and review queue  | `71394c9b`                 | Codex Desktop                  | PASS, after two corrections                            | 8 Sept 2026      | `2026-09-08-sprint-3-final-audit.md`                     |
| Sprint 4, clustering and incidents         | `4a0a847`                  | Codex Desktop                  | PASS, after one audit and two corrections              | 9 Sept 2026      | `2026-09-09-sprint-4-documentation-final-audit.md`       |
| Sprint 5 candidate, evidence and drafting  | `6fad82c3`                 | Codex Desktop                  | CHANGES REQUIRED, F1 to F5                             | 10 Sept 2026     | `2026-09-10-sprint-5-evidence-drafting-final-reaudit.md` |
| Sprint 5 correction                        | `313db359`                 | none                           | not audited                                            |                  | `docs/SPRINT-5-REPORT.md` section 16                     |
| Security foundation track                  | `98b75d5`                  | none                           | not audited                                            |                  | `docs/SECURITY-FOUNDATION-REPORT.md`                     |
| Dashboard and authentication track         | `05237c9`                  | none                           | not audited                                            |                  | `docs/SPRINT-6-DASHBOARD-AUTH-HANDOFF.md`                |
| Google Sheets intake track                 | `76ec3ae`                  | none                           | not audited                                            |                  | `docs/SHEETS-INTAKE.md`                                  |
| MCP tooling candidate                      | `7f03a34f`                 | Codex Desktop                  | CHANGES REQUIRED, F1 to F16                            | 10 Sept 2026     | `2026-09-10-track-d-mcp-tooling-audit.md`                |
| MCP tooling, three corrections integrated  | `1d47f1b8`                 | Claude, not Codex              | CHANGES REQUIRED, M1, M2, L3, L4                       | 12 Sept 2026     | `2026-09-12-track-d-mcp-tooling-final-reaudit.md`        |
| MCP tooling correction                     | `3858339`                  | none                           | not audited                                            |                  | `docs/MCP-TOOLING-TRACK-REPORT.md`                       |
| Release integration                        | `056d8e86`                 | none (Claude-only integration) | not audited                                            |                  | `docs/RELEASE-INTEGRATION-REPORT.md`                     |
| Production candidate, PR #1                | `587b4ee` to `05c9849`     | none                           | not audited                                            | 13 Sept 2026     | PR #1                                                    |
| Passwordless email login, PR #2            | `3afa23a` to `61b9766`     | none                           | not audited                                            | 13 Sept 2026     | PR #2                                                    |
| `main` after the hackathon                 | `cfb2a86`                  | none                           | not audited                                            | 13 Sept 2026     |                                                          |
| Post-event plan, PR #12                    | `ce8e367`                  | none (documents only)          | not audited                                            | 16 Sept 2026     | `docs/POST-EVENT-PLAN.md`                                |
| Dependency advisories, PR #15              | `83bcb8e`                  | none                           | not audited                                            | 22 Oct 2026      | `docs/DECISIONS.md`, D29 amendment of 22 Oct 2026        |
| CAS-001 candidate, PR #14                  | `2c33e09`                  | Codex Desktop                  | CHANGES REQUIRED, F1 to F5                             | 21 Oct 2026      | `2026-10-21-cas-001-pr-14.md`                            |
| CAS-001 correction, PR #14                 | `2ad714d`                  | Codex                          | PASS, F1 to F5 corrected                               | 22 Oct 2026      | `2026-10-22-cas-001-pr-14-reaudit.md`                    |
| CAS-006 blockers 6 and 7, PR #17           | `2e77d2e`                  | Codex                          | CHANGES REQUIRED, F1                                   | 22 Oct 2026      | `2026-10-22-cas-006-pr-17-release-blockers.md`           |
| CAS-006 blocker 3 code half, PR #18        | `32e1357`                  | Codex                          | PASS, delta only                                       | 22 Oct 2026      | `2026-10-22-cas-006-pr-18-trusted-proxy.md`              |
| CAS-002 categories, PR #19                 | `6229ff5`                  | Codex                          | CHANGES REQUIRED, F1 and F2                            | 22 Oct 2026      | `2026-10-22-cas-002-pr-19.md`                            |
| CAS-002 correction, PR #19 merged          | `aeeccf4` in `b4c8270`     | Codex                          | CHANGES REQUIRED, one Medium (hash ownership)          | 22 Oct 2026      | `2026-10-22-cas-002-pr-19-correction-reaudit.md`         |
| CAS-002 second correction, PR #22 merged   | `2c87946` in `592d3bc`     | Codex                          | PASS, no findings                                      | 22 Oct 2026      | `2026-10-22-pr-22-pr-23-independent-review.md`           |
| CAS-003 weekly run, PR #23                 | `f49619f`                  | Codex                          | CHANGES REQUIRED, F1 to F6                             | 22 Oct 2026      | `2026-10-22-pr-22-pr-23-independent-review.md`           |
| CAS-003 correction, PR #23                 | `ad94940` (code `44fc682`) | Codex                          | CHANGES REQUIRED, F3 reopened (Medium)                 | 22 Oct 2026      | `2026-10-22-pr-23-ad94940-rereview.md`                   |
| CAS-003 second correction, PR #23          | `3c1d253` (code `48896ab`) | Codex                          | CHANGES REQUIRED, F3 at the database boundary (Medium) | 22 Oct 2026      | `2026-10-22-pr-23-third-review.md`                       |
| CAS-003 third correction, PR #23 merged    | `048e673` in `bda4303`     | Codex                          | PASS, no findings                                      | 22 Oct 2026      | `2026-10-22-pr-23-fourth-review.md`                      |
| CAS-004 round-up, PR #24                   | `f2e985c`                  | Codex                          | CHANGES REQUIRED, F1 to F3 (P1), F4 to F6 (P2)         | 22 Oct 2026      | `2026-10-22-CAS-004-roundup-pr24.md`                     |
| CAS-004 correction, PR #24                 | `64f7cac` (code `b57ecf5`) | Codex                          | CHANGES REQUIRED, RR1 and RR2 (P1), RR3 to RR5 (P2)    | 22 Oct 2026      | `2026-10-22-CAS-004-roundup-pr24-rereview.md`            |
| CAS-004 second correction, PR #24          | `d7d4e7e` (code `aa34985`) | Codex                          | CHANGES REQUIRED, one P2 (U+2060 survived the export)  | 22 Oct 2026      | `2026-10-22-CAS-004-roundup-pr24-third-review.md`        |
| CAS-004 third correction, PR #24 merged    | `fcdf88c` in `6f25fb0`     | Codex                          | PASS, no findings                                      | 22 Oct 2026      | `2026-10-22-CAS-004-roundup-pr24-fourth-review.md`       |
| CAS-006 correction, PR #17 merged          | `e19449e` in `355e773`     | Codex                          | PASS, no findings                                      | 22 Oct 2026      | `2026-10-22-cas-006-pr-17-correction-reaudit.md`         |
| CAS-006 blocker 3 code half, PR #18 merged | `3ceaf09` in `c32c963`     | Codex (delta at `32e1357`)     | PASS, delta only; merge head not audited               | 22 Oct 2026      | `2026-10-22-cas-006-pr-18-trusted-proxy.md`              |

## What this means for the deployed service

Everything the Railway dashboard runs today is on `main` at `83bcb8e` or later. Of the code it
runs, Sprints 0 to 4 were accepted by an independent reviewer at the commits above; the Sprint
5 correction, the security foundation, the dashboard, the Sheets connector, the MCP tooling
correction, the release integration and both 13 September pull requests were not. CAS-006
step 12 is the owner's decision, per unaudited track, between requesting an independent review
now and recording an accepted risk here with a review date.

## How a row changes

A row changes only when a reviewer issues a verdict on the commit it names, or when a new
commit supersedes the one under review. Nothing here is edited to look better; a verdict is
quoted, never paraphrased into a stronger word.
