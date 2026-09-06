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
    expect(files.map((f) => f.fileName)).toEqual(['0001_editorial_ingestion.sql']);
    const bytes = await readFile(path.join(MIGRATIONS_DIRECTORY, '0001_editorial_ingestion.sql'));
    expect(files[0]?.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(files[0]?.version).toBe(1);
    expect(files[0]?.name).toBe('editorial_ingestion');
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
