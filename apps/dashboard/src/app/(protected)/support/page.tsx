import Link from 'next/link';

import { Csrf, Instant, Notice } from '../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../server/dal/principal.ts';
import { supportView } from '../../../server/dal/support.ts';
import { attempt, escalate, single, type SearchParams } from '../../page-support.ts';
import { openBillingPortalAction, startCheckoutAction } from './actions.ts';

export const dynamic = 'force-dynamic';

/**
 * The support page (CAS-008). Reading stays free; this page offers the
 * supporter tier through Stripe's hosted Checkout and shows the account's
 * mark as the webhooks last left it. A supporter sees a thank-you and the
 * same content as everyone else (D45).
 */
export default async function SupportPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { runtime, principal } = await currentPrincipal();
  const params = await searchParams;
  const result = await attempt(() => supportView(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>Support</h2>
      <Notice code={single(params['notice'])} />
      <p className="small">
        Reading is free and stays free. A monthly subscription supports the work; it grants a
        thank-you and nothing else. Card details are entered on Stripe&apos;s page, never here.
        {view.mode === 'test' ? ' Stripe is in test mode: no real charge is made.' : ''}
      </p>
      {view.mark === 'supporter' ? (
        <p className="notice">
          Thank you for supporting Latest in Cyber. Your support has been active since{' '}
          <Instant value={view.asOf} />.
        </p>
      ) : null}
      {view.mark === 'past_due' ? (
        <p className="notice notice-error">
          Your last renewal did not go through. Update the card from the billing portal below.
        </p>
      ) : null}
      {!view.configured ? (
        <p>Card support is not set up yet.</p>
      ) : view.mark === 'none' ? (
        <form action={startCheckoutAction}>
          <Csrf token={token} />
          <button type="submit">Become a supporter</button>
        </form>
      ) : (
        <form action={openBillingPortalAction}>
          <Csrf token={token} />
          <button type="submit">Manage your support</button>
        </form>
      )}
      <p className="small">
        Prefer a one-off donation? <Link href="/donate">The donation page</Link> lists the pinned
        addresses.
      </p>
    </section>
  );
}
