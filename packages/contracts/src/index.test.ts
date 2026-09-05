import { describe, expect, it } from 'vitest';

import { DATA_ORIGINS, REVIEW_STATES } from './index.js';

describe('@cas/contracts', () => {
  it('fixes the review-state enum required by the editorial charter', () => {
    expect([...REVIEW_STATES]).toEqual(['selected', 'rejected', 'unreviewed']);
  });

  it('fixes the data-origin enum that keeps live, fixture and replay data distinct', () => {
    expect([...DATA_ORIGINS]).toEqual(['live', 'fixture', 'replay']);
  });
});
