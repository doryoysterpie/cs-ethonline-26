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

A versioned, hashed system prompt (`roundup-prompt@1`) that instructs reformatting only: the
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

### 1.10 Decisions this design takes within the contract, and one it raises

- The deterministic revision 0 is rendered from the same snapshot: headline from the
  representative title, summary from the recorded summary text (or the title when none),
  sources in row order. It is what the owner edits if the model is unavailable.
- Cost is bounded twice: the cap at the month and `max_tokens` per request.
- D4, the victim-naming rule, is provisional and asks for human confirmation before drafting
  work begins. The owner's template puts the organization name in the summary body, which the
  recorded sources already name. This design applies the template's rule, naming as the
  sources name, and raises D4's two-source bar as a question for the owner; changing the
  answer is one line of the prompt contract and one validation.

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

`packages/roundup/src/prompt.ts` fixes `roundup-prompt@1`. The system prompt is built from the
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
