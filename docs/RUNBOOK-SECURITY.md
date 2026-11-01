# Security-control activation and verification

**Status:** local control definition only. This repository file does not prove that any GitHub
setting is enabled. Activation, settings changes and the final read-back are owner-only actions.

This runbook covers the `main` branch ruleset, secret scanning, push protection, Dependabot
alerts and Dependabot security updates. It does not authorize an engineering agent to change
repository settings, merge a pull request, or close an issue.

## 1. Control definition

`.github/rulesets/main.json` is an API-ready repository-ruleset request body for exactly
`refs/heads/main`. It defines the following controls:

- updates reach `main` through a pull request;
- no approving review is required and no last-push approval (D52): the repository has one
  GitHub identity, which cannot approve its own pull request, so either rule would block every
  merge. The review is enforced by the seventh check instead;
- every review conversation is resolved before merge, so each Codex review thread is addressed;
- `Verify`, both PostgreSQL trust and SCRAM lanes, `Browser E2E`, `Supply chain`, and
  `Analyze (javascript-typescript)` pass against the latest `main` before merge;
- `Codex verdict` passes: a commit status on the pull request's head that
  `.github/workflows/codex-verdict.yml` sets from the pull request's comments, success only when
  the last verdict line naming that exact head is `Codex verdict: PASS at <commit>` (§1.1);
- each required check is bound to the GitHub Actions integration (`integration_id` 15368),
  observed on `main` at `978d6cc6fadbbd5fee3b000edf17e0795331596f` on 2026-10-23;
- branch deletion and non-fast-forward updates are prohibited; the ruleset has no bypass actor.

`tools/checks/rulesets.ts` fails when the JSON is malformed, a named control is weakened, an
approval rule that one identity cannot satisfy returns, a required check changes identity, a
required job disappears, the verdict workflow stops setting its status or a job takes its name,
two jobs publish the same name, or a required check is no longer bound to GitHub Actions.

### 1.1 Recording a Codex verdict

A verdict is one line of a pull-request comment, exactly:

```text
Codex verdict: PASS at <40-character head commit>
Codex verdict: CHANGES REQUIRED at <40-character head commit>
```

Codex, or the owner pasting Codex's verdict, posts it after the review of that exact head. The
engineering agent never posts one. Only a comment by an account with write access counts, so a
public commenter cannot pass a head. The comment sets the status within a minute; a new push
makes a head no verdict names, and the status turns to failure until Codex passes it. Until the
ruleset is active, nothing enforces the verdict but the process.

Each run sets the status to pending before it reads anything, and writes success only after every
comment has been read, so a failed read leaves the head pending or failed, never green from an
earlier run. One case remains: if GitHub refuses every status write, the earlier status stands
and the `Codex verdict record` job fails. Before a merge, the latest `Codex verdict record` run
on the pull request is green.

### 1.2 What one identity cannot enforce

With a single GitHub identity, everyone who can push can also write a verdict comment, add a
workflow that sets the status, or edit the ruleset. The check enforces against the realistic
failure, merging a head Codex never passed, not against a deliberate forger with push access;
nothing can, in a one-identity repository. The bypass list stays empty, so the only way around
the gate is to change the ruleset, and the ruleset's own history records every change. That is
the honest limit of the control. `corepack pnpm check:repo` and
`corepack pnpm verify` run this check.

## 2. Activation prerequisites

Do not activate the ruleset until all of these statements are true:

1. A pull request has produced all seven required check names. In particular, `Browser E2E`
   must execute the repaired passwordless browser harness, and `Codex verdict` must have been
   set by GitHub Actions on the head, once as failure and, after a verdict comment, as success;
   a skipped, absent, or failing check is not evidence.
2. The owner has read §1.1 and §1.2: no approval is required, and the review is enforced by the
   `Codex verdict` status.
3. The owner has reviewed the empty bypass list. There is no administrative escape path in the
   local definition.
4. The owner has retained an authenticated recovery session and knows how to edit or disable a
   ruleset if a required context is renamed.

Run the local preflight from a clean checkout:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:repo
corepack pnpm verify
```

List the check names produced by the pull-request head and compare them byte for byte with the
JSON. This command is read-only:

```bash
gh pr checks <PR-NUMBER> --repo doryoysterpie/cs-ethonline-26
```

Expected required contexts:

```text
Verify
PostgreSQL integration
PostgreSQL integration, password authentication
Browser E2E
Supply chain
Analyze (javascript-typescript)
Codex verdict
```

Confirm that the `Codex verdict` status comes from GitHub Actions, the source the ruleset names
(`integration_id` 15368). This command is read-only:

```bash
gh api repos/doryoysterpie/cs-ethonline-26/commits/<HEAD>/status \
  --jq '.statuses[] | select(.context == "Codex verdict") | [.state, .creator.login] | @tsv'
```

## 3. Owner-only ruleset activation

The owner performs this section. Engineering and review agents stop after the local preflight.

1. Open **Settings → Rules → Rulesets → New branch ruleset**.
2. Reproduce `.github/rulesets/main.json` exactly, including the `main` ref, active enforcement,
   empty bypass list, pull-request controls (no approval, conversation resolution required),
   strict required checks, deletion rule, and non-fast-forward rule.
3. Select GitHub Actions as the expected source for every status check.
4. Save the ruleset, then open a disposable pull request; confirm that a missing Codex verdict,
   a verdict on an earlier head, an unresolved conversation, an out-of-date branch, and each
   absent check independently block merge.

Alternatively, the owner may submit the committed JSON through the REST API. This command
changes repository settings; it is recorded here for the human owner and must not be executed
by an engineering or review agent:

```bash
gh api --method POST \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  repos/doryoysterpie/cs-ethonline-26/rulesets \
  --input .github/rulesets/main.json
```

Read back the effective configuration after activation:

```bash
gh api repos/doryoysterpie/cs-ethonline-26/rulesets \
  --jq '.[] | [.id, .name, .target, .enforcement] | @tsv'
gh api repos/doryoysterpie/cs-ethonline-26/rulesets/<RULESET-ID>
```

Record the activation date, ruleset identifier, test pull request and observed blocking outcomes
in `docs/tcu/CAS-006.md`. The committed JSON plus a successful local validator does not satisfy
CAS-006 step 6 without this live read-back.

## 4. Owner-only security scanning controls

Open **Settings → Security and quality → Advanced Security** and establish the following state:

| Control                             | Required state | Verification evidence                                                                                     |
| ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| Secret Protection / secret scanning | Enabled        | The repository's Security view exposes secret-scanning alerts.                                            |
| Push protection                     | Enabled        | A disposable branch push containing GitHub's published test pattern is blocked; do not use a real secret. |
| Dependabot alerts                   | Enabled        | The dependency graph is populated and the Dependabot alert view is available.                             |
| Dependabot security updates         | Enabled        | The setting reports enabled; a security update will open a pull request, not merge it.                    |
| Code scanning default setup         | Not configured | `.github/workflows/codeql.yml` remains the sole CodeQL configuration.                                     |

Push-protection bypasses are security events. The owner reviews every bypass, determines whether
the detected value is a test value or an exposed credential and, for an exposed credential,
follows `docs/INCIDENT_RESPONSE.md` before removing the alert.

Dependabot security-update pull requests remain subject to the same review, strict status checks,
24-hour dependency-release gate and lockfile review as any other pull request. Automated security
updates do not carry merge authority.

## 5. Quarterly and change-triggered verification

Run this procedure quarterly and whenever a workflow job name, workflow file, authentication
mode, or ruleset changes:

1. Run `corepack pnpm check:repo` from a clean checkout.
2. Read back the live ruleset; compare its target, enforcement, bypass actors, rules and required
   contexts with `.github/rulesets/main.json`.
3. Confirm a recent pull request produced all seven checks from GitHub Actions and that each
   passed, `Codex verdict` on the head it merged.
4. Confirm the four security scanning controls in §4 remain enabled and inspect open alerts.
5. Record the date, reviewer, deviations and remediation issue in `docs/tcu/CAS-006.md`; do not
   record tokens, credentials, connection strings, or alert payloads.

The control is falsified when the live read-back differs from the committed definition, a named
check can be satisfied by an unexpected integration, a pull request can merge without a Codex
PASS on its head or with an unresolved conversation, or a force push or deletion of `main`
succeeds. Stop merges, restore
the intended setting, and follow the incident runbook if the deviation could have admitted an
unreviewed commit.

## 6. References

- [GitHub REST API: repository rulesets](https://docs.github.com/en/rest/repos/rules)
- [GitHub rules available for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub security and analysis settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository)
- [GitHub push protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection)
