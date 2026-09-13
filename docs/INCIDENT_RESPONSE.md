# Incident response

**Status: speculative.** Security-foundation track, branch `parallel/s6-security-foundation`,
pending independent audit. This is the preparation the project can make before any hosted
component exists: who decides, what counts as an incident, what to do first in each case, and
what must be written down afterwards. Every runbook uses only commands and controls that exist
on this branch; nothing here assumes a dashboard, an MCP server, a feed or a deployment.

## 1. Roles

| Role          | Who                            | Does                                                                                                                                            |
| ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Incident lead | Project owner                  | Declares and closes the incident, decides every irreversible step (rotation, retraction, disclosure), owns every account and repository setting |
| Implementer   | Claude, on a correction branch | Reproduces, fixes, tests; pushes only the correction branch; never merges, deploys, rewrites history or touches settings                        |
| Auditor       | Codex Desktop                  | Independently verifies the fix and the reproduction; issues PASS or CHANGES REQUIRED                                                            |
| Reporter      | Anyone                         | Reports through `VULNERABILITY_DISCLOSURE.md`                                                                                                   |

Nothing in an incident changes the operating model: the owner instructs, Claude implements on
a branch, Codex audits, and neither agent merges.

## 2. Severity

| Level | Meaning                                                                                                    | First response within |
| ----- | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| S1    | A secret is exposed, or a published statement is false or names someone the sourcing does not support      | 1 hour                |
| S2    | Integrity of stored evidence or of the repository is in doubt (drift, tampering, a compromised dependency) | 4 hours               |
| S3    | Availability: the pipeline cannot run, or a hostile input keeps a command from completing                  | 1 day                 |
| S4    | A weakness reported with no evidence of exploitation                                                       | 5 days                |

Times are targets for a one-person project during the event, not promises.

## 3. Triggers

- A token shape or credential URL appears in a commit, a log, a CI run, a document or a
  message (`tools/checks/secrets.ts` fires, or a person notices).
- `db:check` reports `drift` above zero, or a reconciliation report prints
  `RECONCILIATION FAILED`.
- `pnpm audit:deps` reports an advisory, or `supply-chain:check` reports that the committed
  bill of materials differs from the lockfile.
- A command exits `124` (deadline) or `3` with a `limit_*` code on input that should have
  been ordinary.
- A draft or a published issue is found to name an organisation or a person the sourcing does
  not support, or to state an incident that did not happen.
- A vulnerability report arrives.

## 4. Runbooks

### Runbook 1: secret exposure (S1)

1. Treat the value as compromised now, whatever the exposure window (`SECURITY.md`
   section 2). Removing a commit does not undo a leak.
2. Owner rotates the credential at the provider (for `GRAPH_API_KEY`: Subgraph Studio) and
   replaces it in the local `.env` only.
3. Owner checks the provider's usage for the period since the last known-good state.
4. Implementer searches the repository and every workflow log for the value's shape, runs
   `pnpm check:repo`, and records where it appeared and where it did not.
5. If the value reached Git history, the owner decides whether to rewrite history; the
   rotation is the remedy either way, and no agent rewrites history.
6. Record the incident (section 5).

### Runbook 2: compromised or vulnerable dependency (S2)

1. Identify the package and version from the advisory; find it in `supply-chain/sbom.cdx.json`
   by its `purl` and read its `dependencies` entry to see what depends on it.
2. Implementer prepares a correction branch that moves the catalog entry to a fixed version
   that is at least 24 hours old; the release-age gate is not lowered. If no such version
   exists and the package is not sponsor-required, the dependency is removed or the feature
   using it is disabled; decision D13 permits nothing else.
3. Run `pnpm install --frozen-lockfile`, `pnpm audit:deps`, `pnpm supply-chain:generate`,
   commit the regenerated bill of materials, and run the complete suites.
4. Codex audits the lockfile diff and the regenerated bill of materials.
5. Record the incident.

### Runbook 3: evidence integrity in doubt (S2)

1. Do not write. Stop every running command; the deadline and the transaction design mean a
   stopped command leaves nothing partial.
2. Run `db:check` and record the migration status and checksums; compare with
   `packages/database/migrations/*.sql` SHA-256 values in the current sprint report.
3. Run `editorial report`, `classification report`, `clustering report` and `evidence report`
   for every batch and run in question; each re-derives its counters and hashes from rows.
4. Diff the reconciliation output against the figures recorded in the sprint reports.
5. If drift or a reconciliation failure is confirmed, the owner decides between restoring a
   known-good database and re-importing from the exports (the importer is idempotent by file
   hash, so a re-import reproduces the batch), then reclassifying and reclustering; every
   run is versioned and hashed, so the rebuilt chain can be compared with the old one.
6. Record the incident, including which controls detected it and which did not.

### Runbook 4: false or unsupported publication (S1)

1. Owner publishes a correction through the newsletter's own channel; the system cannot and
   must not publish anything (`SECURITY.md` section 6).
2. Implementer traces the statement through the draft's provenance sidecar to the claim,
   its incident, its source rows and its evidence state, and records the chain.
3. If a human decision was wrong, it stays in the record; a new decision is appended with a
   reason code. If the drafter or the naming policy allowed it, that is a defect: reproduce it
   in a test, fix it on a correction branch, audit.
4. Record the incident.

### Runbook 5: resource exhaustion or a hostile input (S3)

1. Read the command's fixed error: a `limit_*` code names the bound and a count; exit `124`
   names the deadline. Nothing was written (the structural pass refuses before any
   transaction; the deadline rolls back).
2. Keep the offending file for analysis; do not import it.
3. If the input is legitimate and the bound is wrong, the bound changes only through a new
   `resource-limits@N` version with a recorded measurement and a rerun of the boundary tests;
   never by editing a constant in place.
4. Record the incident.

### Runbook 6: a vulnerability report (S4 unless evidence of exploitation)

1. Acknowledge privately within the disclosure policy's window.
2. Reproduce on a disposable clone; classify the severity; open a correction branch.
3. Fix, test, audit; the reporter is told when the fix is on a branch and when it is accepted.
4. Credit the reporter if they wish; record the incident.

## 5. Records

Every incident, including a false alarm, gets an entry in this document's log below and,
where a rule changed, a decision in `DECISIONS.md`. An entry states: date and time
(America/Toronto), severity, trigger, what was affected, what was done, what detected it,
what did not, and the follow-up with an owner. No entry contains a secret value or third-party
text.

## 6. What is never done in an incident

- No force-push, rebase or history rewrite by an agent; the owner alone may decide one.
- No change to repository settings, secrets or accounts by an agent.
- No merge to `main` and no deployment as part of a fix; a correction is a branch and an
  audit.
- No lowering of the release-age gate, the resource limits or the credential policy to make
  a fix land faster.
- No message to a reporter, a provider or the public from an agent; the owner speaks.

## 7. Log

| Date (America/Toronto) | Severity | Summary | Outcome |
| ---------------------- | -------- | ------- | ------- |
| none recorded          |          |         |         |
