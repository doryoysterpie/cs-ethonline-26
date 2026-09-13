import { describe, expect, it } from 'vitest';

import { isErrorNotice, noticeFor } from './notices.ts';

describe('notices', () => {
  it('maps only fixed codes to fixed sentences', () => {
    expect(noticeFor('saved')).toBe('Saved.');
    expect(noticeFor('sign_in_failed')).toBe('Sign-in failed.');
    expect(noticeFor('<script>')).toBeNull();
    expect(noticeFor('SAVED')).toBeNull();
    expect(noticeFor(undefined)).toBeNull();
    expect(noticeFor('x'.repeat(40))).toBeNull();
    expect(isErrorNotice('forbidden')).toBe(true);
    expect(isErrorNotice('saved')).toBe(false);
  });
});
