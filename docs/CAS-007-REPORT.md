# CAS-007 report: reader sign-up with owner approval, the published mark, and scrape protection

Unit tracker: `docs/tcu/CAS-007.md`; live status: issue #9. Branch `cas-007/readers` from
`cas-005/article` at `78b1db2`, stacked on pull request 26. This report grows one section per
step. Nothing in it marks a test as passed until the runner's own counts are recorded here.
Audit state: not audited.

## 1. Design note, S0, written before code (step 3)

Written against the owner's two decisions of 22 October 2026 (D42, D43): a reader sees the four
sanitized views and the latest revision of each round-up and article once the owner marks that
revision published, the mark per revision and owner-only, unmarking immediate; the `judge` role
is retired into `reader`, existing judge accounts become readers, and a reader account's expiry
is a per-account value set at approval, one year by default.

### 1.1 What the unit does, in one paragraph

Anyone can ask for an account with an email address alone: the address, then the code that
proves they hold it, then a pending request the owner (or an admin) approves or denies from a
page. An approved reader signs in by the existing one-time code and holds the `reader` role: the
four sanitized views a judge had, plus the published outputs. Publication is the owner's act, per
revision; nothing generated is visible without it, which holds D6 and D4 at one point. Every
unauthenticated path and every reader is rate-limited, with a fixed refusal and a count-only
audit event when a limit trips, and the instance serves a `robots.txt` that disallows the known
AI crawlers, a convention they may ignore, so the limits are the protection.

### 1.2 The request record: migration 0017

`signup_requests`, one row per request, append-only in the narrow way `otp_challenges` is:

- `id`, `normalized_email` (the same shape and normalisation as `accounts.normalized_email`),
  `code_digest` (HMAC-SHA-256 of the code under the server-held OTP pepper, as sign-in does;
  no code is stored), `attempt_count`, `requested_at`, `expires_at` (the code's life, ten
  minutes), `verified_at`, `decided_at`, `decision` (`approved` or `denied`), `decided_by` (an
  account), `account_id` (the reader account created at approval).
- One-way transitions by guard: `attempt_count` only increases; `verified_at`, `decided_at`,
  `decision`, `decided_by` and `account_id` move from null to a value once; `decision` requires
  `verified_at`; `account_id` requires `decision = 'approved'`; nothing else changes; no delete.
- Keys: a partial unique index on `normalized_email` where `decided_at IS NULL`, so one open
  request per address; an index on `(decided_at, verified_at)` for the pending page.

One deviation from the tracker's wording, recorded with its reason: the record holds the
normalised address, not only its hash. Approval has to create an account for the address and the
decision emails have to reach it; a hash alone makes both impossible. The address is Restricted
data exactly as `accounts.normalized_email` is (retention inventory, section 2), and no page shows
it to anyone but an admin.

The same migration: `output_publications`, the published mark (section 1.5); `accounts.role`
admits `reader` and no longer `judge`, every existing `judge` row becomes `reader` (the one data
change a migration of this repository has made, taken by D43), and `accounts_reader_expiry`
replaces `accounts_judge_expiry`; `audit_events.kind` gains the eight kinds of section 1.7.

### 1.3 The flow, and the exact generic responses

1. `/signup`: the address. The action checks same-origin, normalises the address, applies the
   limits (section 1.6), and then, whatever the address (unknown, already an account, already
   pending, malformed but well-shaped), does the same work and gives the same answer: a
   challenge is recorded and a code sent only when the address is well-formed, holds no account
   and has no open request; in every other case nothing is sent and nothing is recorded beyond
   the audit event; the page always redirects to `/signup/verify?notice=signup_code_sent`, whose
   text is: "If that address can request access, a code was sent. Enter it below." The
   pending-request identifier travels in the same kind of short-lived, host-only cookie the
   sign-in flow uses.
2. `/signup/verify`: the code. A right code sets `verified_at` and shows "Your request is
   recorded. The owner reviews requests; you will receive an email either way." A wrong code
   increments the attempt count and shows "That code did not work."; the fifth wrong code locks
   the request (`signup_locked`), after which the same message shows and nothing more is
   accepted. An expired or unknown challenge shows "Enter your address again to request a new
   code."
3. `/admin/requests`: verified, undecided requests, oldest first, with the address and the
   instants, for a principal holding `admin:accounts`. Approve takes an expiry (one year from
   now by default, D43) and creates the reader account through the existing invitation path,
   then sends the approval email; deny records the decision and sends the denial email. Both are
   audit events naming the request and the account, never the address.

Byte-identical responses: the request page's answer and redirect are the same for an unknown
address, a pending one and an existing account; the verify page's answer is the same for a wrong
code whether or not the request exists. The tests compare the full response bodies.

### 1.4 The `reader` role, written out in full

`reader` holds `view:command_center`, `view:incidents`, `view:anomaly`, `view:evidence` (the
judge's four, sanitized: no source headline, no source link, no source text, no note, no draft)
and `view:published` (the published outputs, section 1.5). Nothing else: no queue, no draft, no
selection, no generation, no administration. `judge` leaves the role table; the capability
tables, the provisioning and invitation commands, the synthetic accounts and every test that
named `judge` name `reader`. A reader account requires an expiry; the invitation and approval
paths set it, one year from approval by default and any value the admin enters.

### 1.5 The published mark: D6 and D4 at one point

`output_publications`: `id`, `week_run_id`, `category`, `output` (`roundup` or `article`),
`revision`, `action` (`publish` or `unpublish`), `actor_account_id`, `created_at`; append-only;
the revision must exist in the output's table. The public revision of an output is the latest row
for (week run, category, output) when its action is `publish`; after an `unpublish` row there is
none. A later generation or edit changes nothing public until the owner marks the new revision;
unmarking takes effect on the next request. Capability `publish:output`, the owner's alone,
beside `generate:roundup`, `generate:article` and `edit:output`. The round-up and article pages
gain the mark controls for the owner; `/published` lists the weeks and categories with a public
output for a principal holding `view:published`, and `/published/<week run>?category=&output=`
shows the public revision's Markdown through the existing sanitiser. Nothing on those pages comes
from a draft, a note or source text: the Markdown is the owner's published revision, and D4 was
applied when it was written.

### 1.6 Limits, fixed at S0

- Sign-up requests: at most 3 per address and 10 per network source in 15 minutes, the network
  source as the trusted proxy reports it (`DASHBOARD_TRUST_FORWARDED_FOR`, CAS-006 blocker 3
  settles the hop); over the limit the action does nothing and redirects to the same notice, so a
  flood learns nothing, and one `limit_tripped` audit event with code `signup_address` or
  `signup_network` is written per window, never per request.
- Code attempts: five wrong codes lock the request (`signup_locked`).
- Unauthenticated routes (`/login`, `/login/verify`, `/signup`, `/signup/verify`, `/robots.txt`,
  `/api/healthz`): the existing sign-in throttle stays as it is (30 attempts per source per
  15 minutes on the code request); the sign-up limits above cover the new routes; the two
  read-only routes are static answers with no cost behind them.
- Reader reads: at most 600 data-access reads per reader account in 15 minutes, counted at the
  data-access layer where every reader page begins; over the limit a fixed refusal with
  `retry-after`, and one `limit_tripped` event with code `reader_reads` per window.
- `robots.txt`: served at `/robots.txt` from a fixed, versioned list (`robots-policy@1`) that
  disallows the known AI crawlers by user agent (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot,
  Claude-Web, anthropic-ai, Google-Extended, CCBot, PerplexityBot, Bytespider, Amazonbot,
  Applebot-Extended, cohere-ai, Diffbot, FacebookBot, Meta-ExternalAgent, omgili, Timpibot,
  YouBot, ImagesiftBot, AI2Bot), and allows nothing else to be inferred: the dashboard is behind
  sign-in, so the file is a courtesy, and the limits are the protection.
- The hosting layer, checked on 22 October 2026 and recorded, not assumed: Railway's edge
  firewall offers an on-demand "Under Attack Mode" (a browser check for every new visitor while
  it is on) and no always-on rate limit or address rule; a native firewall is on Railway's
  roadmap; the common practice is a Cloudflare zone in front, which would be a hosting decision
  of CAS-006's blocker 3, not this unit's. This unit assumes nothing from the host.

### 1.7 Audit events

`signup_requested` (code: the outcome class, `sent`, `silent` or `limited`; subject: the request
when one exists; actor none), `signup_verified`, `signup_locked`, `signup_approved` (actor: the
admin; subject: the request; subject account: the new reader), `signup_denied`,
`limit_tripped` (code: which limit; count-only), `output_published`, `output_unpublished` (actor:
the owner; code: `<output>_<revision>`; subject: the week run). Identifiers and fixed codes
only; never an address, never content.

### 1.8 The emails, fixed text, no link that signs in

Approval: subject "Your request to read Latest in Cyber was approved"; body: "Your request was
approved. Sign in at <the dashboard's public address> with this address; a code is sent to it
each time. Your access runs until <date>." The address is the configured public origin as text,
not a token. Denial: subject "Your request to read Latest in Cyber"; body: "Your request was not
approved." Both go through the existing provider interface; a test injects a fake and asserts
the exact text.

### 1.9 What is reused unchanged

The one-time code's generation, digest and lifetime (`otp.ts`); the address normalisation and
shape (`email.ts`); the same-origin check; the network key; the pending cookie's attributes; the
sign-in throttle; the account invitation path (`inviteAccount`) and the account store; the
Markdown sanitiser; the data-access layer's capability guard and DTO discipline.

### 1.10 Files touched, and not touched

Touched: `packages/database/migrations/0017_readers.sql` (new) and `src/readers.ts`;
`apps/dashboard` roles, store (audit kinds), runtime (the email provider and the limiters), the
sign-up pages and actions, the admin requests page, the published pages, the publish controls on
the round-up and article pages, the `robots.txt` route, DTOs, reads, mutations; tests;
`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/THREAT_MODEL.md` (B9 from planned
to built), `docs/DECISIONS.md`, this report.

Not touched: the owner's capabilities (D39), what editors see, payments, cards, every applied
migration.

### 1.11 Verification plan

Offline: the role table (reader's five capabilities, judge gone); the limiters (a burst from one
source throttled, a burst for one address throttled, the window's reset, bounded memory); the
code lock at five; the generic responses byte-identical; `robots.txt` with the fixed list;
approval by a non-admin refused; a reader refused at every editor, owner and admin function in
the authorization enumeration; the published mark's current-revision rule. PostgreSQL: every
transition of a request (request, verify, lock, approve, deny) and its guard; the migration's
role change; the publications table and the public revision; a reader's page responses with
source text selected as `NULL`; the audit events' codes. Then the loop, the four suites, a clean
clone and CI.

## 2. The data contract, S2 (step 4)

`packages/database/migrations/0017_readers.sql`, forward-only, checksum
`13c3ed7f6f5bf8761f479407d8c021c29881f443051a16759c83fe797c3b787b`, unapplied outside test and
scratch databases: `signup_requests` and its one-way guard (section 1.2); `output_publications`,
append-only, its guard refusing a revision that does not exist in the output's table;
`accounts.role` admitting `reader` and no longer `judge`, every existing `judge` row made a
`reader` inside the migration (D43), and `accounts_reader_expiry` in place of
`accounts_judge_expiry`; the eight audit kinds. `packages/database/src/readers.ts` is the
operations module: insert a request (`open_exists` when the address has one), read it, record an
attempt, verify once, decide once, list the pending ones; insert a publication, the current
publication of an output, the list of everything published. Tests: the role check admits
`reader` with an expiry and refuses `judge`; a request moves one way and only one is open per
address; a decision needs a verification; an account needs an approval; a publication names a
revision that exists; the latest record decides; unmarking is a record; nothing is rewritten or
deleted; the eight kinds are admitted.

## 3. The reference implementation and the role, S3 (steps 5 and 6 in part)

`judge` became `reader` throughout the code and the tests (D43): the role table, the capability
sets, the provisioning and invitation commands, the memory store's seed check, the synthetic
accounts, the authorization enumeration. `reader` holds the judge's four sanitized views and
`view:published`; editors, admins and the owner hold `view:published` too, so the owner can see
the public page as readers do; `publish:output` is the owner's alone (D42).

`apps/dashboard/src/server/dal/readers.ts` holds the transitions over the store and the
database: `requestSignup` (the limits, the normalisation, the same answer whatever the address,
the code sent only where one is due), `verifySignup` (one verification, five attempts, the lock),
`pendingSignups`, `approveSignup` (the reader account through the invitation path, the decision,
the fixed email) and `denySignup`; `publishOutput` and `unpublishOutput`; `publishedList` and
`publishedOutput`. `reader-limit.ts` applies the reader read limit where every reader-reachable
read begins: the four sanitized views and the two published reads. `http/limits.ts` is the
fixed-window limiter, bounded in memory, that carries the three limits of section 1.6.

## 4. The interface, S5 (step 6), and the emails (step 8)

`/signup` and `/signup/verify` are the two unauthenticated steps, behind the same-origin check
and the limits, the request identifier in a host-only pending cookie of its own (never the
address); every outcome of the first step redirects to the same screen with the same notice.
`/admin/requests` lists verified requests for a principal holding `admin:accounts`, with approve
(an expiry field, one year by default) and deny. `/published` lists what the owner has marked;
`/published/<week run>?category=&output=` renders the marked revision through the existing
sanitiser and nothing else. The round-up and article pages gain a column per revision with
"Publish this revision" or "Published · unpublish" for the owner, and the word "published" for
everyone else. `/robots.txt` serves the fixed, versioned list (`robots-policy@1`). The proxy
admits the three new public paths. The approval and denial emails are the fixed texts of
section 1.8; the approval names the dashboard's public address as text, never a token.

## 5. Audit events and the limits, S6 (steps 7 and 8a)

Every outcome is an audit event with identifiers and fixed codes (section 1.7): a request as
`sent`, `silent` or `limited`; a verification; a lock; an approval naming the admin, the request
and the new reader; a denial; a publication or its removal with `<output>_<revision>`; and
`limit_tripped` with `signup_address`, `signup_network` or `reader_reads`, written once per window
on the first refusal and never per refused request. No event carries an address, a code or
content; the tests assert it. The hosting layer's bot management was checked and recorded
(section 1.6): nothing is assumed from it.

## 6. Verification, S8 (step 12)

On the branch at `ae5e7e3`, 22 October 2026, from the runner: the database 32 offline and 109
against PostgreSQL (the three for migration 0017 among them), the dashboard 88 offline (the
limiter, `robots.txt`, the roles and the authorization enumeration with the seven new functions
among them) and 34 against PostgreSQL (the three for sign-up, the limits and the published mark
among them). The full loop, the four suites, the clean clone and CI are recorded below as they
complete.
