import 'server-only';

import { describeLocated, type LocatedCodePoint } from '@cas/contracts';

/**
 * Failure kinds of the dashboard, with fixed messages.
 *
 * Every message a person can see is chosen from a fixed vocabulary here. A
 * message never carries a username, a password, a token, a stored title, a
 * note, a driver message or a stack. What reaches a page or a response body
 * is `publicMessage(error)`, which maps anything it does not recognise to one
 * generic sentence, so an internal error can neither leak nor be induced to
 * leak.
 */
export const DASHBOARD_FAILURE_KINDS = [
  'configuration',
  'authentication',
  'authorization',
  'validation',
  'conflict',
  'not_found',
  'throttled',
  'persistence_paused',
  'unavailable',
] as const;
export type DashboardFailureKind = (typeof DASHBOARD_FAILURE_KINDS)[number];

export class DashboardError extends Error {
  readonly kind: DashboardFailureKind;
  readonly code: string;
  /** For a character refusal (D50): each refused character by code point and position, never the text. */
  readonly characters: readonly LocatedCodePoint[];
  /** For a character refusal: the field refused, an identifier from the code (`markdown`), never a value. */
  readonly field: string | null;

  constructor(
    kind: DashboardFailureKind,
    code: string,
    message: string,
    characters: readonly LocatedCodePoint[] = [],
    field: string | null = null,
  ) {
    super(message);
    this.name = 'DashboardError';
    this.kind = kind;
    this.code = code;
    this.characters = characters;
    this.field = field;
  }
}

export function isDashboardError(value: unknown): value is DashboardError {
  return value instanceof DashboardError;
}

export const GENERIC_FAILURE_MESSAGE = 'The request could not be completed.';
export const SIGN_IN_FAILURE_MESSAGE = 'Sign-in failed.';
export const FORBIDDEN_MESSAGE = 'You do not have access to this.';
export const SIGN_IN_REQUIRED_MESSAGE = 'Sign in to continue.';

/**
 * The sentence a person is shown for an error. Validation, conflict and
 * not-found failures carry their own fixed message because the person can act
 * on it; everything else collapses to a generic sentence so an internal
 * condition is never described to a browser.
 */
export function publicMessage(error: unknown): string {
  if (!isDashboardError(error)) return GENERIC_FAILURE_MESSAGE;
  switch (error.kind) {
    case 'validation':
    case 'conflict':
    case 'not_found':
      return error.message;
    case 'authentication':
      return SIGN_IN_REQUIRED_MESSAGE;
    case 'authorization':
      return FORBIDDEN_MESSAGE;
    case 'throttled':
      return SIGN_IN_FAILURE_MESSAGE;
    default:
      return GENERIC_FAILURE_MESSAGE;
  }
}

/** The HTTP status a route handler answers with for an error. */
export function statusFor(error: unknown): number {
  if (!isDashboardError(error)) return 500;
  switch (error.kind) {
    case 'authentication':
      return 401;
    case 'authorization':
      return 403;
    case 'validation':
      return 400;
    case 'conflict':
      return 409;
    case 'not_found':
      return 404;
    case 'throttled':
      return 429;
    case 'persistence_paused':
    case 'unavailable':
      return 503;
    default:
      return 500;
  }
}

export function validation(code: string, message: string): DashboardError {
  return new DashboardError('validation', code, message);
}

/**
 * A refusal of characters the field may not carry (D50): the message names the
 * first by its escape, name and position, `where` being the field, never the
 * value; every refused character travels with the error for the notice.
 */
export function characterRefusal(
  code: string,
  where: string,
  characters: readonly LocatedCodePoint[],
): DashboardError {
  const first = characters[0];
  const named = first === undefined ? where : describeLocated(where, first);
  return new DashboardError('validation', code, `refused character at ${named}`, characters, where);
}

export function forbidden(code: string): DashboardError {
  return new DashboardError('authorization', code, 'the principal lacks the required capability');
}

export function unauthenticated(code: string): DashboardError {
  return new DashboardError('authentication', code, 'no valid session');
}
