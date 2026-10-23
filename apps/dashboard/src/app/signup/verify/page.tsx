import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Notice } from '../../../components/ui.tsx';
import { signupPendingCookieName } from '../../../server/auth/cookie.ts';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { single, type SearchParams } from '../../page-support.ts';
import { verifySignupAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function SignupVerifyPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { principal } = await currentPrincipal();
  if (principal !== null) redirect('/command-center');
  const params = await searchParams;
  const notice = single(params.notice);
  const runtime = await getRuntime();
  const jar = await cookies();
  const pending = jar.get(signupPendingCookieName(runtime.config.environment))?.value;
  // Once recorded there is nothing left to enter; without a pending request, back to the start.
  const recorded = notice === 'signup_recorded';
  if (pending === undefined && !recorded) redirect('/signup');
  return (
    <main className="login">
      <h1>Latest in Cyber</h1>
      <Notice code={notice} />
      {recorded ? null : (
        <>
          <p className="small">Enter the code from your email. It expires in 10 minutes.</p>
          <form className="stack" action={verifySignupAction}>
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
            <button type="submit">Confirm my address</button>
          </form>
          <p className="small">
            <a href="/signup">Use a different email</a>
          </p>
        </>
      )}
    </main>
  );
}
