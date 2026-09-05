import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/', '**/node_modules/', '**/.turbo/', 'pnpm-lock.yaml']),
  js.configs.recommended,
  tseslint.configs.recommended,
]);
