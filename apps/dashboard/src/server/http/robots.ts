import 'server-only';

/**
 * The robots.txt the instance serves (CAS-007, report section 1.6): the known
 * AI crawlers are disallowed by user agent, a convention they may ignore, so
 * the limits are the protection; the list is fixed and versioned. Everything
 * is behind sign-in, so the file is a courtesy, and nothing else is inferred
 * from it.
 */
export const ROBOTS_POLICY_VERSION = 'robots-policy@1';

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
  return `# ${ROBOTS_POLICY_VERSION}\n${groups}\nUser-agent: *\nDisallow: /\n`;
}
