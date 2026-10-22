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
