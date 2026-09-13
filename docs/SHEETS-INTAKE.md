# Google Sheets intake: a read-only, file-scoped connector

Status: **built and verified within Claude sessions on the parallel track
`parallel/google-sheets-intake`. Not merged, not deployed, and not audited by
Codex Desktop.** No live inventory has been run: no service account exists yet.
All times America/Toronto unless marked UTC.

Count-only throughout: no cell, URL, headline, spreadsheet identifier or
credential appears in this document.

## 1. The one authorized file

| Item          | Value                                                                               |
| ------------- | ----------------------------------------------------------------------------------- |
| File name     | `Cyberattack Sunday - RSS Intake`                                                   |
| Contents      | the current full RSS feed, plus roughly seventy historical weekly tabs              |
| Identifier    | supplied through `GOOGLE_SHEETS_SPREADSHEET_ID`; never committed, never printed     |
| Authorization | SHA-256 digest of that identifier, pinned in `data/policy/authorized-workbook.json` |
| Access        | one Google Cloud service account, shared with this file alone, as Viewer            |
| Scope         | `https://www.googleapis.com/auth/spreadsheets.readonly`, and nothing else           |
| Drive API     | not enabled, not called, not depended on                                            |
| Write access  | none exists anywhere in the code                                                    |

## 2. The sharing model, and why it is file-scoped

The owner shares one file with one service account, as Viewer. That is the
entire grant.

This is deliberately not OAuth against the owner's Google account. An OAuth
flow would authorize the application to act **as the owner**, which means the
scope covers everything the owner can see, and narrowing it afterwards is a
matter of the application behaving well. A file-scoped service account inverts
that: the account starts with access to nothing, and the owner adds exactly one
file. Even a completely compromised connector cannot reach a second document,
because no second document was ever shared with the identity it holds.

**Revocation is one action.** Open the file's sharing dialog, remove the
service account, save. Access ends immediately and completely, with no key
rotation, no deployment and no code change. Nothing else the owner holds is
affected, because nothing else was ever granted.

## 3. Why the Drive API is prohibited

The Sheets API can read a spreadsheet the caller already knows the identifier
of. The Drive API can **enumerate**: list files, search by name, walk folders,
read metadata for documents nobody deliberately shared. Those are different
powers, and only the first is needed here.

Enabling Drive would mean that a defect, a confused-deputy bug or a future
careless feature could turn "read this one file" into "discover what else this
account can see". The connector therefore has no Drive dependency at all, and
three separate properties keep it that way:

- **No Google SDK.** The JWT-bearer authorization flow and the two REST calls
  are implemented directly against Node's crypto and `fetch`. A general client
  library would carry Drive, the write scopes and a discovery mechanism into
  the dependency graph; then "we do not call Drive" would be a claim about how
  a large library is used, rather than a fact about what the code contains.
- **Two allowed origins.** `sheets.googleapis.com` and `oauth2.googleapis.com`.
  Every request URL is parsed and its origin compared with that frozen list
  before a socket opens, and **no redirect is ever followed** — a 3xx is
  refused outright, because a redirect is the one mechanism that could move a
  request off an allowed origin.
- **A test that reads the source.** `boundary.test.ts` scans every file the
  package ships for a Drive host, a Drive path, a Drive scope, `files.list` and
  `includeGridData`, and asserts the only OAuth scope string present anywhere
  is the read-only Sheets one.

## 4. The editorial lineage, and what the weekly tabs are not

This is the most important section in this document, and the one most likely to
be skipped.

```
1. RSS source corpus          the living feed aggregated by Make
2. weekly candidate cut-down  the owner reduces it to one week's possibles
3. assistant reformatting     an assistant reformats and deduplicates
4. owner edit                 the owner selects, orders and edits
5. published Substack edition the authoritative editorial outcome
```

The workbook contains stages 1 and 2. It does **not** contain stages 3, 4 or 5.

A tab named after a Cyberattack Sunday week therefore records **what was a
candidate that week**. It does not record what ran, in what order, under what
headline, or whether a story survived the owner's final edit at all. The gap
between stage 2 and stage 5 is exactly the editorial judgement that makes the
publication worth reading, and none of it is written down in this file.

**The approximately seventy historical weeks are not training or evaluation
truth.** They become usable as truth only when all four of these hold:

1. the weekly candidate tab is identified;
2. the corresponding published edition is identified;
3. the pairing between them is reviewed and recorded by the owner;
4. the pairing is stored as its own record, separate from the workbook.

Until then they may be used for structural analysis and as candidate-selection
signals, and may never be presented as published outcomes.

**Holdout rule.** When paired weeks do become available, a group of them is
chosen and held back _before_ any tuning begins, and is never used to iterate.
A holdout selected after the results are known measures nothing.

This lineage is not only prose. It is a typed constant in
`packages/sheets-intake/src/lineage.ts`, every dry run requires an explicit
`--stage` that is never inferred from a tab's name, and every inventory report
prints the limitation sentence verbatim.

## 5. What the inventory reports, and what it refuses to

The inventory exists so the owner and a reviewer can agree on the workbook's
structure **before** anything is imported.

It reports: whether the title matches the authorized name; tab counts, visible
and hidden; sanitized tab names and a stable twelve-character digest of each;
declared row and column counts; frozen-row counts; header names after safe
display handling; the positions of blank and duplicate headers; a provisional
type inference with its evidence and confidence; and every structural warning.

It refuses to report: any data cell, any URL, any headline, the spreadsheet
identifier, and anything derived from them. The metadata call uses a field mask
that selects structure only, so the API cannot return cell values to it; the
only cells read are header rows, which the owner named as permitted output.

Two deliberate properties:

- **A tab's type is a hypothesis, typed as one.** Every inference carries
  `provisional: true`, a confidence and the header names that led to it. The
  ingestion adapter never consumes an inference; it takes an explicit mapping.
  The tab's _name_ is deliberately not evidence, because naming a tab after the
  publication says what the week was called, not which lineage stage it holds.
- **The historical tabs are not assumed uniform.** Each is described on its own
  terms, and a tab that cannot be read becomes a warning on that tab rather
  than an aborted run.

A separate, opt-in command reports a timestamp range: two normalized instants
and three counts, from one named column. It is the only inventory operation
that reads a data column, and it returns no cell — a value it cannot normalize
is counted, not shown.

## 6. Credential setup

The connector uses Application Default Credentials: a JSON service-account key
on a path named by `GOOGLE_APPLICATION_CREDENTIALS`.

1. Create a dedicated Google Cloud project, or use an existing one that holds
   nothing else of consequence.
2. Enable **only** the Google Sheets API. Do not enable the Drive API.
3. Create a service account with **no** project roles. It needs none: its
   access comes from the file share, not from IAM.
4. Create a JSON key for it. Store it outside this repository, for example
   under `~/.config/cas/`, and set it to mode `0600`.
5. Open `Cyberattack Sunday - RSS Intake`, share it with the service account's
   address as **Viewer**, and turn off notification email.
6. Export `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_APPLICATION_CREDENTIALS`.
7. Run `corepack pnpm sheets:pin`. It prints a SHA-256 digest and nothing else;
   paste that digest into `data/policy/authorized-workbook.json` as
   `spreadsheetIdSha256`, in its own reviewable commit.

Two refusals are structural rather than advisory, and both will stop a setup
that took a shortcut:

- **A key inside the repository is refused**, whatever `.gitignore` says. An
  ignore rule stops `git add .`; it does not stop a force-add, a changed ignore
  rule, `git archive`, or a Docker build context that copies the working tree.
  A key that is not in the tree is protected from all of those.
- **A key readable beyond its owner is refused** on POSIX hosts. A secret every
  account on the machine can read is not a secret.

## 7. Rotation and revocation

| Action                         | How                                                                   | Effect                           |
| ------------------------------ | --------------------------------------------------------------------- | -------------------------------- |
| Rotate the key                 | create a new JSON key, replace the file, delete the old key in GCP    | no code or policy change needed  |
| Revoke all access              | remove the service account from the file's sharing dialog             | immediate and complete           |
| Authorize a different workbook | change `spreadsheetIdSha256` in the policy file, in a reviewed commit | requires human review, by design |
| Suspend the connector          | unset `GOOGLE_SHEETS_SPREADSHEET_ID`                                  | every command refuses            |

Rotation and revocation are independent. Removing the share ends access even if
a key leaked, and rotating the key ends the leaked key's usefulness even if the
share remains. Neither requires touching this repository.

## 8. Resource limits

Every bound lives in `packages/sheets-intake/src/limits.ts`. A bound that is
reached is always an explicit, counted refusal: **this connector never silently
truncates**, because a partial reading presented as a complete one produces
counts that will be believed.

| Bound                 |   Default | What it protects                            |
| --------------------- | --------: | ------------------------------------------- |
| Tabs per workbook     |       200 | an unexpectedly large or hostile workbook   |
| Rows per tab          |   100,000 | a runaway read                              |
| Columns per tab       |        64 | a workbook widened past the mapped schema   |
| Characters per cell   |    50,000 | a single enormous cell                      |
| Characters per header |       200 | a header row used as a payload              |
| Rows per page         |       500 | request size and memory                     |
| Cells per page        |    32,000 | rows multiplied by columns                  |
| Response bytes        | 8,388,608 | an oversized body, checked while it is read |
| Rows per run          |   250,000 | total work for one ingestion                |
| Request timeout       |      30 s | a hung request                              |
| Run timeout           |     900 s | a hung paginated read                       |
| Attempts per request  |         4 | unbounded retrying                          |

## 9. Failure and retry behaviour

Failures are typed, and each kind is a distinct boundary: `configuration`,
`credential`, `authorization`, `network`, `timeout`, `http`, `schema`,
`structural`, `policy`.

Only an idempotent read is retried, only for a transient condition (429, 500,
502, 503, 504 or a timeout), at most four attempts, with exponential delay
capped at eight seconds. A cancellation ends the attempt loop immediately
rather than after the next sleep. A status that will not change — 400, 401,
403, 404 — is never retried.

**No response body ever reaches an error message.** A Google error body can
quote the request, and the request path carries the spreadsheet identifier;
echoing it would defeat the rule that the identifier never appears in output.
What a failure carries is the status and a fixed sentence saying what to check.

A 404 is reported as also being what a revoked share looks like, because those
two cases are indistinguishable from outside and an operator should check the
share before assuming the file moved.

## 10. What this track deliberately does not do

- **It does not import anything into the database.** There is no import
  command, no database handle in the connector, and no migration. The dry run
  reads, validates and counts; that is the whole of it. An import path will be
  built after the owner has reviewed an inventory report and approved a tab
  mapping.
- **It does not follow a link found in a cell.** The transport allowlist makes
  an article URL unreachable, and a test asserts that a full inventory and read
  attempt only ever contacted the two Google origins.
- **It does not write to the workbook.** The client exposes exactly two
  methods, `metadata` and `values`, and a test enumerates its prototype chain
  to prove no third exists.
- **It does not treat a weekly tab as truth.** See section 4.

## 11. Verification

All tests are offline and use synthetic fixtures. No real cell content, article
URL, private identifier or credential exists anywhere in this repository: the
RSA key pair the tests sign with is generated in the test process and discarded
with it, and the identifiers are invented literals.

```
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test --force
corepack pnpm build
corepack pnpm audit
```

To confirm the suite is genuinely offline rather than believed to be:

```
sandbox-exec -f tools/offline-sandbox.sb corepack pnpm test --force
```

## 12. The single outstanding human action

**Create the dedicated Google Cloud service account, enable only the Sheets
API, and share `Cyberattack Sunday - RSS Intake` with its address as Viewer.**

Nothing in this repository can do that step, and nothing should. Until it is
done there are no credentials to run a live inventory with, and the connector
refuses every operation because no workbook digest is pinned.
