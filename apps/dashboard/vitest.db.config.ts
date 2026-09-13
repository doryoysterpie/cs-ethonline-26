import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// PostgreSQL integration run. Requires DATABASE_URL and built workspace
// packages. Every test creates a schema whose exact name it generated and
// drops only that schema. Never wired into the default `test` task or CI.
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.db.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
