# CAS-006 report: debt, audits and dispositions

Unit tracker: `docs/tcu/CAS-006.md`; live status: issue 8. This report grows one section per
step. Nothing in it changes an audit state; the ledger quotes verdicts, never upgrades them.

## 1. The audit ledger and the README status (steps 1 and 2)

Written 22 October 2026, branch `cas-006/audit-ledger` from `main` at `83bcb8e`.

- `docs/AUDIT-LEDGER.md`: one row per track and production commit, from Sprint 0 to the CAS-001
  correction under re-review. Every commit named was checked to exist in the repository with
  its date; every verdict is quoted from the vault record it cites, or from the repository's
  own report where the vault has none (Sprints 0 and 1). The ledger states what the deployed
  service runs and which of it was accepted: Sprints 0 to 4 at their accepted commits, and
  nothing after.
- `README.md`, status section: rewritten to describe `main` as it is, with the product's
  purpose, what runs, what is in review, and Sprint 5's containment stated exactly, including
  the two provenance sentences the documentation tests require word for word. The applied
  migration range is now stated from the shipped files, so a new migration must update the
  sentence a reader acts on.
- `apps/worker/src/documentation.test.ts`: the two assertions that pinned the hackathon-era
  status text ("Sprint 5 in progress", "nine migrations") now assert the same intent against
  the current truth: Sprint 5 corrected and not re-audited, and the README naming the highest
  shipped migration. The premature-claim checks are unchanged.

Not done here: steps 3, 4, 6, 11 and 12 are the owner's decisions; steps 7 to 10 follow.
Audit state: not audited.

## 2. The two open release blockers, 6 and 7 (steps 9 and 10)

Written 22 October 2026, branch `cas-006/release-blockers`, stacked on `cas-006/audit-ledger`.
Each item of `docs/RELEASE-INTEGRATION-REPORT.md` section 15, blockers 6 and 7, is listed with
what was already true, what changed, and the test that proves it.

### 2.1 Blocker 6, Sheets activation prerequisites

| Item                                                     | State                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The loader opens the key once and checks the open handle | Already closed by `f348acb` (13 September): `O_NOFOLLOW` on the open, every check and the read on that one descriptor.                                                                                                                                                                                                                                                      |
| The repository check resolves real paths                 | Closed here. The key's directory and the repository root are resolved with `realpath` and compared again after the lexical check, so a key reached through a directory link that lands inside the working tree is refused. Two tests in `credentials.test.ts`.                                                                                                              |
| A scan rule covers Sheets URLs and identifiers           | Closed here. Four rules in `tools/checks/secrets.ts`: a spreadsheet URL, a spreadsheet identifier assignment, a service-account address, a service-account key file. Tests and the subprocess harness are skipped by these rules, as the existing synthetic-credential rules are. A planted-token test in `checks.test.ts`; the scan over the tracked tree reports nothing. |
| The digest pinned in its own reviewed commit             | Already true: `546c040` (13 September).                                                                                                                                                                                                                                                                                                                                     |

### 2.2 Blocker 7, the dashboard's lower findings

| Item                                          | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cap password length before Argon2             | Provisioning already capped at 128 characters through `assertPassword`. Closed here for verification too: `verifyPassword` refuses above the cap before any hashing, so the cap no longer depends on the caller. No route accepts a password since the passwordless login; the guard is structural. Test in `password.test.ts`.                                                                                                                                                                                                                                                                                                                              |
| Bound the action body size                    | Closed here. `experimental.serverActions.bodySizeLimit` is declared at 1 MB in `next.config.ts` rather than defaulted, and `next-config.test.ts` proves the bound holds the largest legitimate action, a draft revision of 200,000 characters at four bytes each.                                                                                                                                                                                                                                                                                                                                                                                            |
| Bound stored revisions and decisions          | Closed here, corrected after review. A draft keeps at most 1,000 revisions and a queue row of one run at most 100 decisions; both are refusals with fixed codes, never deletions, because the stores are append-only. The decision bound is enforced where the write happens, as one atomic store operation (`appendIfBelow`): in PostgreSQL, one transaction that takes an advisory lock on the entry, counts, then appends; in memory, a count and a push with no await between them. Tests in `dal.db.test.ts` (two reviews of one row together: one lands, one is refused, 100 remain) and `postgres-store.db.test.ts` (the store alone, the same race). |
| Report a failed sign-out                      | Closed here. Session revocation now reports whether it revoked a live session; a sign-out that revoked nothing records a failure audit event and answers 409 with the cookie still cleared. Test in `session.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Clear the cookie with its original attributes | Already closed on `main`: the clearing header carries `Path=/`, `HttpOnly`, `SameSite=Strict` and, outside `local`, `Secure`; `cookie.test.ts` asserts it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 2.3 Counts, from the runners

Default suites 1,031 tests (dashboard 84, sheets-intake 132); tools 31; PostgreSQL 270
(database 92, worker 108, dashboard 21, MCP 49); verify loop green; secrets, hygiene and
forbidden-file scans clean with the new rules.

Not done here: steps 3, 4, 6, 11 and 12 are the owner's decisions; step 7 (blocker 3, the
trusted proxy) needs the owner at Railway; step 8 (blocker 5) waits on the MCP server's
disposition. Audit state: not audited.

## 3. Release blocker 3, the trusted proxy hop: the code half (step 7)

Written 22 October 2026, branch `cas-006/trusted-proxy`, stacked on `cas-006/release-blockers`.

The release review found two things wrong with how sign-in throttling keyed a request: with
`DASHBOARD_TRUST_FORWARDED_FOR` unset every client shared the single bucket `direct`, so one
attacker could lock everyone out; with it set, the key was the first entry of
`X-Forwarded-For`, which the client itself may have written. Both are closed in code:

- `DASHBOARD_TRUSTED_PROXY_HOPS` (1 to 8, default 1) declares how many trusted proxies stand
  between the client and the process. The key is the entry that many places from the right end
  of the header, the address the outermost trusted proxy saw as its client, never the first
  entry. A header with fewer entries than hops did not come through the declared chain and
  keys as `malformed`. Railway's edge is one hop.
- The configuration documents that `false` is a local-only setting because it puts every
  client in one bucket. Tests cover one and two hops, a spoofed first entry, and a header
  shorter than the chain; the configuration test covers the default and five refusals.

The owner's half remains: set `DASHBOARD_TRUST_FORWARDED_FOR=true` and
`DASHBOARD_TRUSTED_PROXY_HOPS=1` on the Railway service, then prove from two networks that a
lockout on one does not lock the other. Until then the deployed instance keys as `direct`.

Counts, from the runners: dashboard 84 unit and 21 PostgreSQL; verify loop green. Audit state:
not audited.

## 4. Independent review of steps 9 and 10, and the correction (step 14, first round)

Codex reviewed pull request 17 at `2e77d2e` on 22 October 2026: CHANGES REQUIRED, one Medium
finding, F1. The 100-decision bound was a count followed by a separate insert, so two reviews
of the same queue row arriving together at 99 could both pass the check and leave 101; the
committed test proved only the sequential case. Blocker 6 and the other blocker 7 items had no
findings. Record: `2026-10-22-cas-006-pr-17-release-blockers.md`.

Correction, same day: the bound is now enforced where the write happens. The store interface
gains `appendIfBelow(decision, limit)`, one atomic operation. The PostgreSQL store runs it as
one transaction that takes `pg_advisory_xact_lock` on the entry (run and row), counts, and
appends only below the limit; the memory store counts and pushes with no await between the two.
The data-access layer keeps its early refusal and now reads the atomic outcome, refusing
`decision_limit` when the append reports the limit. Two tests reproduce the race the review
named: the data-access layer with two concurrent reviews of one real queue row (a quarantined
row classified to `review`, seeded for the purpose), and the PostgreSQL store on its own. Each
asserts one success, one `decision_limit`, and a final count of exactly 100.

In the same round Codex passed pull request 18 at `32e1357` (step 7's code half, no findings,
its verdict independent of this one) and pull request 14 at `2ad714d` (CAS-001), and returned
two findings on pull request 19 (CAS-002); the ledger carries all four. The corrected head of
this pull request awaits re-review; nothing is called audited until it says so.

## 5. Merges of 22 October 2026

The owner merged pull request 17 at `355e773` and pull request 18 at `c32c963` on
22 October 2026. Pull request 17's corrected head `e19449e` had not been re-reviewed; its
audit state stays not audited until a verdict names that commit, and the re-review request
stands. Pull request 18's delta was passed at `32e1357`; its merged head carries 17's
correction by merge. With both on `main`, the owner's halves of step 7 can be completed on the
recreated Railway service: `DASHBOARD_TRUST_FORWARDED_FOR=true`,
`DASHBOARD_TRUSTED_PROXY_HOPS=1`, and the two-network proof that one lockout does not lock the
other.

## 6. Re-review of the correction (step 14, second round)

Codex re-reviewed `e19449e` on 22 October 2026: **PASS**, no findings. The atomic
`appendIfBelow` closes the race; both committed race tests finish with exactly 100 decisions.
Record: `2026-10-22-cas-006-pr-17-correction-reaudit.md`. Steps 9 and 10 are therefore audited
at the commit `main` carries. Pull request 18's delta was passed at `32e1357`; the owner's
halves of step 7 remain, on the recreated Railway service.

## 7. Review of pull request 65 at `aa6f519`, and the corrections (1 November 2026)

Codex reviewed pull request 65, the ruleset for one identity (D52) and the restore drill carried
from pull request 51 (record `2026-11-01-pr-65-aa6f519.md`): CHANGES REQUIRED, two High. The
ruleset's four conditions, the validator, the carry of pull request 51 and the records were
supported. Neither gap was ever on `main`. Each is named here and corrected with its tests, in the
same push (D53).

- **H1: a failed run of the verdict recorder could leave an earlier success standing.** The
  recorder decided before it wrote, so a run that failed while reading the comments wrote
  nothing, and a head an earlier run had passed stayed green after its verdict changed. Corrected
  in `tools/ci/codex-verdict.ts`: once the head is known the status is set to pending before
  anything is read, a failed read or a malformed page leaves it failed or pending, and success is
  written only after every comment is read and decided. Five cases are tested from an earlier
  success; the one that remains, GitHub refusing every status write, fails the job and is named in
  `docs/RUNBOOK-SECURITY.md`, section 1.1.
- **H2: the restore drill's local-only check read a different host from the one its clients
  used.** The guard classified the URL's authority, while the Node client and the child tools
  honoured a host parameter, and the child tools inherited the drill's whole environment.
  Corrected in `packages/database/src/restore.ts`: `drillTarget` reads each URL once, refusing
  any libpq parameter that could route a client elsewhere, a parameter given twice, more than one
  host or none; the guard checks that target; `drillChildEnvironment` hands the child tools that
  target and keeps from the inherited environment only what finds the tools and formats messages.
  `summarizeConnection` now reads the effective host as well. Tests cover the parameters that
  route, socket directories in either place, the variables a child must not inherit, and that the
  Node client and the child tools resolve the same host, port, database and user. The drill passes
  locally at 25 migrations, and a target that routes elsewhere is refused before any connection.
