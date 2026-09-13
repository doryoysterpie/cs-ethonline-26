import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Notice } from '../../../components/ui.tsx';
import { otpPendingCookieName } from '../../../server/auth/cookie.ts';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { single, type SearchParams } from '../../page-support.ts';
import { verifyCode } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { principal } = await currentPrincipal();
  if (principal !== null) redirect('/command-center');
  const runtime = await getRuntime();
  const jar = await cookies();
  const pending = jar.get(otpPendingCookieName(runtime.config.environment))?.value;
  // No pending request names no screen of its own: back to the start.
  if (pending === undefined) redirect('/login');
  const params = await searchParams;
  return (
    <main className="login">
      <h1>Latest in Cyber</h1>
      <p className="small">Enter the code from your email. It expires in 10 minutes.</p>
      <Notice code={single(params.notice)} />
      <form className="stack" action={verifyCode}>
        <label>
          Code
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            pattern="[0-9]{6}"
          />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p className="small">
        <a href="/login">Use a different email</a>
      </p>
    </main>
  );
}
