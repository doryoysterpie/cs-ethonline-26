import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Short writes (the combined re-review of pull requests 55 and 57, F3).
 * `writeSync` may take fewer bytes than asked; on 6276df0 the fix ignored the
 * count and renamed a truncated replacement over the tracked file. Here every
 * write is cut to at most three bytes, or, in the second case, takes none.
 */
const writes = vi.hoisted(() => ({ mode: 'off' as 'off' | 'short' | 'none', calls: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeSync = ((...args: unknown[]) => {
    if (writes.mode !== 'off' && args[1] instanceof Uint8Array) {
      writes.calls += 1;
      if (writes.mode === 'none') return 0;
      const [handle, bytes, offset, length, position] = args as [
        number,
        Uint8Array,
        number,
        number,
        number,
      ];
      return actual.writeSync(handle, bytes, offset, Math.min(length, 3), position);
    }
    return (actual.writeSync as (...rest: unknown[]) => number)(...args);
  }) as typeof actual.writeSync;
  return { ...actual, writeSync };
});

const { fixHygiene } = await import('./hygiene.ts');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  writes.mode = 'off';
  writes.calls = 0;
});

function trackedNote(text: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-check-write-')));
  temps.push(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/note.md'), text);
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

describe('hygiene --fix under short writes (combined re-review of pull requests 55 and 57, F3)', () => {
  it('writes the whole replacement when each write takes three bytes at most', () => {
    const root = trackedNote(`abc${String.fromCodePoint(0x200b)}defgh\n`);
    writes.mode = 'short';
    expect(fixHygiene(root)).toEqual([{ path: 'docs/note.md', removed: 1 }]);
    expect(writes.calls).toBe(3);
    expect(fs.readFileSync(path.join(root, 'docs/note.md'), 'utf8')).toBe('abcdefgh\n');
    expect(fs.readdirSync(path.join(root, 'docs'))).toEqual(['note.md']);
  });

  it('stops, leaving the tracked file as it was and no replacement behind, when a write takes nothing', () => {
    const original = `abc${String.fromCodePoint(0x200b)}defgh\n`;
    const root = trackedNote(original);
    writes.mode = 'none';
    expect(() => fixHygiene(root)).toThrow(
      new Error('hygiene fix could not write the replacement for docs/note.md'),
    );
    expect(fs.readFileSync(path.join(root, 'docs/note.md'), 'utf8')).toBe(original);
    expect(fs.readdirSync(path.join(root, 'docs'))).toEqual(['note.md']);
  });
});
