import 'server-only';

import type { SubscriptionStatus } from '@cas/database';

/**
 * The supporter mark (D45): derived from the latest subscription status an
 * account's events carry, never stored on the account and never read by a
 * capability check. `supporter` while Stripe says active or trialing;
 * `past_due` while a renewal is failing; `none` otherwise.
 */
export type SupporterMark = 'supporter' | 'past_due' | 'none';

export function markFor(status: SubscriptionStatus | null): SupporterMark {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'supporter';
    case 'past_due':
      return 'past_due';
    default:
      return 'none';
  }
}
