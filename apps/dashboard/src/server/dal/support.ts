import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import type { Principal } from '../auth/session.ts';
import type { AuditEvent } from '../auth/store.ts';
import { DashboardError } from '../errors.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import type { Queryable } from '@cas/database';
import {
  loadDonationPolicy,
  pinnedDonationPolicy,
  type DonationEntry,
} from '../support/donations.ts';
import { parseStripeEvent } from '../support/events.ts';
import { verifySignature } from '../support/signature.ts';
import { markFor, type SupporterMark } from '../support/status.ts';
import type { StripeMode } from '../support/config.ts';
import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';
import { transactionOn } from './mutate.ts';

/**
 * The supporter tier and the donation page (CAS-008, report section 1).
 * Every signed-in account may support; the capability named below is the
 * one every role holds, so the check is a session check with the layer's
 * usual shape, and no capability reads the supporter mark (D45). The webhook
 * entry is unauthenticated by nature: the signature is its authentication,
 * and every outcome is an audit event with a fixed code.
 */
const SIGNED_IN = 'view:command_center' as const;
/** A delivery over this many bytes is refused before anything is read from it. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function audit(
  runtime: Pick<Runtime, 'stores'>,
  event: Omit<AuditEvent, 'id' | 'at'>,
): Promise<void> {
  await runtime.stores.audit.append({ id: randomUUID(), at: new Date().toISOString(), ...event });
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function notConfigured(): DashboardError {
  return new DashboardError(
    'configuration',
    'support_not_configured',
    'card support is not configured',
  );
}

// ---------------------------------------------------------------- the support page

export interface SupportViewDto {
  readonly configured: boolean;
  readonly mode: StripeMode | null;
  readonly mark: SupporterMark;
  /** The instant of the event the mark derives from, or null. */
  readonly asOf: string | null;
}

export async function supportView(
  runtime: Runtime,
  principal: Principal | null,
): Promise<SupportViewDto> {
  const who = requireCapability(principal, SIGNED_IN);
  const packages = await workspace();
  try {
    const status = await runtime.database.withClient((client) =>
      packages.database.supporterStatus(client, who.accountId),
    );
    return {
      configured: runtime.support !== null && runtime.publicUrl !== null,
      mode: runtime.support?.mode ?? null,
      mark: markFor(status?.status ?? null),
      asOf: status?.asOf ?? null,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export interface CheckoutInput {
  readonly networkKey: string;
  /** The request's instant; the wall clock when absent. Tests advance it past an attempt's expiry. */
  readonly now?: Date | undefined;
}

/** How long one hosted session, and the attempt that holds it, stays usable. Stripe asks for at least 30 minutes. */
export const CHECKOUT_ATTEMPT_MINUTES = 35;

/**
 * One hand-off at a time per account: an advisory lock tried on one
 * connection, never waited for, held across the provider's answer, so two
 * submissions at once make one request and the second is refused at once
 * with a fixed conflict; every read and write of the attempt runs on the
 * one connection that holds the lock. Released on every exit.
 */
async function withCheckoutLock<T>(
  runtime: Runtime,
  accountId: string,
  work: (holder: Queryable) => Promise<T>,
): Promise<T> {
  const key = `${runtime.database.schema}:checkout:${accountId}`;
  return runtime.database.withClient(async (holder) => {
    const claimed = await holder.query<{ locked: boolean }>(
      'SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',
      [key],
    );
    if (claimed.rows[0]?.locked !== true) {
      throw new DashboardError(
        'conflict',
        'checkout_in_progress',
        'a checkout for this account is being prepared; try again in a moment',
      );
    }
    try {
      return await work(holder);
    } finally {
      await holder.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))', [key]);
    }
  });
}

/**
 * The hand-off to Stripe's hosted Checkout, one subscription per account
 * (train review F7). An account whose standing is already a supporter's or
 * past due is not sent to Checkout again. Under the account's lock, the open
 * attempt is reused when the provider has answered it; otherwise an attempt
 * is opened, or the open one without an answer is taken up again, and the
 * provider is asked once under the attempt's own idempotency key (the
 * customer the account is bound to reused when known), then the session is
 * recorded and bound to the attempt. A request that fails leaves the
 * attempt committed with its key, so a retry inside the window asks under
 * the same key and the provider answers the session it may already hold.
 */
export async function startCheckout(
  runtime: Runtime,
  principal: Principal | null,
  input: CheckoutInput,
): Promise<{ readonly url: string }> {
  const who = requireCapability(principal, SIGNED_IN);
  const now = input.now ?? new Date();
  const base = {
    actorAccountId: who.accountId,
    subjectAccountId: who.accountId,
    sessionId: who.sessionId,
    networkKey: input.networkKey,
  };
  const refused = async (code: string): Promise<void> => {
    await audit(runtime, {
      kind: 'checkout_started',
      outcome: 'failure',
      code,
      ...base,
      subjectId: null,
    });
  };
  if (runtime.support === null || runtime.publicUrl === null) {
    await refused('support_not_configured');
    throw notConfigured();
  }
  const support = runtime.support;
  const publicUrl = runtime.publicUrl;
  const decision = runtime.limits.checkoutAccount.check(`account:${who.accountId}`, seconds());
  if (!decision.allowed) {
    if (decision.firstTrip) {
      await audit(runtime, {
        kind: 'limit_tripped',
        outcome: 'failure',
        code: 'checkout_account',
        ...base,
        subjectId: null,
      });
    }
    await refused('limited');
    throw new DashboardError('throttled', 'checkout_limited', 'too many checkout attempts');
  }
  const packages = await workspace();
  const db = packages.database;
  let outcome: {
    readonly url: string;
    readonly code: 'reused' | 'redirected';
    readonly subjectId: string;
  };
  try {
    outcome = await withCheckoutLock(runtime, who.accountId, async (holder) => {
      const standing = await db.supporterStatus(holder, who.accountId);
      if (standing !== null && markFor(standing.status) !== 'none') {
        throw new DashboardError(
          'conflict',
          'support_already_active',
          'this account already has a subscription',
        );
      }
      const customer = await db.customerForAccount(holder, who.accountId);
      const attempt = await transactionOn(holder, async () => {
        await db.closeExpiredCheckoutAttempts(holder, who.accountId, now.toISOString());
        const open = await db.lockOpenCheckoutAttempt(holder, who.accountId);
        if (open !== null) return open;
        const created = {
          id: randomUUID(),
          accountId: who.accountId,
          idempotencyKey: randomUUID(),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + CHECKOUT_ATTEMPT_MINUTES * 60_000).toISOString(),
        };
        if ((await db.insertCheckoutAttempt(holder, created)) === 'open_exists') {
          // Cannot happen under the lock; read what is there rather than use a key not on record.
          const raced = await db.lockOpenCheckoutAttempt(holder, who.accountId);
          if (raced !== null) return raced;
        }
        return { ...created, sessionId: null, url: null, closedAt: null };
      });
      if (attempt.url !== null) return { url: attempt.url, code: 'reused', subjectId: attempt.id };
      const session = await support.stripe.createCheckoutSession({
        priceId: support.priceId,
        accountId: who.accountId,
        customerId: customer,
        customerEmail: customer === null ? who.normalizedEmail : null,
        successUrl: `${publicUrl}/support?notice=checkout_returned`,
        cancelUrl: `${publicUrl}/support?notice=checkout_cancelled`,
        idempotencyKey: attempt.idempotencyKey,
        expiresAtSeconds: Math.floor(Date.parse(attempt.expiresAt) / 1000),
      });
      await transactionOn(holder, async () => {
        await db.insertCheckoutSession(holder, {
          id: session.id,
          accountId: who.accountId,
          createdAt: now.toISOString(),
        });
        await db.bindCheckoutAttempt(holder, attempt.id, {
          sessionId: session.id,
          url: session.url,
        });
      });
      return { url: session.url, code: 'redirected', subjectId: session.id };
    });
  } catch (error) {
    if (error instanceof DashboardError) {
      await refused(
        error.code === 'checkout_unavailable' ||
          error.code === 'support_already_active' ||
          error.code === 'checkout_in_progress'
          ? error.code
          : 'record_failed',
      );
      throw error;
    }
    await refused('record_failed');
    throw mapFailure(error, packages);
  }
  await audit(runtime, {
    kind: 'checkout_started',
    outcome: 'success',
    code: outcome.code,
    ...base,
    subjectId: outcome.subjectId,
  });
  return { url: outcome.url };
}

/** The hand-off to Stripe's hosted billing portal, for a supporter to cancel or update a card. */
export async function openBillingPortal(
  runtime: Runtime,
  principal: Principal | null,
  input: CheckoutInput,
): Promise<{ readonly url: string }> {
  const who = requireCapability(principal, SIGNED_IN);
  const base = {
    actorAccountId: who.accountId,
    subjectAccountId: who.accountId,
    sessionId: who.sessionId,
    networkKey: input.networkKey,
  };
  if (runtime.support === null || runtime.publicUrl === null) throw notConfigured();
  const packages = await workspace();
  let customer: string | null;
  try {
    customer = await runtime.database.withClient((client) =>
      packages.database.customerForAccount(client, who.accountId),
    );
  } catch (error) {
    throw mapFailure(error, packages);
  }
  if (customer === null) {
    throw new DashboardError(
      'not_found',
      'no_supporter_record',
      'no support record exists for this account',
    );
  }
  let portal: { url: string };
  try {
    portal = await runtime.support.stripe.createPortalSession({
      customerId: customer,
      returnUrl: `${runtime.publicUrl}/support`,
    });
  } catch (error) {
    await audit(runtime, {
      kind: 'checkout_started',
      outcome: 'failure',
      code: 'portal_unavailable',
      ...base,
      subjectId: null,
    });
    throw error;
  }
  await audit(runtime, {
    kind: 'checkout_started',
    outcome: 'success',
    code: 'portal_redirected',
    ...base,
    subjectId: customer,
  });
  return { url: portal.url };
}

// ---------------------------------------------------------------- the webhook

export interface WebhookInput {
  readonly body: string;
  readonly signatureHeader: string | null;
  readonly networkKey: string;
  readonly now?: Date | undefined;
}

export interface WebhookOutcome {
  readonly status: 200 | 400 | 503;
  readonly code: string;
}

/**
 * One delivery: bounded, verified, parsed, recorded once by its identifier,
 * and the account's mark re-derived in the same transaction. A replay
 * changes nothing and is acknowledged. The handler never calls Stripe back.
 */
export async function recordWebhook(
  runtime: Runtime,
  input: WebhookInput,
): Promise<WebhookOutcome> {
  const now = input.now ?? new Date();
  const base = {
    actorAccountId: null,
    subjectAccountId: null,
    sessionId: null,
    networkKey: input.networkKey,
  };
  const refuse = async (status: 400 | 503, code: string): Promise<WebhookOutcome> => {
    await audit(runtime, {
      kind: 'webhook_received',
      outcome: 'failure',
      code,
      ...base,
      subjectId: null,
    });
    return { status, code };
  };
  if (Buffer.byteLength(input.body, 'utf8') > WEBHOOK_MAX_BYTES)
    return refuse(400, 'webhook_too_large');
  if (runtime.support === null) return refuse(503, 'webhook_not_configured');
  const verdict = verifySignature({
    payload: input.body,
    header: input.signatureHeader,
    secret: runtime.support.webhookSecret,
    nowSeconds: Math.floor(now.getTime() / 1000),
  });
  if (verdict !== 'ok') return refuse(400, `webhook_signature_${verdict}`);
  const event = parseStripeEvent(input.body);
  if (event === null) return refuse(400, 'webhook_body_malformed');
  const digest = createHash('sha256').update(input.body, 'utf8').digest('hex');
  const packages = await workspace();
  let outcome: { code: string; accountId: string | null; changed: SupporterMark | null };
  try {
    outcome = await runtime.database.withTransaction(async (tx) => {
      const db = packages.database;
      let accountId: string | null = null;
      if (event.sessionId !== null)
        accountId = await db.accountForCheckoutSession(tx, event.sessionId);
      if (accountId === null && event.subscriptionId !== null) {
        accountId = await db.accountForSubscription(tx, event.subscriptionId);
      }
      if (accountId === null && event.customerId !== null) {
        accountId = await db.accountForCustomer(tx, event.customerId);
      }
      if (
        accountId === null &&
        event.clientReferenceId !== null &&
        UUID_SHAPE.test(event.clientReferenceId)
      ) {
        const account = await runtime.stores.accounts.getById(event.clientReferenceId);
        accountId = account?.id ?? null;
      }
      const before = accountId === null ? null : await db.supporterStatus(tx, accountId);
      const inserted = await db.insertSupporterEvent(tx, {
        id: randomUUID(),
        provider: 'stripe',
        eventId: event.id,
        eventType: event.type,
        occurredAt: new Date(event.created * 1000).toISOString(),
        receivedAt: now.toISOString(),
        accountId,
        customerId: event.customerId,
        subscriptionId: event.subscriptionId,
        status: event.status,
        payloadDigest: digest,
      });
      if (inserted === 'replay') return { code: 'webhook_replay', accountId, changed: null };
      if (event.sessionId !== null && event.type === 'checkout.session.completed') {
        await db.closeCheckoutAttemptForSession(tx, event.sessionId, now.toISOString());
      }
      const after = accountId === null ? null : await db.supporterStatus(tx, accountId);
      const from = markFor(before?.status ?? null);
      const to = markFor(after?.status ?? null);
      return {
        code: event.handled ? 'webhook_recorded' : 'webhook_ignored',
        accountId,
        changed: from === to ? null : to,
      };
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
  await audit(runtime, {
    kind: 'webhook_received',
    outcome: 'success',
    code: outcome.code,
    ...base,
    subjectAccountId: outcome.accountId,
    subjectId: event.id,
  });
  if (outcome.changed !== null) {
    await audit(runtime, {
      kind: 'supporter_changed',
      outcome: 'success',
      code: outcome.changed,
      ...base,
      subjectAccountId: outcome.accountId,
      subjectId: event.id,
    });
  }
  return { status: 200, code: outcome.code };
}

// ---------------------------------------------------------------- donations

export interface DonationsDto {
  readonly entries: readonly DonationEntry[];
}

/** The pinned entries, or a fixed refusal when the file and the code disagree. */
export async function donationsView(
  runtime: Runtime,
  principal: Principal | null,
): Promise<DonationsDto> {
  requireCapability(principal, SIGNED_IN);
  void runtime;
  return { entries: loadDonationPolicy(pinnedDonationPolicy()) };
}
