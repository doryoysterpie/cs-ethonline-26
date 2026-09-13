import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PRIVILEGE_CHECKS, REQUIRED_TABLES } from './store/privileges.js';

/**
 * The provisioning template and the verification matrix must describe the
 * same role. These checks hold the two together without a database.
 */

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

describe('the reader-role template', () => {
  it('grants SELECT on exactly the tables the verification requires', async () => {
    const template = await readFile(here('../sql/mcp-reader-role.sql'), 'utf8');
    const block = /required text\[\] := ARRAY\[([\s\S]*?)\];/u.exec(template);
    expect(block).not.toBeNull();
    const listed = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]);
    expect(listed).toEqual([...REQUIRED_TABLES]);
    expect([...REQUIRED_TABLES]).toEqual([...REQUIRED_TABLES].sort());
  });

  it('holds no password, credential or connection string', async () => {
    const template = await readFile(here('../sql/mcp-reader-role.sql'), 'utf8');
    expect(template).not.toMatch(/PASSWORD\s+'/iu);
    expect(template).not.toMatch(/postgres(ql)?:\/\/[^\s<>]*:[^\s<>]*@/u);
    expect(template).not.toMatch(/\b[0-9a-f]{32,}\b/u);
    // Every attribute that could widen the role is refused by name.
    for (const attribute of [
      'NOINHERIT',
      'NOSUPERUSER',
      'NOCREATEDB',
      'NOCREATEROLE',
      'NOREPLICATION',
      'NOBYPASSRLS',
    ]) {
      expect(template).toContain(attribute);
    }
    expect(template).toContain('REVOKE TEMP ON DATABASE');
    expect(template).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  });

  it('is checked by a matrix that names every check code exactly once', async () => {
    const source = await readFile(here('./store/privileges.ts'), 'utf8');
    for (const code of PRIVILEGE_CHECKS) {
      const occurrences = source.split(`'${code}'`).length - 1;
      // Once in the list, once in the SQL.
      expect(occurrences, code).toBe(2);
    }
    // Every catalogue function in the matrix is named by schema.
    const matrix = source.slice(source.indexOf('WITH me AS'), source.indexOf('ORDER BY n'));
    const calls = [...matrix.matchAll(/\b([a-z_]+)\(/gu)].map((match) => match[1]);
    const unqualified = calls.filter(
      (name) =>
        !matrix.includes(`pg_catalog.${name}(`) && !['writes', 'me', 'app'].includes(name ?? ''),
    );
    expect(unqualified).toEqual([]);
  });
});
