import { describe, expect, it, vi } from 'vitest';

import { READINESS_TIMEOUT_MILLIS } from '../../../server/config.ts';
import { NO_STORE } from '../../../server/http/headers.ts';
import { readinessResponse, type ReadinessDependencies } from './route.ts';

const DATABASE_URL = 'postgresql://user:hunter2-marker@db.internal:5432/cas';
const VALID_ENV = {
  DASHBOARD_ENVIRONMENT: 'local',
  DASHBOARD_ACCOUNT_STORE: 'memory',
  DASHBOARD_MEMORY_STORE_SEED: '/tmp/cas-readyz-seed.json',
  DATABASE_URL,
} as const;

function dependencies(
  options: {
    readonly parse?: () => { readonly connectionString: string; readonly schema: string | null };
    readonly probe?: () => Promise<void>;
  } = {},
): {
  readonly deps: ReadinessDependencies;
  readonly loadDatabase: ReturnType<typeof vi.fn>;
  readonly parseDatabaseConfig: ReturnType<typeof vi.fn>;
  readonly probeDatabaseReadiness: ReturnType<typeof vi.fn>;
} {
  const parseDatabaseConfig = vi.fn(
    options.parse ?? (() => ({ connectionString: DATABASE_URL, schema: 'public' })),
  );
  const probeDatabaseReadiness = vi.fn(options.probe ?? (async () => undefined));
  const loadDatabase = vi.fn(async () => ({ parseDatabaseConfig, probeDatabaseReadiness }));
  return { deps: { loadDatabase }, loadDatabase, parseDatabaseConfig, probeDatabaseReadiness };
}

async function expectEmpty(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe(NO_STORE);
  expect(await response.text()).toBe('');
}

describe('/api/readyz', () => {
  it('returns 200 only after valid configuration and a successful database probe', async () => {
    const { deps, parseDatabaseConfig, probeDatabaseReadiness } = dependencies();
    await expectEmpty(await readinessResponse(VALID_ENV, deps), 200);
    expect(parseDatabaseConfig).toHaveBeenCalledWith(VALID_ENV, { schema: 'public' });
    expect(probeDatabaseReadiness).toHaveBeenCalledWith(
      { connectionString: DATABASE_URL, schema: 'public' },
      { timeoutMillis: READINESS_TIMEOUT_MILLIS },
    );
  });

  it('returns an empty 503 before database loading when required configuration is missing', async () => {
    const { deps, loadDatabase } = dependencies();
    await expectEmpty(await readinessResponse({}, deps), 503);
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it('returns an empty 503 for invalid runtime configuration without echoing it', async () => {
    const invalid = { ...VALID_ENV, DASHBOARD_PUBLIC_URL: 'not-a-url-hunter2-marker' };
    const { deps, loadDatabase } = dependencies();
    const response = await readinessResponse(invalid, deps);
    await expectEmpty(response, 503);
    expect(loadDatabase).not.toHaveBeenCalled();
  });

  it('returns an empty 503 when the required database URL is missing or invalid', async () => {
    const { deps, probeDatabaseReadiness } = dependencies({
      parse: () => {
        throw new Error(`DATABASE_URL rejected: ${DATABASE_URL}`);
      },
    });
    const response = await readinessResponse(VALID_ENV, deps);
    await expectEmpty(response, 503);
    expect(probeDatabaseReadiness).not.toHaveBeenCalled();
  });

  it('returns an empty 503 when PostgreSQL is unreachable or times out', async () => {
    const { deps } = dependencies({
      probe: async () => {
        throw new Error(`connect ETIMEDOUT ${DATABASE_URL}`);
      },
    });
    const response = await readinessResponse(VALID_ENV, deps);
    await expectEmpty(response, 503);
  });
});
