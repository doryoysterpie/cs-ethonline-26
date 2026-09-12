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
]);
