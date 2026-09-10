import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROHIBITED_CODE_POINTS,
  describeOffender,
  scanBytes,
  scanSourceTree,
} from './hygiene/scan.js';

/**
 * Source files carry no invisible characters, and the scanner that says so is
 * shown to detect them (audit finding F5).
 *
 * The first test scans the repository as it is. The rest build a disposable
 * source tree, put one prohibited code point into it programmatically, and
 * require the scanner to report the exact file and line. No prohibited byte
 * appears in this file: every one is produced from its numeric value.
 *
 * The test reads only the repository's own source and a temporary directory,
 * so it opens no socket and needs no database, secret or real data.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('repository hygiene', () => {
  it('has no invisible control character in any TypeScript or SQL source', async () => {
    const scan = await scanSourceTree(ROOT, { subdirectories: ['apps', 'packages'] });
    // A scan that silently found nothing to scan would pass forever.
    expect(scan.scanned).toBeGreaterThan(50);
    expect(scan.offenders.map(describeOffender)).toEqual([]);
  });

  it('documents the whole prohibited set', () => {
    // C0 except tab and newline, DEL, C1, and the two line separators.
    expect(PROHIBITED_CODE_POINTS).toHaveLength(30 + 1 + 32 + 2);
    expect(PROHIBITED_CODE_POINTS).not.toContain(0x09);
    expect(PROHIBITED_CODE_POINTS).not.toContain(0x0a);
    for (const code of [0x00, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x2028, 0x2029]) {
      expect(PROHIBITED_CODE_POINTS).toContain(code);
    }
  });
});

describe('the hygiene scanner against a disposable tree', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cas-hygiene-'));
    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'a', 'clean.ts'),
      "export const clean = 'a\\tb';\n// tabs and newlines are fine\n",
      'utf8',
    );
    // A tab and a multi-byte character are not offenders, and a skipped
    // directory is not scanned however bad its contents.
    await writeFile(path.join(root, 'src', 'a', 'unicode.sql'), "SELECT 'é\t—';\n", 'utf8');
    await writeFile(
      path.join(root, 'node_modules', 'dep', 'bad.ts'),
      `x${String.fromCodePoint(0x1b)}`,
      'utf8',
    );
    await writeFile(
      path.join(root, 'src', 'a', 'notes.md'),
      `m${String.fromCodePoint(0x1b)}`,
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes a clean tree and scans only the documented extensions', async () => {
    const scan = await scanSourceTree(root);
    expect(scan.scanned).toBe(2);
    expect(scan.offenders).toEqual([]);
  });

  it.each([
    ['NUL', 0x00],
    ['SOH', 0x01],
    ['backspace', 0x08],
    ['vertical tab', 0x0b],
    ['form feed', 0x0c],
    ['carriage return', 0x0d],
    ['escape', 0x1b],
    ['unit separator', 0x1f],
    ['DEL', 0x7f],
    ['C1 PAD', 0x80],
    ['C1 NEL', 0x85],
    ['C1 CSI', 0x9b],
    ['C1 APC', 0x9f],
    ['line separator', 0x2028],
    ['paragraph separator', 0x2029],
  ])('reports %s at its exact file and line', async (_name, codePoint) => {
    const contents = `const a = 1;\nconst b = 'x${String.fromCodePoint(codePoint)}y';\nconst c = 3;\n`;
    await writeFile(path.join(root, 'src', 'a', 'injected.ts'), contents, 'utf8');
    const scan = await scanSourceTree(root);
    expect(scan.scanned).toBe(3);
    expect(scan.offenders).toEqual([{ file: 'src/a/injected.ts', line: 2, codePoint }]);
    expect(scan.offenders.map(describeOffender)).toEqual([
      `src/a/injected.ts:2: U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
    ]);
  });

  it('reports every prohibited code point in the documented set, and nothing else', () => {
    const encoder = new TextEncoder();
    for (const codePoint of PROHIBITED_CODE_POINTS) {
      const bytes = encoder.encode(`ok\n${String.fromCodePoint(codePoint)}\nok\n`);
      expect(scanBytes(bytes, 'f.ts'), String(codePoint)).toEqual([
        { file: 'f.ts', line: 2, codePoint },
      ]);
    }
    for (const codePoint of [0x09, 0x0a, 0x20, 0x41, 0xe9, 0x2014, 0x1f600]) {
      const bytes = encoder.encode(`ok\n${String.fromCodePoint(codePoint)}\nok\n`);
      expect(scanBytes(bytes, 'f.ts'), String(codePoint)).toEqual([]);
    }
  });

  it('reports a line that is not valid UTF-8 rather than decoding it leniently', async () => {
    // 0xC3 0x28 is an invalid two-byte sequence; 0xA0 alone is a stray
    // continuation byte, which a byte-wise scan would misread as C1.
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('const a = 1;\n'),
      0xc3,
      0x28,
      0x0a,
      0xa0,
      0x0a,
    ]);
    await writeFile(path.join(root, 'src', 'a', 'bytes.ts'), bytes);
    const scan = await scanSourceTree(root);
    expect(scan.offenders).toEqual([
      { file: 'src/a/bytes.ts', line: 2, codePoint: null },
      { file: 'src/a/bytes.ts', line: 3, codePoint: null },
    ]);
    expect(describeOffender(scan.offenders[0] as never)).toBe('src/a/bytes.ts:2: invalid UTF-8');
  });

  it('reports several offenders across files in a stable order', async () => {
    await writeFile(
      path.join(root, 'src', 'a', 'one.ts'),
      `a\nb${String.fromCodePoint(0x7f)}\n`,
      'utf8',
    );
    await writeFile(path.join(root, 'src', 'two.sql'), `${String.fromCodePoint(0x2029)}\n`, 'utf8');
    const scan = await scanSourceTree(root);
    expect(scan.offenders).toEqual([
      { file: 'src/a/one.ts', line: 2, codePoint: 0x7f },
      { file: 'src/two.sql', line: 1, codePoint: 0x2029 },
    ]);
  });
});
