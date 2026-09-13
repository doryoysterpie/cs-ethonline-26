import { defineConfig } from 'vitest/config';

// The clustering suite includes the contract-mutation sweep and the bounds
// tests, which each cluster a large synthetic corpus many times over. They
// take a few seconds alone and considerably longer while the rest of the
// workspace builds and tests beside them, so the default five-second timeout
// fails them on a loaded machine for no reason but load.
//
// The budget is raised rather than the work reduced: the corpora are the point
// of those tests, and a mutation sweep that stops short proves less.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
