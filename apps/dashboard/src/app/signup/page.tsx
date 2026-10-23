import { redirect } from 'next/navigation';

import { Notice } from '../../components/ui.tsx';
import { currentPrincipal } from '../../server/dal/principal.ts';
import { single, type SearchParams } from '../page-support.ts';
import { requestSignupAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function SignupPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { principal } = await currentPrincipal();
  if (principal !== null) redirect('/command-center');
  const params = await searchParams;
  return (
    <main className="login">
      <h1>Latest in Cyber</h1>
      <p className="small">
        Request access with your email. The owner reviews every request; approved readers sign in
        with a code sent to their address each time.
      </p>
      <Notice code={single(params.notice)} />
      <form className="stack" action={requestSignupAction}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <button type="submit">Send me a code</button>
      </form>
      <p className="small">
        <a href="/login">Already approved? Sign in</a>
      </p>
    </main>
  );
}
