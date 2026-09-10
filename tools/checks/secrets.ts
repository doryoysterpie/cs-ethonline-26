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

const TEST_FILE = /\.test\.ts$/u;

export interface SecretsResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

export function scanTextForSecrets(relativePath: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const isTest = TEST_FILE.test(relativePath);
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const rule of SECRET_RULES) {
      if (rule.skipTests === true && isTest) continue;
      if (rule.pattern.test(line)) findings.push(finding(relativePath, index + 1, rule.rule));
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
