import { describe, expect, it } from 'vitest';

import { openStores, PERSISTENCE_PAUSED_MESSAGE } from './auth/stores.ts';
import { loadDashboardConfig } from './config.ts';
import { isDashboardError } from './errors.ts';

const base = {
  DASHBOARD_ENVIRONMENT: 'local',
  DASHBOARD_ACCOUNT_STORE: 'memory',
  DASHBOARD_MEMORY_STORE_SEED: '/tmp/seed.json',
};

const codeOf = (env: Record<string, string | undefined>): string => {
  try {
    loadDashboardConfig(env);
  } catch (error) {
    if (isDashboardError(error) && error.kind === 'configuration') return error.code;
    throw error;
  }
  return 'accepted';
};

describe('dashboard configuration', () => {
  it('accepts the local memory configuration with defaults', () => {
    expect(loadDashboardConfig(base)).toEqual({
      environment: 'local',
      accountStore: 'memory',
      memorySeedPath: '/tmp/seed.json',
      databaseSchema: 'public',
      trustForwardedFor: false,
    });
    expect(
      loadDashboardConfig({
        ...base,
        DASHBOARD_DATABASE_SCHEMA: 'cas_test_ab',
        DASHBOARD_TRUST_FORWARDED_FOR: 'true',
      }),
    ).toMatchObject({ databaseSchema: 'cas_test_ab', trustForwardedFor: true });
  });

  it('refuses every malformed or unsafe combination by rule, never by value', () => {
    expect(codeOf({})).toBe('environment_missing');
    expect(codeOf({ DASHBOARD_ENVIRONMENT: 'staging' })).toBe('environment_invalid');
    expect(codeOf({ DASHBOARD_ENVIRONMENT: 'local' })).toBe('account_store_missing');
    expect(codeOf({ DASHBOARD_ENVIRONMENT: 'local', DASHBOARD_ACCOUNT_STORE: 'redis' })).toBe(
      'account_store_invalid',
    );
    expect(codeOf({ ...base, DASHBOARD_ENVIRONMENT: 'production' })).toBe(
      'memory_store_outside_local',
    );
    expect(codeOf({ DASHBOARD_ENVIRONMENT: 'local', DASHBOARD_ACCOUNT_STORE: 'memory' })).toBe(
      'memory_seed_missing',
    );
    expect(
      codeOf({
        DASHBOARD_ENVIRONMENT: 'production',
        DASHBOARD_ACCOUNT_STORE: 'postgres',
        DASHBOARD_MEMORY_STORE_SEED: '/tmp/x',
      }),
    ).toBe('memory_seed_unexpected');
    expect(codeOf({ ...base, DASHBOARD_DATABASE_SCHEMA: 'Public; DROP' })).toBe(
      'database_schema_invalid',
    );
    expect(codeOf({ ...base, DASHBOARD_TRUST_FORWARDED_FOR: 'yes' })).toBe(
      'trust_forwarded_for_invalid',
    );
    try {
      loadDashboardConfig({ ...base, DASHBOARD_DATABASE_SCHEMA: 'Public; DROP' });
    } catch (error) {
      expect((error as Error).message).not.toContain('DROP');
    }
  });

  it('refuses the PostgreSQL store with the fixed persistence-paused message', async () => {
    const config = loadDashboardConfig({
      DASHBOARD_ENVIRONMENT: 'production',
      DASHBOARD_ACCOUNT_STORE: 'postgres',
    });
    await expect(openStores(config)).rejects.toSatisfy(
      (error) =>
        isDashboardError(error) &&
        error.kind === 'persistence_paused' &&
        error.message === PERSISTENCE_PAUSED_MESSAGE,
    );
  });
});
