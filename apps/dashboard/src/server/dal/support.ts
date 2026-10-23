import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import type { Principal } from '../auth/session.ts';
import type { AuditEvent } from '../auth/store.ts';
import { DashboardError } from '../errors.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
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
}

/**
 * The hand-off to Stripe's hosted Checkout: one session per request, bound
 * to the account before the browser is sent anywhere, so a later webhook
 * resolves to the account whatever Stripe's object carries.
 */
export async function startCheckout(
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
  let session: { id: string; url: string };
  try {
    session = await runtime.support.stripe.createCheckoutSession({
      priceId: runtime.support.priceId,
      accountId: who.accountId,
      customerEmail: who.normalizedEmail,
      successUrl: `${runtime.publicUrl}/support?notice=checkout_returned`,
      cancelUrl: `${runtime.publicUrl}/support?notice=checkout_cancelled`,
    });
  } catch (error) {
    await refused('checkout_unavailable');
    throw error;
  }
  const packages = await workspace();
  try {
    await runtime.database.withTransaction((tx) =>
      packages.database.insertCheckoutSession(tx, {
        id: session.id,
        accountId: who.accountId,
        createdAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    await refused('record_failed');
    throw mapFailure(error, packages);
  }
  await audit(runtime, {
    kind: 'checkout_started',
    outcome: 'success',
    code: 'redirected',
    ...base,
    subjectId: session.id,
  });
  return { url: session.url };
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
