import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Tests of the repository tooling under tools/. They read the repository's
// own tracked files and build disposable Git repositories under the system
// temporary directory; they open no socket and need no database or secret.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['tools/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
