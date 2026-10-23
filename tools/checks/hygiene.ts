import { readFileSync } from 'node:fs';

import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';

/**
 * Repository text hygiene over every tracked file.
 *
 * Every tracked file must be valid UTF-8 and must not carry a character
 * nobody can see in review: C0 and C1 controls, the Unicode line and
 * paragraph separators, the bidirectional controls that reorder displayed
 * source ("Trojan Source"), zero-width characters and a stray byte-order
 * mark, interlinear annotation characters and Unicode noncharacters. Sprint
 * 5 shipped five raw NUL bytes inside a TypeScript string that every
 * formatter, linter and test accepted; this check is the repository-wide
 * form of the guard that followed.
 *
 * Two synthetic fixtures are exempt from exactly one rule each, because the
 * real exports they imitate carry a byte-order mark and CRLF line endings.
 * The exemptions are by exact path and by rule; nothing else is exempt.
 *
 * Findings name the file, the line and the code point. The character itself
 * is never printed, because a finding that reprinted it would be as
 * invisible as the defect.
 */

export interface HygieneOptions {
  readonly bomAllowed: ReadonlySet<string>;
  readonly carriageReturnAllowed: ReadonlySet<string>;
}

export const DEFAULT_HYGIENE_OPTIONS: HygieneOptions = {
  bomAllowed: new Set(['data/fixtures/editorial/master-synthetic.csv']),
  carriageReturnAllowed: new Set(['data/fixtures/editorial/weekly-synthetic.csv']),
};

/** Findings per file are capped so one hostile file cannot flood the output. */
export const MAX_FINDINGS_PER_FILE = 100;

function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let code = from; code <= to; code += 1) out.push(code);
  return out;
}

/** The policy file both this check and the round-up export read (`data/policy/prohibited-text.json`). */
const POLICY_PATH = new URL('../../data/policy/prohibited-text.json', import.meta.url);

interface ProhibitedTextPolicy {
  readonly version: string;
  readonly rules: readonly {
    readonly rule: string;
    readonly ranges: readonly (readonly [string, string])[];
  }[];
}

export function readProhibitedTextPolicy(): ProhibitedTextPolicy {
  const parsed = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as ProhibitedTextPolicy;
  if (parsed.version !== 'prohibited-text@1' || !Array.isArray(parsed.rules)) {
    throw new Error('data/policy/prohibited-text.json is not the structure this check reads');
  }
  return parsed;
}

function table(): ReadonlyMap<number, string> {
  const rules = new Map<number, string>();
  for (const entry of readProhibitedTextPolicy().rules) {
    for (const [from, to] of entry.ranges) {
      for (const code of span(Number.parseInt(from, 16), Number.parseInt(to, 16))) {
        rules.set(code, entry.rule);
      }
    }
  }
  return rules;
}

/** Code point to the rule it violates. Carriage return and the BOM are handled by path. */
export const PROHIBITED_CODE_POINTS: ReadonlyMap<number, string> = table();

function label(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

export interface HygieneResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

export function scanFileHygiene(
  relativePath: string,
  bytes: Uint8Array,
  options: HygieneOptions = DEFAULT_HYGIENE_OPTIONS,
): Finding[] {
  const findings: Finding[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return [finding(relativePath, null, 'invalid_utf8')];
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasBom && !options.bomAllowed.has(relativePath)) {
    findings.push(finding(relativePath, 1, 'byte_order_mark', label(0xfeff)));
  }
  const crAllowed = options.carriageReturnAllowed.has(relativePath);
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    if (code === 0x0a) {
      line += 1;
    } else if (code === 0x0d) {
      if (!crAllowed) findings.push(finding(relativePath, line, 'carriage_return', label(code)));
    } else if (code === 0xfeff && index === 0 && hasBom) {
      // The leading byte-order mark was judged above.
    } else {
      const rule = PROHIBITED_CODE_POINTS.get(code);
      if (rule !== undefined) findings.push(finding(relativePath, line, rule, label(code)));
    }
    if (findings.length > MAX_FINDINGS_PER_FILE) {
      findings.length = MAX_FINDINGS_PER_FILE;
      findings.push(
        finding(relativePath, null, 'findings_truncated', `max=${MAX_FINDINGS_PER_FILE}`),
      );
      break;
    }
    index += width;
  }
  return findings;
}

export function scanHygiene(
  root: string,
  options: HygieneOptions = DEFAULT_HYGIENE_OPTIONS,
  entries: readonly TrackedEntry[] = trackedEntries(root),
): HygieneResult {
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (entry.mode !== '100644' && entry.mode !== '100755') continue;
    findings.push(...scanFileHygiene(entry.path, readTracked(root, entry.path), options));
  }
  return { scanned: entries.length, findings };
}

if (isMain(import.meta.url)) {
  const result = scanHygiene(repositoryRoot());
  process.exitCode = conclude('hygiene', result.scanned, result.findings);
}
