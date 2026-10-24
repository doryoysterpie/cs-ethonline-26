import 'server-only';

import { randomBytes, randomUUID } from 'node:crypto';

import { toPublicStoryCard, type PublicStoryCard } from '@cas/contracts';

import type { Principal } from '../auth/session.ts';
import type { AuditEvent } from '../auth/store.ts';
import { rasterize } from '../cards/raster.ts';
import {
  articleHeadline,
  articleSourceUrls,
  publishersOf,
  roundupHeadline,
  roundupStories,
} from '../cards/story.ts';
import { cardSvg } from '../cards/svg.ts';
import { DashboardError, validation } from '../errors.ts';
import { uuid } from '../input.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import type { Queryable } from '@cas/database';

import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';

/**
 * Story cards (CAS-009, D48, `docs/CAS-009-REPORT.md`). A signed-in principal
 * who may view published outputs makes a card for one story; anyone with the
 * address may view it. A card is bound to its output and entry, never to a
 * revision: every request reads what is published now and renders that, so a
 * correction is never contradicted, and an unpublished output, a
 * deterministic revision (whose headlines are the sources' own titles) or an
 * entry the published text no longer holds answers not found. What crosses to
 * the public is exactly the contract's allowlist (`toPublicStoryCard`).
 */
const CATEGORY_SHAPE = /^[a-z][a-z0-9_]{1,31}$/u;
const CARD_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/u;
const ENTRY_MAX = 999;

export type CardOutput = 'roundup' | 'article';

export interface StoryInput {
  readonly weekRunId: unknown;
  readonly category: unknown;
  readonly output: unknown;
  readonly entryIndex: unknown;
}

interface StoryKey {
  readonly weekRunId: string;
  readonly category: string;
  readonly output: CardOutput;
  readonly entryIndex: number;
}

type ResolvedStory = Omit<PublicStoryCard, 'id'>;

async function audit(
  runtime: Pick<Runtime, 'stores'>,
  event: Omit<AuditEvent, 'id' | 'at'>,
): Promise<void> {
  await runtime.stores.audit.append({ id: randomUUID(), at: new Date().toISOString(), ...event });
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

function notShareable(): DashboardError {
  return new DashboardError('not_found', 'story_not_shareable', 'That story cannot be shared.');
}

function storyKey(input: StoryInput): StoryKey {
  const weekRunId = uuid(input.weekRunId, 'weekRunId');
  if (typeof input.category !== 'string' || !CATEGORY_SHAPE.test(input.category)) {
    throw validation('category_invalid', 'The category is not valid.');
  }
  if (input.output !== 'roundup' && input.output !== 'article') {
    throw validation('output_invalid', 'The output is not valid.');
  }
  const raw = typeof input.entryIndex === 'string' ? Number(input.entryIndex) : input.entryIndex;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > ENTRY_MAX) {
    throw validation('entry_invalid', 'The story is not valid.');
  }
  if (input.output === 'article' && raw !== 0) {
    throw validation('entry_invalid', 'The story is not valid.');
  }
  return { weekRunId, category: input.category, output: input.output, entryIndex: raw };
}

/** The rundown's entries as the slots hold them, or null when the slots are not a rundown. */
export function rundownOf(
  slots: unknown,
): readonly { readonly sources: readonly string[] }[] | null {
  const rundown = (slots as { rundown?: unknown } | null)?.rundown;
  if (!Array.isArray(rundown)) return null;
  const entries: { sources: string[] }[] = [];
  for (const entry of rundown) {
    const sources = (entry as { sources?: unknown } | null)?.sources;
    if (!Array.isArray(sources) || sources.some((url) => typeof url !== 'string')) return null;
    entries.push({ sources: sources as string[] });
  }
  return entries;
}

/**
 * The story as the current published revision states it, or null when it
 * cannot be shown, read on the caller's connection: a caller that holds a
 * snapshot gets the current publication, the revision and its text from that
 * one snapshot.
 */
async function resolveStoryOn(client: Queryable, key: StoryKey): Promise<ResolvedStory | null> {
  const packages = await workspace();
  const { currentPublication, getWeekRun, listArticleRevisions, listRoundupRevisions } =
    packages.database;
  const current = await currentPublication(client, key.weekRunId, key.category, key.output);
  if (current === null) return null;
  const week = await getWeekRun(client, key.weekRunId);
  if (week === null) return null;
  const revisions =
    key.output === 'roundup'
      ? await listRoundupRevisions(client, key.weekRunId, key.category)
      : await listArticleRevisions(client, key.weekRunId, key.category);
  const revision = revisions.find((candidate) => candidate.revision === current.revision);
  if (revision === undefined || revision.kind === 'deterministic') return null;
  let headline: string | null;
  let publishers: string[];
  if (key.output === 'roundup') {
    const entry = rundownOf(revision.slots)?.[key.entryIndex];
    if (entry === undefined) return null;
    headline = roundupHeadline(revision.markdown, entry.sources);
    publishers = publishersOf(entry.sources);
  } else {
    headline = articleHeadline(revision.markdown);
    publishers = publishersOf(articleSourceUrls(revision.markdown));
  }
  if (headline === null) return null;
  return {
    output: key.output,
    category: key.category,
    weekStart: week.windowStart,
    weekEnd: week.windowEnd,
    revision: revision.revision,
    headline,
    publishers,
  };
}

/** One snapshot for a story read: every statement sees the same committed state. */
const SNAPSHOT = { isolationLevel: 'repeatable read' } as const;

/** The stories of one published revision a principal may make cards for (the published page's list). */
export function shareableStories(
  output: CardOutput,
  revision: { readonly kind: string; readonly slots: unknown; readonly markdown: string },
): readonly { readonly entryIndex: number; readonly headline: string }[] {
  if (revision.kind === 'deterministic') return [];
  if (output === 'article') {
    const headline = articleHeadline(revision.markdown);
    return headline === null ? [] : [{ entryIndex: 0, headline }];
  }
  const rundown = rundownOf(revision.slots);
  return rundown === null ? [] : roundupStories(revision.markdown, rundown);
}

/**
 * Stores the image of a card as one read stated it: the render is that read's
 * content and the key is that read's revision, so an image can only ever be
 * stored under the revision whose text it shows.
 */
async function storeImage(runtime: Runtime, card: PublicStoryCard): Promise<Uint8Array> {
  const packages = await workspace();
  const { png, sha256 } = await rasterize(cardSvg(card));
  await runtime.database.withTransaction((tx) =>
    packages.database.insertStoryCardImage(tx, {
      cardId: card.id,
      revision: card.revision,
      png,
      pngSha256: sha256,
      createdAt: new Date().toISOString(),
    }),
  );
  return png;
}

/**
 * Makes the card of one story, or returns the card already made for it (D48,
 * 7): one public address per story, the per-account limit spent only on a
 * new card. The card's image is rasterized at once for the revision it shows;
 * a failure there leaves the card, and the image route renders it later.
 */
export async function makeCard(
  runtime: Runtime,
  who: Principal | null,
  input: StoryInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const principal = requireCapability(who, 'view:published');
  const key = storyKey(input);
  if (runtime.stores.kind !== 'postgres') {
    throw validation(
      'persistent_accounts_required',
      'Making a card needs the PostgreSQL account store.',
    );
  }
  const packages = await workspace();
  const { findStoryCard, insertStoryCard } = packages.database;
  try {
    const story = await runtime.database.withTransaction((tx) => resolveStoryOn(tx, key), SNAPSHOT);
    if (story === null) throw notShareable();
    const existing = await runtime.database.withClient((client) => findStoryCard(client, key));
    if (existing !== null) return { id: existing.id, created: false };
    const decision = runtime.limits.cardAccount.check(`account:${principal.accountId}`, seconds());
    if (!decision.allowed) {
      if (decision.firstTrip) {
        await audit(runtime, {
          kind: 'limit_tripped',
          outcome: 'failure',
          code: 'card_account',
          actorAccountId: principal.accountId,
          subjectAccountId: principal.accountId,
          sessionId: principal.sessionId,
          networkKey: null,
          subjectId: null,
        });
      }
      throw new DashboardError('throttled', 'card_limited', 'Too many cards made; wait a while.');
    }
    const { card, created } = await runtime.database.withTransaction((tx) =>
      insertStoryCard(tx, {
        ...key,
        id: randomBytes(16).toString('base64url'),
        createdBy: principal.accountId,
        createdAt: new Date().toISOString(),
      }),
    );
    if (created) {
      await audit(runtime, {
        kind: 'card_created',
        outcome: 'success',
        code: key.output,
        actorAccountId: principal.accountId,
        subjectAccountId: null,
        sessionId: principal.sessionId,
        networkKey: null,
        subjectId: card.id,
      });
      try {
        await storeImage(runtime, toPublicStoryCard({ id: card.id, ...story }));
      } catch {
        // The image route rasterizes on its first request instead.
      }
    }
    return { id: card.id, created };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

export interface CardPageDto {
  readonly card: PublicStoryCard;
  /** The published page the card points back to; it needs a sign-in. */
  readonly publishedPath: string;
  readonly views: number;
}

async function publicCard(
  runtime: Runtime,
  id: unknown,
  networkKey: string,
  withImage: boolean,
): Promise<{
  readonly card: PublicStoryCard;
  readonly key: StoryKey;
  readonly cached: Uint8Array | null;
}> {
  if (typeof id !== 'string' || !CARD_ID_SHAPE.test(id)) throw notShareable();
  const decision = runtime.limits.cardNetwork.check(`network:${networkKey}`, seconds());
  if (!decision.allowed) {
    if (decision.firstTrip) {
      await audit(runtime, {
        kind: 'limit_tripped',
        outcome: 'failure',
        code: 'card_network',
        actorAccountId: null,
        subjectAccountId: null,
        sessionId: null,
        networkKey,
        subjectId: null,
      });
    }
    throw new DashboardError('throttled', 'card_views_limited', 'Too many requests; wait a while.');
  }
  const packages = await workspace();
  // The card, the current publication, the revision's text and the cached
  // image are read in one snapshot (the owner's condition of 23 October
  // 2026): the image served is the one stored for the revision this read
  // found current, and a render uses this read's text.
  const read = await runtime.database.withTransaction(async (tx) => {
    const record = await packages.database.getStoryCard(tx, id);
    if (record === null) return null;
    const key: StoryKey = {
      weekRunId: record.weekRunId,
      category: record.category,
      output: record.output,
      entryIndex: record.entryIndex,
    };
    const story = await resolveStoryOn(tx, key);
    if (story === null) return null;
    const cached = withImage
      ? await packages.database.getStoryCardImage(tx, record.id, story.revision)
      : null;
    return {
      key,
      card: toPublicStoryCard({ id: record.id, ...story }),
      cached: cached?.png ?? null,
    };
  }, SNAPSHOT);
  if (read === null) throw notShareable();
  return read;
}

/** The public card page: no session; limited per source; one origin view counted. */
export async function cardPage(
  runtime: Runtime,
  id: unknown,
  networkKey: string,
): Promise<CardPageDto> {
  const packages = await workspace();
  try {
    const { card, key } = await publicCard(runtime, id, networkKey, false);
    const views = await runtime.database.withTransaction((tx) =>
      packages.database.countStoryCardView(tx, card.id),
    );
    return {
      card,
      publishedPath: `/published/${key.weekRunId}?category=${encodeURIComponent(key.category)}&output=${key.output}`,
      views: views ?? 0,
    };
  } catch (error) {
    throw mapFailure(error, packages);
  }
}

/** The card's image: the SVG, or the PNG from the cache (rasterized once per card and revision). Not counted. */
export async function cardImage(
  runtime: Runtime,
  id: unknown,
  format: 'png' | 'svg',
  networkKey: string,
): Promise<{ readonly body: Uint8Array | string; readonly revision: number }> {
  const packages = await workspace();
  try {
    const { card, cached } = await publicCard(runtime, id, networkKey, format === 'png');
    if (format === 'svg') return { body: cardSvg(card), revision: card.revision };
    return { body: cached ?? (await storeImage(runtime, card)), revision: card.revision };
  } catch (error) {
    if (error instanceof Error && error.name === 'RasterError') {
      throw new DashboardError(
        'unavailable',
        'card_image_unavailable',
        'The card image could not be rendered.',
      );
    }
    throw mapFailure(error, packages);
  }
}
