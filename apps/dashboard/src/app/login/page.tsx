import { redirect } from 'next/navigation';

import { Notice } from '../../components/ui.tsx';
import { currentPrincipal } from '../../server/dal/principal.ts';
import { single, type SearchParams } from '../page-support.ts';
import { signIn } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const { principal } = await currentPrincipal();
  if (principal !== null) redirect('/command-center');
  const params = await searchParams;
  return (
    <main className="login">
      <h1>CAS Chainwatch</h1>
      <p className="small">Editorial dashboard. Sign in with a provisioned account.</p>
      <Notice code={single(params.notice)} />
      <form className="stack" action={signIn}>
        <label>
          Username
          <input name="username" autoComplete="username" required maxLength={32} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
