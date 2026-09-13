import { defineConfig } from 'vitest/config';

// PostgreSQL integration run. Requires DATABASE_URL in the environment. Every
// test creates a schema whose exact name it generated and drops only that
// schema. Never wired into the default `test` task or CI.
export default defineConfig({
  test: {
    include: ['src/**/*.db.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
