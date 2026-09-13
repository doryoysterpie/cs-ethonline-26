# Latest in Cyber: release integration report

**Release candidate on `release/latest-in-cyber-integration`. Nothing is merged to `main`,
nothing is deployed, no account is provisioned, the live workbook is not imported, and no
remote MCP service is enabled.**

This integration was built, verified and security-reviewed within Claude sessions. No Codex
audit was requested for it. Each component track keeps the audit status its own report records, and combining the tracks changes none of them. All times America/Toronto.

## 1. Starting state

| Reference                    | Commit                                     | Checked                                                 |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `main`                       | `3011b5b50189a79181a9cf2d0c95724c019e5e74` | unchanged locally and on `origin` before and after work |
| Corrected evidence base      | `313db359c72ea305c03c30cc764ea67e51cbcec8` | head of `sprint-5/evidence-drafting` on `origin`        |
| Security foundation          | `98b75d5e5dbcfca19dc8cf291ba4aabf7108a663` | head of `parallel/s6-security-foundation` on `origin`   |
| Google Sheets intake         | `76ec3aefde91aa8f84bc971ed6aea5d70b3ed4ce` | head of `parallel/google-sheets-intake` on `origin`     |
| Dashboard and authentication | `05237c943de7fc1e446896164706f138f9d36c49` | head of `parallel/s6-dashboard-auth` on `origin`        |
| MCP tooling                  | `385833900e55ea32548bd7a6f760364b2e1c94b8` | head of `parallel/s6-mcp-tooling` on `origin`           |

Three tracks forked from the rejected evidence candidate `6fad82c`, not from the corrected
base. Every merge therefore had to preserve the five evidence corrections actively rather than
inherit them, and section 4 records the one place a clean automatic merge undid a correction.

## 2. Merges

Each track entered through a true two-parent merge, in the order the brief set. No commit was
rebased, squashed, cherry-picked or force-pushed, and every commit of every track remains
reachable from the release head.

| Order | Merge commit                               | First parent                               | Second parent (track head)                 | Track                        |
| ----- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ---------------------------- |
| 1     | `efd873707bf398b1e54fff09b7f803eda3fe0f06` | `313db359c72ea305c03c30cc764ea67e51cbcec8` | `98b75d5e5dbcfca19dc8cf291ba4aabf7108a663` | security foundation          |
| 2     | `18363faa58e3afaee865e9629ab0f8c0d0f1c447` | `efd873707bf398b1e54fff09b7f803eda3fe0f06` | `76ec3aefde91aa8f84bc971ed6aea5d70b3ed4ce` | Google Sheets intake         |
| 3     | `f1547882a2f8d7ae48f17baec18f406c1d1d116b` | `d120f08b3cebc187679a89d1afdabab8800b3902` | `05237c943de7fc1e446896164706f138f9d36c49` | dashboard and authentication |
| 4     | `7cd09210c8ab562a7a611cd041b7304001b77654` | `f1547882a2f8d7ae48f17baec18f406c1d1d116b` | `385833900e55ea32548bd7a6f760364b2e1c94b8` | MCP tooling                  |

## 3. Integrator commits

| Commit                                     | Purpose                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `d120f08b3cebc187679a89d1afdabab8800b3902` | Let the secret scan accept two synthetic private-key lines from the Sheets tests, matched by SHA-256 digest of the exact line |
| `4041d215c99a9d6bbabe56bbd7ee2ed03819a6f8` | Apply the release naming and palette, and replace the environment example with one reference in six groups                    |
| `c4de9a4f32ed0960768e93990f2a49636d3608bc` | Run CI and CodeQL on `release/**`, which no existing push filter matched                                                      |
| `ad7224dd134a73d992fb19afc7dd54784ce2ae94` | Regenerate the bill of materials for the merged lockfile and teach the generator about packages no platform installs          |
| `23fcc6b0edc4c205f42f0efb688139647237b546` | Correct that generator rule after the security review: exempt a package only when no supported platform installs it           |
| `5065cbb221f3a9f0db36ea1d60da54ec6c1180e4` | Stop exporting live signal ingestion from the worker package entry                                                            |
| `1b2161346c517a240c0d470c674998f79fdb6abf` | Make the MCP PostgreSQL seed obey migration 0009                                                                              |
| `9e22d27b4f4f423200f01c9dd9c44e76759ea2f0` | Keep the socket-bound MCP redirect test out of the Linux network-denial run, matching the MCP track's split                   |
| this commit                                | Correct the README documentation index and add this report                                                                    |

## 4. Conflict resolution

`git show --remerge-diff` reproduces every resolution below. None used a blanket `ours` or `theirs`. Each file was reconciled by its content.

| Merge | File                                                                                                       | Resolution                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `README.md`                                                                                                | layout table and documentation index carry both the evidence correction and the security tooling                                                                                                |
| 1     | `docs/DECISIONS.md`                                                                                        | the evidence correction keeps D26 and the security foundation keeps D27                                                                                                                         |
| 2     | `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`                                                    | Sheets sections added beside existing ones, nothing removed                                                                                                                                     |
| 3     | `apps/worker/src/index.ts`                                                                                 | Git merged cleanly but re-exported `ingestSnapshot`, a name the evidence correction removed; the build caught it, and the entry now exports the corrected file-ingest function without an alias |
| 3     | `apps/dashboard/src/test/seed-pipeline.ts`                                                                 | the test seed calls `ingestSnapshotFile` with `kind: 'file'` and `dataOrigin: 'replay'`                                                                                                         |
| 3     | `.env.example`, `package.json`                                                                             | dashboard variables added; `test:db` also runs the dashboard suite                                                                                                                              |
| 3     | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/SECURITY.md`, `docs/SPRINT-6-DASHBOARD-AUTH-HANDOFF.md` | the dashboard decision becomes D28, and only dashboard references are renumbered                                                                                                                |
| 4     | `docs/DECISIONS.md`, `docs/SPRINT_BOARD.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `README.md`       | the MCP decision becomes D29 with its two amendments; condensed README rows restored in full                                                                                                    |
| 4     | `packages/mcp-server/src/documentation.test.ts`                                                            | two assertions follow the renumbering: the amendment label reads D29, and the guard now asserts that no D30 exists                                                                              |
| 4     | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`                                                    | catalogs and manifests reconciled first; the lockfile regenerated, then confirmed with a frozen install; `verify` keeps the security foundation's stricter definition                           |
| 4     | `tools/checks/forbidden-files.ts`                                                                          | exact-path exemption for `packages/mcp-server/sql/mcp-reader-role.sql`, an operator script that creates a cluster role and must never become a migration                                        |
| 4     | `tools/checks/secrets.ts`                                                                                  | support files named `test-support.ts` and `db-support.ts` count as test files for the rules that skip tests                                                                                     |
| 4     | `tools/sandbox-probe.mjs`                                                                                  | executable bit removed; the probe runs as `node tools/sandbox-probe.mjs`                                                                                                                        |

The three scan changes were each proven narrow by falsification: a real RSA private key and a
GitHub token placed in the tree made the scan fail, and it passed again once they were removed.

## 5. Decision numbering

| Decision                                          | Subject                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ |
| D5 amendment, 2026-09-12                          | release naming                                               |
| D25                                               | evidence, anomaly and drafting design                        |
| D26                                               | evidence provenance bound in the schema; a claim is a record |
| D27                                               | security foundation                                          |
| D28                                               | dashboard and authentication                                 |
| D29, with amendments of 2026-09-10 and 2026-09-12 | MCP tooling                                                  |

The log runs from D1 to D29 with no gap or repeat. `D7a` and `D7b` were already present at the
accepted Sprint 4 base, and no D30 exists.

## 6. Migrations

No track adds a migration. Migration 0009 belongs to the evidence correction, and the dashboard's
PostgreSQL store has no number yet. Every checksum is identical at every merge and at the release
head.

| Migration                           | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| 0001 editorial ingestion            | `6ccf4b05cdcd255b326029e99097c73ec220fa77d38d767e86a40175abc8b936` |
| 0002 provenance integrity           | `4139f25cd5ca24746208c40cc3b65076c2bd9cccbc287e08880d508691d71b8d` |
| 0003 classification                 | `60d24e6ce016db85d6ff6f8f0066d5cad4641f156f3cb56fed1e452c0ac17dc6` |
| 0004 classification integrity       | `89763968c272d178a6a40c8f83ed5b28907c7e727393901ff99681b7b13ec719` |
| 0005 classification schema security | `f94c3342c1e2eb4d0d884a98b8afb8909d49d217fc0c3fdb094a3359004ae4de` |
| 0006 incident clustering            | `cb88b6a9ba6891cb211372f3542cf1fae78a11fdb3dfe442ae1ce777b0d860b2` |
| 0007 clustering integrity           | `1f066032ae936ce2b68be05c7d76e5c781e4d9277255bee0f5fd3da6e22d1449` |
| 0008 graph evidence                 | `548c810d925d113f2d5ab74f399d3dff9b22f9e144bd2202072489a030344449` |
| 0009 evidence integrity             | `b553eac744dedfed97e5eb247d0f82781daeb03455fba7a34203caca1cdec13a` |

Three database runs on PostgreSQL 17.10 exercised them:

- **From empty.** All nine applied, a second run was a no-op, and the drift check reported none.
- **Upgrade from the accepted Sprint 4 schema.** Migrations 0001 to 0007 were applied from commit
  `4a0a847` with the real migrator, then seeded with a master import, a weekly import, a
  classification run and a clustering run. The release migrator applied 0008 and 0009, and all
  thirteen prior tables kept identical row counts, among them 20 source rows, 12 classification
  results and 10 incidents. A replay snapshot then ingested cleanly over the old rows.
- **The PostgreSQL suites.** Section 13 gives the totals.

## 7. Dependency changes

| Package                    | Added                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cas/sheets-intake` (new) | no third-party dependency                                                                                                                                                                                                                                                           |
| `@cas/dashboard`           | `next` 16.3.4, `react` and `react-dom` 19.2.8, `argon2` 0.45.1, `hast-util-sanitize` 5.0.2, `hast-util-to-jsx-runtime` 2.3.6, `mdast-util-from-markdown` 2.0.3, `mdast-util-to-hast` 13.2.1, `server-only` 0.0.1; for development `@playwright/test` 1.63.0 and three type packages |
| `@cas/mcp-server`          | `@modelcontextprotocol/server` 2.0.0, `zod` 4.5.4; for development `@modelcontextprotocol/client` 2.0.0                                                                                                                                                                             |

`argon2` ships prebuilt binaries, so its install script stays refused. The bill of materials
grew from 197 to 326 third-party components: 258 carry a licence read from the installed
manifest, 66 are platform-constrained binaries, and 2 are unconstrained packages that no supported
platform installs. It reproduces byte for byte and agrees with pnpm's own generator on all 326.
`pnpm audit` reports no known vulnerability.

## 8. Configuration

`.env.example` is now one reference in six groups. Every name it declares is read by shipped
code, except the reserved `ANTHROPIC_API_KEY`, which the file marks as unread.

| Group                               | Names                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                          | `DATABASE_URL`                                                                                                                                  |
| Dashboard sessions                  | `DASHBOARD_ENVIRONMENT`, `DASHBOARD_ACCOUNT_STORE`, `DASHBOARD_MEMORY_STORE_SEED`, `DASHBOARD_DATABASE_SCHEMA`, `DASHBOARD_TRUST_FORWARDED_FOR` |
| Google Sheets read-only credentials | `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SHEETS_TAB_MAP`                                                       |
| Graph access                        | `GRAPH_API_KEY`, `GRAPH_GATEWAY_URL`                                                                                                            |
| MCP runtime                         | `CAS_MCP_MODE`, which was missing before                                                                                                        |
| Deployment configuration            | `CAS_COMMAND_DEADLINE_MS`, the reserved `ANTHROPIC_API_KEY`, and the categories that have no verified name yet                                  |

## 9. Naming and visual identity

The product and dashboard are **Latest in Cyber**, the weekly workflow is **Cyberattack Sunday**,
and the crypto-focused editorial feed is **Latest in Crypto**, which the interface calls a feed.
A D5 amendment records the change. Machine identifiers stay as they were: the repository name,
the `@cas/` scope and the MCP server name `cas-chainwatch-mcp`, which host configuration and the
skill contract tests depend on.

The palette puts off-white text on a deep navy ground (`#0d1b2e`), with sky blue, orange, yellow,
green and restrained magenta accents and pixel-style borders. Each text colour was measured
against both surfaces before use.

| Text colour         | On navy | On panel |
| ------------------- | ------- | -------- |
| off-white `#eef2f7` | 15.40:1 | 13.34:1  |
| muted `#a8b8cc`     | 8.57:1  | 7.42:1   |
| sky `#6fc3f7`       | 8.92:1  | 7.73:1   |
| orange `#ff9f4a`    | 8.50:1  | 7.36:1   |
| yellow `#ffd75e`    | 12.47:1 | 10.80:1  |
| green `#5fd68b`     | 9.46:1  | 8.19:1   |
| magenta `#ff7bc8`   | 7.35:1  | 6.37:1   |

The weakest pair clears the WCAG AA floor of 4.5:1, and the navy ground sits at 1.21:1 against
black, so the theme is not an all-black one. Focus shows a yellow outline, and reduced-motion and
forced-colours preferences are honoured. The dashboard review confirmed that the palette change
adds no external resource and no inline style, leaving the Content Security Policy, sanitization
and browser controls unchanged.

## 10. Google Sheets

The connector is **inactive**. Its pinned digest in `data/policy/authorized-workbook.json` is `null`, no Sheets variable is set, and every Sheets command refuses before loading a credential or making a request. No live request was made during integration. It calls the Sheets API alone, with the `spreadsheets.readonly` scope. The security review found no Drive host, path, scope or dependency, and no spreadsheet identifier, Sheet URL or service-account key in any of the 111 reachable commits.

## 11. Authentication and production state

- **Memory store.** It is refused at start-up unless `DASHBOARD_ENVIRONMENT` is `local`.
- **PostgreSQL store.** It is paused and fails with a fixed message. The dashboard must not be
  deployed until it exists and passes its own security tests.
- **Accounts.** None is provisioned, and no seed or credential file exists in the release tree.
  The browser suite creates three synthetic accounts with CSPRNG passwords in gitignored files. Its teardown deletes them and drops the schema, and a check after the run found nothing left.
  No fixed password literal appears in source, tests or documentation.
- **MCP.** The server speaks stdio only and binds no socket. Its production mode is the default.

## 12. Defects found and fixed during integration

1. **A clean merge undid an evidence correction.** The worker entry re-exported the removed `ingestSnapshot`, and merge 3 itself carries the fix.
2. **The committed bill of materials predated two merges,** and regenerating it failed on two
   packages no ordinary platform installs. The generator's first fix rested on a false premise. After the security review caught it, `23fcc6b0edc4c205f42f0efb688139647237b546` replaced it with a supported-platform rule and
   five tests.
3. **CI could not run for the release branch.** Fixed by `c4de9a4f32ed0960768e93990f2a49636d3608bc`.
4. **The MCP PostgreSQL seed broke two rules of migration 0009.** It wrote a live signal run naming
   a reserved-domain host, and it cited a source-row identifier as a claim. Every MCP database
   test failed during setup, so CI's database job would have failed. The seed now writes live
   rows with the official Graph gateway host and records a real claim, and one integration test
   asserts the recorded claim instead of the source-row identifier.
5. **Live ingestion was public.** The merge repair exported `ingestLiveEvaluations` from the worker
   entry, although its input is a plain object nothing outside the worker can prove came from the
   Graph client. `5065cbb221f3a9f0db36ea1d60da54ec6c1180e4` exports only the file path.
6. **A workflow merged cleanly but could not pass.** The security foundation's CI step ran the
   whole offline suite inside a network namespace whose loopback is down, which the MCP track's
   `redirect.stdio.test.ts` cannot survive because it serves synthetic redirects from a local
   listener. CI failed on its three tests. `9e22d27b4f4f423200f01c9dd9c44e76759ea2f0` mirrors the MCP track's split on Linux: the
   denial run excludes that one file, which still runs in CI's ordinary test step.
7. **The README was stale.** Its index named the log as D1 to D28 and omitted three documents,
   its CI paragraph omitted `release/*`, and it named a macOS command that no longer passes.

## 13. Verification

Each result names the commit it ran at. Later commits changed only what their rows say, and
section 3 lists every one.

**Local, macOS arm64, Node 24.21.0, pnpm 11.10.0, PostgreSQL 17.10.**

| Check                                                       | Commit    | Result                                                                                                                                                             |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frozen install and toolchain assertion                      | `c4de9a4` | lockfile already up to date; Node and pnpm match their pins                                                                                                        |
| Formatting, lint, type check, build                         | `c4de9a4` | all pass                                                                                                                                                           |
| Offline tests, uncached                                     | `c4de9a4` | 1,011 passed across 12 packages, MCP 208 among them                                                                                                                |
| Tooling tests                                               | `23fcc6b` | 30 passed                                                                                                                                                          |
| Worker tests after narrowing its exports                    | `5065cbb` | 231 passed; the dashboard typechecks against the rebuilt worker                                                                                                    |
| Strict network denial, macOS sandbox                        | `c4de9a4` | 803 tests across 11 packages and 204 MCP tests, uncached                                                                                                           |
| Loopback-only MCP redirect tests                            | `c4de9a4` | 4 passed                                                                                                                                                           |
| MCP setup and a raw stdio session under the offline sandbox | `c4de9a4` | catalogue digest `ebddcec863a546a7cfcc7a3050cf9a962f1a3d7b2046df0a7e9c863349502082` matches its pin; 4 tools listed; invalid arguments and an unknown tool refused |
| Browser tests against the production build                  | `c4de9a4` | 20 passed; no seed or credential file left                                                                                                                         |
| Migrations from empty, rerun, drift                         | `c4de9a4` | 9 applied, no-op, no drift                                                                                                                                         |
| Upgrade from the Sprint 4 schema with rows                  | `c4de9a4` | 0008 and 0009 applied; 13 prior tables unchanged                                                                                                                   |
| PostgreSQL suites                                           | `c4de9a4` | database 90, worker 108, dashboard 11 passed                                                                                                                       |
| MCP PostgreSQL suite                                        | `1b21613` | 47 of 49 passed, then 22 of 23 in isolation; see below                                                                                                             |
| Bill of materials check and cross-check                     | `23fcc6b` | reproduces byte for byte; agrees with pnpm on 326 components                                                                                                       |
| Dependency audit                                            | `c4de9a4` | no known vulnerability; the lockfile has not changed since                                                                                                         |
| Repository scans                                            | `9e22d27` | 483 files, no findings                                                                                                                                             |
| `git fsck --full` and `git diff --check`                    | `9e22d27` | clean                                                                                                                                                              |

The local MCP failures were timing assertions: a follow-up read under a one-second deadline, and a
connection count taken without waiting. They ran while other workloads held the machine's load
average above 200 on 8 cores. CI passed all 49 on an idle runner, which settles them as load.

**Continuous integration, GitHub Actions on ubuntu-latest.**

| Run                | Commit    | Result                                                                                                                                                                                                                                                         |
| ------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 34730693758     | `1b21613` | PostgreSQL integration passed: 9 migrations applied, no-op rerun, no drift, then database 90, worker 108, dashboard 11 and MCP 49. Supply chain passed. Verify failed in its network-denial step on the MCP redirect tests, which section 12 records as fixed. |
| CodeQL 34730693761 | `1b21613` | passed, with the ten open alerts section 14 explains                                                                                                                                                                                                           |
| CodeQL 34731238853 | `9e22d27` | passed; still ten open alerts, now analysed at this commit, so it added none                                                                                                                                                                                   |
| CI 34731238872     | `9e22d27` | all three jobs passed. Inside a network namespace proven to refuse even loopback, 20 test tasks ran uncached, then the MCP package's 204 tests. The PostgreSQL job and the supply-chain job passed again.                                                      |

This report's own commit follows `9e22d27`, so its CI run is stated in the handoff message rather
than here.

## 14. Security review

Three reviewers ran in fresh Claude sessions against a clean, detached checkout of `ad7224dd134a73d992fb19afc7dd54784ce2ae94`.
They could read and search but not edit, install, run scripts or reach the network, and the
checkout held no change when it was removed. One covered the dashboard and authentication, one the Google Sheets intake with the repository-scan exemptions, and one the database, worker, evidence, drafting, MCP server and bill-of-materials generator. Commits `23fcc6b0edc4c205f42f0efb688139647237b546`, `5065cbb221f3a9f0db36ea1d60da54ec6c1180e4` and the
seed fix came after the review and were not reviewed separately.

| Severity | Area         | Finding                                                                                                                                                                                                                                                                                                                                                                      | Disposition                                                    |
| -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| High     | dashboard    | A judge's draft preview shows source headlines, publishers and URLs, and any draft text an editor saved. The dashboard brief granted judges the preview, while `docs/THREAT_MODEL.md` (R9) and `docs/SECURITY.md` forbid unpublished drafts and source text for judges.                                                                                                      | owner decision; production blocker 1                           |
| Medium   | dashboard    | With no trusted proxy, every sign-in shares one throttle bucket, so one client can block all sign-ins in repeating 15-minute windows.                                                                                                                                                                                                                                        | production blocker 3                                           |
| Medium   | drafting     | Draft claims are built from source headlines and inherit the incident's evidence state, under source-row identifiers rather than recorded claims. Present in the corrected base, not introduced by a merge.                                                                                                                                                                  | production blocker 4                                           |
| Medium   | MCP          | The PostgreSQL seed violates migration 0009.                                                                                                                                                                                                                                                                                                                                 | fixed                                                          |
| Low      | dashboard    | the first `X-Forwarded-For` hop is trusted; sign-out reports success after a failed revocation; the cookie clear omits `Secure` and `Path`; a command-line password rotation does not reach a running memory store and can be overwritten; password length, action body size, revisions and decisions are unbounded                                                          | blocker 7, except the forwarded-for hop, which joins blocker 3 |
| Low      | Sheets       | the in-repository key refusal compares unresolved paths; no scan rule covers Sheets URLs, identifiers or service-account addresses; the digest exemption can shelter a key body through an interpolated constant; bidirectional and invisible characters are not escaped; `sheets timestamps` clamps rows silently and reads unpaginated                                     | blocker 6 for the first two, recorded for the rest             |
| Low      | MCP          | connection setup ignores cancellation, so an unreachable database holds concurrency slots; the privilege matrix misses PostgreSQL's built-in role memberships and other schemas, and the role template grants all of `source_rows`                                                                                                                                           | production blocker 5                                           |
| Low      | worker       | live ingestion exported from the package entry                                                                                                                                                                                                                                                                                                                               | fixed                                                          |
| Low      | supply chain | the inherited licence rule's premise                                                                                                                                                                                                                                                                                                                                         | fixed                                                          |
| Info     | several      | queue decisions are last-write-wins; the production guard relies on one self-declared variable; body-read failures are untyped; the redactor has defence-in-depth gaps; `runTimeoutMs` is not enforced; draft publication re-resolves paths after its symlink walk; a snapshot file is read without a size cap; the Graph probe follows redirects when no policy is supplied | recorded                                                       |

CodeQL analysed the release head and reports ten open alerts that it rates high. None was
introduced by integration: every flagged file is byte-identical to its track's head. Five sit in
the worker's limit tests and were already open on the security foundation branch. The other five
surfaced for the first time because only the security foundation carried the CodeQL workflow, so
the Sheets, dashboard and MCP code had never been analysed. Four of those are deliberate test
patterns: substring host filters over recorded requests, a `javascript:` assertion, and a
stat-then-read in a file-mode test. The fifth is real. `loadServiceAccountCredential` in
`packages/sheets-intake/src/credentials.ts` checks the key file's type, size and permissions,
then reads it again by path, so a local actor who can replace the file in between defeats those
checks. The connector is inactive, so the fix joins production blocker 6.

The reviewers found no authentication bypass, no object-ownership gap, no CSRF gap, no session
fixation, no unsafe Markdown or HTML rendering, no search-path shadowing, no cross-run or
cross-origin substitution, no path traversal in draft publication, and no production fallback to
memory state. The command line still refuses to ingest a file as live, a claim decision still
loads the claim record, and snapshot input stays closed.

## 15. Production blockers, in priority order

1. **Decide the judge's draft preview.** Either withdraw `view:draft` from the judge role, or
   replace the preview with one built from public metadata that never returns an editor's
   revision.
2. **Build the PostgreSQL store** for accounts, sessions, audit events, queue decisions and draft
   revisions, with its own security tests. The brief forbids deployment until it exists.
3. **Settle hosting and the trusted proxy (D8).** Key sign-in throttling on the right-most hop the
   proxy adds, and stop one shared bucket from locking out every user.
4. **Rebuild draft claims from recorded claims** before any draft is published or shown as
   evidence, attaching an evidence state only to the claim it cites.
5. **Harden the MCP reader role** before any production credential exists: refuse any role
   membership, check every non-system schema, grant `source_rows` by column, and bound connection
   setup by the call deadline.
6. **Prepare Sheets activation.** A human creates the service account and shares the one workbook. Before the first live read, the credential loader must open the key once and check that open handle, its repository check must resolve real paths, and a scan rule must cover Sheets URLs and identifiers. Only then is the digest pinned, in its own reviewed commit.
7. **Close the dashboard's lower findings:** cap password length before Argon2 and the action body
   size, bound stored revisions and decisions, report a failed sign-out, and clear the cookie with
   its original attributes.

## 16. Next build task

Build the dashboard's PostgreSQL store behind `DASHBOARD_ACCOUNT_STORE=postgres`, as migration
0010, after the owner settles blocker 1.

- **Schema.** Accounts, sessions stored as token hashes, append-only audit events, queue
  decisions and draft revisions, created with the repository's schema-security pattern:
  `pg_catalog.format` with quoted identifiers, a pinned `search_path`, and no `SECURITY DEFINER`.
  Composite foreign keys bind decisions and revisions to the runs they cite, and a CHECK keeps
  every judge row expiring.
- **Behaviour.** It implements the existing store interfaces so the data-access layer does not
  change, enforces draft-revision concurrency in the database, and removes the paused message
  only for this store. The memory store stays local-only.
- **Security tests.** The suite proves resistance to session fixation, rotation and revocation, immutable audit events and revisions, detected conflicts between concurrent revisions and decisions, no password or token at rest, a least-privilege application role, a clean upgrade from 0009 with populated tables, and drift detection.
- **Out of scope.** Provisioning any account, deploying, or reusing the compromised demonstration
  passwords.

## 17. Reproduction

On Node 24.21.0 with corepack, from a clean checkout of the release head:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm test:denied
corepack pnpm test:localhost
corepack pnpm supply-chain:check
corepack pnpm audit:deps
```

With a local PostgreSQL 17 and `DATABASE_URL` naming a database you control:

```bash
corepack pnpm db:migrate
corepack pnpm db:check
corepack pnpm test:db
corepack pnpm --filter @cas/dashboard test:browser
```
