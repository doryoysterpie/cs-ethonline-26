import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Default unit tests never open a database, a browser or a socket. The
// `server-only` marker is aliased to an empty module here: its job is to make
// a Next build fail when a client component imports server code, and the
// build proves that; under Vitest the server modules are exercised directly.
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./src/test/server-only.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.db.test.ts', 'tests/**'],
    // The authorization enumeration hashes a synthetic password per role with
    // Argon2id before every case, CPU-bound work that the runner's 5-second
    // default cut off when `verify` built the other packages beside it (a
    // CAS-006 follow-up). The bound stays well under the database suite's.
    testTimeout: 30_000,
  },
});
