import { defineConfig } from 'vitest/config';

// The default suite: no database, no network, no secret. The stdio tests
// spawn the built entry point, which is why the package's `test` script
// builds first.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.db.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
