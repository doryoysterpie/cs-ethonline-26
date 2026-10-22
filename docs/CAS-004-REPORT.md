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
