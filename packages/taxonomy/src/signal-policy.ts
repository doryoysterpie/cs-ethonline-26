/**
 * Classification signal policy, version 1.
 *
 * This is a **classification policy**, not the project's incident taxonomy.
 * The repository holds no authoritative incident-taxonomy specification, and
 * none is invented here: `data/taxonomy` stays empty and nothing below claims
 * to be canonical. What this file defines is the vocabulary the Sprint 3
 * high-recall classifier matches against, grouped into three tiers with an
 * explicit version, so that a rule change is visible in the ruleset hash.
 *
 * Rules for editing this file:
 *
 * - Terms are general security or non-security vocabulary. No term may name a
 *   dataset, a calibration week, a source-row identifier, a publisher, a URL
 *   or a known outcome.
 * - Terms are matched case-insensitively on whole words, so a term must be
 *   written in lower case and contain no regular-expression syntax.
 * - Adding, removing or retiering a term changes the ruleset hash and
 *   therefore creates a distinct classification run. That is intended.
 */

/**
 * - `decisive`: vocabulary that names a security incident, an attack
 *   technique or an exploited weakness on its own. One hit is enough to
 *   consider a source in scope.
 * - `contextual`: security-adjacent vocabulary that is ambiguous alone
 *   ("attack", "breach", "patch"). Several distinct hits are required.
 * - `out_of_scope`: vocabulary that names a clearly unrelated subject. It can
 *   only ever contribute to an exclusion, and only when no security signal of
 *   any tier matched.
 */
export const SIGNAL_TIERS = ['decisive', 'contextual', 'out_of_scope'] as const;
export type SignalTier = (typeof SIGNAL_TIERS)[number];

export interface SignalDefinition {
  /** Stable machine-readable identifier. Never a source excerpt. */
  readonly id: string;
  readonly tier: SignalTier;
  /** Lower-case whole-word phrases. Matched with Unicode word boundaries. */
  readonly terms: readonly string[];
}

export const CLASSIFICATION_SIGNAL_POLICY_VERSION = 'classification-signal-policy@1';

/**
 * A source identifier is matched by pattern rather than by phrase, because
 * its numeric part varies. The pattern is written here in full so the ruleset
 * hash covers it.
 */
export const CVE_IDENTIFIER_PATTERN = 'cve-\\d{4}-\\d{4,7}';
export const CVE_SIGNAL_ID = 'cve_identifier';

const DECISIVE: readonly SignalDefinition[] = [
  { id: 'ransomware', tier: 'decisive', terms: ['ransomware', 'ransomware gang'] },
  {
    id: 'cyberattack',
    tier: 'decisive',
    terms: ['cyberattack', 'cyberattacks', 'cyber attack', 'cyber attacks', 'cyber-attack'],
  },
  {
    id: 'data_breach',
    tier: 'decisive',
    terms: ['data breach', 'data breaches', 'data leak', 'security breach'],
  },
  {
    id: 'malware',
    tier: 'decisive',
    terms: [
      'malware',
      'spyware',
      'infostealer',
      'info-stealer',
      'stealer malware',
      'trojan',
      'rootkit',
      'keylogger',
      'wiper malware',
      'cryptominer',
    ],
  },
  { id: 'botnet', tier: 'decisive', terms: ['botnet', 'botnets'] },
  {
    id: 'phishing',
    tier: 'decisive',
    terms: ['phishing', 'spear phishing', 'spear-phishing', 'smishing', 'vishing'],
  },
  {
    id: 'denial_of_service',
    tier: 'decisive',
    terms: ['ddos', 'ddos attack', 'denial-of-service attack', 'denial of service attack'],
  },
  { id: 'zero_day', tier: 'decisive', terms: ['zero-day', 'zero day', '0-day'] },
  {
    id: 'exploited_weakness',
    tier: 'decisive',
    terms: [
      'remote code execution',
      'privilege escalation',
      'sql injection',
      'cross-site scripting',
      'cross site scripting',
      'buffer overflow',
      'command injection',
      'authentication bypass',
      'path traversal',
      'actively exploited',
      'exploited vulnerability',
      'exploited a vulnerability',
      'exploited flaw',
      'proof-of-concept exploit',
    ],
  },
  { id: 'backdoor', tier: 'decisive', terms: ['backdoor', 'backdoored'] },
  {
    id: 'credential_attack',
    tier: 'decisive',
    terms: [
      'credential stuffing',
      'password spraying',
      'account takeover',
      'sim swapping',
      'sim-swapping',
    ],
  },
  {
    id: 'supply_chain_attack',
    tier: 'decisive',
    terms: ['supply chain attack', 'supply-chain attack', 'software supply chain attack'],
  },
  {
    id: 'threat_actor',
    tier: 'decisive',
    terms: [
      'threat actor',
      'threat actors',
      'advanced persistent threat',
      'apt group',
      'hacktivist',
      'hacktivists',
      'initial access broker',
    ],
  },
  {
    id: 'espionage_operation',
    tier: 'decisive',
    terms: ['cyber espionage', 'cyberespionage', 'espionage campaign'],
  },
  {
    id: 'security_incident',
    tier: 'decisive',
    terms: [
      'security incident',
      'cyber incident',
      'cybersecurity incident',
      'unauthorized access',
      'unauthorised access',
    ],
  },
  {
    id: 'data_exfiltration',
    tier: 'decisive',
    terms: ['exfiltrate', 'exfiltrated', 'exfiltration', 'data exfiltration'],
  },
  {
    id: 'intrusion_operations',
    tier: 'decisive',
    terms: ['lateral movement', 'command and control server', 'leak site', 'cryptojacking'],
  },
  { id: CVE_SIGNAL_ID, tier: 'decisive', terms: [] },
];

const CONTEXTUAL: readonly SignalDefinition[] = [
  {
    id: 'security_domain',
    tier: 'contextual',
    terms: ['security', 'cybersecurity', 'cyber security', 'infosec', 'cyber'],
  },
  {
    id: 'weakness',
    tier: 'contextual',
    terms: ['vulnerability', 'vulnerabilities', 'flaw', 'flaws', 'security bug'],
  },
  {
    id: 'intrusion_actor',
    tier: 'contextual',
    terms: ['hacker', 'hackers', 'hacking', 'hacked', 'hack'],
  },
  { id: 'breach_language', tier: 'contextual', terms: ['breach', 'breached', 'breaches'] },
  {
    id: 'compromise_language',
    tier: 'contextual',
    terms: ['compromise', 'compromised', 'intrusion', 'intruder'],
  },
  { id: 'exploit_language', tier: 'contextual', terms: ['exploit', 'exploits', 'exploited'] },
  {
    id: 'attack_language',
    tier: 'contextual',
    terms: ['attack', 'attacks', 'attacker', 'attackers', 'attacked'],
  },
  {
    id: 'remediation',
    tier: 'contextual',
    terms: ['patch', 'patched', 'patches', 'security update', 'hotfix', 'advisory'],
  },
  {
    id: 'credentials',
    tier: 'contextual',
    terms: ['credentials', 'password', 'passwords', 'authentication', 'mfa'],
  },
  { id: 'encryption', tier: 'contextual', terms: ['encryption', 'encrypted', 'decrypt'] },
  {
    id: 'defensive_tooling',
    tier: 'contextual',
    terms: ['firewall', 'antivirus', 'endpoint protection', 'edr', 'siem', 'vpn'],
  },
  { id: 'leak_language', tier: 'contextual', terms: ['leak', 'leaked', 'leaks'] },
  {
    id: 'disruption',
    tier: 'contextual',
    terms: ['incident', 'outage', 'disruption', 'disrupted', 'downtime'],
  },
  {
    id: 'criminal_activity',
    tier: 'contextual',
    terms: ['fraud', 'scam', 'extortion', 'ransom', 'cybercrime', 'dark web', 'darknet'],
  },
  { id: 'surveillance', tier: 'contextual', terms: ['espionage', 'surveillance', 'spying'] },
  {
    id: 'security_authority',
    tier: 'contextual',
    terms: ['cisa', 'enisa', 'ncsc', 'mitre att&ck'],
  },
  { id: 'data_protection', tier: 'contextual', terms: ['privacy', 'gdpr', 'personal data'] },
  {
    id: 'attack_surface',
    tier: 'contextual',
    terms: ['firmware', 'iot device', 'router', 'server', 'endpoint'],
  },
];

const OUT_OF_SCOPE: readonly SignalDefinition[] = [
  {
    id: 'sport',
    tier: 'out_of_scope',
    terms: [
      'box score',
      'football match',
      'soccer match',
      'basketball game',
      'baseball game',
      'hockey game',
      'world cup',
      'super bowl',
      'grand slam',
      'olympic medal',
      'transfer window',
      'formula one race',
    ],
  },
  {
    id: 'entertainment',
    tier: 'out_of_scope',
    terms: [
      'box office',
      'movie review',
      'film festival',
      'red carpet',
      'episode recap',
      'album review',
      'concert tour',
      'oscar nominations',
      'reality show',
    ],
  },
  {
    id: 'lifestyle',
    tier: 'out_of_scope',
    terms: [
      'recipe',
      'cookbook',
      'restaurant review',
      'horoscope',
      'gardening tips',
      'home decor',
      'wedding planning',
      'travel guide',
      'hotel review',
      'workout routine',
      'weight loss',
    ],
  },
  {
    id: 'commerce_promotion',
    tier: 'out_of_scope',
    terms: [
      'coupon code',
      'discount code',
      'black friday deal',
      'gift guide',
      'shopping guide',
      'best deals',
      'deal of the day',
    ],
  },
  {
    id: 'weather',
    tier: 'out_of_scope',
    terms: ['weather forecast', 'hurricane warning', 'snowfall totals'],
  },
];

export const CLASSIFICATION_SIGNALS: readonly SignalDefinition[] = [
  ...DECISIVE,
  ...CONTEXTUAL,
  ...OUT_OF_SCOPE,
];

/**
 * Decision thresholds, versioned with the policy. One decisive signal, or two
 * distinct contextual signals, put a source in scope.
 */
export const POLICY_THRESHOLDS = {
  decisiveHitsForInclude: 1,
  distinctContextualHitsForInclude: 2,
} as const;

/**
 * Weights used for the stored `signal_score`. The score is a deterministic
 * function of the distinct signal identifiers that matched. It is not a
 * probability and carries no confidence semantics.
 */
export const SIGNAL_WEIGHTS = { decisive: 3, contextual: 1, out_of_scope: 0 } as const;

/**
 * The policy as canonical JSON: sorted, fully expanded and stable across
 * runs. The classifier hashes this together with its own constants, so the
 * hash changes whenever any term, tier or threshold changes.
 */
export function canonicalSignalPolicy(): string {
  const signals = [...CLASSIFICATION_SIGNALS]
    .map((signal) => ({
      id: signal.id,
      tier: signal.tier,
      terms: [...signal.terms].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    version: CLASSIFICATION_SIGNAL_POLICY_VERSION,
    cvePattern: CVE_IDENTIFIER_PATTERN,
    thresholds: POLICY_THRESHOLDS,
    weights: SIGNAL_WEIGHTS,
    signals,
  });
}
