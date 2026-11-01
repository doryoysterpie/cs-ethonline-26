import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describeLocated, prohibitedCodePoints, prohibitedTextRule } from '@cas/contracts';

/**
 * A scanner for invisible characters in source (audit finding F5).
 *
 * Sprint 5 wrote five raw NUL bytes into a TypeScript file, where they framed
 * the fields of a hash input. Nothing caught it: the bytes are legal inside a
 * JavaScript string, Prettier reformatted around them, ESLint passed, and every
 * test went green because the digest was self-consistent. A reviewer reading
 * the diff would have seen ordinary spaces.
 *
 * The project refuses these code points in stored notes and rationales, and
 * refusing them in its own source is the same rule applied to the same risk:
 * a character nobody can see is a character nobody can review.
 *
 * The scanner decodes each line as UTF-8 and walks it by code point, so a
 * continuation byte of a multi-byte character is never mistaken for a C1
 * control, and a line that is not valid UTF-8 is reported as itself rather
 * than decoded leniently. The root is a parameter, so the same scanner can
 * be pointed at a disposable tree to prove that it detects what it claims to.
 */

/**
 * Every code point the prohibited-text rule names (`@cas/contracts`, D49), as
 * the running Node enumerates it: the same rule the repository's hygiene check
 * and the review-note refusal apply (CAS-012). Tab, line feed and carriage
 * return are not among them; the repository check refuses a carriage return by
 * path.
 */
export const PROHIBITED_CODE_POINTS: readonly number[] = prohibitedCodePoints();

export const DEFAULT_SCANNED_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.sql'];
export const DEFAULT_SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  '.git',
];

export interface HygieneOffender {
  /** Path relative to the scanned root, with forward slashes. */
  readonly file: string;
  /** One-based line. */
  readonly line: number;
  /** One-based column, in code points; 0 for a line that is not valid UTF-8. */
  readonly column: number;
  /** The prohibited code point, or null when the line is not valid UTF-8. */
  readonly codePoint: number | null;
}

export interface HygieneScan {
  readonly scanned: number;
  readonly offenders: readonly HygieneOffender[];
}

export interface HygieneScanOptions {
  readonly extensions?: readonly string[] | undefined;
  readonly skippedDirectories?: readonly string[] | undefined;
  /** Subdirectories of the root to scan. Default: the root itself. */
  readonly subdirectories?: readonly string[] | undefined;
}

async function sourceFiles(
  directory: string,
  extensions: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipped.has(entry.name)) continue;
      found.push(...(await sourceFiles(full, extensions, skipped)));
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name))) found.push(full);
  }
  return found;
}

/**
 * Formats an offender in the one form every refusal and scan reports in (D50):
 * `file:line:column: rule \u{XXXX} NAME`, or `file:line: invalid UTF-8`.
 */
export function describeOffender(offender: HygieneOffender): string {
  if (offender.codePoint === null) return `${offender.file}:${offender.line}: invalid UTF-8`;
  const rule = prohibitedTextRule(offender.codePoint) ?? 'line_character';
  return describeLocated(offender.file, {
    codePoint: offender.codePoint,
    rule,
    line: offender.line,
    column: offender.column,
  });
}

/** Scans one file's bytes: every line decoded strictly and walked by code point. */
export function scanBytes(bytes: Uint8Array, file: string): HygieneOffender[] {
  // `ignoreBOM` keeps a byte-order mark in the decoded text, so one that opens a line is
  // reported rather than silently dropped by the decoder.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const offenders: HygieneOffender[] = [];
  let line = 1;
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    const slice = bytes.subarray(start, index);
    let text: string;
    try {
      text = decoder.decode(slice);
    } catch {
      offenders.push({ file, line, column: 0, codePoint: null });
      text = '';
    }
    let column = 1;
    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (prohibitedTextRule(codePoint) !== null) offenders.push({ file, line, column, codePoint });
      column += 1;
    }
    line += 1;
    start = index + 1;
  }
  return offenders;
}

/** Scans every source file under the root, or under the named subdirectories of it. */
export async function scanSourceTree(
  root: string,
  options: HygieneScanOptions = {},
): Promise<HygieneScan> {
  const extensions = new Set(options.extensions ?? DEFAULT_SCANNED_EXTENSIONS);
  const skipped = new Set(options.skippedDirectories ?? DEFAULT_SKIPPED_DIRECTORIES);
  const roots = (options.subdirectories ?? ['.']).map((sub) => path.join(root, sub));
  const files: string[] = [];
  for (const directory of roots) files.push(...(await sourceFiles(directory, extensions, skipped)));
  files.sort();
  const offenders: HygieneOffender[] = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    offenders.push(...scanBytes(bytes, relative));
  }
  return { scanned: files.length, offenders };
}
