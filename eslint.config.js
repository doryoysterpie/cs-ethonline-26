import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/dist/',
    '**/node_modules/',
    '**/.turbo/',
    '**/.next/',
    '**/next-env.d.ts',
    '**/test-results/',
    '**/playwright-report/',
    'pnpm-lock.yaml',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  // Plain scripts under `tools/` run under Node, so they see its globals.
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  // A regression harness spawned as a real subprocess under plain `node`, so
  // it sees Node's own globals plus the platform fetch API it fakes
  // (`URL`, `Response`), neither of which has a `node:`-module import.
  {
    files: ['apps/worker/src/sheets/inventory-subprocess-harness.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
      },
    },
  },
]);
