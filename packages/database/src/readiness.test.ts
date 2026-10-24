import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from './database.js';
import { isDatabaseError } from './errors.js';

const CONFIG = { connectionString: 'postgresql://localhost/cas', schema: 'public' } as const;

describe('database readiness probe', () => {
  it('executes exactly one constant read-only query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const release = vi.fn();
    const client = { query, release } as unknown as pg.PoolClient;
    const database = openDatabase(CONFIG, { connect: async () => client });
    try {
      await expect(database.readinessProbe(100)).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith('SELECT 1', undefined);
      expect(release).toHaveBeenCalledWith(false);
    } finally {
      await database.end();
    }
  });

  it('bounds an unresponsive query and destroys its client', async () => {
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const release = vi.fn();
    const client = { query, release } as unknown as pg.PoolClient;
    const database = openDatabase(CONFIG, { connect: async () => client });
    let caught: unknown;
    try {
      await database.readinessProbe(20);
    } catch (error) {
      caught = error;
    } finally {
      await database.end();
    }
    expect(isDatabaseError(caught) && caught.kind === 'connection').toBe(true);
    expect(String((caught as Error).message)).toBe('database readiness probe timed out');
    expect(String((caught as Error).message)).not.toContain(CONFIG.connectionString);
    expect(release).toHaveBeenCalledWith(true);
  });
});
