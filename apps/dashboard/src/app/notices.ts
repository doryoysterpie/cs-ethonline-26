/**
 * Fixed notices a page may show after a redirect. A URL carries only one of
 * these codes; the sentence is looked up here, so nothing submitted by a
 * person or stored in the database ever travels through a query string.
 */
const NOTICES: Readonly<Record<string, string>> = {
  saved: 'Saved.',
  recorded: 'Recorded.',
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
    code === 'sign_in_failed' ||
    code === 'forbidden' ||
    code === 'invalid' ||
    code === 'conflict' ||
    code === 'not_found' ||
    code === 'failed' ||
    code === 'session_expired'
  );
}
