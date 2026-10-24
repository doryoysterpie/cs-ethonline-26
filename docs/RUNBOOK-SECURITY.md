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
- one approving review is required; a new reviewable push dismisses stale approvals; the most
  recent reviewable push requires approval from someone other than its pusher;
- every review conversation is resolved before merge;
- `Verify`, both PostgreSQL trust and SCRAM lanes, `Browser E2E`, `Supply chain`, and
  `Analyze (javascript-typescript)` pass against the latest `main` before merge;
- each required check is bound to the GitHub Actions integration (`integration_id` 15368),
  observed on `main` at `978d6cc6fadbbd5fee3b000edf17e0795331596f` on 2026-10-23;
- branch deletion and non-fast-forward updates are prohibited; the ruleset has no bypass actor.

`tools/checks/rulesets.ts` fails when the JSON is malformed, a named control is weakened, a
required check changes identity, a required job disappears, two jobs publish the same name, or
a required check is no longer bound to GitHub Actions. `corepack pnpm check:repo` and
`corepack pnpm verify` run this check.

## 2. Activation prerequisites

Do not activate the ruleset until all of these statements are true:

1. The pull request containing `.github/workflows/ci.yml` has produced all six required check
   names. In particular, `Browser E2E` must execute the repaired passwordless browser harness;
   a skipped, absent, or failing check is not evidence.
2. A person other than the most recent pusher has write access and can supply the required
   approval. On a single-maintainer repository, activating this rule without an eligible
   reviewer deliberately prevents merges.
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
```

## 3. Owner-only ruleset activation

The owner performs this section. Engineering and review agents stop after the local preflight.

1. Open **Settings → Rules → Rulesets → New branch ruleset**.
2. Reproduce `.github/rulesets/main.json` exactly, including the `main` ref, active enforcement,
   empty bypass list, pull-request review controls, strict required checks, deletion rule, and
   non-fast-forward rule.
3. Select GitHub Actions as the expected source for every status check.
4. Save the ruleset, then open a disposable pull request; confirm that a missing review, an
   unresolved conversation, an out-of-date branch, and each absent check independently block
   merge.

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
3. Confirm a recent pull request produced all six checks from GitHub Actions and that each passed.
4. Confirm the four security scanning controls in §4 remain enabled and inspect open alerts.
5. Record the date, reviewer, deviations and remediation issue in `docs/tcu/CAS-006.md`; do not
   record tokens, credentials, connection strings, or alert payloads.

The control is falsified when the live read-back differs from the committed definition, a named
check can be satisfied by an unexpected integration, a pull request can merge without the review
and conversation conditions, or a force push or deletion of `main` succeeds. Stop merges, restore
the intended setting, and follow the incident runbook if the deviation could have admitted an
unreviewed commit.

## 6. References

- [GitHub REST API: repository rulesets](https://docs.github.com/en/rest/repos/rules)
- [GitHub rules available for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub security and analysis settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository)
- [GitHub push protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/enable-push-protection)
