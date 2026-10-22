import 'server-only';

import { randomUUID } from 'node:crypto';

import type { Principal } from '../auth/session.ts';
import { DashboardError } from '../errors.ts';
import type { Runtime } from '../runtime.ts';

/**
 * The reader read limit (CAS-007, report section 1.6): at most a fixed number
 * of data-access reads per reader account in one window, applied where every
 * reader-reachable read begins. Over the limit, a fixed refusal with the wait;
 * one count-only audit event per window, written on the first refusal, never
 * on each.
 */
export async function enforceReaderLimit(runtime: Runtime, principal: Principal): Promise<void> {
  if (principal.role !== 'reader') return;
  const decision = runtime.limits.readerReads.check(
    `account:${principal.accountId}`,
    Math.floor(Date.now() / 1000),
  );
  if (decision.allowed) return;
  if (decision.firstTrip) {
    await runtime.stores.audit.append({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: 'limit_tripped',
      outcome: 'failure',
      code: 'reader_reads',
      actorAccountId: principal.accountId,
      subjectAccountId: null,
      sessionId: principal.sessionId,
      networkKey: null,
      subjectId: null,
    });
  }
  throw new DashboardError(
    'throttled',
    'reader_read_limit',
    `Too many requests; try again in ${decision.retryAfterSeconds} seconds.`,
  );
}
