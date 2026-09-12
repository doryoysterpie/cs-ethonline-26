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
  },
});
