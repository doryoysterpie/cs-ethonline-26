# Security-foundation track: report and Codex Desktop handoff

**Security-foundation track remains pending until Codex Desktop issues PASS.**
**Nothing from this branch has been deployed or merged.**

| Item              | Value                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch            | `parallel/s6-security-foundation`, pushed to `origin` only                                                                                          |
| Base              | Sprint 5 candidate `6fad82c3b03325101940d9ca25575d94550e7d25`                                                                                       |
| `main`            | `3011b5b50189a79181a9cf2d0c95724c019e5e74`, untouched, confirmed locally and remotely before work and after every push                              |
| Working copy      | A separate Git worktree, `~/cs-ethonline-26-s6-security`, never shared with another session                                                         |
| Sprint 5 status   | Not accepted: Codex Desktop returned CHANGES REQUIRED (F1 to F5) on 10 September 2026 while this track was being built                              |
| Coordination      | The Sprint 5 correction owner exclusively owns the draft-output finding; this track touched no drafting file and no migration                       |
| Decision reserved | D26 in the brief; recorded as **D27**, PROPOSED, because the Sprint 5 correction (`313db359`) appended its own D26 while this track was being built |
| Author identity   | `doryoysterpie`, additive commits only, no rebase, no amend, no force-push, no merge                                                                |

This report is written in the present tense of its own SHA and states its own figures; it
does not rewrite any earlier report. Section 12 is the reproduction for Codex Desktop.

## 1. Preflight

Confirmed before any change, on 10 September 2026:

- Remote `origin` is `https://github.com/doryoysterpie/cs-ethonline-26.git`, public; the
  active GitHub identity is `doryoysterpie` and the Git author is `doryoysterpie`.
- `6fad82c3b03325101940d9ca25575d94550e7d25` existed locally and as the remote head of
  `sprint-5/evidence-drafting`; `main` was `3011b5b50189a79181a9cf2d0c95724c019e5e74` locally
  and remotely; the working tree was clean; `parallel/s6-security-foundation` existed neither
  locally nor remotely; no pull request existed at all; no Sprint 5 merge existed.
- Baselines at the base SHA, from the runner and not estimated: 484 offline tests (contracts 9,
  taxonomy 7, database 24, classification 56, clustering 50, evidence 69, drafting 19,
  graph-evidence 102, worker 148); 173 PostgreSQL tests (database 81, worker 92); eight
  migrations, applied to a fresh database, rerun as a no-op, drift zero; contract hashes as
  recorded in D25.
- During the session the remote `sprint-5/evidence-drafting` moved from the base to
  `313db359c72ea305c03c30cc764ea67e51cbcec8`, the correction owner's work. Nothing from it was
  pulled into this branch, and this branch must later be rebased or rebuilt additively from
  whatever SHA Codex Desktop accepts.

## 2. Commits

Seven commits carry the track; an eighth, documentation only, adds this report and a wording
fix in the generated licence inventory. Its SHA is stated in the handoff message, not here,
because a report cannot name the commit that contains it.

| SHA                                        | Commit                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `ac725b5cfa19c0d4537f1e39c29dc128883989b2` | feat(contracts): publish versioned resource limits                                                      |
| `6599253cd61e6f12904cff2267040123203f952c` | feat(worker): enforce import limits and a command deadline                                              |
| `a0cfc9a558b6eeb53f32930469f29b08b47aeaa6` | feat(graph): bound provider responses while they stream                                                 |
| `9436852fd4c3505d50ee57e2406fc7d0ed7c891d` | feat(tools): add repository checks, toolchain pins and a reproducible bill of materials                 |
| `c618787ad8cfa115fe57436dd3c44eeb4ac8b7d7` | ci: add PostgreSQL, network-denial, supply-chain and CodeQL jobs                                        |
| `96fbc96421266b7a97811e56cc1befd796191a26` | docs: add the threat model, risk register, data classification, incident response and disclosure policy |
| `dad99397997c8c8e90d013209ba934947f0bd99a` | fix(tools): resolve the command path before entering the network namespace                              |

## 3. Changed files

53 files at `dad99397`, 11,951 insertions and 140 deletions against the base, plus this
report and one regenerated line in `supply-chain/LICENSES.md`.

| Area             | Files                                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts        | `packages/contracts/src/limits.ts` (new), `limits.test.ts` (new), `index.ts`                                                                                                                                                                                                                                          |
| Worker           | `apps/worker/src/editorial/csv-stream.ts`, `validate.ts`, `import.ts`, `errors.ts`, `limits.test.ts` (new), `limits.db.test.ts` (new); `apps/worker/src/deadline.ts` (new), `deadline.test.ts` (new); `cli.ts` (the `main` function and its header comment only); `index.ts`                                          |
| Graph client     | `packages/graph-evidence/src/bounded-body.ts` (new), `json-shape.ts` (new), `client.ts`, `errors.ts`, `index.ts`, `limits.test.ts` (new), `client.test.ts` (two existing tests now inject the body failure through the stream instead of `text()`, see section 11)                                                    |
| Tooling          | `tools/tsconfig.json`, `tools/vitest.config.ts`, `tools/checks/{hygiene,forbidden-files,secrets,workflows,toolchain}.ts`, `tools/checks/lib/{report,tracked}.ts`, `tools/checks/network-denial.sh`, `tools/checks/checks.test.ts`, `tools/supply-chain/{lockfile,sbom}.ts`, `tools/supply-chain/supply-chain.test.ts` |
| Supply chain     | `supply-chain/sbom.cdx.json` (new), `supply-chain/LICENSES.md` (new)                                                                                                                                                                                                                                                  |
| Toolchain and CI | `.nvmrc`, `package.json`, `pnpm-lock.yaml` (root importer gains `@types/node` 24.13.3, already in the lockfile; no new third-party version), `.prettierignore`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml` (new)                                                                                      |
| Documents        | `docs/THREAT_MODEL.md`, `RISK_REGISTER.md`, `DATA_CLASSIFICATION_RETENTION.md`, `INCIDENT_RESPONSE.md`, `VULNERABILITY_DISCLOSURE.md`, `SECURITY-FOUNDATION-REPORT.md` (all new); `SECURITY.md`, `DECISIONS.md` (D27), `ARCHITECTURE.md`, `SPRINT_BOARD.md`, `README.md`, `.env.example`                              |

**Not touched, by the coordination instruction and by ownership:** `packages/drafting/src/draft.ts`,
`apps/worker/src/drafting/generate.ts`, the `drafting generate` output handling in `cli.ts`,
any safe-writer or path-traversal test, `apps/worker/src/evidence/signals.ts`, every
migration (there is no `0009`), `apps/dashboard`, `packages/mcp-server`. No authentication,
MCP tool, Hedera, Bazantic, deployment or URL fetcher was added. The draft-file hardening the
brief listed was never started on this branch, so there is no work to preserve or report from
it beyond the declared, unenforced draft limits in `RESOURCE_LIMITS.draft`.

## 4. Migration and contract state

| Item                                    | State                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                              | Eight, `0001` to `0008`, unchanged; SHA-256 of `0008_graph_evidence.sql` `548c810d925d113f2d5ab74f399d3dff9b22f9e144bd2202072489a030344449`; no migration added                                                                                                                          |
| Fresh database (local, CI, fresh clone) | `db:migrate: applied=8 alreadyApplied=0 total=8`; rerun `applied=0 alreadyApplied=8 total=8 (no-op)`; `migrations: applied=8 pending=0 drift=0`                                                                                                                                          |
| Behaviour contracts                     | Unchanged: evidence `faabdade6fb05e0fd8a3f7dcf92807731da126642954e4ddcd9db28ac8dec873`, drafting `f89382d6794e77a90eb11df841de234421dee2a75651d1cb95187b29b6ddade3`, clustering `f0fc48b986959feb341b2762760a0e570186c84e8dfbf73c8d6eaf17bc0f8967` as printed by the real clustering run |
| New versioned constant                  | `resource-limits@1` in `@cas/contracts`, pinned value by value in `packages/contracts/src/limits.test.ts`                                                                                                                                                                                |
| Lockfile                                | SHA-256 `75f03314d8f0327f287486b305429dfb25fb94b3b3dd548a7cb5b77236e27abc`; 185 third-party packages, unchanged in versions                                                                                                                                                              |

## 5. Resource limits: measurements and selections

Measured on 10 September 2026 against real inputs; counts and bytes only, no content
retained. Every figure below was produced by a scratch measurement over the built worker's own
CSV stream and Graph client, or by the real commands themselves, and none was estimated.

### 5.1 Editorial exports

| File                         | Bytes       | Rows   | Header cells | Largest cell (bytes / chars) | Largest row (bytes) | Total cell bytes |
| ---------------------------- | ----------- | ------ | ------------ | ---------------------------- | ------------------- | ---------------- |
| Master (Cyberattack Sundays) | 119,643,204 | 23,910 | 9            | 48,456 / 48,329              | 97,135              | 118,603,091      |
| CS79                         | 155,199     | 157    | 9            | 11,947 / 11,850              | 12,250              | 152,429          |
| CS86                         | 149,523     | 181    | 7            | 9,553 / 9,439                | 9,791               | 146,618          |
| CS88                         | 117,396     | 160    | 7            | 13,787 / 13,673              | 14,036              | 115,190          |
| CS89                         | 291,292     | 143    | 9            | 15,485 / 15,321              | 17,590              | 287,074          |

### 5.2 Live Graph responses

Seven live standardized-TVL queries at the maximum snapshot count of 30 (the registry's five
Ethereum and two Base targets), 10 September 2026, through the pinned client with a measuring
`fetch`:

| Quantity                      | Observed                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------- |
| Decoded body bytes            | 4,287 to 4,446                                                                  |
| `Content-Length`              | absent on every response (`content-encoding: br`, `transfer-encoding: chunked`) |
| JSON nesting depth (root = 1) | 5                                                                               |
| Largest array / object        | 30 elements / 9 keys                                                            |
| Containers per document       | 37                                                                              |
| Longest string                | 66 characters                                                                   |
| Round trip                    | 111 to 386 ms                                                                   |

The absent length is the point: the limit is enforced on the decoded stream, and a declared
length is never the upper bound.

### 5.3 Drafts and commands

| Quantity                             | Observed                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real drafts (two)                    | Markdown 64,670 and 75,168 bytes; sidecars 79,009 and 92,779 bytes; 154 and 180 incidents; 154 and 181 claims; 4 sections (header, incidents, crypto, provenance) |
| `editorial validate`, master         | 6.7 s wall clock                                                                                                                                                  |
| `editorial import`, master, `replay` | 25,864 ms (`durationMs` as printed)                                                                                                                               |
| `classification run`, master batch   | 12,760 ms                                                                                                                                                         |
| `clustering run`, master batch       | 79,514 ms                                                                                                                                                         |

### 5.4 Selected limits (`resource-limits@1`)

Rule: at least four times the measured maximum, rounded up to a round figure, except the two
structural draft bounds. The multiple is the limit divided by the measurement.

| Limit                          | Value                          | Measured maximum | Multiple | Enforced by                                                                         |
| ------------------------------ | ------------------------------ | ---------------- | -------- | ----------------------------------------------------------------------------------- |
| `import.fileBytes`             | 536,870,912 (512 MiB)          | 119,643,204      | 4.5      | `csv-stream.ts` decoder, per chunk before hashing or decoding                       |
| `import.rowCount`              | 250,000                        | 23,910           | 10.5     | `csv-stream.ts` record loop, before the record reaches a handler                    |
| `import.columnCount`           | 64                             | 9                | 7.1      | `csv-stream.ts` header, before the header reaches a handler                         |
| `import.cellBytes`             | 1,048,576 (1 MiB)              | 48,456           | 21.6     | `csv-stream.ts`, UTF-8 bytes of every cell including header cells                   |
| `import.retainedBytes`         | 536,870,912 (512 MiB)          | 118,603,091      | 4.5      | `csv-stream.ts`, running sum of data-row cell bytes                                 |
| `import.recordBytes` (derived) | 67,108,864 = 64 × 1 MiB        | 97,135           | 691      | csv-parse `max_record_size`, mapped to the fixed limit message                      |
| `graph.responseBodyBytes`      | 1,048,576 (1 MiB)              | 4,446            | 236      | `bounded-body.ts`, while streaming; declared length refused above, distrusted below |
| `graph.httpErrorSnippetBytes`  | 4,096                          | not applicable   |          | `bounded-body.ts` truncate policy for non-2xx bodies only                           |
| `graph.jsonMaxDepth`           | 32                             | 5                | 6.4      | `json-shape.ts` linear scan before `JSON.parse`, walk after                         |
| `graph.jsonMaxCollectionSize`  | 4,096                          | 30               | 137      | `json-shape.ts` walk                                                                |
| `graph.jsonMaxCollections`     | 16,384                         | 37               | 443      | `json-shape.ts` walk                                                                |
| `graph.concurrentRequests`     | 8                              | 1                | 8        | `client.ts`, checked and raised synchronously before the first `await`              |
| `draft.sections`               | 4 (structural)                 | 4                | exact    | declared only; the draft writer is owned by the Sprint 5 correction                 |
| `draft.claims`                 | 10,000 = 500 × 20 (structural) | 181              | 55       | declared only                                                                       |
| `draft.outputBytes`            | 16,777,216 (16 MiB)            | 75,168           | 223      | declared only                                                                       |
| `draft.sidecarBytes`           | 16,777,216 (16 MiB)            | 92,779           | 181      | declared only                                                                       |
| `command.durationMs`           | 1,800,000 (30 min)             | 79,514           | 22.6     | `deadline.ts` through `cli.ts` `main`: abort, roll back, exit 124 after grace       |
| `command.graceMs`              | 5,000                          | not applicable   |          | `deadline.ts`                                                                       |

Behaviour on a crossed limit, everywhere it is enforced: a fixed message, numeric details
only, the whole input refused, nothing written, nothing truncated. The import limits apply to
both passes of the importer, so a file the structural pass admits is a file the import pass
admits. Draft limits are declared and explicitly not claimed as enforced.

## 6. Continuous integration

### 6.1 Workflows

| Workflow     | Jobs                                                                                                                                                                                                                                                                                                                              | Permissions                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ci.yml`     | `Verify` (toolchain assertion, format, lint, typecheck, test, tooling tests, repository scans, build, offline suite under network denial); `PostgreSQL integration` (fresh digest-pinned PostgreSQL 17.11, migrate, no-op rerun, drift, `test:db`); `Supply chain` (`pnpm audit`, bill-of-materials reproduction and cross-check) | `contents: read` at the top level; no job raises it          |
| `codeql.yml` | `Analyze (javascript-typescript)`, `build-mode: none`, `security-extended`, on push, pull request and weekly                                                                                                                                                                                                                      | `contents: read`; the job adds `security-events: write` only |

Branch filter: `main`, `sprint-*/**`, `parallel/**`, and every pull request. The service holds
no credential: `POSTGRES_HOST_AUTH_METHOD: trust` on the job's loopback, role `cas_ci`,
database `cas_ci`, `DATABASE_URL=postgresql://cas_ci@127.0.0.1:5432/cas_ci`. Each migration
step asserts the exact fixed line the command prints, with the expected count read from the
migrations directory, so a ninth migration changes the expectation rather than the assertion.

### 6.2 Pins

| Action or image                        | Pin                                                                                                                                                   | Version |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `actions/checkout`                     | `3d3c42e5aac5ba805825da76410c181273ba90b1`                                                                                                            | v7.0.1  |
| `pnpm/action-setup`                    | `0977fd99725f1db4007ccb2928dbb4e90d06cc86`                                                                                                            | v6.0.10 |
| `actions/setup-node`                   | `820762786026740c76f36085b0efc47a31fe5020`                                                                                                            | v7.0.0  |
| `github/codeql-action/init`, `analyze` | `cdf488f595d80d6e07e03d4674febd5ab45fa938` (tagged 2026-08-26; v4.38.0 of 2026-09-09 was not taken, being one day old)                                | v4.37.9 |
| `postgres`                             | `17.11@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675` (image index digest read from the registry; tag published 2026-08-26) | 17.11   |

`tools/checks/workflows.ts` refuses an unpinned action, an undigested image, a missing or
`write-all` permissions block, a `pull_request_target` or `workflow_run` trigger, and a
checkout that persists credentials; it runs in CI and in `pnpm verify`.

### 6.3 Runs

| Run                                                                                             | SHA        | Result                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CI 34493396882](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34493396882)     | `c618787a` | `PostgreSQL integration` success, `Supply chain` success, `Verify` failed at the network-denial step: the denial was proven, then `sudo` could not find `pnpm` on its secure path |
| [CodeQL 34493396966](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34493396966) | `c618787a` | success                                                                                                                                                                           |
| [CI 34498616799](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34498616799)     | `96fbc964` | same failure, documentation-only commit                                                                                                                                           |
| [CodeQL 34498616853](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34498616853) | `96fbc964` | success                                                                                                                                                                           |
| [CI 34499084584](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34499084584)     | `dad99397` | **success**, all three jobs, 15:58:10 to 15:59:33 UTC                                                                                                                             |
| [CodeQL 34499084527](https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/34499084527) | `dad99397` | **success**                                                                                                                                                                       |

Lines the successful run printed, verbatim:

```
toolchain: node=v24.21.0 pnpm=11.10.0 nvmrc=24.21.0 packageManager=pnpm@11.10.0
hygiene: scanned=285 findings=0 OK
forbidden-files: scanned=285 findings=0 OK
secrets: scanned=285 findings=0 OK
workflows: scanned=2 findings=0 OK
network-denial: proven (root network namespace, command run as runner); outside='connected' inside='error ENETUNREACH'; running: /home/runner/setup-pnpm/node_modules/.bin/bin/pnpm test --force
db:migrate: applied=8 alreadyApplied=0 total=8
db:migrate: applied=0 alreadyApplied=8 total=8 (no-op)
db:check: connected; serverVersion=17.11 (Debian 17.11-1.pgdg13+2); transport=loopback-tcp; passwordPresent=no; ssl=no
migrations: applied=8 pending=0 drift=0
No known vulnerabilities found
cross-check: pnpm=185 own=185 extraEdgesHere=95 AGREE
sbom: components=185 workspace=14 licensed=152 platformConstrained=33 lockfileSha256=75f03314d8f0327f287486b305429dfb25fb94b3b3dd548a7cb5b77236e27abc CHECK OK
```

The CI run for the documentation commit that adds this report is named in the handoff
message.

## 7. Repository settings the owner must decide (read-only observation, 10 September 2026)

Observed through the GitHub API with a read-only query; nothing was changed, because agents
never touch repository settings.

| Setting                                                | Observed                      | Recommendation                                                                                        |
| ------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Secret scanning                                        | disabled                      | Enable (free on public repositories)                                                                  |
| Secret scanning push protection                        | disabled                      | Enable                                                                                                |
| Secret scanning non-provider patterns, validity checks | disabled                      | Enable non-provider patterns; validity checks at the owner's discretion                               |
| Dependabot security updates                            | disabled                      | Enable alerts at least; updates would open pull requests that the 24-hour gate and Codex still govern |
| Vulnerability alerts                                   | not enabled                   | Enable                                                                                                |
| Private vulnerability reporting                        | not verified                  | Enable, so `VULNERABILITY_DISCLOSURE.md` can point at the button                                      |
| Branch protection on `main`                            | none                          | Require the `Verify`, `PostgreSQL integration` and `Supply chain` checks and forbid force pushes      |
| Actions: require SHA pinning                           | `sha_pinning_required: false` | Enable; the workflows already comply                                                                  |
| Actions: default workflow permissions                  | `read`                        | Keep                                                                                                  |
| Code scanning default setup                            | not configured                | Keep unconfigured while `codeql.yml` exists; the two conflict                                         |

The first-party scans in CI are the readiness step and run whether or not these are enabled.

## 8. Toolchain reproducibility

| Item             | State                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node             | `.nvmrc` = `24.21.0` (released 2026-09-07, the current 24 line; installed locally through nvm with a matched SHA-256); `engines.node` = `>=24.21.0 <25`; `actions/setup-node` reads the file with `check-latest: false`                                                                                                                                                                                         |
| pnpm             | `packageManager` = `pnpm@11.10.0` (published 2026-07-04); `pnpm/action-setup` reads it                                                                                                                                                                                                                                                                                                                          |
| Integrity suffix | **Blocker, reproduced.** `pnpm@11.10.0+sha512.C3+LmAY…` is what corepack and `pnpm/action-setup` accept, but pnpm 11.10.0 itself refuses to run with it: `Invalid package manager specification in package.json (...); expected a semver version`, with and without `managePackageManagerVersions: false`. The pin is the exact version alone; the check accepts the suffix so it can be adopted when pnpm does |
| Assertion        | `tools/checks/toolchain.ts` fails when the running Node is not `v24.21.0`, the pnpm on the path is not `11.10.0`, `.nvmrc` is not exact, `packageManager` is not exact, or `engines.node` does not name that line; first step of every CI job                                                                                                                                                                   |
| Tooling runtime  | `tools/**/*.ts` runs under Node's built-in type stripping (no build step, no dependency); `tools/tsconfig.json` sets `erasableSyntaxOnly` so the sources stay runnable that way; the root gains `@types/node` for its typings only                                                                                                                                                                              |
| Local sandbox    | `tools/offline-sandbox.sb` (macOS `sandbox-exec`, unchanged); `tools/checks/network-denial.sh` (Linux) added                                                                                                                                                                                                                                                                                                    |

## 9. Supply chain

| Item                                     | Result                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit --audit-level=low`           | No known vulnerabilities; 185 packages, 20 direct                                                                                                                                                                                                                                                                                                                                            |
| Release-age policy                       | `minimumReleaseAge: 1440` unchanged; no D13 exception; no new third-party version installed                                                                                                                                                                                                                                                                                                  |
| Bill of materials                        | `supply-chain/sbom.cdx.json`, CycloneDX 1.6: 185 third-party components with SHA-512 hashes and package URLs, 14 workspace components and the root, 200 dependency entries; no timestamp, no serial number; `cas:lockfile:sha256` property carries the lockfile hash                                                                                                                         |
| Schema validation                        | Validated in a scratch Python environment against the CycloneDX specification schema set at tag `1.6.1` (`bom-1.6.schema.json`, `spdx.schema.json`, `jsf-0.82.schema.json`) with `jsonschema` Draft 7: **0 errors**, 199 components, 200 dependencies. The validator is not in the repository                                                                                                |
| Cross-check                              | pnpm's built-in `pnpm sbom --sbom-format cyclonedx --sbom-spec-version 1.6 --lockfile-only` lists the same 185 components; every edge it records is present here; this document carries 95 additional edges (resolved peer dependencies the lockfile records and pnpm's generator drops; for `pg@8.23.0` pnpm's generator also omits two regular dependencies, `pg-protocol` and `pg-types`) |
| Why not pnpm's generator as the artifact | Its output changes on every run (fresh `metadata.timestamp`, random `serialNumber`), carries no licence in lockfile-only mode and no `hashes` on components; it is the cross-check                                                                                                                                                                                                           |
| Licence inventory                        | `supply-chain/LICENSES.md`: 152 packages licensed from installed manifests (MIT 114, Apache-2.0 15, BSD-2-Clause 10, ISC 9, BSD-3-Clause 2, BlueOak-1.0.0 1, MPL-2.0 1); 33 platform-constrained optional binaries listed with their constraint and optional parent, licence not inventoried offline by design so the document is identical on every platform                                |
| Reproducibility                          | Regenerated in CI on Linux and in a fresh clone on macOS: byte-identical, SHA-256 `c73194fdbb2a994b7b71cdaf85fab80df1646f879085cc7f33743034db55af4e`                                                                                                                                                                                                                                         |
| Lifecycle scripts                        | Not disabled (`ignore-scripts` unset); recorded as risk K6 for the owner                                                                                                                                                                                                                                                                                                                     |

## 10. Tests

| Package or suite           | Base | Now | Added                                                                                                                                                                                                                                             |
| -------------------------- | ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cas/contracts`           | 9    | 16  | `limits.test.ts`: 7                                                                                                                                                                                                                               |
| `@cas/taxonomy`            | 7    | 7   |                                                                                                                                                                                                                                                   |
| `@cas/database`            | 24   | 24  |                                                                                                                                                                                                                                                   |
| `@cas/classification`      | 56   | 56  |                                                                                                                                                                                                                                                   |
| `@cas/clustering`          | 50   | 50  |                                                                                                                                                                                                                                                   |
| `@cas/evidence`            | 69   | 69  |                                                                                                                                                                                                                                                   |
| `@cas/drafting`            | 19   | 19  |                                                                                                                                                                                                                                                   |
| `@cas/graph-evidence`      | 102  | 122 | `limits.test.ts`: 20 (exact bound, streaming overrun, lying and missing lengths, absent body, UTF-8, snippet truncation, transport failure classification, depth, collection size and count, concurrency, slot release)                           |
| `@cas/worker` offline      | 148  | 167 | `editorial/limits.test.ts`: 12 (each limit at bound minus one, exact, plus one; refusal at the crossing chunk; UTF-8 bytes versus string length; header cells; non-reflection; validation command; fixture under defaults); `deadline.test.ts`: 7 |
| **Offline total**          | 484  | 530 |                                                                                                                                                                                                                                                   |
| Tooling (`test:tools`)     | 0    | 25  | `checks.test.ts`: 17 (clean tree and planted defects per check, disposable Git repositories); `supply-chain.test.ts`: 8                                                                                                                           |
| `@cas/database` PostgreSQL | 81   | 81  |                                                                                                                                                                                                                                                   |
| `@cas/worker` PostgreSQL   | 92   | 95  | `editorial/limits.db.test.ts`: 3 (no partial write under a row limit and a cell limit; whole import under defaults)                                                                                                                               |
| **PostgreSQL total**       | 173  | 176 |                                                                                                                                                                                                                                                   |

Adversarial conditions the brief asked for and where each is proven: boundary minus one,
exact bound, bound plus one (`apps/worker/src/editorial/limits.test.ts`,
`packages/graph-evidence/src/limits.test.ts`); streaming overrun and missing or lying lengths
(`packages/graph-evidence/src/limits.test.ts`); rollback and no partial write
(`apps/worker/src/editorial/limits.db.test.ts`; the deadline's abort path reuses the
existing interrupt rollback proven in `import.db.test.ts`); large Unicode input
(`limits.test.ts`, four-byte characters measured in bytes); error non-reflection (every
refusal in both files, with a planted marker); concurrent creation of the same file
(`packages/graph-evidence` concurrency cap for requests; file creation belongs to the draft
writer, not touched). Traversal and symlink substitution are the Sprint 5 correction's and
are not claimed here.

## 11. Judgement calls and deviations

1. **Draft-file hardening was excluded**, per the coordination instruction. It was not
   started, so nothing was preserved or discarded. The draft limits are declared in
   `RESOURCE_LIMITS.draft` and the report says everywhere that they are unenforced.
2. **`apps/worker/src/evidence/signals.ts` was left untouched** although snapshot ingestion is
   an input boundary, because audit findings F1 and F4 both change that file. The bounded
   reader and bounded JSON parser are exported from `@cas/graph-evidence` for the correction
   to reuse; the gap is risk K4.
3. **`cli.ts` was edited only in `main` and its header comment**, far from the evidence and
   drafting blocks the correction owns; the command deadline lives in a new module.
4. **Two existing Graph client tests were changed** (`client.test.ts`,
   `responseWithFailingBody`): they injected a body failure by overriding `response.text()`,
   which the streaming reader no longer calls, so they now inject it through the body stream.
   The behaviour they assert is unchanged. Codex should read that diff as a harness change,
   not a weakening.
5. **A credential-free CI database** rather than a synthetic password: trust authentication on
   the job's own loopback means the workflow file carries no password at all, which keeps
   `SECURITY.md` section 2 literally true. Section 11 of that document was updated to say CI
   now runs a database with no secret.
6. **The pnpm integrity suffix was not adopted** (section 8); the exact version is the pin.
7. **`@types/node` was added to the root manifest** so `tools/` typechecks; the lockfile
   diff is one importer entry and no new version.
8. **pnpm's built-in `sbom` command shadowed a script of the same name**, so the scripts are
   `supply-chain:generate` and `supply-chain:check`; the first generated inventory carried the
   old names in its heading and was regenerated in the final commit.
9. **The 24-hour policy was respected for actions too**: CodeQL v4.38.0, one day old at pin
   time, was passed over for v4.37.9.
10. **D27 is PROPOSED**, not ACCEPTED: the owner has not confirmed it and the track is
    unaudited.
11. **The cross-check treats pnpm's edge set as a subset requirement**, because pnpm's
    generator was observed to drop edges the lockfile records (section 9); a stricter equality
    would have failed on pnpm's omissions rather than on a defect here.

12. **D26 became D27.** The brief reserved D26; the Sprint 5 correction branch appended a D26 of its own (`313db359c72ea305c03c30cc764ea67e51cbcec8`, "Evidence provenance is bound in the schema, and a claim is a record") while this track was being built. Every reference on this branch was renumbered to D27 before any rebase so the two logs can merge without a collision; the correction's D26 was not read into this branch.

## 12. Reproduction for Codex Desktop

At the final SHA named in the handoff, in a fresh clone, with Node 24.21.0 and pnpm 11.10.0:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:toolchain
corepack pnpm verify
```

`verify` runs `format:check`, `lint`, `typecheck` (packages and `tools/`), `test` (530
offline tests across nine packages), `test:tools` (25), `check:repo` (four scans, 285 tracked
files at the time of writing, zero findings) and `build`. Then, with a fresh database named by
`DATABASE_URL` (no password needed locally):

```bash
corepack pnpm db:migrate && corepack pnpm db:migrate && corepack pnpm db:check
corepack pnpm test:db
```

Expected: `applied=8 alreadyApplied=0 total=8`, then `applied=0 alreadyApplied=8 total=8
(no-op)`, then `migrations: applied=8 pending=0 drift=0`; 81 database and 95 worker
PostgreSQL tests. Then:

```bash
corepack pnpm audit:deps
corepack pnpm supply-chain:check
```

Expected: no known vulnerabilities; `cross-check: pnpm=185 own=185 extraEdgesHere=95 AGREE`;
`CHECK OK`. Network denial: on Linux `corepack pnpm test:offline-enforced`; on macOS
`sandbox-exec -f tools/offline-sandbox.sb corepack pnpm test --force` after proving the
denial with the probe in that file's comment. Both were run on 10 September 2026: the Linux
form in CI run 34499084584, the macOS form locally with the probe reporting `EPERM` and all
nine packages passing (530 tests) inside the sandbox.

Fresh-checkout reproduction performed on 10 September 2026 at `dad99397`, cloned from the
public remote into a scratch directory: frozen install, toolchain assertion, `verify`,
migrations on a fresh database (8, no-op, drift 0), `test:db` (81 and 95),
`supply-chain:check` (AGREE, CHECK OK), and a byte-identical bill of materials. The final
commit after that reproduction is documentation and one regenerated inventory line.

## 13. Threat-model coverage

`THREAT_MODEL.md` covers the eleven scenarios the brief named, each as an abuse case with
adversary, attempt, mitigations mapped to tests, and what remains:

| Scenario                   | Abuse case | Mitigations                   | Residual             |
| -------------------------- | ---------- | ----------------------------- | -------------------- |
| Malicious RSS publisher    | AC1        | M1, M2, M3, M4, M5, M6        | RR3, RR13            |
| Compromised feed row       | AC2        | M7, M8, M9                    | RR1, RR6             |
| Malicious CSV              | AC3        | M2, M5, M10                   | operator-chosen path |
| Compromised Graph endpoint | AC4        | M2, M11, M12, M13             | RR4                  |
| Stolen provider key        | AC5        | M2, M14, M15, M16             | RR7, RR8             |
| Malicious dashboard user   | AC6        | requirements only (not built) | future               |
| Malicious MCP client       | AC7        | requirements only (not built) | future               |
| Compromised dependency     | AC8        | M17, M18, M19, M20, M21       | RR9, RR10            |
| Database operator          | AC9        | M9, M22, M23, M24             | RR6                  |
| Payment replay             | AC10       | requirements only (not built) | future               |
| Editorial error            | AC11       | M6, M25, M26                  | RR2, RR5             |

The model also lists ten assets, eleven boundaries, eleven roles, ten entry points, seven
flows, six external dependencies, eleven adversary capability profiles, twenty-eight
mitigations each mapped to a test or a CI job, and thirteen residual risks; `RISK_REGISTER.md`
carries twenty entries with owner, status, next action and review date.

## 14. Residual risks and deferred items

- F1 to F5 of the Sprint 5 audit remain open and belong to the Sprint 5 correction; this
  track neither fixed nor touched them (K1 to K4).
- Draft limits are declared, not enforced (K3).
- Snapshot-file ingestion has no byte or shape limit yet; the bounded reader and parser are
  available for the correction to apply (K4).
- GitHub's own secret scanning, push protection, alerts, private reporting, branch protection
  and required SHA pinning are off; only the owner can enable them (K5, section 7).
- Dependency lifecycle scripts run at install (K6).
- The pnpm integrity suffix is a documented blocker (K12); Node 25's removal of corepack is
  a documented future change (K13).
- Licences of 33 platform-constrained optional binaries are not inventoried offline (K15).
- This branch must be rebased or rebuilt additively from the Codex-accepted Sprint 5 SHA and
  audited on its own before anything in it is relied upon (K20).

**Security-foundation track remains pending until Codex Desktop issues PASS.**
**Nothing from this branch has been deployed or merged.**
