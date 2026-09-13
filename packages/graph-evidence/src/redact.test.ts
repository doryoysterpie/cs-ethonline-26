import { describe, expect, it } from 'vitest';

import { REDACTED, createRedactor } from './redact.js';

describe('createRedactor', () => {
  const key = 'abcdef0123456789abcdef0123456789';
  const redact = createRedactor([key, undefined]);

  it('removes the raw credential wherever it appears', () => {
    expect(redact(`error for key ${key} at ${key}`)).toBe(
      `error for key ${REDACTED} at ${REDACTED}`,
    );
  });

  it('removes bearer tokens even when the exact key is not known', () => {
    const other = createRedactor([]);
    expect(other('authorization: Bearer zzzzzzzzzzzzzzzzzzzz')).toBe(
      `authorization: Bearer ${REDACTED}`,
    );
  });

  it('removes a credential embedded in the legacy key-in-path gateway URL', () => {
    const other = createRedactor([]);
    expect(
      other('https://gateway.example/api/abcdef0123456789abcdef0123456789/subgraphs/id/X'),
    ).toBe(`https://gateway.example/api/${REDACTED}/subgraphs/id/X`);
  });

  it('leaves the subgraph-id path segment intact', () => {
    const url =
      'https://gateway.example/api/subgraphs/id/JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
    expect(redact(url)).toBe(url);
  });

  it('ignores secrets shorter than four characters so it cannot mangle ordinary text', () => {
    const tiny = createRedactor(['ab']);
    expect(tiny('abacus')).toBe('abacus');
  });
});
