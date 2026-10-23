import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Csrf, Origin, Prompt } from '../../components/ui.tsx';
import { holds } from '../../server/dal/guard.ts';
import { csrfFor, currentPrincipal } from '../../server/dal/principal.ts';
import { shellStatus, type ShellStatusDto } from '../../server/dal/shell.ts';
import type { Capability } from '../../server/auth/roles.ts';
import { formatAsOf } from '../../server/display.ts';
import { PATHNAME_HEADER } from '../../server/http/headers.ts';
import { attempt } from '../page-support.ts';
import { signOut } from './actions.ts';

export const dynamic = 'force-dynamic';

/**
 * The sections, in the existing order, each gated by the capability it is
 * gated by today; the glyphs are monospaced characters, not an icon font
 * (CAS-010, design note 1.2).
 */
const SECTIONS: readonly {
  readonly href: string;
  readonly label: string;
  readonly glyph: string;
  readonly needs: Capability | null;
}[] = [
  { href: '/command-center', label: 'Command center', glyph: '#', needs: null },
  { href: '/queue', label: 'Review queue', glyph: '?', needs: 'view:queue' },
  { href: '/incidents', label: 'Incident explorer', glyph: '*', needs: null },
  { href: '/week', label: 'Editorial week', glyph: '~', needs: null },
  { href: '/evidence', label: 'Evidence states', glyph: '=', needs: null },
  { href: '/anomaly', label: 'Anomaly feed', glyph: '!', needs: null },
  { href: '/drafts', label: 'Drafts', glyph: '/', needs: null },
  { href: '/published', label: 'Published', glyph: '^', needs: 'view:published' },
  { href: '/support', label: 'Support', glyph: '$', needs: null },
  { href: '/donate', label: 'Donate', glyph: '@', needs: null },
  { href: '/admin/accounts', label: 'Accounts and sessions', glyph: '&', needs: 'admin:accounts' },
  { href: '/admin/requests', label: 'Access requests', glyph: '+', needs: 'admin:accounts' },
];

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The status block's lines: the build, the latest week, the data instant, the principal. */
function StatusBlock({
  status,
  who,
}: {
  readonly status: ShellStatusDto | null;
  readonly who: { readonly username: string | null; readonly role: string };
}) {
  const week = status?.latestWeek ?? null;
  return (
    <div className="status">
      <dl>
        <dt>Build</dt>
        <dd className="mono">{status?.build ?? '—'}</dd>
        <dt>Latest week</dt>
        <dd>
          {week === null ? (
            '—'
          ) : (
            <>
              <span
                className={`dot ${week.status === 'completed' ? '' : week.status === 'failed' ? 'dot-warn' : 'dot-off'}`}
                aria-hidden="true"
              />
              <span className="mono">{week.windowStart.slice(0, 10)}</span> to{' '}
              <span className="mono">{week.windowEnd.slice(0, 10)}</span> · {week.status}{' '}
              <Origin value={week.dataOrigin} />
            </>
          )}
        </dd>
        <dt>As of</dt>
        <dd className="mono">{formatAsOf(status?.asOf ?? null)}</dd>
        <dt>Signed in</dt>
        <dd>
          <span className="mono">{who.username ?? 'by email'}</span> · {who.role}
        </dd>
      </dl>
    </div>
  );
}

/**
 * The protected shell. It resolves the principal through the session service
 * and redirects when there is none; every page inside still calls the
 * data-access layer, which checks again. Navigation shows only what the
 * principal may open, and each hidden entry is also refused by the layer if
 * typed by hand. The status block states only what the dashboard can state
 * truthfully; a line the layer refuses is not shown.
 */
export default async function ProtectedLayout({ children }: { readonly children: ReactNode }) {
  const { runtime, principal } = await currentPrincipal();
  if (principal === null) redirect('/login?notice=session_expired');
  const token = csrfFor(principal);
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  const status = await attempt(() => shellStatus(runtime, principal));
  const shown = status.ok ? status.value : null;
  return (
    <div className="shell">
      <nav className="nav" aria-label="Sections">
        <h1 className="brand">Latest in Cyber</h1>
        <p className="tag">Onchain incident intelligence</p>
        <ul>
          {SECTIONS.filter((s) => s.needs === null || holds(principal, s.needs)).map((s) => (
            <li key={s.href}>
              <Link href={s.href} aria-current={isCurrent(pathname, s.href) ? 'page' : undefined}>
                <span className="glyph" aria-hidden="true">
                  {s.glyph}
                </span>
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
        <StatusBlock status={shown} who={principal} />
        <form action={signOut}>
          <Csrf token={token} />
          <button type="submit" className="quiet">
            Sign out
          </button>
        </form>
      </nav>
      <header className="topbar">
        <span>
          <Prompt />
          <span className="product">Latest in Cyber</span>
        </span>
        <span className="asof">
          as of <span className="mono">{formatAsOf(shown?.asOf ?? null)}</span>
        </span>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
