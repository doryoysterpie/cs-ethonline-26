import { describe, expect, it } from 'vitest';

import { DISALLOWED_AGENTS, ROBOTS_POLICY_VERSION, robotsText } from './robots.ts';

describe('robots.txt (CAS-007)', () => {
  it('serves the fixed, versioned list, one disallow per AI crawler, and disallows everyone else', () => {
    const text = robotsText();
    expect(text.startsWith(`# ${ROBOTS_POLICY_VERSION}\n`)).toBe(true);
    for (const agent of ['GPTBot', 'ClaudeBot', 'CCBot', 'PerplexityBot', 'Google-Extended']) {
      expect(DISALLOWED_AGENTS).toContain(agent);
      expect(text).toContain(`User-agent: ${agent}\nDisallow: /\n`);
    }
    expect(text.endsWith('User-agent: *\nDisallow: /\n')).toBe(true);
    expect(text.match(/^User-agent: /gmu)).toHaveLength(DISALLOWED_AGENTS.length + 1);
    expect(text).not.toMatch(/Allow: \//u);
  });
});
