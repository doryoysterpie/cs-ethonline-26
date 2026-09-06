import { defineConfig } from 'vitest/config';

// Default unit tests never open a database connection and never read a real
// export. PostgreSQL integration tests live in *.db.test.ts and run only
// through `corepack pnpm test:db` (vitest.db.config.ts), which requires
// DATABASE_URL.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts'],
  },
});
