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
      '0004_classification_integrity.sql',
      '0005_classification_schema_security.sql',
      '0006_incident_clustering.sql',
      '0007_clustering_integrity.sql',
      '0008_graph_evidence.sql',
      '0009_evidence_integrity.sql',
      '0010_dashboard_persistence.sql',
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
    expect(files[3]?.version).toBe(4);
    expect(files[3]?.name).toBe('classification_integrity');
    expect(files[4]?.version).toBe(5);
    expect(files[4]?.name).toBe('classification_schema_security');
    expect(files[5]?.version).toBe(6);
    expect(files[5]?.name).toBe('incident_clustering');
    expect(files[6]?.version).toBe(7);
    expect(files[6]?.name).toBe('clustering_integrity');
    expect(files[7]?.version).toBe(8);
    expect(files[7]?.name).toBe('graph_evidence');
  });

  it('pins the checksums of the applied migrations, which must never change', async () => {
    // Migrations 0001 to 0005 were applied to the working database and
    // accepted with Sprint 3. Migration 0006 was applied to it during Sprint 4
    // and its bytes are the ones Codex Desktop's audit recorded, so it is
    // pinned here too: the Sprint 4 correction is additive in 0007 and may not
    // touch anything already applied. 0007 is pinned from the moment it is
    // applied, for the same reason. Editing any of them would be drift on
    // every existing database.
    for (const [fileName, expected] of [
      [
        '0001_editorial_ingestion.sql',
        '6ccf4b05cdcd255b326029e99097c73ec220fa77d38d767e86a40175abc8b936',
      ],
      [
        '0002_provenance_integrity.sql',
        '4139f25cd5ca24746208c40cc3b65076c2bd9cccbc287e08880d508691d71b8d',
      ],
      [
        '0003_classification.sql',
        '60d24e6ce016db85d6ff6f8f0066d5cad4641f156f3cb56fed1e452c0ac17dc6',
      ],
      [
        '0004_classification_integrity.sql',
        '89763968c272d178a6a40c8f83ed5b28907c7e727393901ff99681b7b13ec719',
      ],
      [
        '0005_classification_schema_security.sql',
        'f94c3342c1e2eb4d0d884a98b8afb8909d49d217fc0c3fdb094a3359004ae4de',
      ],
      [
        '0006_incident_clustering.sql',
        'cb88b6a9ba6891cb211372f3542cf1fae78a11fdb3dfe442ae1ce777b0d860b2',
      ],
      [
        '0007_clustering_integrity.sql',
        '1f066032ae936ce2b68be05c7d76e5c781e4d9277255bee0f5fd3da6e22d1449',
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
