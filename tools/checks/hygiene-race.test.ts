import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The race the re-review of pull request 57 at 7ab3697 reproduced (F1): a
 * hard link made from outside the checkout after the fix had sampled the
 * file's link count. `statSync` is wrapped so the link is made at the second
 * check of the target, the moment the reviewer's probe chose; on 7ab3697 the
 * fix then rewrote the inode in place and the outside name saw it.
 */
const race = vi.hoisted(() => ({
  target: null as string | null,
  outside: null as string | null,
  seen: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    if (race.target !== null && race.outside !== null && String(args[0]) === race.target) {
      race.seen += 1;
      if (race.seen === 2) actual.linkSync(race.target, race.outside);
    }
    return actual.statSync(...args);
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

const { fixHygiene } = await import('./hygiene.ts');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  race.target = null;
  race.outside = null;
  race.seen = 0;
});

describe('hygiene --fix under a concurrent hard link (review of pull request 57 at 7ab3697, F1)', () => {
  it('leaves the bytes behind a link made after the link count was sampled, and still fixes the checkout', () => {
    const hidden = `outside${String.fromCodePoint(0x200b)}\n`;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-check-race-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-check-outside-')));
    temps.push(root, outside);
    execFileSync('git', ['-C', root, 'init', '-q']);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/note.md'), hidden);
    execFileSync('git', ['-C', root, 'add', '-A']);
    race.target = path.join(root, 'docs/note.md');
    race.outside = path.join(outside, 'linked.md');

    expect(fixHygiene(root)).toEqual([{ path: 'docs/note.md', removed: 1 }]);
    expect(race.seen).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(race.outside, 'utf8')).toBe(hidden);
    expect(fs.readFileSync(path.join(root, 'docs/note.md'), 'utf8')).toBe('outside\n');
    expect(fs.readdirSync(path.join(root, 'docs'))).toEqual(['note.md']);
  });
});
