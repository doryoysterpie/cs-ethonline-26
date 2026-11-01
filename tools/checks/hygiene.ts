import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { prohibitedTextRule } from '../../packages/contracts/src/prohibited-text.ts';
import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { readTracked, repositoryRoot, trackedEntries, type TrackedEntry } from './lib/tracked.ts';

/**
 * Repository text hygiene over every tracked file.
 *
 * Every tracked file must be valid UTF-8 and must not carry a character
 * nobody can see in review: whatever the prohibited-text rule names (D49,
 * `packages/contracts/src/prohibited-text.ts`, the one predicate the round-up
 * export and the story card also call): C0 and C1 controls, the Unicode line
 * and paragraph separators, the bidirectional controls that reorder displayed
 * source ("Trojan Source"), every other default-ignorable code point but the
 * two emoji presentation selectors (zero-width characters, a stray byte-order
 * mark, the soft hyphen, variation selectors, tags), interlinear annotation
 * characters and Unicode noncharacters. The rule is read as source because
 * this check runs before any build. Sprint 5 shipped five raw NUL bytes
 * inside a TypeScript string that every formatter, linter and test accepted;
 * this check is the repository-wide form of the guard that followed.
 *
 * Two synthetic fixtures are exempt from exactly one rule each, because the
 * real exports they imitate carry a byte-order mark and CRLF line endings.
 * The exemptions are by exact path and by rule; nothing else is exempt.
 *
 * Findings name the file, the line and the code point. The character itself
 * is never printed, because a finding that reprinted it would be as
 * invisible as the defect.
 *
 * `--fix` (`corepack pnpm hygiene:fix`) removes the default-ignorable code
 * points, which is what copied article text and editors bring in (a soft
 * hyphen, a zero-width space, a leading byte-order mark), and then checks
 * again. Every other finding is left for a person: a control character or a
 * noncharacter in a file says something is wrong that removal would hide.
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
      const rule = code >= 0x20 && code < 0x7f ? null : prohibitedTextRule(code);
      if (rule !== null) findings.push(finding(relativePath, line, rule, label(code)));
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

/**
 * The file's bytes with every default-ignorable code point removed, a leading
 * byte-order mark included unless the file is exempt from that rule, or null
 * when there is nothing to remove or the file is not valid UTF-8.
 */
export function fixFileHygiene(
  relativePath: string,
  bytes: Uint8Array,
  options: HygieneOptions = DEFAULT_HYGIENE_OPTIONS,
): { readonly bytes: Uint8Array; readonly removed: number } | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const keepBom = options.bomAllowed.has(relativePath) && text.codePointAt(0) === 0xfeff;
  const kept: string[] = [];
  let removed = 0;
  let index = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const rule = code >= 0x20 && code < 0x7f ? null : prohibitedTextRule(code);
    const invisible = rule === 'default_ignorable' || rule === 'bidi_control';
    if (invisible && !(index === 0 && keepBom)) removed += 1;
    else kept.push(character);
    index += character.length;
  }
  return removed === 0 ? null : { bytes: new TextEncoder().encode(kept.join('')), removed };
}

export interface HygieneFix {
  readonly path: string;
  readonly removed: number;
}

/**
 * Rewrites each tracked file that carries a default-ignorable code point. The
 * file is opened without following a link, refused unless it is a regular
 * file, and read, judged and rewritten through that one handle.
 */
export function fixHygiene(
  root: string,
  options: HygieneOptions = DEFAULT_HYGIENE_OPTIONS,
  entries: readonly TrackedEntry[] = trackedEntries(root),
): HygieneFix[] {
  const fixed: HygieneFix[] = [];
  for (const entry of entries) {
    if (entry.mode !== '100644' && entry.mode !== '100755') continue;
    if (fixFileHygiene(entry.path, readTracked(root, entry.path), options) === null) continue;
    const handle = openSync(path.join(root, entry.path), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(handle).isFile()) continue;
      const result = fixFileHygiene(entry.path, readFileSync(handle), options);
      if (result === null) continue;
      ftruncateSync(handle, 0);
      writeSync(handle, result.bytes, 0, result.bytes.length, 0);
      fixed.push({ path: entry.path, removed: result.removed });
    } finally {
      closeSync(handle);
    }
  }
  return fixed;
}

if (isMain(import.meta.url)) {
  const root = repositoryRoot();
  if (process.argv.includes('--fix')) {
    for (const item of fixHygiene(root)) {
      console.log(`${item.path}: removed ${item.removed} default-ignorable code point(s)`);
    }
  }
  const result = scanHygiene(root);
  process.exitCode = conclude('hygiene', result.scanned, result.findings);
}
