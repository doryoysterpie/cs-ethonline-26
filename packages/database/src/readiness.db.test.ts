import { describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from './config.js';
import { probeDatabaseReadiness } from './database.js';

describe('database readiness against PostgreSQL', () => {
  it('accepts a reachable database with one bounded read-only probe', async () => {
    await expect(
      probeDatabaseReadiness(parseDatabaseConfig(process.env), { timeoutMillis: 2_000 }),
    ).resolves.toBeUndefined();
  });
});
