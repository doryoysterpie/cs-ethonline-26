import { Csrf, Instant, Notice, SectionBlock } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { pendingSignups, READER_EXPIRY_DEFAULT_DAYS } from '../../../../server/dal/readers.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import { approveAction, denyAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function RequestsPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => pendingSignups(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const pending = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>Access requests</h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        Addresses that proved they receive mail and await a decision, oldest first. Approval creates
        a reader account that sees the sanitized views and the published outputs, with an expiry{' '}
        {READER_EXPIRY_DEFAULT_DAYS} days from now unless you set one; denial records the decision.
        Both send a fixed email.
      </p>
      {pending.length === 0 ? (
        <p>No request is waiting.</p>
      ) : (
        <SectionBlock title="Pending requests">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Requested</th>
                <th>Verified</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((request) => (
                <tr key={request.requestId}>
                  <td className="mono">{request.email}</td>
                  <td>
                    <Instant value={request.requestedAt} />
                  </td>
                  <td>
                    <Instant value={request.verifiedAt} />
                  </td>
                  <td>
                    <form action={approveAction} className="inline">
                      <Csrf token={token} />
                      <input type="hidden" name="requestId" value={request.requestId} />
                      <label>
                        Expiry (UTC; empty for one year)
                        <input name="expiresAt" type="text" placeholder="2027-10-22T00:00:00Z" />
                      </label>
                      <button type="submit">Approve</button>
                    </form>
                    <form action={denyAction} className="inline">
                      <Csrf token={token} />
                      <input type="hidden" name="requestId" value={request.requestId} />
                      <button type="submit" className="quiet">
                        Deny
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionBlock>
      )}
    </section>
  );
}
