import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Source files carry no invisible characters.
 *
 * Sprint 5 wrote five raw NUL bytes into a TypeScript file, where they framed
 * the fields of a hash input. Nothing caught it: the bytes are legal inside a
 * JavaScript string, Prettier reformatted around them, ESLint passed, and every
 * test went green because the digest was self-consistent. A reviewer reading
 * the diff would have seen ordinary spaces.
 *
 * That is the whole argument for this file. The project refuses these code
 * points in stored notes and rationales, and refusing them in its own source is
 * the same rule applied to the same risk: a character nobody can see is a
 * character nobody can review.
 *
 * The code points are built from their numeric values rather than typed, so
 * this file stays clean by the standard it enforces. It reads only the
 * repository's own source, so it opens no socket and needs no database, secret
 * or real data.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED_ROOTS = ['apps', 'packages'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.sql'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git']);

/**
 * Every C0 control except tab and newline, DEL, every C1 control, and the two
 * Unicode line separators. This is the set migration 0007 refuses in a stored
 * note, and the set `assertReviewNote` refuses at the worker API.
 */
const PROHIBITED: readonly number[] = [
  ...Array.from({ length: 0x20 }, (_, code) => code).filter(
    (code) => code !== 0x09 && code !== 0x0a,
  ),
  0x7f,
  ...Array.from({ length: 0x20 }, (_, offset) => 0x80 + offset),
  0x2028,
  0x2029,
];

const PROHIBITED_SET = new Set(PROHIBITED.map((code) => String.fromCodePoint(code)));

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await sourceFiles(full)));
      continue;
    }
    if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) found.push(full);
  }
  return found;
}

describe('repository hygiene', () => {
  it('has no invisible control character in any TypeScript or SQL source', async () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) files.push(...(await sourceFiles(path.join(ROOT, root))));
    // A scan that silently found nothing to scan would pass forever.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const [index, character] of [...text].entries()) {
        if (!PROHIBITED_SET.has(character)) continue;
        const line = text.slice(0, index).split('\n').length;
        const code = character.codePointAt(0) ?? 0;
        offenders.push(
          `${path.relative(ROOT, file)}:${line}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads every scanned source as valid UTF-8', async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const root of SCANNED_ROOTS) {
      for (const file of await sourceFiles(path.join(ROOT, root))) {
        const bytes = await readFile(file);
        expect(() => decoder.decode(bytes), path.relative(ROOT, file)).not.toThrow();
      }
    }
  });
});
