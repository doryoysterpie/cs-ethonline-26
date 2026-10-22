import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../cli.js';

/**
 * The import command's gate, from the outside: the committed tab map is the
 * only declaration it reads (audit F2), and the database configuration is
 * checked before any credential is touched. Neither case opens a socket.
 */

let temporary = '';

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'cas-import-cli-'));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function invoke(argv: string[], env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { env, io: { log: (l) => out.push(l), error: (l) => err.push(l) } });
  return { code, out, err };
}

describe('sheets import, the gate', () => {
  it('ignores an environment tab map and refuses a tab the committed file does not declare', async () => {
    const rogue = path.join(temporary, 'rogue.json');
    await writeFile(
      rogue,
      JSON.stringify({
        tabs: [
          {
            title: 'CS90',
            stage: 'rss_source_corpus',
            sourceKind: 'master',
            firstDataRow: 2,
            columns: 7,
            timestampColumns: [2, 3],
          },
        ],
      }),
      'utf8',
    );
    const result = await invoke(['sheets', 'import', '--tab', 'CS90'], {
      GOOGLE_SHEETS_TAB_MAP: rogue,
      GOOGLE_SHEETS_SPREADSHEET_ID: 'SyntheticAuthorized_0000000000000000000001',
      GOOGLE_APPLICATION_CREDENTIALS: path.join(temporary, 'absent.json'),
      DATABASE_URL: 'postgres://user@localhost:5432/absent',
    });
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('tab_not_declared');
    expect(result.out).toEqual([]);
  });

  it('checks the database configuration before touching any credential', async () => {
    const result = await invoke(['sheets', 'import', '--tab', 'Cyberattack Sundays'], {
      GOOGLE_SHEETS_SPREADSHEET_ID: 'SyntheticAuthorized_0000000000000000000001',
      GOOGLE_APPLICATION_CREDENTIALS: path.join(temporary, 'absent.json'),
    });
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toMatch(/DATABASE_URL/u);
    expect(result.err.join('\n')).not.toMatch(/credential/iu);
  });

  it('requires --tab', async () => {
    const result = await invoke(['sheets', 'import'], {});
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('tab_required');
  });
});
