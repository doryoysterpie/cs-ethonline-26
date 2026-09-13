import { defineConfig } from 'vitest/config';

// PostgreSQL integration run. Requires DATABASE_URL in the environment and a
// built @cas/database. Every test creates a schema whose exact name it
// generated and drops only that schema. Never wired into the default `test`
// task or CI.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
