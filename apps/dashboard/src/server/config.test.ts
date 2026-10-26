import { describe, expect, it } from 'vitest';

import { openStores } from './auth/stores.ts';
import { loadDashboardConfig, loadDashboardRuntimeConfig } from './config.ts';
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
      trustedProxyHops: 1,
      buildCommit: null,
    });
    expect(
      loadDashboardConfig({
        ...base,
        DASHBOARD_DATABASE_SCHEMA: 'cas_test_ab',
        DASHBOARD_TRUST_FORWARDED_FOR: 'true',
      }),
    ).toMatchObject({
      databaseSchema: 'cas_test_ab',
      trustForwardedFor: true,
      trustedProxyHops: 1,
    });
    expect(loadDashboardConfig({ ...base, DASHBOARD_TRUSTED_PROXY_HOPS: '2' })).toMatchObject({
      trustedProxyHops: 2,
    });
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
    for (const hops of ['0', '9', 'one', '-1', '1.5']) {
      expect(codeOf({ ...base, DASHBOARD_TRUSTED_PROXY_HOPS: hops }), hops).toBe(
        'trusted_proxy_hops_invalid',
      );
    }
    try {
      loadDashboardConfig({ ...base, DASHBOARD_DATABASE_SCHEMA: 'Public; DROP' });
    } catch (error) {
      expect((error as Error).message).not.toContain('DROP');
    }
  });

  it('fails closed when the PostgreSQL store is selected with no database handle', async () => {
    const config = loadDashboardConfig({
      DASHBOARD_ENVIRONMENT: 'production',
      DASHBOARD_ACCOUNT_STORE: 'postgres',
    });
    await expect(openStores(config)).rejects.toSatisfy(
      (error) =>
        isDashboardError(error) &&
        error.kind === 'configuration' &&
        error.code === 'postgres_store_requires_database',
    );
  });

  it('keeps the first seven characters of a commit hash Railway sets, and nothing else (CAS-010)', () => {
    expect(
      loadDashboardConfig({
        ...base,
        RAILWAY_GIT_COMMIT_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01',
      }).buildCommit,
    ).toBe('abcdef0');
    for (const value of ['', ' ', 'abcdef0', 'not a hash', 'g'.repeat(40)]) {
      expect(
        loadDashboardConfig({ ...base, RAILWAY_GIT_COMMIT_SHA: value }).buildCommit,
      ).toBeNull();
    }
  });

  it('validates the required production integration configuration as one unit', () => {
    const production = {
      DASHBOARD_ENVIRONMENT: 'production',
      DASHBOARD_ACCOUNT_STORE: 'postgres',
    };
    expect(() => loadDashboardRuntimeConfig(production)).toThrowError(/RESEND_API_KEY is not set/);
    expect(
      loadDashboardRuntimeConfig({
        ...production,
        RESEND_API_KEY: 'test-provider-key',
        AUTH_EMAIL_FROM: 'access@example.test',
        AUTH_OTP_PEPPER: 'a'.repeat(32),
      }).dashboard,
    ).toMatchObject({ environment: 'production', accountStore: 'postgres' });
  });
});
