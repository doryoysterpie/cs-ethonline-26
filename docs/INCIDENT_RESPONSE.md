# Incident response

**Status: operational with named unverified controls.** This document began on the
security-foundation track; the dashboard and PostgreSQL service now exist on Railway, while
backup activation remains unverified until the owner records provider evidence under
`RUNBOOK-HOSTING.md`, section 6. Every runbook distinguishes a control the repository proves
from a provider setting only the owner can verify.

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
| S1    | A secret is exposed; the only live data copy is lost; or a published statement is false or unsupported     | 1 hour                |
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
- A scheduled backup is missing, PITR reports an unhealthy archive, a restore refuses, or the
  restore drill reports a pending/drifting migration or a per-table row-count mismatch.
- The only live database, volume, or Railway project is deleted or becomes unreadable.

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

### Runbook 7: a provider-side exposure (S1 at the host)

When the hosting provider reports that environment variables may have been read, every
variable of the hosted service is treated as exposed, and the rebuild follows
`RUNBOOK-HOSTING.md`, section 3: the database replaced rather than kept, every secret
re-minted at its own provider and the old one revoked there, `main` redeployed, the roles and
migrations inspected, the first account re-invited, and the log row written with codes and
dates and no value. Added after the 21 to 22 October 2026 incident.

### Runbook 8: single-copy database loss or failed recovery (S1/S2)

1. Stop every writer and record the last known-good application timestamp. Do not migrate,
   re-import, delete a service, wipe a volume, or restore over the source.
2. Owner inspects the Railway Backups tab for the newest healthy PITR point, volume backup,
   and their timestamps. If the archive or volume is missing, open Railway support at once;
   keep the project, failed service, and volume unchanged for provider investigation.
3. Restore PITR to a new sibling service or restore a volume backup as a staged change. For a
   logical dump, restore only to a local `cas_restore_*` database by following
   `RUNBOOK-HOSTING.md`, section 7. The source stays read-only throughout the drill.
4. Verify the restored target before any cutover: every committed migration is applied,
   `pending=0`, `drift=0`, and every exact per-table row count matches the source snapshot or
   the backup manifest. A missing source makes count comparison impossible; record that limit
   and reconcile the restored counts against the last successful drill instead.
5. Record actual RPO as the interval from the incident's last known-good timestamp to the
   newest verified restored record; record actual RTO from incident declaration to a verified
   cutover candidate. Exceeding `RUNBOOK-HOSTING.md`, section 6's objectives is an incident
   finding, not a reason to alter the figures.
6. Owner alone approves a connection-string swap. Keep the old service and volume intact
   until the application passes sign-in and read-path checks against the restored target; do
   not delete either copy during the incident.
7. If no restorable copy exists, reconstruct from the weekly copy-ready exports and replayable
   inputs; name every unrecoverable human decision and the affected interval. The incident
   remains S1 until the owner accepts or remediates that loss.
8. Record the incident, the provider ticket identifier, backup timestamp, measured RPO/RTO,
   migration result, table-count result, cutover decision, and owners; record no credential,
   connection string, or row content.

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
- No in-place restore over a source database and no deletion of a failed source before a
  verified recovery copy exists.

## 7. Log

| Date (America/Toronto)                                     | Severity                                              | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22, 08:40, declared by the owner                   | S1 (secret exposure), with S2 for the hosted database | Railway's platform incident, disclosed by Railway on 21 October 2026 (UTC): an unauthorized party may have read customer environment variables and decrypted some. Every variable of this project's Railway service is treated as exposed: the PostgreSQL credential, the Resend API key, the one-time-code pepper and the non-secret dashboard settings. Trigger: the owner's report and Railway's status page. Detected by: Railway, not by any control of this project. Not exposed: the repository and CI (`check:repo` clean at `7f080a4`; the workflows reference no secret, and no Railway token exists on GitHub); the Google service-account key and the workbook identifier, which live only on the owner's machine; the editorial corpus, which has not been imported into the hosted database (CAS-001 step 14 had not run). What the hosted database held: dashboard accounts, session token hashes (SHA-256, tokens never stored), one-time-code digests (HMAC under the pepper), audit events and the applied migrations. | Open. Owner rotates at each provider per Railway's published guides (Resend key, pepper, GitHub reconnection, the PostgreSQL service deleted and recreated once Hobby builds resume, the owner's decision of 22 October 2026, since it held nothing worth keeping), redeploys, then inspects `pg_roles`, `pg_stat_activity` and the migration checksums; the dashboard is not used until then. Follow-up, owner: enable GitHub secret scanning and push protection (CAS-006 step 6). Follow-up, implementer: this runbook predates hosting and gains a hosted-provider runbook; the first real import (CAS-001 step 14) waits for a trusted database. No secret value appears in this entry. |
| 2026-10-22, 19:30 to 21:00, the owner with the implementer | S1 recovery                                           | The rebuild the 08:40 entry called for, on Railway, step by step (`RUNBOOK-HOSTING.md`, section 3): a stray staged TCP proxy on the dashboard service discarded; the pre-incident PostgreSQL service (created September, its volume at 99%) wiped, then deleted with its volume; a new PostgreSQL service created and referenced from the dashboard through Railway's picker (a hand-typed reference had resolved to nothing: `DATABASE_URL is not set` at pre-deploy); `main` at `bda4303` deployed, the pre-deploy step applying migrations 0001 to 0014, the health check green; the one-time-code pepper replaced and the Resend key replaced, the old key deleted at Resend; `DASHBOARD_TRUSTED_PROXY_HOPS=1` and `DASHBOARD_PUBLIC_URL` added, `DASHBOARD_TRUST_FORWARDED_FOR=true` confirmed; the first account invited as `admin` from the dashboard container's console and signed in by code. Inspection: one role, `postgres`, a superuser (RR6); 14 migrations.                                                              | Closed for the rotations and the database. Open: the two-network lockout proof (CAS-006 step 7, owner's half); GitHub secret scanning and push protection (step 6); backups, which Railway gates behind the Pro plan, deferred by the owner to the launch, the refined dashboard opened for public reader sign-up and the supporter tier (`RISK_REGISTER.md` K21; D30 note); no public TCP proxy on the database until the first import needs one (`RUNBOOK-HOSTING.md`, section 6). No secret value appears in this entry.                                                                                                                                                                  |
