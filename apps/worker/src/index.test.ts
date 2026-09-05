import { describe, expect, it } from 'vitest';

import { REVIEW_STATES } from '@cas/contracts';

describe('@cas/worker workspace boundary', () => {
  it('resolves the shared contracts package through the workspace dependency', () => {
    expect(REVIEW_STATES).toContain('unreviewed');
  });
});
