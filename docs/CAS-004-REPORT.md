# CAS-004 report: the round-up through the rundown template, and the owner editor

Unit tracker: `docs/tcu/CAS-004.md`; live status: issue #6. Branch `cas-004/roundup` from
`cas-003/weekly-run` at `f49619f`, stacked on pull request 23. This report grows one section per
step. Nothing in it marks a test as passed until the runner's own counts are recorded here.
Audit state: not audited.

## 1. Design note and the round-up contract, S0, written before code (step 4)

Written 22 October 2026 from the code on `cas-003/weekly-run` at `f49619f` and the owner's
decisions of the same day: the template as structure (D40), D9 resolved for the round-up, the
owner role (D39). Every claim below names its file or the record it rests on.

### 1.1 What a round-up is, in one paragraph

A round-up is the week's selected stories, reformatted into the template's entry shape, in the
owner's selection order, with every source listed. The model receives only the recorded fields
of the selected stories and returns the template's slots with a citation per entry; it invents
nothing and reorders nothing. The deterministic rendering of the same input is kept as revision
0, the generated one as revision 1 with its provenance, and the owner's edits follow as later
revisions under the optimistic concurrency the drafts editor already uses. The export is the
latest revision rendered as copy-ready Markdown. Only the owner role can generate or edit.

### 1.2 The template and the slot schema

`data/policy/rundown-template.json` is the structure D40 records, version `rundown-template@1`.
It is canonicalized and hashed at load (SHA-256 of the canonical JSON); the hash travels with
every generated revision and a mismatch between the running template's hash and the one the
request names refuses the generation. The slot schema, as a Zod schema in `@cas/roundup`:

- `rundown[]`: `headline` (bounded text), `summary` (bounded text, one or two sentences),
  `sources[]` (the member URLs, in row order, as recorded; the model may not alter or add one),
  `citations[]` (source row identifiers from the selection).
- `flagged[]`: `headline`, `reason`, `disposition` (`omit` or `carry`).
- `extras`: the marker only.

A citation naming a row outside the selection, an entry whose sources differ from the
incident's recorded URLs, a missing or extra entry against the selection, or an order that
differs from the selection's, rejects the whole response with a fixed code; nothing is written.

### 1.3 The input: the selection snapshot, and nothing else

The input is the latest `selected` record per incident of one week run and one category
(CAS-003), in selection order (the latest `selected` record's time), with each incident's
member rows as the selection recorded them: source row identifier, normalized title, derived
summary text, the recorded URL and its host as the publisher, the posted time, the category and
the incident identifier. No note, no other row, no fetched page, no title of an unselected
incident reaches the model. The input digest (SHA-256 of the canonical JSON of this snapshot) is
recorded on the generated revision, so a generation can be matched to exactly what it saw.

### 1.4 The flagged section is deterministic

The flagged entries come from records, not from the model: an incident whose latest selection
is `unselected` with a note is `omit` with that note as the reason; an incident the sift table
marks carried and the owner did not select is `carry`, with the D10 rule as the reason. Their
headlines are the representative row's recorded title. The model never sees them.

### 1.5 Revisions: migration 0015

`roundup_revisions`, append-only: `week_run_id` (to `week_runs`), `category`, `revision`,
`kind` (`deterministic` for revision 0, `generated` for revision 1, `edited` from revision 2),
`slots` (jsonb, the validated slot object), `markdown` (the rendering), and for the generated
revision `model`, `prompt_version`, `prompt_hash`, `template_version`, `template_hash`,
`input_digest`, `input_tokens`, `output_tokens`, `cost_microdollars`; `saved_by_account_id`,
`created_at`. Primary key `(week_run_id, category, revision)`; a check binds the kind to the
revision number; a guard refuses update and delete and refuses a revision that does not follow
the last. Revision 0 and 1 are written together by one generation; an edit names the revision it
expects and is refused with a conflict when another edit landed first, exactly as
`draft_revisions` works.

`model_calls`, append-only: one row per request made or refused, with `kind` (`roundup`),
`week_run_id`, `category`, `model`, `input_tokens`, `output_tokens`, `cost_microdollars`,
`outcome` (`completed`, `refused`, `failed`), `created_at`. The monthly cap is the sum of
`cost_microdollars` over the UTC month plus the request's estimate, compared with
USD 25 before any request; a request that would cross it is refused with `spend_cap_exceeded`
and recorded as `refused`.

The accounts table's role check gains `owner` (D39), the way migration 0011 extended a check.

### 1.6 The model boundary

`@cas/roundup` is pure: the template, the schema, the prompt contract, the deterministic
rendering, the validation and the Markdown export, with no network and no SDK. The call itself
goes through a transport interface, `generate(input) -> { slots, usage, model }`, implemented
once in the dashboard with the official client (`@anthropic-ai/sdk`, pinned through the
catalogue under the release-age gate): model `claude-opus-5-5`, adaptive thinking, `effort:
low`, structured output against the slot schema, `max_tokens` 16,000, an explicit timeout, the
key read from `ANTHROPIC_API_KEY` by the configuration loader and never placed anywhere else.
With the key absent the transport is absent and a generation fails closed with
`model_key_missing` before any request; the default suites inject a recorded transport and open
no socket. Every string the boundary emits passes the existing redactor; a provider error is
stored as a fixed kind and code, never its body. Cost is estimated from the response's token
counts at D9's published rates.

### 1.7 The prompt contract

A versioned, hashed system prompt (`roundup-prompt@1` at S0; `roundup-prompt@2` after the review
of 22 October 2026, section 7, F1) that instructs reformatting only: the
entry rules of D40 (headline, summary, sources), the deduplication rule, the selection order,
the output shape, and that nothing may be added that the recorded fields do not say. The user
turn is the selection snapshot as JSON. The prompt hash is recorded on the revision. Naming of
organizations follows the recorded fields, the owner's rule that the name sits in the body; see
1.10 on D4.

### 1.8 The owner role, the control, the editor, the export, the audit events

`owner` joins `roles.ts` with the editor's capabilities plus `generate:roundup`,
`generate:article` and `edit:output`. The sift table page gains a "Generate round-up" control
for a principal holding `generate:roundup`, posting through the existing same-origin and
session-bound action checks to `generateRoundup`; a non-owner sees no control and a direct
request is refused with the fixed code `forbidden`. A round-up page shows the latest revision in
a textarea, saves an edit as the next revision under `edit:output` with the expected revision,
and offers the copy-ready Markdown. Audit events, never content: `roundup_requested` and
`roundup_completed` with token counts and cost, `roundup_refused` with its code,
`roundup_edited`.

### 1.9 Files touched, and not touched

Touched: `packages/roundup` (new); `data/policy/rundown-template.json` (new);
`packages/database/migrations/0015_roundup.sql` (new) and `src/roundup.ts`; the catalogue and
lockfile and the bill of materials for the client; `apps/dashboard` roles, store (audit kinds),
configuration (the key), the transport adapter, DTOs, reads, mutations, the round-up page and
the control on the week page; tests; `README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
`docs/DECISIONS.md`, this report.

Not touched: the classifier, clustering, the week run, the selection record, every applied
migration, the drafts of Sprint 5.

### 1.10 Decisions this design takes within the contract, and one it raised

- The deterministic revision 0 is rendered from the same snapshot: headline from the
  representative title, summary from the recorded summary text (or the title when none),
  sources in row order. It is what the owner edits if the model is unavailable.
- Cost is bounded twice: the cap at the month and `max_tokens` per request.
- D4, the victim-naming rule, is provisional and asks for human confirmation before drafting
  work begins. The owner's template puts the organization name in the summary body, which the
  recorded sources already name. This design applies the template's rule, naming as the
  sources name, and raised D4's two-source bar as a question for the owner. Resolved on
  22 October 2026: the bar is scoped to the article, and a round-up entry names as its
  selected sources name (the D4 amendment in `docs/DECISIONS.md`). The prompt contract's rule
  stands as written; nothing changed in code.

### 1.11 Verification plan

Offline: the template hash and canonical form; schema validation; the citation, source, order
and count rejections; the deterministic rendering; the Markdown export; golden recorded
responses for a cyberattack and a crypto selection; the key-absent refusal; the cap refusal;
the template-hash mismatch; that the default suite opens no socket. PostgreSQL: a generation
over a real selection writing revisions 0 and 1 and the ledger row; an edit as revision 2 with
the conflict on a stale expected revision; the non-owner refusals; the audit events' counts.
Then the full verify loop, the four database suites, a clean clone and CI.

## 2. The prompt contract, the client and the data contract, S1 and S2 (steps 5 to 7)

### 2.1 The prompt contract (step 5)

`packages/roundup/src/prompt.ts` fixed `roundup-prompt@1` (now `roundup-prompt@2`, section 7). The system prompt is built from the
template file alone and instructs reformatting only: one entry per incident in the given order,
the headline in title case and bold, a summary of one or two sentences in the register the
template describes, the sources exactly as given, a citation for every entry naming the source
rows it used, nothing invented, nothing fetched, and the flagged entries and the extras marker
copied through unchanged. Its hash over the canonical form of that text, with the template's
hash, is recorded on every generated revision (`promptHash`), so a change to either is a new
provenance, never a silent drift. The user turn is the selection snapshot (section 1.3) as
canonical JSON: recorded title, summary text, publisher derived from the URL, URL, posting
instant and incident grouping; never a note, never a row outside the selection, never a page
body. The response is constrained to the slot schema by structured output, then validated
again on receipt (section 3), because the schema constrains shape and the validator constrains
truth: every citation inside the selection, every source one of the cited rows' URLs, the
order and count the selection's.

### 2.2 Stack check: the client (step 6)

The official client, `@anthropic-ai/sdk`, pinned in the workspace catalogue at `1.0.0`, the
string the installed tool prints. Reason: the one supported client for the model D9 names, with
structured output, adaptive thinking, an explicit timeout and bounded retries in the client
rather than in this code. Rejected alternative: a hand-written HTTP call, which would re-create
the client's request shaping, error typing and retry policy with no test coverage behind it. The
release-age control (D13, 1,440 minutes) refused the version until it was a day old; the
install waited for the gate, not around it. The lockfile and the bill of materials are in the
same commit as the catalogue pin; the bill of materials check passes at 358 components.

### 2.3 The data contract: migration 0015 (step 7)

A new table rather than the draft-revision record: a round-up is per week run and category,
not per clustering run, and carries model provenance the draft record has no columns for.
`packages/database/migrations/0015_roundup.sql`, forward-only, checksum
`8260e8d783fd9a084e05cb631a08e3db36520dad1a0b10f941dec7eb80973c60`, unapplied outside test and
scratch databases:

- `roundup_revisions`, keyed by (week run, category, revision). `kind` is `deterministic`,
  `generated` or `edited`; a check binds the provenance columns to the kind, present on a
  generated revision and absent otherwise; `slots` holds the validated JSON, `markdown` the
  rendering. A guard trigger refuses update and delete and admits an insert only at the next
  revision number, so revision 0 is the deterministic draft, 1 the generation, and every edit
  the next integer.
- `model_calls`, the ledger: one row per request made or refused, with kind, week run,
  category, model, token counts, cost in microdollars, outcome (`completed`, `refused`,
  `failed`), a fixed code, the actor and the instant. Append-only by trigger, indexed by instant
  for the month's spend. A refusal is a row with zero tokens and its code.
- `accounts.role` admits `owner` (D39); `audit_events.kind` admits `roundup_requested`,
  `roundup_completed`, `roundup_refused` and `roundup_edited`.

`packages/database/src/roundup.ts` is the operations module: insert and list revisions, the
latest revision, insert a ledger row, the spend between two instants, the selected rows in
selection order with their member rows, the omitted incidents with their notes. Every query is
parameterised and reads only under the week run it is given.

## 3. The generation function and its tests, S3 and S4 (steps 8 and 9)

`packages/roundup` is pure: no socket, no file beyond the template, no environment. `generate.ts`
takes the snapshot, the loaded template, a transport or `null`, and the month's spend; it checks
the template hash the caller expected against the one it loaded, refuses an empty or malformed
snapshot, renders the deterministic draft, refuses when the worst case of this request would
take the month over the cap, refuses with `model_key_missing` when there is no transport, sends
one request, validates the response, computes the cost from the usage at the rates D9 recorded,
and returns both revisions with the provenance (model, prompt version and hash, template version
and hash, input digest, tokens, cost). Every refusal is a `RoundupError` with a fixed code; a
transport's coded failure (`model_failed`, `model_refused`, `response_invalid`) is mapped by its
code, never by its message. There is no fallback model and no retry at this layer.

The one transport implementation is in the dashboard (`server/model/anthropic.ts`): the
official client with a 120-second timeout and two bounded retries; `messages.create` with the
model and output allowance D9 resolved, adaptive thinking at low effort, and structured output
against the slot schema; a `refusal` stop reason is `model_refused`, an exhausted allowance is
`model_failed`, a provider error is `model_failed` with its status and never its body. The key
is read by name from `ANTHROPIC_API_KEY` at runtime construction and travels in the client and
nowhere else; absent, the runtime has no transport and the dashboard serves everything else.

Tests, offline, in `packages/roundup`: the template hash and canonical form; the slot schema;
the rejections for a citation outside the selection, a source outside the cited rows, an entry
out of order and a count mismatch; the deterministic rendering and the Markdown export; a
golden recorded response for a cyberattack selection and one for a crypto selection through the
recorded transport; the key-absent refusal; the cap refusal; the template-hash mismatch; and that
the default suite opens no socket. Against PostgreSQL, in the dashboard's data-access suite: a
generation over a real selection by the owner with a recorded transport, writing revisions 0
and 1 and the ledger row and leaving `roundup_requested` and `roundup_completed` with counts and
cost; the judge, editor and admin refused with the capability as the code; a second generation
refused; the key-absent, cap and template-hash refusals in a schema of their own, each a ledger
row and an audit event and nothing else; the owner's edit as revision 2, the conflict on a stale
expected revision, the control-character refusal, and the three non-owner refusals.

## 4. The owner role, the control, the editor and the export, S5 (step 10)

`owner` joins the role table with the editor's capabilities and `generate:roundup`,
`generate:article` and `edit:output` (D39); the provisioning and invitation commands admit it.
The week page links to the round-up page for a principal who may view drafts. The round-up page
(`/week/<week run>/roundup?category=<category>`) shows the template version and hash, the
month's model spend against the cap, the selected incident count and every revision with its
kind, author and provenance. A principal holding `generate:roundup` sees the generate control
while no revision exists; the action posts the expected template hash through the existing
same-origin and session-bound checks. The latest revision is shown as copy-ready Markdown, and a
principal holding `edit:output` edits it in a textarea and saves the next revision under the
expected one. A non-owner sees neither control, and a direct request is refused at the
data-access layer with a fixed code; the memory account store refuses both with
`persistent_accounts_required`, as selection does.

## 5. Audit events and the ledger, S6 (step 11), and the security baseline

Audit events carry counts and codes, never content: `roundup_requested` with the category;
`roundup_completed` with the cost and the token counts in its code; `roundup_refused` with the
refusal's code; `roundup_edited` with the revision number on success and the refusal's code
otherwise. Every refusal with a known actor is audited once, at the boundary, the rule review F4
set for selections: the wrapper around each mutation records the fixed code and the week run
when well formed. The ledger row is written inside the generation path, which alone knows the
usage; a completed generation writes revisions 0 and 1 and the ledger row in one transaction.

Baseline: the key is read by name and never logged, echoed or placed in a message; the request
carries recorded fields only; the response is validated against the selection before anything
is written; the output is rendered through the existing Markdown sanitiser, never as HTML; cost
is bounded per request by the output allowance and per month by the cap, checked before the
request against the worst case and recorded after it from the usage; the tables are append-only;
no automatic publication exists, the owner copies the text out by hand (D6).

## 6. Verification, S8 (step 14)

On the branch at the head that carries the documentation, 22 October 2026, from the runner:
`verify` exit 0, 1,088 offline tests (the round-up package 10, the dashboard 84, the worker
275), 31 tool tests; `test:db` exit 0, 301 (database 104, worker 119, dashboard 29, mcp-server
49). The counts against `main` as of pull request 23's corrected head are 1,078 and 296; the
differences are this unit's ten package tests, the two database tests for migration 0015 and
the three dashboard data-access tests.

At `a0e594a`, 22 October 2026: a fresh clone from the remote, install from the lockfile,
`verify` (1,088 offline, 31 tool) and `test:db` (301) all exit 0; CI run 39818786370 green on
every job (Verify, PostgreSQL integration, Supply chain), with CodeQL and its analysis green
beside it.

## 7. Independent review and correction (step 15, first round)

Codex reviewed pull request 24 at `f2e985c` on 22 October 2026: CHANGES REQUIRED, three P1 and
three P2. Record: `2026-10-22-CAS-004-roundup-pr24.md`. Every finding is corrected on the same
branch the same day, each with a test at the point of its claim.

- **F1, P1, editorial notes crossed the model boundary.** The user turn carried the flagged
  entries with their reasons, and an omitted incident's reason is the owner's note; the design
  note (section 1.4) said the model never sees them, and the committed test asserted the
  opposite. Correction: the flagged section is out of the prompt contract in both directions.
  `userPrompt` carries the selected incidents and the marker only; the model's schema
  (`ModelSlotsSchema`, the structured output) has no `flagged`; `validateResponse` attaches the
  section from records (`deterministicFlagged`) after the response passes; the prompt is
  `roundup-prompt@2` and its hash changes with it. Tests: the request's keys are exactly
  `weekRunId`, `category`, `window`, `incidents`, `extras`, and the exact note is absent from
  the system and user turns (package and PostgreSQL); a response that carries a `flagged` key
  is `response_invalid`; every stored revision holds the omitted incident and its note.
- **F2, P1, a model response could place an unselected URL in the export.** The validator
  checked the arrays and the renderer interpolated the headline and summary verbatim, so a
  summary carrying a `Sources:` block and a URL passed and rendered. Correction, three layers:
  `inlineSlotTextIssue` refuses a model-written headline or summary that is not plain inline
  prose (line break, control character, HTML, link, URL or `www.`, Markdown block marker,
  code, table bar, emphasis marker, empty) with `response_text_unsafe`; `escapeInline` is the
  one path every slot text takes into the export, model-written or recorded, collapsing it to
  one line, escaping the characters that open Markdown structure and breaking a bare URL
  scheme; and `generateRoundup` checks that the rendered Markdown of both revisions carries
  exactly the selection's URLs (`urlsIn`), refusing with `response_url_outside_selection`
  otherwise. Tests: the reviewer's probe (a `Sources:` block and an unselected URL inside the
  summary) is rejected and nothing is kept; thirteen unsafe shapes are each rejected in either
  slot; a recorded title that is hostile Markdown renders without a heading, a link, a tag or
  a URL off the selection; the escape and URL functions against fixed strings.
- **F3, P1, a billed but rejected response was recorded at zero and did not count toward the
  cap.** Correction: `RoundupError` carries `billed` (model and usage) for every failure after a
  response; the ledger records such a failure at its real tokens and cost; `spendBetween` sums
  every row of the month whatever its outcome (a refusal before any request carries zero).
  Tests: a validation failure with 2,000 input and 500 output tokens is a failed row at
  USD 0.018 (package: the error carries the usage; PostgreSQL: the ledger row), and a second
  attempt is refused by the cap once that cost is what stands between the month and the
  ceiling; the database's month sum includes a failed row.
- **F4, P2, concurrent generation could make an unrecorded duplicate request.** The existence
  check was a standalone read before the request. Correction: the claim, the cap check, the
  request, the ledger row and the revisions run under a PostgreSQL advisory lock
  (`withGenerationLock`, keyed by the schema, held on a connection of its own); the second of
  two submissions waits, then finds the round-up generated and is refused without a request;
  the completed ledger row is written in its own transaction before the revisions, so a billed
  request keeps its record even if persistence fails after it. Test: two concurrent
  submissions make exactly one transport call, one succeeds, one is refused, one ledger row.
- **F5, P2, the selection query could silently truncate.** Correction: the generation fetches
  the bound plus one row and refuses whole with `selection_too_large` when the page is full;
  the database operations take any page size up to `SELECTION_PAGE_MAX` and never decide the
  bound. Test: 201 incidents of 50 rows seeded through the real import, classification and
  clustering (`seedLargeWeek`) and selected; the generation is refused with no request and no
  revision; one incident set aside, exactly 10,000 rows generate with every row kept.
- **F6, P2, 201 flagged entries passed preflight.** Correction: `INPUT_LIMITS.flagged` is 200,
  `assertRoundupInput` refuses past it before any request, the generation fetches 201 omitted
  incidents and refuses with `flagged_too_many`. Test: 200 accepted, 201 refused, no transport
  call; the stored schema refuses 201.
- **Found by the F5 boundary test, corrected with it.** A selection at the row bound rendered
  past migration 0015's bound on a stored revision (400,000 characters), so a round-up that
  passed every input check could be requested, billed and then refused by the database.
  Correction: `MAX_MARKDOWN_CHARACTERS` (400,000) is pinned in the package beside the
  migration's bound; `prepareGeneration` refuses with `input_too_long` before any request when
  the deterministic rendering, the smallest a round-up of the selection can be, exceeds it; a
  generated rendering past it is `response_too_long`, billed and recorded. Tests: a wide
  selection is refused with no transport call; a long generated response is refused with its
  usage; the database refuses the 400,001st character.

Counts at the corrected head, from the runner, 22 October 2026: `verify` exit 0, 1,093 offline
tests (round-up 15, dashboard 84, worker 275), 31 tool tests; `test:db` exit 0, 304 (database
104, worker 119, dashboard 32, mcp-server 49). The clean-clone reproduction and the CI run at
the corrected head are recorded on the tracker.
CI at `9def38c` was green on every job; code scanning flagged one new alert in the
correction's own code, a polynomial regular expression in `text.ts` (the URL detection over a
model-written slot). Both URL scans are rewritten as single passes over the text (`includes`,
`indexOf`, a fixed-width word-boundary pattern) in the commit that follows, with the same
tests.

### 7.2 Second round, at `64f7cac`: CHANGES REQUIRED, two P1 and three P2

Codex re-reviewed the correction on 22 October 2026 (record
`2026-10-22-CAS-004-roundup-pr24-rereview.md`): F1, F2's probe, F5's bound and F6's direct
bounds held; five residual defects in the corrected paths remained. Every one is corrected on
the same branch the same day, each with a test at the point of its claim.

- **RR1, P1, provider-side failures after an answer were still ledgered at zero.** The
  adapter threw without usage on a refusal, an output that did not fit and text that was not
  JSON, although the provider had answered and billed. Correction: `ModelTransportError`
  carries `billed` (model and usage) for every failure after a response; the package reads it
  by shape (`billedOf`, never by class) and keeps it on its own error; the ledger records the
  real cost. Tests: `anthropic.test.ts` through an injected client, a refusal, an overflow and
  a non-JSON answer each carrying the usage and a request failure carrying none; the package
  keeps a foreign billed shape; against PostgreSQL, a refusal after an answer is a failed row
  at its real tokens and cost.
- **RR2, P1, the lock could exhaust the pool.** The holder kept one connection while waiting
  on the advisory lock and took more for its work; at pool-sized concurrency the waiters held
  every connection and the holder starved. Correction: the lock is tried, never waited for
  (`pg_try_advisory_lock`), a concurrent submission is refused at once with the fixed conflict
  `roundup_generation_in_progress`, and every protected read and write (the claim check, the
  spend, the ledger row, the revisions) runs on the lock-holding connection through
  `transactionOn`, so a generation holds exactly one pooled connection. Test: five concurrent
  submissions against the four-connection test pool make one transport call, one succeeds,
  the rest are refused, nothing waits.
- **RR3, P2, an upper-bound round-up could not be edited.** The editor reused the draft
  bound of 200,000 characters while storage admits 400,000. Correction: `MAX_ROUNDUP_CHARACTERS`
  (400,000) governs the round-up editor, held equal to the package's constant by a test; the
  server-action body bound is 2 MB so 400,000 characters of UTF-8 fit. Test: the upper-bound
  fixture generates, then a small edit above 200,000 characters saves as revision 2.
- **RR4, P2, carried incidents came from a 1,000-row page.** Correction:
  `listCarriedIncidents`, an exhaustive read of every carried, unselected, un-omitted incident
  of the run in posted order, bound plus one; the layer refuses `flagged_too_many` when omitted
  and carried together exceed 200. Test: 1,003 incidents through the real pipeline, three of
  them carried and sorted past the first thousand; all three are flagged in the stored
  revision.
- **RR5, P2, only the first control character was removed on export.** Correction: the
  removal is global, and the invisible characters that steer or hide text (the bidirectional
  controls, the zero-width characters, the byte-order mark) are removed with the controls and
  rejected in a model-written slot. Policy: stored text keeps them exactly (threat model RR13);
  the copy-ready Markdown is a rendering, and removal is its escape. Test: nine characters
  across a recorded slot reduce to the nine letters; a bidirectional or zero-width character in
  a model slot is `control_character`.

Counts at the second corrected head, from the runner, 22 October 2026: `verify` exit 0, 1,096
offline tests (round-up 15, dashboard 87, worker 275), 31 tool tests; `test:db` exit 0, 307
(database 104, worker 119, dashboard 35, mcp-server 49). The clean-clone reproduction and the
CI run are recorded on the tracker.
