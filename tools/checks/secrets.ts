import { createHash } from 'node:crypto';

import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';

/**
 * Secret-pattern scan over every tracked file.
 *
 * This is the repository's own line of defence and the readiness step for
 * GitHub secret scanning and push protection, which are repository settings
 * an owner enables (docs/SECURITY.md section 8). The patterns are the
 * high-precision token shapes of the services the project uses or could be
 * handed a credential for. A finding names the file, the line and the rule
 * and never the match: a check that printed the token it found would put it
 * in every log.
 *
 * Two rules skip test files by design. The credential-policy tests exercise
 * URLs with synthetic passwords, and a secret-shaped assignment is the very
 * thing an output-safety test constructs; those files are reviewed for
 * markers rather than scanned for shapes.
 */

export interface SecretRule {
  readonly rule: string;
  readonly pattern: RegExp;
  /** Skip `*.test.ts` files, which build synthetic credentials on purpose. */
  readonly skipTests?: boolean;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { rule: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
  { rule: 'github_fine_grained_token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/u },
  { rule: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { rule: 'private_key_block', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/u },
  { rule: 'slack_token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/u },
  { rule: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { rule: 'stripe_key', pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}\b/u },
  { rule: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  { rule: 'openai_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/u },
  { rule: 'npm_token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { rule: 'graph_api_key_assignment', pattern: /GRAPH_API_KEY\s*[=:]\s*['"]?[0-9a-f]{32}\b/u },
  {
    rule: 'hedera_ed25519_private_key',
    pattern: /\b302e020100300506032b657004220420[0-9a-f]{64}\b/iu,
  },
  {
    rule: 'credential_in_url',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@/iu,
    skipTests: true,
  },
  {
    rule: 'secret_assignment',
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/iu,
    skipTests: true,
  },
];

/**
 * Files that exist only for tests.
 *
 * Two rules — `credential_in_url` and `secret_assignment` — deliberately skip
 * these, because a URL with a synthetic password and a secret-shaped
 * assignment are the very things a credential-policy or output-safety test
 * constructs. The pattern covers `*.test.ts` and the support modules the tests
 * import, which every package's `tsconfig.build.json` excludes from its build
 * output: a value in one of them cannot reach a shipped artefact.
 *
 * The high-precision token rules above are not skipped for any file. A real
 * GitHub, AWS, Stripe or Anthropic token is a finding wherever it appears.
 */
const TEST_FILE = /(?:\.test\.ts|(?:^|\/)(?:test-support|db-support)\.ts)$/u;

/**
 * Lines a test constructs as an attack input, allowed by SHA-256 of the exact
 * line rather than by file or by pattern.
 *
 * The `private_key_block` rule deliberately does not skip test files: a real
 * key committed into a test is exactly the mistake worth catching, and
 * exempting a whole file class to quieten a known-synthetic line would give
 * that mistake somewhere to hide. So the exemption is the narrowest one
 * available, and it is stored as a digest so that this file does not itself
 * have to contain the shapes it scans for.
 *
 * Each exempted line was checked with `crypto.createPrivateKey` and does not
 * decode to a usable key. Change the line by one character and the digest
 * stops matching, so the exemption cannot drift into covering something else.
 */
const SYNTHETIC_SECRET_LINES: ReadonlySet<string> = new Set([
  // packages/sheets-intake/src/redaction.test.ts: a truncated PEM prefix used
  // to prove the redactor removes key material it was never told about.
  '956c92eb6479377489f1e43dd048b4e38b720725f42665a25e67a5f24f5a37b2',
  // packages/sheets-intake/src/credentials.test.ts: an invented marker body
  // used to prove key material never reaches a refusal message.
  '7391020fb55d5cdbc61b3a62080f27f1b8eabfeec67d24a12b4b21560ed8da33',
]);
export interface SecretsResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

function lineDigest(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

export function scanTextForSecrets(relativePath: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isTest = TEST_FILE.test(relativePath);
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const rule of SECRET_RULES) {
      if (rule.skipTests === true && isTest) continue;
      if (rule.pattern.test(line) && !SYNTHETIC_SECRET_LINES.has(lineDigest(line))) {
        findings.push(finding(relativePath, index + 1, rule.rule));
      }
    }
  }
  return findings;
}

export function scanSecrets(
  root: string,
  entries: readonly TrackedEntry[] = trackedEntries(root),
): SecretsResult {
  const findings: Finding[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const entry of entries) {
    if (entry.mode !== '100644' && entry.mode !== '100755') continue;
    findings.push(...scanTextForSecrets(entry.path, decoder.decode(readTracked(root, entry.path))));
  }
  return { scanned: entries.length, findings };
}

if (isMain(import.meta.url)) {
  const result = scanSecrets(repositoryRoot());
  process.exitCode = conclude('secrets', result.scanned, result.findings);
}
