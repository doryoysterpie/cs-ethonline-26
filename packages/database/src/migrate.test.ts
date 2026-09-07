import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMigrations, MIGRATIONS_DIRECTORY } from './migrate.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  it('loads the shipped migrations in numeric order with SHA-256 checksums of the file bytes', async () => {
    const files = await loadMigrations();
    expect(files.map((f) => f.fileName)).toEqual([
      '0001_editorial_ingestion.sql',
      '0002_provenance_integrity.sql',
      '0003_classification.sql',
    ]);
    for (const file of files) {
      const bytes = await readFile(path.join(MIGRATIONS_DIRECTORY, file.fileName));
      expect(file.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.name).toBe('editorial_ingestion');
    expect(files[1]?.version).toBe(2);
    expect(files[1]?.name).toBe('provenance_integrity');
    expect(files[2]?.version).toBe(3);
    expect(files[2]?.name).toBe('classification');
  });

  it('pins the checksums of the applied migrations, which must never change', async () => {
    // 0001 and 0002 were applied and audited in Sprint 2. Editing either would
    // be drift on every existing database, so their bytes are pinned here.
    for (const [fileName, expected] of [
      [
        '0001_editorial_ingestion.sql',
        '6ccf4b05cdcd255b326029e99097c73ec220fa77d38d767e86a40175abc8b936',
      ],
      [
        '0002_provenance_integrity.sql',
        '4139f25cd5ca24746208c40cc3b65076c2bd9cccbc287e08880d508691d71b8d',
      ],
    ] as const) {
      const bytes = await readFile(path.join(MIGRATIONS_DIRECTORY, fileName));
      expect(createHash('sha256').update(bytes).digest('hex'), fileName).toBe(expected);
    }
  });

  it('orders by version, ignores files that do not match the naming rule, and rejects duplicate versions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-migrations-'));
    temps.push(dir);
    await writeFile(path.join(dir, '0002_second.sql'), 'SELECT 2;');
    await writeFile(path.join(dir, '0001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'README.md'), 'not a migration');
    expect((await loadMigrations(dir)).map((f) => f.version)).toEqual([1, 2]);
    await writeFile(path.join(dir, '0002_again.sql'), 'SELECT 22;');
    await expect(loadMigrations(dir)).rejects.toThrowError(/duplicate migration version 2/);
  });
});
