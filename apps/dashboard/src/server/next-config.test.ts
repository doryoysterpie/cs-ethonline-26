import { describe, expect, it } from 'vitest';

import config from '../../next.config.ts';
import { MAX_DRAFT_CHARACTERS } from './dal/mutate.ts';

/**
 * The server-action body bound is declared, not defaulted, and it holds the
 * largest legitimate action: a draft revision of `MAX_DRAFT_CHARACTERS`
 * characters, each at most four UTF-8 bytes (CAS-006, release blocker 7).
 */
describe('the server-action body bound', () => {
  it('is declared at 1 MB and holds the largest draft revision', () => {
    const limit = config.experimental?.serverActions?.bodySizeLimit;
    expect(limit).toBe('1mb');
    expect(MAX_DRAFT_CHARACTERS * 4).toBeLessThan(1024 * 1024);
  });
});
