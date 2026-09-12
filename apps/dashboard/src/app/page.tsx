import { redirect } from 'next/navigation';

import { currentPrincipal } from '../server/dal/principal.ts';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { principal } = await currentPrincipal();
  redirect(principal === null ? '/login' : '/command-center');
}
