import { Csrf, Instant, Notice } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { administration } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import {
  assignRoleAction,
  disableAction,
  provisionAction,
  revokeSessionsAction,
  setExpiryAction,
} from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function AccountsPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => administration(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>Accounts and sessions</h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        Store: <span className="mono">{runtime.config.accountStore}</span>. Passwords are stored
        only as Argon2id hashes with a fresh salt each; nothing on this page can show one. A judge
        account must carry an expiry.
      </p>
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Created</th>
            <th>Password changed</th>
            <th>Expires</th>
            <th>Disabled</th>
            <th>Live sessions</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {view.accounts.map((account) => (
            <tr key={account.id}>
              <td className="mono">{account.username}</td>
              <td>{account.role}</td>
              <td>
                <Instant value={account.createdAt} />
              </td>
              <td>
                <Instant value={account.passwordChangedAt} />
              </td>
              <td>
                <Instant value={account.expiresAt} />
              </td>
              <td>
                <Instant value={account.disabledAt} />
              </td>
              <td>{account.liveSessions}</td>
              <td>
                <form action={revokeSessionsAction} className="inline">
                  <Csrf token={token} />
                  <input type="hidden" name="accountId" value={account.id} />
                  <button type="submit" className="quiet">
                    Revoke sessions
                  </button>
                </form>{' '}
                {account.disabledAt === null &&
                principal !== null &&
                account.id !== principal.accountId ? (
                  <form action={disableAction} className="inline">
                    <Csrf token={token} />
                    <input type="hidden" name="accountId" value={account.id} />
                    <button type="submit" className="danger">
                      Disable
                    </button>
                  </form>
                ) : null}
                {principal !== null && account.id !== principal.accountId ? (
                  <form action={assignRoleAction} className="stack">
                    <Csrf token={token} />
                    <input type="hidden" name="accountId" value={account.id} />
                    <label>
                      Role
                      <select name="role" defaultValue={account.role}>
                        <option value="judge">judge</option>
                        <option value="editor">editor</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>
                    <label>
                      Expiry (UTC; required for a judge)
                      <input
                        name="expiresAt"
                        defaultValue={account.expiresAt ?? ''}
                        placeholder="2026-09-14T00:00:00Z"
                      />
                    </label>
                    <button type="submit">Assign role</button>
                  </form>
                ) : null}
                <form action={setExpiryAction} className="stack">
                  <Csrf token={token} />
                  <input type="hidden" name="accountId" value={account.id} />
                  <label>
                    Set expiry only (UTC; empty clears it, except for a judge)
                    <input
                      name="expiresAt"
                      defaultValue={account.expiresAt ?? ''}
                      placeholder="2026-09-14T00:00:00Z"
                    />
                  </label>
                  <button type="submit" className="quiet">
                    Set expiry
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Provision an account</h3>
      <p className="small">
        The same path as the command line: the password is validated, hashed with Argon2id and a
        fresh salt, and discarded. Rotating an existing account replaces its hash and revokes every
        session of that account.
      </p>
      <form className="stack" action={provisionAction} autoComplete="off">
        <Csrf token={token} />
        <label>
          Username (3 to 32 characters: a lower-case letter, then letters, digits, underscores or
          hyphens)
          <input
            name="username"
            required
            pattern="[a-z][a-z0-9_-]{2,31}"
            maxLength={32}
            autoComplete="off"
          />
        </label>
        <label>
          Role
          <select name="role" defaultValue="judge">
            <option value="judge">judge</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <label>
          Expiry (UTC; required for a judge)
          <input name="expiresAt" placeholder="2026-09-14T00:00:00Z" />
        </label>
        <label>
          Password (12 to 128 characters)
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <label>
          Password again
          <input
            name="passwordAgain"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <label>
          <span>
            <input type="checkbox" name="rotate" value="yes" /> Rotate: replace the password of an
            existing account
          </span>
        </label>
        <button type="submit">Provision</button>
      </form>

      <h3>Security audit (newest first, last 100)</h3>
      <table>
        <thead>
          <tr>
            <th>At</th>
            <th>Kind</th>
            <th>Outcome</th>
            <th>Code</th>
            <th>Actor</th>
            <th>Subject</th>
            <th>Network</th>
          </tr>
        </thead>
        <tbody>
          {view.audit.map((event, index) => (
            <tr key={`${event.at}:${index}`}>
              <td>
                <Instant value={event.at} />
              </td>
              <td>{event.kind}</td>
              <td>{event.outcome}</td>
              <td className="mono">{event.code}</td>
              <td className="mono">{event.actor ?? '—'}</td>
              <td className="mono">{event.subject ?? '—'}</td>
              <td className="mono">{event.networkKey ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
