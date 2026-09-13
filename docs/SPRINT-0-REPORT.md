# Sprint 0 report

Charter and readiness sprint for `doryoysterpie/cs-ethonline-26`, written by the
implementation agent for the independent Codex audit. Sprint 0 spans three commits on
`sprint-0/charter-readiness`: the foundation commit, the audit-remediation commit and the
final correction commit that introduces this revision. A file cannot contain the SHA of the
commit that adds it, so the final correction's SHA and its verification results are in the
audit handoff message and in the branch's CI run. Sections marked **historical** describe an
earlier commit and must not be read as the current repository state.

## Result

`BLOCKED`, pending Codex audit of the final correction commit.

Every implementation item in the charter is complete and verified, the audit findings of
4 September are remediated, and the final documentation corrections are applied. The result
stays `BLOCKED` rather than `PASS` because the charter requires it whenever unresolved
account or decision blockers remain: Subgraph Studio or equivalent live Graph provider
access, required for Sprint 1, is not checked, and D2, D7b, D8 and D9 are unresolved. D1 is
resolved by D11, the licence by D12, the schedule by D14 and D16.

## Repository identity

| Field                 | Value                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Repository            | `doryoysterpie/cs-ethonline-26`, `https://github.com/doryoysterpie/cs-ethonline-26`                |
| Visibility            | `PUBLIC` (`gh repo view`, 4 September 2026, America/Toronto)                                       |
| Created               | `2026-09-05T00:33:33Z`, which is 4 September 2026 20:33 EDT                                        |
| Default branch        | `main`, at the bootstrap commit                                                                    |
| Bootstrap commit      | `3011b5b50189a79181a9cf2d0c95724c019e5e74`, `chore: initialize repository`, README only            |
| Foundation commit     | `bae7f29b5d7e4ef7aee2c5965bea286c72abbc55`, `chore: establish ETHOnline project foundation`        |
| Remediation commit    | `0e43135b63edd81b455b361011ceae295f549d05`, `fix: remediate sprint 0 audit findings`               |
| Final correction      | `fix: close sprint 0 audit findings`, the commit that introduces this revision; SHA in the handoff |
| Implementation branch | `sprint-0/charter-readiness`, created from `origin/main` at the bootstrap commit                   |
| Author identity       | `doryoysterpie`, from the existing global Git configuration                                        |

The bootstrap commit was made under a separate, explicit authorization from the project
owner because the repository had no branch. It contains exactly one file, `README.md`, with
one heading line.

## Current state of the code

- `@cas/contracts` exports three constant tuples with derived types: `REVIEW_STATES` and
  `ReviewState` (`selected`, `rejected`, `unreviewed`), the human review state;
  `CLASSIFICATION_DECISIONS` and `ClassificationDecision` (`include`, `exclude`, `review`),
  the machine decision; and `DATA_ORIGINS` and `DataOrigin` (`live`, `fixture`, `replay`),
  the execution and data context. No behaviour.
- Tests: four contract tests in `packages/contracts/src/index.test.ts`, which pin the three
  value sets and prove that `ReviewState` and `ClassificationDecision` share no value and
  are distinct types; and one worker test in `apps/worker/src/index.test.ts`, which imports
  `@cas/contracts` through the workspace dependency. Five tests in total, in two files.
- Every other package's `src/index.ts` is a documented placeholder containing `export {}`.
  The dashboard placeholder does not scaffold Next.js, which Plan 2.0 fixes for Sprint 6.
- Root metadata declares `"license": "Apache-2.0"`, and `LICENSE` holds the canonical
  Apache License 2.0 text (sha256
  `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`).
- The workspace declares one dependency edge, `@cas/worker` on `@cas/contracts`.

There is no importer, Graph query, classifier, clustering logic, drafting logic, payment
code, dashboard feature, sponsor SDK or model SDK. No dependency was added after the
foundation commit.

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

## Current verification record

Remediation commit `0e43135b`, working copy, run through `corepack pnpm` 11.10.0:

| Command                                   | Exit | Result                                                |
| ----------------------------------------- | ---- | ----------------------------------------------------- |
| `corepack pnpm install --frozen-lockfile` | 0    | lockfile up to date; supply-chain policy check passed |
| `corepack pnpm format:check`              | 0    | all matched files use Prettier style                  |
| `corepack pnpm lint`                      | 0    | clean                                                 |
| `corepack pnpm typecheck`                 | 0    | 14 tasks                                              |
| `corepack pnpm test`                      | 0    | 2 files, 5 tests passed                               |
| `corepack pnpm build`                     | 0    | 13 tasks                                              |
| `corepack pnpm verify`                    | 0    | full chain                                            |
| `git diff --check`                        | 0    | no whitespace errors                                  |
| CI run 33938846371 on `0e43135b`          |      | success on every step                                 |
| `git diff --shortstat bae7f29b..0e43135b` | 0    | 17 files changed, 916 insertions, 359 deletions       |

Codex independently ran the locked install and the full verification suite on the foundation
commit `bae7f29b` successfully before remediation.

The final correction commit's verification, run with the same commands before committing, is
recorded with exit codes in the audit handoff message and reproduced by the CI run on the
pushed commit. Diff statistics for that commit are computed from Git in the handoff.

## Decisions

| ID  | Status                                                                      |
| --- | --------------------------------------------------------------------------- |
| D1  | SUPERSEDED by D11                                                           |
| D2  | UNRESOLVED; Sprint 1 ranks candidates                                       |
| D3  | PROVISIONAL; confirmation by 8 September, before Sprint 5                   |
| D4  | PROVISIONAL; confirmation by 8 September, before Sprint 5                   |
| D5  | PROVISIONAL, repository name fixed                                          |
| D6  | PROVISIONAL                                                                 |
| D7  | SUPERSEDED by D7a and D7b                                                   |
| D7a | PROVISIONAL (provisionally decided)                                         |
| D7b | UNRESOLVED; due by 5 September, before Sprint 2                             |
| D8  | UNRESOLVED; due by 10 September, before Sprint 8                            |
| D9  | UNRESOLVED; due by 6 September, before Sprint 3                             |
| D10 | PROVISIONAL timezone; timestamps UNRESOLVED                                 |
| D11 | ACCEPTED; chains and Graph route                                            |
| D12 | ACCEPTED; Apache-2.0 licence                                                |
| D13 | ACCEPTED; release-age exception policy                                      |
| D14 | ACCEPTED; official milestones stand, per-sprint due dates superseded by D16 |
| D15 | ACCEPTED; classification before selection                                   |
| D16 | ACCEPTED; gate-aligned implementation sequence                              |

D11 to D16 were appended on 4 September 2026 by the project owner's instructions. No
provisional decision was promoted to accepted by the implementer.

## Account readiness summary

`READY`: GitHub; Postgres (local development tooling, first needed in Sprint 2).
`NOT CHECKED`: Subgraph Studio or equivalent live Graph provider access, Graph Market or
Substreams (only if an optional path requires it), Anthropic, Postgres (live target),
deployment hosting. `NOT REQUIRED BEFORE SPRINT 8`: Hedera testnet, Blocky402, Bazantic, all
also unchecked. Full matrix with deadlines in `ACCOUNT_READINESS.md`. No secret was read,
printed or stored, and no external account was marked ready without secret-free evidence.

## Known limitations

- Every package except `@cas/contracts` is a placeholder. Nothing is a feature.
- The dependency graph declares one edge. All other edges in `ARCHITECTURE.md` are proposed.
- The per-sprint calendar in `SPRINT_BOARD.md` follows D16. The 10 September gate requires
  all six deliverables complete and demonstrable; the board no longer schedules any of them
  past the gate.
- The event's commit-history rule presumes a single large commit without proper history
  unqualified unless proven otherwise. This repository's history is a bootstrap commit, a
  foundation commit, a remediation commit and a final correction commit, each dated, and
  grows with every sprint. No history is rewritten.

## Exact blockers requiring the project owner

1. Confirm Subgraph Studio or equivalent live Graph provider access and create an API key
   before Sprint 1 starts on 5 September.
2. Decide D7b by 5 September (before Sprint 2), D9 by 6 September (before Sprint 3), D3 and
   D4 by 8 September (before Sprint 5), and D8 by 10 September (before Sprint 8).
3. If Hedera or Bazantic are to be attempted, have the Hedera testnet, Blocky402 and
   Bazantic accounts ready by 10 September.

## Readiness for Codex audit

Ready. The branch is self-contained: a fresh clone plus `corepack pnpm install
--frozen-lockfile` and `corepack pnpm verify` reproduces every result above. The audit
policy is: Claude implements on sprint branches; Codex independently reviews diffs, installs
locked dependencies when appropriate, and reruns verification; neither agent merges to
`main` without the project owner's instruction.

## Historical: the foundation commit `bae7f29b`

The sections below describe the foundation commit as it was audited. They are kept as the
record of that commit and do not describe the current repository state.

### Starting state

At the bootstrap commit the repository contained `README.md` only. There was no package
manifest, lockfile, workflow, `CLAUDE.md` or `AGENTS.md`. No local clone existed before this
sprint; the clone at `~/cs-ethonline-26` was created for it. No uncommitted work existed to
isolate.

### Files added or changed by the foundation commit

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

Deleted or renamed: nothing. 78 files, 3,735 insertions, 0 deletions.

### What the foundation commit's code contained

At that commit `@cas/contracts` exported two tuples, `REVIEW_STATES` and `DATA_ORIGINS`, and
the test suite held two contract tests and one worker test, three tests in total. The
remediation commit added `CLASSIFICATION_DECISIONS` and two contract tests; see "Current
state of the code" above for the present counts.

### Foundation verification, working copy

| Command                                             | Exit | Result                                                                    |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| `pnpm install`                                      | 0    | 14 workspace projects, 132 packages, versions exactly as pinned           |
| `pnpm install --frozen-lockfile`                    | 0    | "Already up to date"                                                      |
| `pnpm config get minimumReleaseAge`                 | 0    | `1440`, control in effect                                                 |
| `pnpm format` then `pnpm format:check`              | 0    | "All matched files use Prettier code style!"                              |
| `pnpm lint`                                         | 0    | 16 files linted (confirmed with `eslint . --format json`), 0 messages     |
| `pnpm typecheck`                                    | 0    | 14 Turborepo tasks successful (13 typecheck plus the contracts build)     |
| `pnpm test`                                         | 0    | 2 test files, 3 tests passed at that commit                               |
| `pnpm build`                                        | 0    | 13 build tasks successful                                                 |
| `pnpm -r ls --depth -1`                             | 0    | 13 `@cas/*` packages plus the root                                        |
| `pnpm exec turbo ls`                                | 0    | 13 packages                                                               |
| credential pattern scan over all 77 candidate files | 0    | no credential-like strings                                                |
| tabular-file and CSV-row scan over the same files   | 0    | no `.csv`, `.xlsx`, `.xlsm` files; no CSV-shaped rows with ISO timestamps |
| `git status --short --untracked-files=all`          | 0    | only Sprint 0 files; `node_modules`, `dist`, `.turbo` ignored             |

A fresh clone at `bae7f29b` passed the same sequence, and CI run 33936826532 succeeded on
every step.

### Deviations from the charter at the foundation commit

1. **Bootstrap commit on `main`.** The charter forbade touching the default branch. The
   project owner separately and explicitly authorized one initial commit because the
   repository had no branch. It is the starting SHA, not Sprint 0 work.
2. **`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`.** Not requested at the time. Added
   as a supply-chain control; later kept by decision D13.
3. **`@cas/contracts` held two real type contracts** rather than an empty placeholder, the
   minimum for a legitimate foundation test and for the shared-contract boundary.
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

## Audit remediation, 4 September 2026 (evening, America/Toronto), commit `0e43135b`

Codex independently ran the locked install and the full verification suite on
`bae7f29b` successfully, and the CI run for that commit succeeded on every step. The
project owner then issued nine corrections. Each is addressed in the remediation commit,
which follows the foundation commit without rewriting it. Git reports the diff as 17 files
changed, 916 insertions, 359 deletions.

| #   | Correction                                            | Where it landed                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Official schedule in America/Toronto; re-cut calendar | D14; `SPRINT_BOARD.md`; README; `HACKATHON_REQUIREMENTS.md` section I; `ACCOUNT_READINESS.md` deadlines; this report                                                                                                                                                                              |
| 2   | Classification before selection                       | D15; `ARCHITECTURE.md` sections 1 to 4; `DATA_INPUTS.md` sections 1, 3, 4, 12; `SPRINT_BOARD.md`; `ClassificationDecision` contract and tests in `packages/contracts`                                                                                                                             |
| 3   | `DataOrigin` as execution context                     | Contract comments in `packages/contracts/src/index.ts`; `ARCHITECTURE.md` section 7; `SECURITY.md` section 4; contract tests; values unchanged                                                                                                                                                    |
| 4   | Graph strategy: either route; Messari schema primary  | D11; `HACKATHON_REQUIREMENTS.md` sections A and B; `SPRINT_BOARD.md` Sprint 1; `ACCOUNT_READINESS.md` Graph rows                                                                                                                                                                                  |
| 5   | Git-history rule paraphrased accurately               | `HACKATHON_REQUIREMENTS.md` finding 2 and rows E2 to E4; this report                                                                                                                                                                                                                              |
| 6   | Cross-project contamination removed                   | This report's limitations and readiness sections; `SPRINT_BOARD.md` standing rules; README audit policy. Repository-wide search: no engineering-brain, spec-folder or Codex-restriction language remains. D3's draft-destination wording is the project owner's own charter text and is unchanged |
| 7   | Apache-2.0 licence                                    | `LICENSE` (canonical text, sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`); `"license"` in `package.json`; README; D12                                                                                                                                                 |
| 8   | Release-age gate kept, narrow exception documented    | D13; `SECURITY.md` section 8; comment in `pnpm-workspace.yaml`                                                                                                                                                                                                                                    |
| 9   | Decisions appended, report updated                    | D11 to D15 with D1 marked superseded; this section; invalid Codex limitations removed                                                                                                                                                                                                             |

## Final correction, 4 September 2026 (late evening, America/Toronto)

Codex audited `0e43135b` and the project owner issued five documentation corrections. Each
is addressed in the final correction commit, which follows the remediation commit without
rewriting it. No Sprint 1 implementation and no dependency was added.

| #   | Correction                                                     | Where it landed                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 10 September Graph gate made internally valid; sequence re-cut | D16; `SPRINT_BOARD.md` (gate deliverables table, Sprints 1 to 9); README build-sequence section; `ARCHITECTURE.md` stage list; `ACCOUNT_READINESS.md` sprints and deadlines; `HACKATHON_REQUIREMENTS.md` sprint references; `.env.example`; `SECURITY.md` section 5; `apps/payer-agent/package.json` description; this report |
| 2   | Dashboard framework restored to Next.js per Plan 2.0           | `ARCHITECTURE.md` section 1 table and framework paragraph; README layout table; `SPRINT_BOARD.md` Sprint 6; D16 consequences. Not scaffolded or installed                                                                                                                                                                     |
| 3   | False Graph feedback rows removed                              | `HACKATHON_REQUIREMENTS.md`: rows A8 and F4 deleted, identifiers left as gaps, historical note added as finding 5 outside the matrices                                                                                                                                                                                        |
| 4   | Stale and inaccurate reporting corrected                       | This report: current-state sections report three contracts, five tests, and the Git-derived remediation diff; foundation-commit sections labelled historical                                                                                                                                                                  |
| 5   | `.env.example` aligned                                         | Postgres from Sprint 2; "Subgraph Studio or equivalent live Graph provider access"; Graph Market only if an optional path requires it; sponsor categories Sprint 8. No variable name added                                                                                                                                    |
