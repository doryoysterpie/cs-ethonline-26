import { redirect } from 'next/navigation';

import { Notice } from '../../components/ui.tsx';
import { currentPrincipal } from '../../server/dal/principal.ts';
import { single, type SearchParams } from '../page-support.ts';
import { requestCode } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const { principal } = await currentPrincipal();
  if (principal !== null) redirect('/command-center');
  const params = await searchParams;
  return (
    <main className="login">
      <h1>Latest in Cyber</h1>
      <p className="small">Editorial dashboard. Sign in with your approved email.</p>
      <Notice code={single(params.notice)} />
      <form className="stack" action={requestCode}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <button type="submit">Send me a code</button>
      </form>
    </main>
  );
}
