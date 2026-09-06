import { defineConfig } from 'vitest/config';

// Live integration run. Requires GRAPH_API_KEY in the environment and
// performs real gateway queries. Never wired into the default `test` task or CI.
export default defineConfig({
  test: {
    include: ['src/**/*.live.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
