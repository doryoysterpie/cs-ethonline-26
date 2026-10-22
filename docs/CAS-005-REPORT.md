# CAS-005 report: the article from the full sources, and the source-reading boundary

Unit tracker: `docs/tcu/CAS-005.md`; live status: issue #7. Branch `cas-005/article` from
`cas-004/roundup` at `d501f31`, stacked on pull request 24, itself stacked on pull request 23.
This report grows one section per step. Nothing in it marks a test as passed until the runner's
own counts are recorded here. Audit state: not audited.

## 1. Design note, the fetch contract and the article contract, S0, written before code (steps 5 and 6)

Written against the owner's four decisions: O-1, O-2 and O-3 of 16 September 2026 (D36), the
reporter register and the article contract of 22 October 2026 (D41), and D9 resolved for the
article on 22 October 2026 (the D9 resolution for the article in `docs/DECISIONS.md`). The
fetch policy `docs/FETCH-POLICY.md` is adopted here as written, rules R1 to R17, reason codes,
threat-model rows and the test list; section 1.3 fixes its numeric bounds from a measurement
and section 1.4 records the two additions the obey-`robots.txt` decision requires.

### 1.1 What an article is, in one paragraph

An article is original prose in a wire-neutral reporter's register, written by the model from
the full text of every source of the stories the owner selected for one week and one category:
a headline, a standfirst and body paragraphs in a fixed order, each paragraph citing the
selected sources it rests on. It is not the round-up, which restates recorded fields. To write
it, the service reads each selected source's page over the network, the first outbound fetch
this system makes, and that boundary is governed by the fetch policy before anything else in
this unit is. A source that cannot be read is listed as not read, shown to the owner before the
model is called, and may not be cited. The owner alone generates (`generate:article`), edits
(`edit:output`) and copies the Markdown out by hand; nothing is published by the dashboard
(D6).

### 1.2 The reading boundary: the fetch policy, adopted

`packages/source-reader` implements rules R1 to R17 over an injected transport, so that the
policy is tested exhaustively without a socket and the one real transport is small (the reading
boundary is its own package, apart from the pure article contract in `packages/article`, a
decision taken before code, section 1.10):

- **R1 to R4, the URL classifier.** The policy of `packages/mcp-server/src/safety/reference.ts`
  is adopted as written. To keep the two classifiers one code path rather than two copies, the
  classifier moves to `@cas/contracts` (`source-reference.ts`: `classifySourceReference`, the
  reason codes, the IPv4 and IPv6 block tables), and the MCP server's module re-exports it with
  its tests unchanged. This is a move, not a change: the function and its vocabulary are
  byte-for-byte the same, and the dependency rule of `docs/ARCHITECTURE.md` section 5 is
  respected, since `@cas/contracts` depends on nothing and every package may depend on it.
- **R5, resolve then connect.** An injected resolver (`dns.promises.lookup` with every address,
  in production) resolves the name before any connection; every address is classified under
  R4; one failure refuses the fetch with `resolved_address_refused`; the connection is then
  made with a `lookup` function that returns one checked address and nothing else, so a name
  that resolves differently a moment later cannot redirect the socket (rebinding).
- **R6 to R9.** Port 443 for `https:` and 80 for `http:`; redirects never followed by the
  client (`node:http` and `node:https` follow none), the `Location` re-classified under R1 to
  R6 and followed at most three times and never from `https:` to `http:`; `GET` only, no
  cookie, no credential, the fixed user agent of O-3, `Accept: text/html, application/xhtml+xml,
text/plain`, `Accept-Encoding: identity`; a `Content-Type` outside the three permitted is
  refused before the body is read.
- **R10, the body bound.** Read as a stream, stopped at the bound; a declared `Content-Length`
  above it refuses before the first byte; a compressed body (sent despite `identity`) is
  decompressed through `node:zlib` with the bound counted on the decompressed side. The bound is
  fixed in section 1.3.
- **R11 and R12.** A deadline per fetch and a deadline for the whole reading stage, both inside
  the command deadline; at most four fetches in flight; each canonical URL fetched once per
  generation.
- **R13.** Only the canonical URL of a source row in the persisted selection is ever fetched: the
  reading stage takes its list from the selection record and nowhere else; no link, image,
  script or subresource is ever requested.
- **R14, extraction.** The worker's `htmlToText` (transform `html-to-text@1`) moves to
  `@cas/article` and the worker re-exports it, so the dashboard and the worker extract text by
  one function. Extracted text is bounded per source (section 1.3); a source over its share is
  cut at a paragraph boundary and listed as partly read.
- **R15 and R16.** Fetched text is held in memory for the generation (O-1), never logged, never
  in an error, handed to the model as quoted material inside the structured user turn; the audit
  event per source carries the source row identifier, the outcome code, bytes read and the
  duration, never a URL, header or text. The revision's provenance keeps a SHA-256 digest of
  each extracted text, so a later run can tell that a page changed without holding it.
- **R17, the not-read list.** The reading stage runs first and ends in a reading record held in
  the dashboard's memory for ten minutes under a random identifier: the extracted texts, the
  not-read list with its codes, and the partly-read list. The page shows the owner what was read
  and what was not; the model is called only when the owner confirms that reading, by its
  identifier. An expired reading is read again. The model is told which sources were not read,
  and a citation of one rejects the whole response (`citation_unread`).

### 1.3 Bounds, fixed at S0 from a measurement

On 22 October 2026, one article page per publisher was fetched for sixteen publishers drawn
from the owner's calibration exports (CS79 and CS86), with the product's user agent,
`Accept-Encoding: identity`, no redirect followed. All sixteen answered 200 with `text/html`.

| Measure                    | Median  | Largest   |
| -------------------------- | ------- | --------- |
| HTML bytes on the wire     | 190,491 | 1,232,873 |
| Extracted text, characters | 9,026   | 34,083    |
| Time to the last byte, ms  | 311     | 858       |

The bounds that follow, each the smallest round value that admits the measurement with margin:

- **Body bound (R10): 2 MiB** of decompressed bytes. The policy's starting value of 1 MiB would
  refuse one page in sixteen (1.18 MiB of HTML for 7,781 characters of text); 2 MiB admits every
  page measured with room, and a page past it is cut at the bound and listed as partly read
  rather than refused, since text extraction tolerates a truncated document.
- **Extracted text per source (R14): 60,000 characters**, cut at the last paragraph boundary
  before the limit; the largest page measured is under two thirds of it.
- **Extracted text per generation: 600,000 characters**, so that the prompt stays within the
  input bound D9 sets for the article (200,000 tokens, at the estimate of four characters per
  token the round-up's cost rule uses, with the recorded fields and the contract beside it).
  Sources are read in selection order; a source that would take the total past the bound is
  listed as not read with `text_limit`.
- **Deadlines (R11): 15 seconds per fetch, 5 minutes for the reading stage**, the policy's
  proposed values, confirmed: the slowest page measured took under one second.
- **Concurrency (R12): 4 in flight**, as proposed.
- **`robots.txt`: 64 KiB**, read once per host per generation under the same rules, with a
  5-second deadline.

### 1.4 Additions to the policy's vocabulary, recorded before code

The policy's vocabulary predates O-2's decision to obey `robots.txt` and names no code for three
outcomes the implementation meets. Five codes are added, each with its reason, and none reflects
input: `robots_disallowed`, for a source whose host's `robots.txt` disallows the product's user
agent (`LatestInCyber`) or every agent for that path, per RFC 9309 longest-match;
`robots_unavailable`, for a host whose `robots.txt` could not be read because of a server error,
a timeout or a redirect, which RFC 9309 treats as a complete disallow (a missing file or any
other 4xx is no restriction); `malformed`, the shared classifier's own verdict for a URL that
does not parse; `content_encoding_not_permitted`, for a body in an encoding the reader cannot
bound (`gzip`, `deflate` and `br` are decompressed with the bound counted on the output);
`status_not_ok`, for a response that is not a page (a 404, a 500). Each lands the source in the
not-read list. The `robots.txt` fetch itself obeys R1 to R12.

### 1.5 The article contract, D41, and the slot schema

The owner's contract, in the owner's words, is recorded as D41 and becomes the schema and the
validator:

- `headline`: declarative, present tense, names the organization when D4 permits (section 1.7)
  and the effect; at most twelve words; no question mark; no colon stack (at most one colon).
- `standfirst`: one sentence of 25 to 35 words, the article in miniature: who, what, when,
  effect.
- `paragraphs[]`, each `{ section, text, citations[] }`: one claim per paragraph, one to three
  sentences, cited to at least one selected source that was read. `section` is one of, in this
  order and never reordered: `what_happened`, `organization_statement`, `scale_impact`,
  `attribution`, `not_confirmed`, `prior_context`, `next_step`. `what_happened` and `next_step`
  are required; `prior_context` is at most one paragraph; a section with nothing sourced is
  omitted, never invented. Attacker statements are claims attributed to who made them.
- `quotations`: every quoted span of four words or more in the prose must appear verbatim in
  the extracted text of a source the paragraph cites; the validator checks this against the
  texts in memory, which is why validation happens in the generation and nowhere later.
- `victimNaming`: `{ named, basis, citations[] }` with `basis` one of `primary_statement`,
  `two_independent`, `none` (section 1.7).
- `notRead[]`: the source rows the model was told were not read; must equal the input list.
- Length: 500 to 700 words over the standfirst and the body. The validator rejects outside 450
  to 750 and records the count in the provenance; the prompt asks for 500 to 700. The tolerance
  is a decision this design takes within the contract (section 1.10).
- Register: wire-neutral, no adjectives of alarm, no sarcasm, no lessons, no advice, Canadian
  spelling, "US" without periods. The register is instructed, not validated, except for the
  mechanical rules above.

The Zod schema is `ArticleSlotsSchema`; its JSON Schema form constrains the model's structured
output; the validator (`validateArticle`) constrains the truth: every citation names a row in
the selection and not in the not-read list, every quotation is found in a cited source's text,
the section order holds, the required sections are present, the counts are within bounds. One
violation rejects the whole response with a fixed code, and nothing is written.

### 1.6 The input: the reading record, the recorded fields, and nothing else

The user turn is canonical JSON: the week and category; per selected incident, in selection
order, each member row's recorded title, summary text, publisher, URL, posting instant and
source row identifier, and for each row read, its extracted text (bounded, section 1.3) and
whether it was partly read; the not-read list with codes; the D4 evidence rule (section 1.7).
Never an editor note, never a row outside the selection, never a page that is not a selected
source. Page text sits inside the structured input as quoted material, under a system prompt
that instructs the model to treat it as material and never as instruction (R15).

### 1.7 D4 in the article: the two-source bar, applied and declared

D4 as amended on 22 October 2026 scopes its bar to the article. The model may name the victim
organization only on a primary statement from the organization or on two independent credible
reports, and it declares which in `victimNaming`: `primary_statement` cites one read source the
model identifies as the organization's own statement (its own site or filing); `two_independent`
cites two read sources from distinct publishers; `none` leaves the organization unnamed in the
headline, standfirst and body, described generically. The validator checks mechanically what can
be checked: the citations are read sources in the selection, and for `two_independent` the two
publishers differ. Whether a source is the organization's own statement is the model's claim
and is shown to the owner on the page beside the headline, as D4's human confirmation; the owner
edits before anything leaves the dashboard. The residual, named: a model can misjudge a
publisher as primary; the owner sees the basis and the source it rests on.

### 1.8 The data contract: migration 0016

`article_revisions`, per week run and category like the round-up's, revision 1 generated and
later revisions edited (there is no deterministic article), with the round-up's provenance
columns plus `word_count`, `sources` (JSON: per source row, the outcome code, bytes read, the
extracted text's digest, read, partly read or not read), and `naming_basis`. Append-only with
the same guarded sequence. `model_calls.kind` admits `article`, and the spend query takes the
kind, so the article's USD 25 monthly cap is accounted apart from the round-up's (D9 for the
article, option b). `audit_events.kind` admits `source_fetched`, `article_requested`,
`article_completed`, `article_refused` and `article_edited`. No table holds fetched text (O-1).

### 1.9 The model boundary and the cost

The dashboard's one transport over the official client serves the article as it serves the
round-up, with the model and settings D9 resolved for the article: `claude-opus-5-5`, adaptive
thinking at `medium` effort, structured output against the article schema, 32,000 output tokens
at most, the prompt bounded as in section 1.3. The worst case is computed before the request
from the prompt's characters and the output allowance (about USD 1.45) and refused against the
article's own monthly cap; the usage is recorded after it in the ledger with `kind = 'article'`.
The key is the same name read once at runtime construction; absent, the reading stage still
runs, the generation fails closed with `model_key_missing` before any request, and nothing is
written.

### 1.10 Decisions this design takes within the contract

- The validator's length tolerance (450 to 750 words against the prompt's 500 to 700), so that
  a draft three words short is not refused at a dollar a request; the count is shown to the
  owner. Changing it is one constant.
- The reading record lives in the dashboard process for ten minutes, keyed by a random
  identifier, and is the only place fetched text exists (O-1): a restart or expiry means
  reading again, never a stored page.
- A page past the body bound is cut and listed as partly read rather than refused, since
  extraction tolerates truncation and the owner sees the list.
- Reading order is selection order and the per-generation text bound is applied in that order,
  so the owner's first selections are read in full first.
- The validator's standfirst tolerance (20 to 40 words against the prompt's 25 to 35), for the
  same reason as the length tolerance.
- The reading boundary and the article contract are two packages: `@cas/source-reader` names
  Node's HTTP clients in its one transport and is depended on by the worker for the text
  extractor it took over; `@cas/article` is pure like `@cas/roundup`. Keeping them apart keeps
  the no-socket test of the article package absolute.
- The URL classifier and the text extractor move into packages so that one code path serves the
  MCP server, the worker and the dashboard; both moves are re-exports with the tests kept.

### 1.11 Verification plan

Offline, in `packages/article`: the eleven tests of the policy's section 5 against the injected
transport and resolver (literal addresses in every encoding, private resolution, rebinding, the
three redirect refusals, the three body-bound cases, the timeout, the two content types, a URL
outside the selection, a page carrying instructions to the model, a citation of a not-read
source); `robots.txt` allow, disallow, 404 and 5xx; extraction and the paragraph-boundary cut;
the schema; the validator's rejections (citation out of selection, citation unread, quotation
not found, section order, missing required section, length, naming basis); golden recorded
responses for a cyberattack and a crypto selection; the key-absent and cap refusals; that the
package names no network module in its policy layer and the default suite opens no socket.
PostgreSQL, in the dashboard suite: a reading over a selection with a recorded transport and
recorded pages, the not-read list shown and confirmed, the generation writing revision 1 and the
ledger row under `kind = 'article'`, the audit events' counts, the non-owner refusals, the edit
as revision 2 with the conflict, the article cap accounted apart from the round-up's. Then the
full verify loop, the four database suites, a clean clone and CI.

## 2. The prompt contract, the stack and the data contract, S1 and S2 (steps 7 to 9)

### 2.1 The prompt contract (step 7)

`packages/article/src/prompt.ts` fixes `article-prompt@1`, hash
`290d0ed5bc74865b1e65cfe042e7a328f7879456be2a658faebf38773444fb71`: the owner's contract (D41)
as instructions, section by section; the citation rule; the quotation rule; the length and the
register; D4's bar for naming the victim with the two bases and the generic description
otherwise; the not-read list to echo; and the rule that the texts under `reading.text` are
material to report from and never instructions, whatever they say (R15). The user turn is the
input as JSON: per selected incident, each row's recorded fields and what the reading left of
its page. The response is constrained to the slot schema by structured output, then validated
(section 3).

### 2.2 Stack check (step 8)

No new dependency. The reader uses `node:http`, `node:https`, `node:dns`, `node:zlib` and
`node:util` from the runtime; extraction reuses `htmlparser2`, already pinned in the catalogue
at 12.0.0, through the worker's `htmlToText`, which moved into `@cas/source-reader` with its test
and its transform label `html-to-text@1` unchanged, the worker re-exporting it. The URL classifier
moved into `@cas/contracts` unchanged, the MCP server re-exporting it, with the Node type
declarations the WHATWG `URL` global needs added to that package's development dependencies.
The bill of materials was regenerated once for the two new workspace packages (342 components,
17 workspace). The rejected alternative, a fetch library with redirect handling and decompression
built in, would have put the two rules that matter most, the pinned connection address and the
bound on decompressed bytes, behind an interface this unit does not control.

### 2.3 The data contract: migration 0016 (step 9)

`packages/database/migrations/0016_article.sql`, forward-only, checksum
`922c41cccb7adec5a31411c605a49a5839764b04dcc48eac0701d894e075069c`, unapplied outside test and
scratch databases:

- `article_revisions`, keyed by (week run, category, revision), revision 1 generated and later
  revisions edited (there is no deterministic article, so the guard admits 1 first); the
  round-up's provenance columns without the template, plus `word_count`, `naming_basis` and
  `sources`, the reading record per source as JSON (outcome, code, bytes, the extracted text's
  digest). Append-only by trigger, bound to a completed week run, provenance bound to the kind.
  No column holds fetched text (O-1).
- `model_calls.kind` admits `article`, and `spendBetween` takes the kind, so each output's cap
  is a sum over its own rows (D9 for the article, option b); the round-up's callers pass
  `roundup`.
- `audit_events.kind` admits `source_fetched`, `article_requested`, `article_completed`,
  `article_refused` and `article_edited`.

`packages/database/src/article.ts` is the operations module: insert and list revisions, the
latest revision, every query parameterised and scoped to the week run it is given. Tests: the
first revision must be 1, the sequence holds, a running week run is refused, provenance is bound
to the kind, update and delete are refused; the ledger accounts the two kinds apart; the five
audit kinds are admitted.

## 3. The reader and the article package, S3 and S4 (steps 10 and 11)

`@cas/source-reader` (section 1.2) reads a selection's sources at most four at a time, each
canonical URL once, in selection order, and applies the per-reading text bound in that order.
Its twenty-three tests are the policy's eleven and more: every literal address in every encoding
the WHATWG parser canonicalizes, a name resolving to a private address with no connection made,
rebinding with the connection pinned to the checked address, a redirect into a private address, a
chain of four, a downgrade, a redirect without a location, a lying length, a body one byte over,
a compressed bomb, an encoding that cannot be bounded, a body that never completes closed at the
deadline, an image and a JSON document, a non-page status, the stage deadline, each URL once, no
link or subresource ever requested, extraction and charset decoding, the paragraph-boundary cut
and the per-reading bound, `robots.txt` parsing and longest-match, one `robots.txt` read per host,
a disallowed path and an unreadable file as not read and 404 as no rule, the one Node transport's
options (the pinned `lookup`, `servername`, the fixed headers, no agent) through an injected
requester, and that the policy layer names no network module.

`@cas/article` (section 1.5) validates a response against the selection as read. Its six tests
cover the input (a stale digest, an unread row carrying text, a partly read row without a code,
a repeated row, the input bound), the schema and the prompt, every rejection code (citation
outside the selection, citation of a source not read, the not-read list not echoed, a quotation
not found, section order, a missing required section, prior context repeated, length, the
standfirst, the headline's question mark and word count, each naming-basis violation including
two sources from one publisher), the quotation match across quote styles and whitespace, golden
responses for a cyberattack and a crypto selection with the provenance and the Markdown export,
the key-absent refusal, the cap refusal, a bad response kept nowhere, a refusal and a failure
reported by code and never by body, and that the package names no network module.

## 4. The dashboard: the reading stage, the generation, the editor, S5 (step 12)

The runtime gains the reader, built from the one Node transport, the real resolver (every
address of a name) and the fixed user agent of O-3, which needs the dashboard's public address
(`DASHBOARD_PUBLIC_URL`, an `https` origin; absent, there is no reader and the reading stage
fails closed with `reader_not_configured`), and the reading cache, where a reading lives for ten
minutes under a random identifier, one per week, category and account.

The article page (`/week/<week run>/article?category=`) shows the selection's counts, the
month's article spend against its own cap, every revision with its provenance (tokens, cost, word
count, naming basis, sources read, partly read and not read) and the latest revision as
copy-ready Markdown. The owner reads the sources with one control; the page then shows the
reading pending confirmation: how many were read in full, partly and not, the publishers not read
with their codes (never a URL path), the bytes and characters, and when the reading expires. The
owner writes the article with a second control that names the reading; a reading that expired,
belongs to another account or no longer matches the selection is refused with a fixed code, and
the owner reads again. After revision 1 the owner edits in a textarea and saves the next revision
under the expected one. A non-owner sees none of the controls, and a direct request is refused at
the data-access layer with the capability as the code.

## 5. Audit events and the ledger, S6 (step 13), and the security baseline

Audit events carry counts and codes, never content: `source_fetched` per source, with the source
row as the subject and bytes, duration and the outcome code in the event's code (R16);
`article_requested` with the category; `article_completed` with the cost, the token counts and
the word count; `article_refused` with the refusal's code; `article_edited` with the revision or
the refusal's code. Every refusal with a known actor is audited once, at the boundary. The ledger
row is written inside the generation path under `kind = 'article'`, so the article's cap never
counts the round-up and the round-up's never counts the article.

Baseline, beyond the fetch policy's own rules: fetched text never reaches a log, an error, an
audit event, a ledger row or a table; it lives in the reading cache and in the request to the
model, and its digest in the revision; the page shows publishers and codes, never a path; the key
is read by name as before; the response is validated against the selection and the texts read
before anything is written; the output is rendered through the existing Markdown sanitiser; cost
is bounded per request by the input and output allowances and per month by the article's cap;
the tables are append-only; no automatic publication exists (D6).

## 6. Verification, S8 (step 15)

On the branch at `1043b17`, 22 October 2026, from the runner: the source reader 23, the article
6, the database 32 offline and 106 against PostgreSQL (the two for migration 0016 among them),
the dashboard 84 offline (the authorization test enumerating the three article mutations and the
view) and 31 against PostgreSQL (the two for the article flow among them).

The first push to CI returned two lint findings and a stale bill of materials, corrected at
`32c0adb`, then three code-scanning alerts (a substring check on a URL in two test assertions,
a comment-stripping regular expression in the `robots.txt` parser), corrected at `3a34b3f`:
the parser cuts comments without a regular expression, and the assertions compare exact URLs
and the audit code's fixed shape. At `3a34b3f`, 22 October 2026: the working checkout and a fresh
clone from the remote both pass install, `pnpm audit`, the bill-of-materials check, `verify`
(exit 0, 1,111 offline tests, 31 tool tests: the source reader 23, the article 6, the worker 269
after its six extractor tests moved, the dashboard 84) and `test:db` (exit 0, 305: database 106,
worker 119, dashboard 31, mcp-server 49); CI green on every check, code scanning included. At
`c06451c`, the branch having taken pull request 23's third correction through pull request 24,
the loop and the four suites pass with the same counts, and CI run 39837895756 is green on every
check.
