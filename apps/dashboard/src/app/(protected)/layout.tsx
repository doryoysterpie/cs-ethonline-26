import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Csrf } from '../../components/ui.tsx';
import { holds } from '../../server/dal/guard.ts';
import { csrfFor, currentPrincipal } from '../../server/dal/principal.ts';
import { signOut } from './actions.ts';

export const dynamic = 'force-dynamic';

/**
 * The protected shell. It resolves the principal through the session service
 * and redirects when there is none; every page inside still calls the
 * data-access layer, which checks again. Navigation shows only what the
 * principal may open, and each hidden entry is also refused by the layer if
 * typed by hand.
 */
export default async function ProtectedLayout({ children }: { readonly children: ReactNode }) {
  const { principal } = await currentPrincipal();
  if (principal === null) redirect('/login?notice=session_expired');
  const token = csrfFor(principal);
  return (
    <div className="shell">
      <nav className="nav" aria-label="Sections">
        <h1>Latest in Cyber</h1>
        <ul>
          <li>
            <Link href="/command-center">Command center</Link>
          </li>
          {holds(principal, 'view:queue') ? (
            <li>
              <Link href="/queue">Review queue</Link>
            </li>
          ) : null}
          <li>
            <Link href="/incidents">Incident explorer</Link>
          </li>
          <li>
            <Link href="/evidence">Evidence states</Link>
          </li>
          <li>
            <Link href="/anomaly">Anomaly feed</Link>
          </li>
          <li>
            <Link href="/drafts">Drafts</Link>
          </li>
          {holds(principal, 'admin:accounts') ? (
            <li>
              <Link href="/admin/accounts">Accounts and sessions</Link>
            </li>
          ) : null}
        </ul>
        <div className="who">
          <div>
            <span className="mono">{principal.username}</span> · {principal.role}
          </div>
          <form action={signOut}>
            <Csrf token={token} />
            <button type="submit" className="quiet">
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
