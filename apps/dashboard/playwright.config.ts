import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level tests against the production build.
 *
 * The launcher in `tests/browser/server.mjs` builds an isolated, migrated
 * PostgreSQL schema seeded by the real pipeline, provisions three synthetic
 * accounts into a memory-store seed file with passwords drawn from the CSPRNG,
 * and starts `next start`. Requires `DATABASE_URL` and a completed `pnpm build`
 * (`pnpm test:browser` does both). Never part of `pnpm test` or CI.
 */
export const BROWSER_PORT = 3419;
export const BASE_URL = `http://127.0.0.1:${BROWSER_PORT}`;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './tests/browser/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --conditions=react-server tests/browser/server.mjs',
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
