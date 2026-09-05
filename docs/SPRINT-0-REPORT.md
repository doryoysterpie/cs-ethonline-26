# Sprint 0 report

Charter and readiness sprint for `doryoysterpie/cs-ethonline-26`. Written by the
implementation agent for the independent Codex audit. This file is part of the Sprint 0
commit, so it cannot contain that commit's own SHA or the clean-checkout results that run
after it; both are in the audit handoff message and in the branch's CI run.

## Result

`BLOCKED`.

Every safe implementation item in the charter is complete and verified in the working copy.
The result is `BLOCKED` rather than `PASS` because the charter requires it whenever
unresolved account or decision blockers remain: D1 needs human confirmation before Sprint 1,
D2, D7b, D8 and D9 are unresolved, and The Graph Studio account, required for Sprint 1, is
not checked. The submission-deadline conflict in `HACKATHON_REQUIREMENTS.md` is a further
human decision.

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

| ID  | Status                                            |
| --- | ------------------------------------------------- |
| D1  | PROVISIONAL; human confirmation before Sprint 1   |
| D2  | UNRESOLVED; Sprint 1 ranks candidates             |
| D3  | PROVISIONAL                                       |
| D4  | PROVISIONAL; confirmation before drafting work    |
| D5  | PROVISIONAL, repository name fixed                |
| D6  | PROVISIONAL                                       |
| D7  | SUPERSEDED by D7a and D7b                         |
| D7a | PROVISIONAL (provisionally decided)               |
| D7b | UNRESOLVED; due before Sprint 2                   |
| D8  | UNRESOLVED; local development recorded separately |
| D9  | UNRESOLVED                                        |
| D10 | PROVISIONAL timezone; timestamps UNRESOLVED       |

No provisional decision was promoted to accepted.

## Account readiness summary

`READY`: GitHub; Postgres (local development tooling). `NOT CHECKED`: The Graph Studio,
Graph Market or Substreams, Anthropic, Postgres (live target), deployment hosting.
`NOT REQUIRED BEFORE SPRINT 8`: Hedera testnet, Blocky402, Bazantic. Full matrix in
`ACCOUNT_READINESS.md`. No secret was read, printed or stored.

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
- The per-sprint calendar in `SPRINT_BOARD.md` is proposed within the charter's fixed
  controls. The event's stated submission deadline conflicts with those controls.
- The engineering-brain vault has no `01_Specs` folder for this project and its Codex
  charter restricts Codex to static review. Nothing was written to the vault; the charter
  restricted work to this repository.
- The repository has no `LICENSE` file; the licence is a human choice.
- The event's rule against "large single commits" is in tension with a single foundation
  commit made by instruction.

## Exact blockers requiring the project owner

1. Confirm D1 (Ethereum mainnet and Base) before Sprint 1.
2. Confirm The Graph Studio account and create an API key before Sprint 1.
3. Reconcile the submission deadline: event page says 13 September 12:00 EDT; charter says
   freeze 14 September, buffer 16 September.
4. Choose a licence so the open-source requirement can be met.
5. Decide D7b before Sprint 2; D9 before Sprint 4; D8 before Sprint 7.
6. Decide whether the single foundation commit should be split, given the event's
   commit-history rule.

## Readiness for Codex audit

Ready. The branch is self-contained: a fresh clone plus `pnpm install --frozen-lockfile`
and `pnpm verify` reproduces every working-copy result above. The vault's Codex charter
limits Codex to static review; the commands are therefore for the project owner or for CI,
whose run on this branch is the executable evidence.
