import 'server-only';

import { forbidden, notFound, redirect } from 'next/navigation';

import { isDashboardError } from '../server/errors.ts';
import {
  NOTICE_CHARACTERS_MAX,
  noticeCharactersParameter,
  noticeRevision,
  type NoticeCharacter,
} from './notices.ts';

/**
 * Helpers shared by every protected page and action.
 *
 * `attempt` runs a data-access call and turns its failure into a value, so a
 * page can decide what to do without a `try` block swallowing Next's own
 * control-flow exceptions (`redirect`, `notFound`, `forbidden` throw).
 * `escalate` then maps a failure to the right interruption.
 */
export type Attempt<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Interrupts rendering for a failure that has a page of its own; returns the notice code otherwise. */
export function escalate(error: unknown): string {
  if (isDashboardError(error)) {
    switch (error.kind) {
      case 'authentication':
        redirect('/login?notice=session_expired');
      // eslint-disable-next-line no-fallthrough
      case 'authorization':
        forbidden();
      // eslint-disable-next-line no-fallthrough
      case 'not_found':
        notFound();
      // eslint-disable-next-line no-fallthrough
      case 'validation':
        return error.characters.length > 0 ? 'invalid_character' : 'invalid';
      case 'conflict':
        return 'conflict';
      default:
        return 'failed';
    }
  }
  return 'failed';
}

/** The notice code an action redirects with after a failure. Never interrupts. */
export function noticeCodeFor(error: unknown): string {
  if (isDashboardError(error)) {
    switch (error.kind) {
      case 'authentication':
        return 'session_expired';
      case 'authorization':
        return 'forbidden';
      case 'validation':
        return error.characters.length > 0 ? 'invalid_character' : 'invalid';
      case 'conflict':
        return 'conflict';
      case 'not_found':
        return 'not_found';
      default:
        return 'failed';
    }
  }
  return 'failed';
}

export type SearchParams = Promise<Readonly<Record<string, string | string[] | undefined>>>;

export function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The characters a refusal names, for its notice (D50); empty for any other failure. */
export function refusedCharacters(error: unknown): readonly NoticeCharacter[] {
  return isDashboardError(error) ? error.characters : [];
}

/**
 * A redirect target with its notice. A refusal's characters travel as `at`,
 * the first `NOTICE_CHARACTERS_MAX` of them, with the number of the rest as
 * `more`; a save that removed characters names its `revision`, whose record
 * the page lists in full (D50, point 1; migration 0024).
 */
export function withNotice(
  path: string,
  code: string,
  characters: readonly NoticeCharacter[] = [],
  revision: number | null = null,
): string {
  const at =
    characters.length > 0 ? `&at=${encodeURIComponent(noticeCharactersParameter(characters))}` : '';
  const more =
    characters.length > NOTICE_CHARACTERS_MAX
      ? `&more=${characters.length - NOTICE_CHARACTERS_MAX}`
      : '';
  const saved = revision === null ? '' : `&revision=${revision}`;
  return `${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(code)}${at}${more}${saved}`;
}

/** The removal record of the revision a save's notice names, or none. */
export function removedAt(
  revisions: readonly {
    readonly revision: number;
    readonly removedCharacters: readonly NoticeCharacter[];
  }[],
  revision: string | undefined,
): readonly NoticeCharacter[] {
  const wanted = noticeRevision(revision);
  if (wanted === null) return [];
  return revisions.find((entry) => entry.revision === wanted)?.removedCharacters ?? [];
}
