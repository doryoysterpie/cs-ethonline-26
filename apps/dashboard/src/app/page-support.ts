import 'server-only';

import { forbidden, notFound, redirect } from 'next/navigation';

import { isDashboardError } from '../server/errors.ts';

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
        return 'invalid';
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
        return 'invalid';
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

export function withNotice(path: string, code: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(code)}`;
}
