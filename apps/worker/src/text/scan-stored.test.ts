import { describe, expect, it } from 'vitest';

import type { Database } from '@cas/database';

import { formatStoredTextScan, scanStoredText } from './scan-stored.js';

const char = (code: number): string => String.fromCodePoint(code);

/** A database that answers each table's query with fixed rows, and refuses any write. */
function stub(rows: Record<string, { key: string; revision: number; markdown: string }[]>): {
  db: Database;
  queries: string[];
} {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (!/^\s*SELECT /u.test(sql)) throw new Error('the scan must only read');
      const table = /FROM (\w+)/u.exec(sql)?.[1] ?? '';
      return { rows: rows[table] ?? [] };
    },
  };
  const db = {
    withClient: async (fn: (c: unknown) => unknown) => fn(client),
  } as unknown as Database;
  return { db, queries };
}

describe('the one-time scan of stored texts (CAS-012, D50)', () => {
  it('reports each revision holding a character the rule names, by code point, rule and count, never the text', async () => {
    const { db, queries } = stub({
      draft_revisions: [
        { key: 'draft-a', revision: 1, markdown: 'clean' },
        {
          key: 'draft-a',
          revision: 2,
          markdown: `co${char(0xad)}op${char(0xad)}erate${char(0x200b)}`,
        },
      ],
      roundup_revisions: [
        { key: 'week/cyberattack', revision: 3, markdown: `turn ${char(0x202e)}here` },
      ],
      article_revisions: [{ key: 'week/cyberattack', revision: 1, markdown: 'clean\n' }],
    });
    const scan = await scanStoredText(db);
    expect(queries).toHaveLength(3);
    expect(scan.scanned).toBe(4);
    const lines = formatStoredTextScan(scan);
    expect(lines).toEqual([
      'text:scan: draft_revisions draft-a revision=2: default_ignorable \\u{00AD} SOFT HYPHEN x2; default_ignorable \\u{200B} ZERO WIDTH SPACE x1',
      'text:scan: roundup_revisions week/cyberattack revision=3: bidi_control \\u{202E} RIGHT-TO-LEFT OVERRIDE x1',
      'text:scan: scanned=4 revisions_with_characters=2',
    ]);
    for (const line of lines) {
      for (const word of ['co', 'operate', 'turn', 'here', 'clean']) {
        expect(line.includes(` ${word}`), word).toBe(false);
      }
    }
  });

  it('reports nothing on a store that holds no such character', async () => {
    const { db } = stub({});
    expect(formatStoredTextScan(await scanStoredText(db))).toEqual([
      'text:scan: scanned=0 revisions_with_characters=0',
    ]);
  });
});
