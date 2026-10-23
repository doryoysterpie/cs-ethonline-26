import 'server-only';

/**
 * The robots.txt the instance serves (CAS-007, report section 1.6): the known
 * AI crawlers are disallowed by user agent, a convention they may ignore, so
 * the limits are the protection; the list is fixed and versioned. Everything
 * is behind sign-in, so the file is a courtesy, and nothing else is inferred
 * from it. Since CAS-009 (D48, the owner's decision of 23 October 2026), the
 * story cards are allowed to every agent but the named AI crawlers, whose own
 * groups still disallow everything: a preview bot can then read a card's
 * image, and a search engine can fetch a card and see its `noindex`, which a
 * disallowed URL never shows. The `Allow` line comes first for parsers that
 * take the first match; RFC 9309's longest match gives the same answer.
 */
export const ROBOTS_POLICY_VERSION = 'robots-policy@2';

export const DISALLOWED_AGENTS: readonly string[] = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'Google-Extended',
  'CCBot',
  'PerplexityBot',
  'Bytespider',
  'Amazonbot',
  'Applebot-Extended',
  'cohere-ai',
  'Diffbot',
  'FacebookBot',
  'Meta-ExternalAgent',
  'omgili',
  'Timpibot',
  'YouBot',
  'ImagesiftBot',
  'AI2Bot',
];

export function robotsText(): string {
  const groups = DISALLOWED_AGENTS.map((agent) => `User-agent: ${agent}\nDisallow: /\n`).join('\n');
  return `# ${ROBOTS_POLICY_VERSION}\n${groups}\nUser-agent: *\nAllow: /cards/\nDisallow: /\n`;
}
