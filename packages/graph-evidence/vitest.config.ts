import { defineConfig } from 'vitest/config';

// Default unit tests never touch the network and never need a credential.
// Live integration tests live in *.live.test.ts and run only through
// `pnpm --filter @cas/graph-evidence test:live` (vitest.live.config.ts).
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
  },
});
