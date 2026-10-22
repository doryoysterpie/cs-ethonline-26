# CAS-008 report: the supporter tier through provider-hosted checkout, and crypto donations

Unit tracker: `docs/tcu/CAS-008.md`; live status: issue #10. Branch `cas-008/support` from
`cas-007/readers` at `05b6a87`, stacked on pull request 27. This report grows one section per
step. Nothing in it marks a test as passed until the runner's own counts are recorded here.
Audit state: not audited.

## 1. Design note, S0, written before code (step 4)

Written against the owner's three decisions of 22 October 2026 (D44, D45, D46): Stripe, with
hosted Checkout and signed webhooks, tax staying with the operating entity; a thank-you and a
`supporter` mark that is an account attribute and never a capability; three donation entries
(Bitcoin, Ethereum mainnet, Base, USDC accepted on the two EVM entries), each verified by its own
transfer and pinned with a verified-on date, the addresses arriving by file at S0.

### 1.1 What the unit does, in one paragraph

Reading stays free. A signed-in reader may become a supporter: the support page hands off to
Stripe's hosted Checkout for a fixed monthly price, so no card data ever touches this service;
Stripe tells the service what happened through signed webhooks; the service keeps every event
as an append-only row and derives the account's supporter status from them; a supporter sees a
thank-you and the same content as everyone else. A donation page shows the owner's pinned
crypto addresses with a QR code drawn in-process from the same pinned record; changing an
address is a reviewed commit, never a configuration edit, and the page refuses to render if the
file drifts from the digest the code pins.

### 1.2 The provider boundary: Stripe, hosted Checkout, signed webhooks

- **Checkout.** The support action creates a Checkout Session through Stripe's REST API
  (`POST /v1/checkout/sessions`, form-encoded, `mode=subscription`, one line item naming the
  configured price, `success_url` and `cancel_url` on the dashboard's public address,
  `client_reference_id` set to the account identifier, `customer_email` set to the account's
  address) and redirects the reader to the session's `url`, a Stripe-hosted page. The secret
  key travels in the `Authorization` header to `api.stripe.com` and nowhere else; the API
  version is pinned in code with the `Stripe-Version` header. One session per request; the
  session identifier and the account are recorded before the redirect so a later webhook can be
  bound to the account even when Stripe's object carries no reference.
- **Webhooks.** `POST /api/stripe/webhook` takes the raw body and the `Stripe-Signature`
  header, verifies the `v1` signature as Stripe documents it (HMAC-SHA256 under the endpoint's
  signing secret over `timestamp.body`, compared in constant time, every scheme but `v1`
  ignored, the timestamp within five minutes), parses the event, and records it once by its
  event identifier: a second delivery of the same identifier is a replay, acknowledged with
  `200` and changing nothing. Events are not ordered by delivery (Stripe says so): the
  supporter status of an account is derived from the recorded events by the event's own
  `created` instant, not by arrival. The handler returns `2xx` as soon as the row is written;
  it never calls Stripe back. A forged or stale signature is refused with `400` and a fixed
  audit code; an unknown event type is recorded and ignored.
- **The events the endpoint subscribes to:** `checkout.session.completed`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. The status
  derived: `active` while the latest subscription event says `active` or `trialing`;
  `past_due` when it says so; `none` after `canceled`, `unpaid` or a deletion.
- **Managing a subscription.** The support page offers Stripe's hosted billing portal
  (`POST /v1/billing_portal/sessions`) for a supporter to cancel or update a card; nothing of
  that is handled here.
- **Tax.** D44: tax stays with the operating entity; Stripe Tax is not enabled by this unit; the
  entity's registration decides whether HST is charged, as the owner records.

### 1.3 The supporter record: migration 0018

- `checkout_sessions`: `id` (Stripe's session identifier), `account_id`, `created_at`;
  append-only, one row per hand-off, so a webhook's `client_reference_id` or session identifier
  resolves to an account.
- `supporter_events`: `id`, `provider` (`stripe`), `event_id` (unique: the idempotency key),
  `event_type`, `occurred_at` (Stripe's `created`), `received_at`, `account_id` (resolved from
  the session, the customer or the subscription; null when none resolves), `customer_id`,
  `subscription_id`, `status` (the subscription status the event carries, or null),
  `payload_digest` (SHA-256 of the raw body; the body itself is never stored). Append-only by
  guard; `event_id` unique; indexed by account and by subscription.
- The supporter mark (D45) is derived: `supporterStatus(accountId)` is the status of the most
  recent subscription event for the account by `occurred_at`, then by `received_at`; `active`
  or `trialing` means supporter. No column on `accounts` changes; no capability reads it; the
  role table is as CAS-007 left it.
- `audit_events.kind` gains `checkout_started`, `webhook_received`, `supporter_changed`.

### 1.4 The donation record: `data/policy/donation-addresses.json`

The file holds `version` (`donation-addresses@1`) and `entries`, each `{ chain, label,
address, tokens, verifiedOn, note }` with `chain` one of `bitcoin`, `ethereum`, `base`. The
dashboard's loader parses it, checks every field's shape (a Bitcoin address as bech32 or
base58 text, an EVM address as a checksummed `0x` string), computes the SHA-256 of the canonical
`entries` and compares it with the digest pinned in code; a mismatch refuses the page with
`donation_policy_drift`, so an address changes only when the file and the code constant change
in one reviewed commit. The page renders each entry's address as text and as a QR code generated
in-process from that same string, with the verified-on date beside it; nothing is fetched. The
file ships with `entries: []` and the digest of the empty list until the owner's file arrives
(D46: addresses by file at S0, never in chat); the page says so while it is empty. The owner's
constraints are recorded as the file's own rule: a wallet dedicated to this product, no address
shared with another venture or already public under another identity, one verification transfer
per entry even where two entries share a string.

### 1.5 Limits and failure modes

The checkout action is a signed-in action under the same-origin and session-bound checks; one
hand-off per request; a provider error is a fixed code (`checkout_unavailable`) and never its
body. The webhook route is unauthenticated by nature: the signature is the authentication; a
body over 256 KiB is refused before verification; a verification failure, a stale timestamp, a
replay and an unknown type each have a fixed code. Nothing in the unit reads a card number, a
bank detail or a tax identifier.

### 1.6 What is reused unchanged

The data-access layer's capability guard and DTO discipline; the audit store; the proxy's
public-path rule for `/api/`; the dashboard's public address (`DASHBOARD_PUBLIC_URL`) for the
return pages; the policy-file pattern of the authorized workbook.

### 1.7 Files touched, and not touched

Touched: `packages/database/migrations/0018_support.sql` (new) and `src/support.ts`;
`apps/dashboard` the Stripe client and the signature verification, the donation policy loader,
the webhook route, the support and donation pages and actions, DTOs, reads, mutations, the
runtime's provider configuration; `data/policy/donation-addresses.json` (new); tests;
`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/THREAT_MODEL.md`,
`docs/DECISIONS.md`, `.env.example`, this report.

Not touched: the role table and every capability check (D45); what readers see; the owner's
capabilities; any applied migration.

### 1.8 Verification plan

Offline: the signature verification against vectors built with Node's crypto (a valid
signature, a wrong secret, a stale timestamp, a `v0`-only header, a tampered body); the event
parser; the status derivation with events out of order; the donation loader (shape checks,
the drift refusal, the empty file); the QR output for a known string; the Stripe client's
request shape through an injected fetch (form encoding, headers, no key in a URL).
PostgreSQL: the migration; a replayed event changes nothing; an event out of order; the status
derived per account; the audit events. Then the loop, the four suites, a clean clone and CI.
