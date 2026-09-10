# Data classification and retention

**Status: speculative.** Security-foundation track, branch `parallel/s6-security-foundation`,
pending independent audit. This document classifies every kind of data the system holds or
produces, says where each lives, who may see it, how long it is kept and how it is removed.
It is the data half of `THREAT_MODEL.md`; the handling rules it cites are the ones
`SECURITY.md` and `DATA_INPUTS.md` already enforce.

## 1. Classes

| Class          | Meaning                                                                                                                                           | Handling floor                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Public**     | Intended for anyone: the repository, its documents, synthetic fixtures, the bill of materials, published issues                                   | Reviewed before commit; scanned for secrets, forbidden files and invisible characters on every push                                                                |
| **Internal**   | The project's own working material: drafts, provenance sidecars, review decisions, evidence states, reports, notes                                | Never published as such; drafts marked unpublished; kept out of Git by `.gitignore` and the forbidden-file scan; visible only to the owner and named reviewers     |
| **Restricted** | Third-party or personal material the project holds but does not own: raw exports, retained source rows, author names, the database connection URL | Never committed, never on chain, never in a fixture; stored only in the local database or the owner's files; printed only as counts, identifiers and hashes        |
| **Secret**     | Credentials: `GRAPH_API_KEY`, any future provider, facilitator or hosting credential                                                              | Only in the ignored `.env` or a hosting secret store; only in an `Authorization` header; redacted from every output; treated as compromised if it ever reaches Git |

## 2. Inventory

| Data                                                                          | Class      | Where it lives                                                                     | Who may access                                                | Retention                                                                                                       | Removal                                                                                                     |
| ----------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Raw editorial exports (master RSS export, weekly snapshot sheets)             | Restricted | The owner's spreadsheet and local download folder; never the repository            | Owner; operator while importing                               | Governed by the owner's editorial process, outside this system                                                  | Owner deletes; nothing in the repository references a path beyond a basename                                |
| Retained source rows: raw cells, raw fields, derived text, hashes             | Restricted | PostgreSQL `source_rows` and related tables, in the owner's local database         | Owner; operator; reviewer through counts and identifiers only | Indefinite while the provenance chain that rests on them exists; a row referenced by a result cannot be deleted | Drop the database or the schema; there is no per-row delete, because provenance is append-only              |
| Author and publisher names inside the exports                                 | Restricted | Same tables (`raw_author`, publisher attribution as recorded at import)            | As above                                                      | As above                                                                                                        | As above; never written on chain (`SECURITY.md` section 9)                                                  |
| Weekly review state, incident subjects, association decisions, merges, splits | Internal   | PostgreSQL review, subject, action and revision tables                             | Owner; named reviewers                                        | Indefinite; append-only with actor and revision                                                                 | Only with the schema; decisions are never rewritten                                                         |
| Classification, clustering, evidence and signal runs                          | Internal   | PostgreSQL run and result tables                                                   | Owner; operator                                               | Indefinite; immutable once completed                                                                            | Only with the schema                                                                                        |
| Graph signals (identities, block context, TVL figures, digests)               | Internal   | PostgreSQL `graph_signal_runs`, `graph_signals`                                    | Owner; operator                                               | Indefinite; series scoped by origin                                                                             | Only with the schema; no provider payload, header or key is stored, so there is nothing secret to remove    |
| Drafts and provenance sidecars                                                | Internal   | `output/drafts/` (ignored); never the repository                                   | Owner; editor                                                 | Until the owner deletes them; a draft is never overwritten                                                      | Owner deletes the files                                                                                     |
| Live probe details                                                            | Internal   | `output/graph-probe/` (ignored), mode 600, redacted                                | Owner; operator                                               | Until deleted                                                                                                   | Owner deletes the files                                                                                     |
| Command output and logs                                                       | Internal   | The operator's terminal; GitHub Actions logs for CI runs                           | Operator; anyone who can read the public workflow logs        | Terminal: not retained by the system. Actions logs: GitHub's default retention                                  | Carry only basenames, hashes, counts, identifiers, statuses, durations and fixed messages; nothing to purge |
| `DATABASE_URL`                                                                | Restricted | The ignored `.env`; in CI, a credential-free loopback URL in the workflow          | Owner; operator; the CI job                                   | For the life of the local setup                                                                                 | Delete `.env`; the CI database is discarded with the job                                                    |
| `GRAPH_API_KEY`                                                               | Secret     | The ignored `.env` only; never CI                                                  | Owner; operator                                               | Until rotated                                                                                                   | Rotate at the provider; delete from `.env`; `INCIDENT_RESPONSE.md` runbook 1                                |
| Synthetic fixtures (`data/fixtures/`)                                         | Public     | Repository                                                                         | Anyone                                                        | With the repository                                                                                             | Git                                                                                                         |
| Replay signal snapshots (`data/fixtures/evidence/`)                           | Public     | Repository; synthetic values, no provider payload                                  | Anyone                                                        | With the repository                                                                                             | Git                                                                                                         |
| Bill of materials and licence inventory (`supply-chain/`)                     | Public     | Repository; reproduced in CI                                                       | Anyone                                                        | With the repository; regenerated on every lockfile change                                                       | Git                                                                                                         |
| Test databases                                                                | Internal   | Schemas `cas_test_*` in the database `DATABASE_URL` names; the CI service database | The test run                                                  | The test's lifetime                                                                                             | Each test drops exactly the schema it created; the CI database ends with the job                            |
| Local verification databases (`cas_*`)                                        | Restricted | The operator's PostgreSQL server                                                   | Operator                                                      | Operator's choice                                                                                               | `dropdb`; they may hold replay imports of the real exports and are Restricted for that reason               |

## 3. Rules that follow from the classes

1. **Nothing Restricted enters Git.** The `.gitignore` excludes raw exports, `output/`, `.env`
   and key files; `tools/checks/forbidden-files.ts` refuses them from the index on every push
   whatever `.gitignore` says; `tools/checks/secrets.ts` refuses token shapes and credential
   URLs. A fixture may imitate the shape of an export and never its content
   (`SECURITY.md` section 3).
2. **Nothing Restricted or Secret is printed.** Every command output line is redacted and
   escaped; metadata is bounded; errors carry counts and fixed vocabulary
   (`SECURITY.md` sections 10 and 11; `RESOURCE_LIMITS` refusals carry numbers only).
3. **Nothing personal goes on chain, ever** (`SECURITY.md` section 9). No chain interaction
   exists on this branch.
4. **Internal material is unpublished by construction.** Every draft carries
   `unpublished_requires_human_review`; publication is a human act outside the system
   (`SECURITY.md` section 6).
5. **Retention follows provenance.** A row, a result or a decision that something later
   rests on is never deleted alone, because a provenance chain with a missing link is a false
   chain. Removal is by schema or database, deliberately, by the owner.
6. **Public output names nobody the sourcing does not support.** Decision D4 (provisional)
   withholds every victim name the drafter cannot support; the drafter proposes none.
7. **Origins never mix.** Live, fixture and replay data are labelled on every record and
   every printed line and are never conflated (`SECURITY.md` section 4). Audit finding F1
   (a file ingested as `live`) is open and owned by the Sprint 5 correction.

## 4. Personal data statement

The exports the owner curates contain the names of authors and publishers and, inside
article text, the names of people and organisations mentioned by the press. The system treats
all of it as Restricted third-party material: stored exactly for provenance, never
interpreted, never published by the machine, never placed on chain, and printed only as counts
and identifiers. The project holds no account data, no reader data and no payment data on this
branch; the planned x402 feed (Sprint 8, conditional) would expose public incident metadata
only (decision D6). A privacy review against the jurisdictions the newsletter reaches is
outside this track's scope and is recorded as open work for the owner.
