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

  it('never prints a credential-bearing connection string, even on connection failure', async () => {
    const url = 'postgresql://app:hunter2-marker@127.0.0.1:1/cas';
    const r = await exec(['db', 'check'], { DATABASE_URL: url });
    expect(r.code).toBe(EXIT_CODES.database);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).not.toContain('hunter2-marker');
    expect(all).not.toContain('postgresql://');
    expect(all).toContain('error[database:connection');
  });
});
