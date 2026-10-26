import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Prompt, SectionBlock } from '../../../components/ui.tsx';
import { loadCard } from './load.ts';

export const dynamic = 'force-dynamic';

const PRODUCT = 'Latest in Cyber';

/**
 * Link previews read these: the published headline, the week and category,
 * and the card's PNG when the dashboard knows its public address. Never
 * indexed (D48, decision 5); the proxy adds `X-Robots-Tag` as well.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadCard(id);
  const robots = { index: false, follow: false };
  if (loaded.kind !== 'card') return { title: PRODUCT, robots };
  const { card } = loaded.view;
  const description = `${card.output === 'roundup' ? 'Round-up' : 'Article'} · ${card.category} · week of ${card.weekStart.slice(0, 10)}`;
  const image =
    loaded.publicUrl === null
      ? undefined
      : [
          {
            url: `${loaded.publicUrl}/cards/${card.id}/image.png`,
            width: 1200,
            height: 630,
            alt: card.headline,
          },
        ];
  return {
    title: `${card.headline} · ${PRODUCT}`,
    description,
    robots,
    openGraph: {
      title: card.headline,
      description,
      siteName: PRODUCT,
      type: 'article',
      images: image,
    },
    twitter: {
      card: 'summary_large_image',
      title: card.headline,
      description,
      images: image?.map((i) => i.url),
    },
  };
}

/** The public story card (CAS-009): no session, the allowlisted fields only. */
export default async function CardPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const loaded = await loadCard(id);
  if (loaded.kind === 'not_found') notFound();
  if (loaded.kind !== 'card') {
    return (
      <main className="card-page">
        <p className="notice notice-error">
          {loaded.kind === 'limited'
            ? 'Too many requests from your network. Try again in a few minutes.'
            : 'This card cannot be shown right now. Try again later.'}
        </p>
      </main>
    );
  }
  const { card, publishedPath } = loaded.view;
  return (
    <main className="card-page">
      <SectionBlock title={<>{PRODUCT}</>} glyph="▣">
        <p className="card-kind">
          <Prompt />
          {card.output === 'roundup' ? 'Round-up' : 'Article'} · {card.category} · week of{' '}
          <span className="mono">{card.weekStart.slice(0, 10)}</span> to{' '}
          <span className="mono">{card.weekEnd.slice(0, 10)}</span>
        </p>
        <h1 className="card-headline">{card.headline}</h1>
        {card.publishers.length === 0 ? null : (
          <p className="card-publishers">Reported by {card.publishers.join(' · ')}</p>
        )}
        <img
          className="card-image"
          src={`/cards/${card.id}/image.png`}
          alt={card.headline}
          width={600}
          height={315}
        />
        <p className="small">
          As the {card.output === 'roundup' ? 'round-up' : 'article'} stands now, revision{' '}
          {card.revision}. Read the whole issue on the dashboard:{' '}
          <Link href={publishedPath}>sign in</Link> or <Link href="/signup">request access</Link>.
        </p>
        <p className="small">
          <a href={`/cards/${card.id}/image.png`} download={`latest-in-cyber-${card.id}.png`}>
            Download the image
          </a>{' '}
          ·{' '}
          <a href={`/cards/${card.id}/image.svg`} download={`latest-in-cyber-${card.id}.svg`}>
            Download the SVG
          </a>
        </p>
      </SectionBlock>
    </main>
  );
}
