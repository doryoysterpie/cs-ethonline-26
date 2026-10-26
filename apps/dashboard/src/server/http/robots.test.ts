import { describe, expect, it } from 'vitest';

import { parseRobots, robotsAllows } from '@cas/source-reader';

import { DISALLOWED_AGENTS, ROBOTS_POLICY_VERSION, robotsText } from './robots.ts';

describe('robots.txt (CAS-007, CAS-009)', () => {
  it('serves the fixed, versioned list: one disallow per AI crawler, the story cards allowed to everyone else and nothing more', () => {
    const text = robotsText();
    expect(ROBOTS_POLICY_VERSION).toBe('robots-policy@2');
    expect(text.startsWith(`# ${ROBOTS_POLICY_VERSION}\n`)).toBe(true);
    for (const agent of ['GPTBot', 'ClaudeBot', 'CCBot', 'PerplexityBot', 'Google-Extended']) {
      expect(DISALLOWED_AGENTS).toContain(agent);
      expect(text).toContain(`User-agent: ${agent}\nDisallow: /\n`);
    }
    // The Allow line first, for parsers that take the first match (D48, the robots decision).
    expect(text.endsWith('User-agent: *\nAllow: /cards/\nDisallow: /\n')).toBe(true);
    expect(text.match(/^User-agent: /gmu)).toHaveLength(DISALLOWED_AGENTS.length + 1);
    expect(text.match(/^Allow: /gmu)).toEqual(['Allow: ']);
  });

  it('reads as intended under RFC 9309, by an independent parser: preview bots and search engines reach cards and nothing else, the AI crawlers reach nothing', () => {
    const rules = parseRobots(robotsText());
    for (const agent of [
      'Twitterbot',
      'LinkedInBot',
      'Slackbot',
      'facebookexternalhit',
      'Googlebot',
      'bingbot',
    ]) {
      expect(robotsAllows(rules, agent, '/cards/AbCdEfGhIjKlMnOpQrSt_-'), agent).toBe(true);
      expect(robotsAllows(rules, agent, '/cards/AbCdEfGhIjKlMnOpQrSt_-/image.png'), agent).toBe(
        true,
      );
      for (const path of ['/', '/login', '/published', '/command-center', '/cardsx']) {
        expect(robotsAllows(rules, agent, path), `${agent} ${path}`).toBe(false);
      }
    }
    for (const agent of DISALLOWED_AGENTS) {
      expect(robotsAllows(rules, agent, '/cards/AbCdEfGhIjKlMnOpQrSt_-'), agent).toBe(false);
      expect(robotsAllows(rules, agent, '/cards/AbCdEfGhIjKlMnOpQrSt_-/image.png'), agent).toBe(
        false,
      );
    }
  });
});
