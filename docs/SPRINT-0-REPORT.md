# Sprint 0 report

Charter and readiness sprint for `doryoysterpie/cs-ethonline-26`. Written by the
implementation agent for the independent Codex audit. This file is part of the Sprint 0
commit, so it cannot contain that commit's own SHA or the clean-checkout results that run
after it; both are in the audit handoff message and in the branch's CI run.

## Result

`BLOCKED`, pending Codex audit of the remediation commit.

Every safe implementation item in the charter is complete and verified, and the audit
findings of 4 September are remediated (see the last section). The result stays `BLOCKED`
rather than `PASS` because the charter requires it whenever unresolved account or decision
blockers remain: The Graph Studio or provider account, required for Sprint 1, is not
checked, and D2, D7b, D8 and D9 are unresolved. D1 is resolved by D11, the licence by D12,
and the schedule by D14.

## Repository identity

| Field                 | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| Repository            | `doryoysterpie/cs-ethonline-26`, `https://github.com/doryoysterpie/cs-ethonline-26`     |
| Visibility            | `PUBLIC` (`gh repo view`, 4 September 2026 evening America/Toronto)                     |
| Created               | `2026-09-05T00:33:33Z`, which is 4 September 2026 20:33 EDT                             |
| Default branch        | `main`                                                                                  |
| Bootstrap commit      | `3011b5b50189a79181a9cf2d0c95724c019e5e74`, `chore: initialize repository`, README only |
| Starting SHA          | the bootstrap commit above                                                              |
| Implementation branch | `sprint-0/charter-readiness`, created from `origin/main` at the starting SHA            |
| Final SHA             | the commit that introduces this file                                                    |
| Author identity       | `doryoysterpie`, from the existing global Git configuration                             |

The bootstrap commit was made under a separate, explicit authorization from the project
owner because the repository had no branch. It contains exactly one file, `README.md`, with
one heading line.

## Starting state

At the starting SHA the repository contained `README.md` only. There was no package
manifest, lockfile, workflow, `CLAUDE.md` or `AGENTS.md`. No local clone existed before this
sprint; the clone at `~/cs-ethonline-26` was created for it. No uncommitted work existed to
isolate.

## Files added or changed

Changed: `README.md` (bootstrap heading kept as the title; body added).

Added, root: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`,
`tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`,
`.gitignore`, `.env.example`, `.nvmrc`, `.github/workflows/ci.yml`.

Added, thirteen workspace packages, each with `package.json`, `tsconfig.json`,
`tsconfig.build.json` and `src/index.ts`: `apps/dashboard`, `apps/worker`,
`apps/sunday-agent`, `apps/payer-agent`, `packages/contracts`, `packages/database`,
`packages/taxonomy`, `packages/classification`, `packages/clustering`,
`packages/graph-evidence`, `packages/mcp-server`, `packages/drafting`, `packages/feed-api`.

Added, tests: `packages/contracts/src/index.test.ts`, `apps/worker/src/index.test.ts`.

Added, data directories: `data/taxonomy/README.md`, `data/fixtures/README.md`.

Added, documentation: `docs/ARCHITECTURE.md`, `docs/DATA_INPUTS.md`,
`docs/PRIOR_INPUTS.md`, `docs/HACKATHON_REQUIREMENTS.md`, `docs/DECISIONS.md`,
`docs/ACCOUNT_READINESS.md`, `docs/SPRINT_BOARD.md`, `docs/SECURITY.md`, this file.

Deleted or renamed: nothing.

## What the code contains

- `@cas/contracts` exports two constant tuples with derived types: `REVIEW_STATES`
  (`selected`, `rejected`, `unreviewed`) and `DATA_ORIGINS` (`live`, `fixture`, `replay`).
  Both are fixed by the charter or its clarification. No behaviour.
- Every other package's `src/index.ts` is a documented placeholder containing `export {}`.
- Two tests: the contracts test pins the two enums; the worker test imports
  `@cas/contracts` through the workspace dependency and so proves the compilation and
  workspace boundary.

There is no Graph query, classifier, clustering logic, drafting logic, payment code,
dashboard feature, sponsor SDK or model SDK.

## Toolchain

| Concern    | Choice                                                    | Reason class       |
| ---------- | --------------------------------------------------------- | ------------------ |
| Node       | 24 (`.nvmrc`); v24.14.0 verified locally                  | charter, local     |
| pnpm       | 11.10.0, pinned in `packageManager`; verified locally     | cost judgment      |
| Turborepo  | 2.10.12                                                   | charter            |
| TypeScript | 6.0.3                                                     | compatibility need |
| ESLint     | 10.9.1 with `@eslint/js` 10.0.1, typescript-eslint 8.69.0 | preference         |
| Prettier   | 3.9.6                                                     | preference         |
| Vitest     | 4.1.11                                                    | preference         |

TypeScript is held at 6.0.3 because typescript-eslint 8.69.0 declares `typescript >=4.8.4
<6.1.0` and the 7.x line is the new native compiler. ESLint 10.10.0 and Vitest 5.0.0 were
published within the two days before this sprint and were not adopted. All versions resolve
through the pnpm catalog to one exact version each in `pnpm-lock.yaml` (lockfile version
9.0). pnpm 11.25.0 is available; 11.10.0 is the locally verified version and was pinned as
such.

## Commands executed and results, working copy

All commands ran in `~/cs-ethonline-26` on the implementation branch.

| Command                                             | Exit | Result                                                                    |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `pnpm install`                                      | 0    | 14 workspace projects, 132 packages, versions exactly as pinned           |
| `pnpm install --frozen-lockfile`                    | 0    | "Already up to date"                                                      |
| `pnpm config get minimumReleaseAge`                 | 0    | `1440`, control in effect                                                 |
| `pnpm format` then `pnpm format:check`              | 0    | "All matched files use Prettier code style!"                              |
| `pnpm lint`                                         | 0    | 16 files linted (confirmed with `eslint . --format json`), 0 messages     |
| `pnpm typecheck`                                    | 0    | 14 Turborepo tasks successful (13 typecheck plus the contracts build)     |
| `pnpm test`                                         | 0    | 2 test files, 3 tests passed; contracts build ran first as a dependency   |
| `pnpm build`                                        | 0    | 13 build tasks successful                                                 |
| `pnpm -r ls --depth -1`                             | 0    | 13 `@cas/*` packages plus the root                                        |
| `pnpm exec turbo ls`                                | 0    | 13 packages                                                               |
| credential pattern scan over all 77 candidate files | 0    | no credential-like strings                                                |
| tabular-file and CSV-row scan over the same files   | 0    | no `.csv`, `.xlsx`, `.xlsm` files; no CSV-shaped rows with ISO timestamps |
| `git status --short --untracked-files=all`          | 0    | only Sprint 0 files; `node_modules`, `dist`, `.turbo` ignored             |

`pnpm verify` chains format check, lint, typecheck, test and build and was run as the final
working-copy check before the commit; its result is in the handoff message.

## Decisions

| ID  | Status                                           |
| --- | ------------------------------------------------ |
| D1  | SUPERSEDED by D11                                |
| D2  | UNRESOLVED; Sprint 1 ranks candidates            |
| D3  | PROVISIONAL                                      |
| D4  | PROVISIONAL; confirmation before drafting work   |
| D5  | PROVISIONAL, repository name fixed               |
| D6  | PROVISIONAL                                      |
| D7  | SUPERSEDED by D7a and D7b                        |
| D7a | PROVISIONAL (provisionally decided)              |
| D7b | UNRESOLVED; due by 6 September, before Sprint 2  |
| D8  | UNRESOLVED; due by 10 September, before Sprint 7 |
| D9  | UNRESOLVED; due by 7 September, before Sprint 3  |
| D10 | PROVISIONAL timezone; timestamps UNRESOLVED      |
| D11 | ACCEPTED; chains and Graph route                 |
| D12 | ACCEPTED; Apache-2.0 licence                     |
| D13 | ACCEPTED; release-age exception policy           |
| D14 | ACCEPTED; corrected submission schedule          |
| D15 | ACCEPTED; classification before selection        |

D11 to D15 were appended on 4 September 2026 by the project owner's audit-remediation
instruction. No provisional decision was promoted to accepted by the implementer.

## Account readiness summary

`READY`: GitHub; Postgres (local development tooling). `NOT CHECKED`: The Graph Studio or
provider, Graph Market or Substreams (only if an optional path needs it), Anthropic, Postgres
(live target), deployment hosting, Hedera testnet, Blocky402, Bazantic. Full matrix with
re-cut deadlines in `ACCOUNT_READINESS.md`. No secret was read, printed or stored, and no
external account was marked ready without secret-free evidence.

## Deviations from the charter

1. **Bootstrap commit on `main`.** The charter forbade touching the default branch. The
   project owner separately and explicitly authorized one initial commit because the
   repository had no branch. It is the starting SHA, not Sprint 0 work.
2. **`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`.** Not requested. Added as a
   supply-chain control that refuses versions published in the last 24 hours. Remove if
   unwanted; nothing depends on it.
3. **`@cas/contracts` holds two real type contracts** rather than an empty placeholder. They
   are the minimum needed for a legitimate foundation test and for the shared-contract
   boundary the architecture document must describe. Both values are fixed by the charter.
4. **CI also runs on pushes to `sprint-*/**` branches**, so the audit branch gets a CI run
   without a pull request. The charter specified only the sequence, not the triggers.
5. **`pnpm verify` convenience script** chains the five checks. CI runs them individually.
6. **`.gitignore` excludes `output/`, `*.csv`, `*.xlsx`, `*.xlsm`, `data/raw/` and
   `data/private/`**, encoding D3 and the data-input rules as a mechanical guard. Fixture
   CSVs under `data/fixtures` remain allowed.
7. **`data/taxonomy/README.md` and `data/fixtures/README.md`** exist so that Git can hold
   the reserved directories; each states the directory's rules.
8. **No pull request was opened.** The charter allowed a branch or a pull-request URL;
   opening a pull request is an outward action not explicitly requested.
9. **Event material was read through an automated fetch** that returns an extracted
   summary. Quotations in `HACKATHON_REQUIREMENTS.md` are marked as extracted and need
   confirmation on the live page.

## Known limitations

- Every package except `@cas/contracts` is a placeholder. Nothing is a feature.
- The dependency graph declares one edge. All other edges in `ARCHITECTURE.md` are proposed.
- The per-sprint calendar in `SPRINT_BOARD.md` is cut against the official schedule (D14);
  the placement of the editable draft and MCP tooling inside Sprint 6 is noted there as a
  tension with the 10 September gate for the project owner to confirm.
- The event's commit-history rule presumes a single large commit without proper history
  unqualified unless proven otherwise. This repository's history is a bootstrap commit, a
  foundation commit and a remediation commit, each dated, and grows with every sprint. No
  history is rewritten.

## Exact blockers requiring the project owner

1. Confirm The Graph Studio or equivalent provider account and create an API key before
   Sprint 1 starts on 5 September.
2. Decide D7b by 6 September (before Sprint 2), D9 by 7 September (before Sprint 3), and D8
   by 10 September (before Sprint 7).
3. Confirm D3 and D4 before Sprint 6.
4. If Hedera or Bazantic are to be attempted, have the Hedera testnet, Blocky402 and
   Bazantic accounts ready by 10 September.

## Readiness for Codex audit

Ready. The branch is self-contained: a fresh clone plus `corepack pnpm install
--frozen-lockfile` and `corepack pnpm verify` reproduces every result above. The audit
policy is: Claude implements on sprint branches; Codex independently reviews diffs, installs
locked dependencies when appropriate, and reruns verification; neither agent merges to
`main` without the project owner's instruction.

## Audit remediation, 4 September 2026 (evening, America/Toronto)

Codex independently ran the locked install and the full verification suite on
`bae7f29b5d7e4ef7aee2c5965bea286c72abbc55` successfully, and the CI run for that commit
(`https://github.com/doryoysterpie/cs-ethonline-26/actions/runs/33936826532`) succeeded on
every step. The project owner then issued nine corrections. Each is addressed in the
remediation commit on `sprint-0/charter-readiness`, which follows the foundation commit
without rewriting it.

| #   | Correction                                            | Where it landed                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Official schedule in America/Toronto; re-cut calendar | D14; `SPRINT_BOARD.md`; README; `HACKATHON_REQUIREMENTS.md` section I; `ACCOUNT_READINESS.md` deadlines; this report                                                                                                                                                                              |
| 2   | Classification before selection                       | D15; `ARCHITECTURE.md` sections 1 to 4; `DATA_INPUTS.md` sections 1, 3, 4, 12; `SPRINT_BOARD.md`; `ClassificationDecision` contract and tests in `packages/contracts`                                                                                                                             |
| 3   | `DataOrigin` as execution context                     | Contract comments in `packages/contracts/src/index.ts`; `ARCHITECTURE.md` section 7; `SECURITY.md` section 4; contract tests; values unchanged                                                                                                                                                    |
| 4   | Graph strategy: either route; Messari schema primary  | D11; `HACKATHON_REQUIREMENTS.md` sections A and B; `SPRINT_BOARD.md` Sprint 1; `ACCOUNT_READINESS.md` Graph rows; feedback requirement withdrawn                                                                                                                                                  |
| 5   | Git-history rule paraphrased accurately               | `HACKATHON_REQUIREMENTS.md` finding 2 and rows E2 to E4; this report                                                                                                                                                                                                                              |
| 6   | Cross-project contamination removed                   | This report's limitations and readiness sections; `SPRINT_BOARD.md` standing rules; README audit policy. Repository-wide search: no engineering-brain, spec-folder or Codex-restriction language remains. D3's draft-destination wording is the project owner's own charter text and is unchanged |
| 7   | Apache-2.0 licence                                    | `LICENSE` (canonical text, sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`); `"license"` in `package.json`; README; D12                                                                                                                                                 |
| 8   | Release-age gate kept, narrow exception documented    | D13; `SECURITY.md` section 8; comment in `pnpm-workspace.yaml`                                                                                                                                                                                                                                    |
| 9   | Decisions appended, report updated                    | D11 to D15 with D1 marked superseded; this section; invalid Codex limitations removed                                                                                                                                                                                                             |

Verification of the remediation commit, working copy, run with the repository-pinned package
manager through `corepack pnpm`: recorded in the audit handoff message with exit codes, and
reproduced by the CI run on the pushed commit.
