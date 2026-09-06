import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { EXIT_CODES } from './editorial/errors.js';
import { fixture, FIXTURES_DIRECTORY } from './test-support.js';

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

async function exec(
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<Captured & { code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { env, io: { log: (l) => out.push(l), error: (l) => err.push(l) } });
  return { out, err, code };
}

describe('cli configuration handling (no database)', () => {
  it('refuses an import without an explicit origin', async () => {
    const r = await exec([
      'editorial',
      'import',
      '--file',
      fixture('master-synthetic.csv'),
      '--kind',
      'master',
    ]);
    expect(r.code).toBe(EXIT_CODES.configuration);
    expect(r.err.join('\n')).toContain('origin_required');
  });

  it('refuses a weekly import without a review label and a master import with one', async () => {
    const weekly = await exec([
      'editorial',
      'import',
      '--file',
      fixture('weekly-synthetic.csv'),
      '--kind',
      'weekly',
      '--origin',
      'fixture',
    ]);
    expect(weekly.code).toBe(EXIT_CODES.configuration);
    expect(weekly.err.join('\n')).toContain('review_label_required');
    const master = await exec([
      'editorial',
      'import',
      '--file',
      fixture('master-synthetic.csv'),
      '--kind',
      'master',
      '--origin',
      'fixture',
      '--review-label',
      'CS00',
    ]);
    expect(master.code).toBe(EXIT_CODES.configuration);
    expect(master.err.join('\n')).toContain('review_label_forbidden');
  });

  it('refuses an import and a migration without DATABASE_URL, before touching the file', async () => {
    const r = await exec(
      [
        'editorial',
        'import',
        '--file',
        'missing-marker.csv',
        '--kind',
        'master',
        '--origin',
        'fixture',
      ],
      {},
    );
    expect(r.code).toBe(EXIT_CODES.configuration);
    expect(r.err.join('\n')).toContain('DATABASE_URL');
    expect(r.err.join('\n')).not.toContain('missing-marker');
    expect((await exec(['db', 'migrate'])).code).toBe(EXIT_CODES.configuration);
  });

  it('validates without a database and prints only the basename', async () => {
    const r = await exec([
      'editorial',
      'validate',
      '--file',
      fixture('master-synthetic.csv'),
      '--kind',
      'master',
    ]);
    expect(r.code).toBe(EXIT_CODES.ok);
    const text = r.out.join('\n');
    expect(text).toContain('file=master-synthetic.csv');
    expect(text).toContain('accepted=7 quarantined=5');
    expect(text).not.toContain(FIXTURES_DIRECTORY);
    expect(text).not.toContain('Synthetic story');
    expect(text).not.toContain('news.example');
    expect(text).not.toContain('Editor Note');
  });

  it('reports a structural rejection with exit code 3 and no content', async () => {
    const r = await exec([
      'editorial',
      'validate',
      '--file',
      fixture('structural-unclosed-quote.csv'),
      '--kind',
      'weekly',
    ]);
    expect(r.code).toBe(EXIT_CODES.structural);
    expect(r.err.join('\n')).toContain('error[structural/');
    expect(r.err.join('\n')).not.toContain('MARKER');
  });

  it('rejects unknown commands and malformed arguments with exit code 2', async () => {
    expect((await exec(['editorial', 'explode'])).code).toBe(EXIT_CODES.configuration);
    expect((await exec(['editorial', 'validate', '--bogus'])).code).toBe(EXIT_CODES.configuration);
    expect((await exec(['editorial', 'validate', '--file', 'x.csv', '--kind', 'daily'])).code).toBe(
      EXIT_CODES.configuration,
    );
  });

  it('rejects a non-UUID batch id before opening a connection', async () => {
    const r = await exec(['editorial', 'report', '--batch', "x'; DROP TABLE import_batches; --"]);
    expect(r.code).toBe(EXIT_CODES.configuration);
    expect(r.err.join('\n')).toContain('batch_id_invalid');
    expect(r.err.join('\n')).not.toContain('DROP TABLE');
  });

  it('renders a hostile basename safely in validation mode, on one line, without rejecting it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-cli-'));
    try {
      const ESC = String.fromCharCode(0x1b);
      const LS = String.fromCharCode(0x2028);
      const hostile = path.join(dir, `a${ESC}[31m${LS}b.csv`);
      await copyFile(fixture('weekly-synthetic.csv'), hostile);
      const r = await exec(['editorial', 'validate', '--file', hostile, '--kind', 'weekly']);
      expect(r.code).toBe(EXIT_CODES.ok);
      expect(r.out).toHaveLength(8);
      for (const line of r.out) {
        expect(line.includes('\n')).toBe(false);
        expect(line.includes(ESC)).toBe(false);
        expect(line.includes(LS)).toBe(false);
      }
      expect(r.out[0]).toContain('file=a\\x1b[31m\\u2028b.csv');
      expect(r.out.join('\n').split('\n')).toHaveLength(8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts an ordinary filename containing spaces in validation mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-cli-'));
    try {
      const spaced = path.join(dir, 'Content @latestincyber - CS86.csv');
      await copyFile(fixture('weekly-synthetic.csv'), spaced);
      const r = await exec(['editorial', 'validate', '--file', spaced, '--kind', 'weekly']);
      expect(r.code).toBe(EXIT_CODES.ok);
      expect(r.out[0]).toContain('file=Content @latestincyber - CS86.csv');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an import whose basename or review label carries a control character', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-cli-'));
    try {
      const hostile = path.join(dir, 'a\nb.csv');
      await copyFile(fixture('weekly-synthetic.csv'), hostile);
      const byName = await exec([
        'editorial',
        'import',
        '--file',
        hostile,
        '--kind',
        'weekly',
        '--origin',
        'replay',
        '--review-label',
        'CS79',
      ]);
      expect(byName.code).toBe(EXIT_CODES.configuration);
      expect(byName.err.join('\n')).toContain('source_basename_invalid');
      expect(byName.err.join('\n').split('\n')).toHaveLength(1);

      const byLabel = await exec([
        'editorial',
        'import',
        '--file',
        fixture('weekly-synthetic.csv'),
        '--kind',
        'weekly',
        '--origin',
        'replay',
        '--review-label',
        'CS79\nRECONCILIATION FAILED for 9 batch(es)',
      ]);
      expect(byLabel.code).toBe(EXIT_CODES.configuration);
      expect(byLabel.err.join('\n')).toContain('review_label_invalid');
      expect(byLabel.err.join('\n').split('\n')).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never prints a credential-bearing connection string, even on connection failure', async () => {
    const url = 'postgresql://app:hunter2-marker@127.0.0.1:1/cas';
    const r = await exec(['db', 'check'], { DATABASE_URL: url });
    expect(r.code).toBe(EXIT_CODES.database);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain('hunter2-marker');
    expect(all).not.toContain('postgresql://');
    expect(all).toContain('error[database:connection');
  });

  it('refuses to run any command while a password too short to redact is configured', async () => {
    // Codex reproduced `short_password_visible=true` with this exact shape:
    // a three-character password that the redactor ignores, appearing inside
    // an otherwise printable filename.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-cli-'));
    try {
      const accidental = path.join(dir, 'accidental-abc.csv');
      await copyFile(fixture('weekly-synthetic.csv'), accidental);
      const env = { DATABASE_URL: 'postgresql://app:abc@127.0.0.1:5432/cas' };
      for (const argv of [
        ['editorial', 'validate', '--file', accidental, '--kind', 'weekly'],
        ['db', 'migrate'],
        ['db', 'check'],
        ['editorial', 'report'],
        [
          'editorial',
          'import',
          '--file',
          accidental,
          '--kind',
          'weekly',
          '--origin',
          'replay',
          '--review-label',
          'CS79',
        ],
      ]) {
        const r = await exec(argv, env);
        expect(r.code, argv.join(' ')).toBe(EXIT_CODES.configuration);
        const all = [...r.out, ...r.err].join('\n');
        expect(all, argv.join(' ')).toContain('at least 4 characters');
        expect(all, argv.join(' ')).not.toContain('accidental-abc.csv');
        expect(all, argv.join(' ')).not.toContain('postgresql://');
        expect(all, argv.join(' ')).not.toContain('127.0.0.1');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts an accepted password that appears in printed metadata', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-cli-'));
    try {
      // Four decoded characters, the shortest the configuration accepts,
      // supplied percent-encoded and appearing decoded in the filename.
      const env = { DATABASE_URL: 'postgresql://app:%41%42%43%44@127.0.0.1:5432/cas' };
      const named = path.join(dir, 'report-ABCD.csv');
      await copyFile(fixture('weekly-synthetic.csv'), named);
      const r = await exec(['editorial', 'validate', '--file', named, '--kind', 'weekly'], env);
      expect(r.code).toBe(EXIT_CODES.ok);
      const all = r.out.join('\n');
      expect(all).toContain('file=report-[REDACTED].csv');
      expect(all).not.toContain('ABCD');
      expect(all).not.toContain('%41%42%43%44');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts the password alone, not only the whole connection string', async () => {
    const url = 'postgresql://app:p%40ss-marker@127.0.0.1:1/cas';
    const r = await exec(['editorial', 'report', '--batch', 'not-a-uuid'], { DATABASE_URL: url });
    expect(r.code).toBe(EXIT_CODES.configuration);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain('p%40ss-marker');
    expect(all).not.toContain('p@ss-marker');
  });
});
