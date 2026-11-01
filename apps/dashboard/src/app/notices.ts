import { prohibitedTextRule } from '@cas/contracts';

/**
 * Fixed notices a page may show after a redirect. A URL carries only one of
 * these codes; the sentence is looked up here, so nothing submitted by a
 * person or stored in the database ever travels through a query string.
 */
const NOTICES: Readonly<Record<string, string>> = {
  saved: 'Saved.',
  recorded: 'Recorded.',
  selected: 'Selected for the issue.',
  generated: 'Round-up generated; revisions 0 and 1 recorded.',
  edited: 'Revision saved.',
  saved_cleaned: 'Saved. These invisible characters were removed before saving:',
  edited_cleaned: 'Revision saved. These invisible characters were removed before saving:',
  invalid_character: 'Not saved. This text carries a character that is refused here:',
  sources_read:
    'Sources read. Review what was read and what was not, then confirm to write the article.',
  article_generated: 'Article written; revision 1 recorded.',
  signup_code_sent: 'If that address can request access, a code was sent. Enter it below.',
  signup_recorded:
    'Your request is recorded. The owner reviews requests; you will receive an email either way.',
  signup_code_invalid: 'That code did not work.',
  signup_locked: 'That code did not work.',
  signup_expired: 'Enter your address again to request a new code.',
  approved: 'Request approved; the reader account exists and the email was sent.',
  denied: 'Request denied; the email was sent.',
  published: 'Published. Readers now see this revision.',
  unpublished: 'Unpublished. Readers no longer see this output.',
  checkout_returned:
    'Thank you. Stripe confirms a subscription within a minute or so; this page then shows it.',
  checkout_cancelled: 'Checkout cancelled. Nothing was charged.',
  checkout_unavailable: 'The payment provider did not answer. Try again later.',
  checkout_limited: 'Too many checkout attempts. Wait a while and try again.',
  checkout_in_progress:
    'A checkout is already being prepared for this account. Try again in a moment.',
  support_already_active:
    'This account already has a subscription. Manage it from the billing portal.',
  card_limited: 'Too many cards made. Wait a while and try again.',
  story_not_shareable: 'That story cannot be shared now.',
  support_not_configured: 'Card support is not set up yet.',
  no_supporter_record: 'No support record exists for this account yet.',
  unselected: 'Set aside for this issue.',
  already_recorded: 'Already recorded: an identical action existed.',
  revoked: 'Sessions revoked.',
  provisioned: 'Account provisioned.',
  rotated: 'Password rotated and every session of the account revoked.',
  disabled: 'Account disabled and every session revoked.',
  role_assigned: 'Role assigned and every session of the account revoked.',
  expiry_set: 'Expiry updated.',
  signed_out: 'Signed out.',
  session_expired: 'Your session ended. Sign in again.',
  sign_in_failed: 'Sign-in failed.',
  code_sent: 'If that email is approved, a code was sent. Enter it below.',
  code_invalid: 'That code did not work. Enter the latest code, or request a new one.',
  code_expired: 'Enter your email again to request a new code.',
  forbidden: 'You do not have access to this.',
  invalid: 'The request was not valid.',
  conflict: 'The record changed while you were working; reload and try again.',
  not_found: 'Not found.',
  failed: 'The request could not be completed.',
};

const CODE = /^[a-z_]{1,32}$/u;

export function noticeFor(code: unknown): string | null {
  if (typeof code !== 'string' || !CODE.test(code)) return null;
  return NOTICES[code] ?? null;
}

export function isErrorNotice(code: unknown): boolean {
  return (
    code === 'invalid_character' ||
    code === 'sign_in_failed' ||
    code === 'forbidden' ||
    code === 'invalid' ||
    code === 'conflict' ||
    code === 'not_found' ||
    code === 'failed' ||
    code === 'session_expired' ||
    code === 'code_invalid' ||
    code === 'code_expired' ||
    code === 'checkout_unavailable' ||
    code === 'checkout_limited' ||
    code === 'checkout_in_progress' ||
    code === 'support_already_active' ||
    code === 'card_limited' ||
    code === 'story_not_shareable' ||
    code === 'support_not_configured' ||
    code === 'no_supporter_record'
  );
}

/** One character a notice names: a code point and where it stood, never the text around it. */
export interface NoticeCharacter {
  readonly codePoint: number;
  readonly line: number;
  readonly column: number;
}

/** At most this many characters travel in a notice; the rest are counted. */
export const NOTICE_CHARACTERS_MAX = 20;

const ENTRY = /^([0-9A-F]{4,6})-([1-9][0-9]{0,6})-([1-9][0-9]{0,6})$/u;

/**
 * The `at` parameter of a notice that names characters (D50, point 1):
 * `CODEPOINT-LINE-COLUMN`, comma-separated, uppercase hexadecimal. It carries
 * code points and positions only, and `noticeCharacters` accepts only code
 * points the prohibited-text rule names, or tab, line feed and carriage
 * return, so nothing a person typed can travel through the query string.
 */
export function noticeCharactersParameter(characters: readonly NoticeCharacter[]): string {
  return characters
    .slice(0, NOTICE_CHARACTERS_MAX)
    .map(
      (character) =>
        `${character.codePoint.toString(16).toUpperCase().padStart(4, '0')}-${character.line}-${character.column}`,
    )
    .join(',');
}

export function noticeCharacters(at: unknown): NoticeCharacter[] {
  if (typeof at !== 'string' || at.length === 0 || at.length > 400) return [];
  const out: NoticeCharacter[] = [];
  for (const entry of at.split(',').slice(0, NOTICE_CHARACTERS_MAX)) {
    const match = ENTRY.exec(entry);
    if (match === null) return [];
    const codePoint = Number.parseInt(match[1] ?? '', 16);
    const named =
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      prohibitedTextRule(codePoint) !== null;
    if (codePoint > 0x10ffff || !named) return [];
    out.push({ codePoint, line: Number(match[2]), column: Number(match[3]) });
  }
  return out;
}
