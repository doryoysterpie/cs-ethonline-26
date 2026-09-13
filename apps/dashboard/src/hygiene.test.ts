import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Structural rules the dashboard's own source must satisfy. Each is a rule
 * from the sprint brief or from `docs/SECURITY.md`, checked against the files
 * rather than trusted.
 */
const ROOT = fileURLToPath(new URL('./', import.meta.url));

async function files(directory: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await files(full, out);
    } else if (/\.(ts|tsx|css)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Modules that are pure by design and are imported by the proxy or by tests only. */
const PURE_SERVER_MODULES = new Set([
  'server/display.ts',
  'server/environment.ts',
  'server/input.ts',
  'server/auth/cookie.ts',
  'server/auth/csrf.ts',
  'server/auth/roles.ts',
  'server/dal/dto.ts',
  'server/http/headers.ts',
  'server/http/network.ts',
  'server/markdown/sanitize.ts',
]);

describe('dashboard source hygiene', () => {
  it('never sets HTML from a string, never uses draft mode or cache invalidation, never inlines styles', async () => {
    for (const file of await files(ROOT)) {
      if (file.endsWith('.test.ts')) continue;
      const text = await readFile(file, 'utf8');
      const relative = path.relative(ROOT, file);
      expect(text, relative).not.toContain('dangerouslySetInnerHTML');
      expect(text, relative).not.toContain('draftMode(');
      expect(text, relative).not.toContain('revalidatePath(');
      expect(text, relative).not.toContain('revalidateTag(');
      expect(text, relative).not.toContain('unstable_cache(');
      expect(text, relative).not.toMatch(/style=\{\{/u);
      expect(text, relative).not.toMatch(/\bon[A-Z][a-zA-Z]+=\{/u);
      expect(text, relative).not.toContain('NEXT_PUBLIC_');
      expect(text, relative).not.toContain("'use client'");
      expect(text, relative).not.toMatch(/from 'next\/image'/u);
      expect(text, relative).not.toContain('eval(');
    }
  });

  it('guards every server module that is not pure with server-only', async () => {
    const serverRoot = path.join(ROOT, 'server');
    for (const file of await files(serverRoot)) {
      if (file.endsWith('.test.ts')) continue;
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      const text = await readFile(file, 'utf8');
      if (PURE_SERVER_MODULES.has(relative)) {
        expect(text, relative).not.toContain("import 'server-only'");
        expect(text, relative).not.toMatch(/from '@cas\/database'/u);
        expect(text, relative).not.toMatch(/from 'argon2'/u);
        continue;
      }
      expect(text.startsWith("import 'server-only';"), relative).toBe(true);
    }
  });

  it('keeps the proxy free of the database, the stores and the session service', async () => {
    const proxy = await readFile(path.join(ROOT, 'proxy.ts'), 'utf8');
    expect(proxy).not.toContain('@cas/');
    expect(proxy).not.toContain('runtime');
    expect(proxy).not.toContain('session.ts');
    expect(proxy).not.toContain('stores');
  });

  it('carries no invisible character in any source file', async () => {
    const prohibited = new RegExp(
      `[${String.fromCodePoint(0x00)}-${String.fromCodePoint(0x08)}${String.fromCodePoint(0x0b)}${String.fromCodePoint(0x0c)}${String.fromCodePoint(0x0e)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}${String.fromCodePoint(0x2028)}${String.fromCodePoint(0x2029)}]`,
      'u',
    );
    for (const file of await files(ROOT)) {
      const text = await readFile(file, 'utf8');
      expect(prohibited.test(text), path.relative(ROOT, file)).toBe(false);
    }
  });
});
