import Link from 'next/link';

import { SafeMarkdown } from '../../../../components/SafeMarkdown.tsx';
import { Instant, Notice, Origin } from '../../../../components/ui.tsx';
import { currentPrincipal } from '../../../../server/dal/principal.ts';
import { publishedOutput } from '../../../../server/dal/readers.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function PublishedOutputPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly weekRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { weekRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    publishedOutput(runtime, principal, weekRunId, single(query.category), single(query.output)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  return (
    <section>
      <h2>
        {view.output === 'roundup' ? 'Round-up' : 'Article'} · {view.category}{' '}
        <Origin value={view.week.dataOrigin} />
      </h2>
      <p className="small">
        Week <Instant value={view.week.windowStart} /> to <Instant value={view.week.windowEnd} /> ·
        revision {view.revision}, published <Instant value={view.publishedAt} /> ·{' '}
        <Link href="/published">all published</Link>
      </p>
      <SafeMarkdown markdown={view.markdown} />
    </section>
  );
}
