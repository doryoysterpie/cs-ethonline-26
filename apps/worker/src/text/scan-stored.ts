import { describeCodePoint, locateProhibitedText, type LocatedCodePoint } from '@cas/contracts';
import type { Database } from '@cas/database';

/**
 * The one-time read-only scan of stored drafts, round-ups and articles
 * (CAS-012, D50, point 1). Before CAS-012 a save stored a soft hyphen, a
 * zero-width space or a byte-order mark as it was pasted; the save path now
 * strips them before the revision is computed, and this scan reports what the
 * revisions stored before that hold. It reads and never writes: no migration
 * rewrites a published revision, which changes only through D6's publication
 * act. A finding names the table, the row's key, the revision, and each code
 * point the rule names with its rule and count, never the text.
 */
export interface StoredTextFinding {
  readonly table: 'draft_revisions' | 'roundup_revisions' | 'article_revisions';
  /** The draft key, or `weekRunId/category`. */
  readonly key: string;
  readonly revision: number;
  readonly located: readonly LocatedCodePoint[];
}

export interface StoredTextScan {
  readonly scanned: number;
  readonly findings: readonly StoredTextFinding[];
}

interface Row {
  readonly key: string;
  readonly revision: number;
  readonly markdown: string;
}

const QUERIES: readonly [StoredTextFinding['table'], string][] = [
  [
    'draft_revisions',
    'SELECT draft_key AS key, revision, markdown FROM draft_revisions ORDER BY draft_key, revision',
  ],
  [
    'roundup_revisions',
    `SELECT week_run_id::text || '/' || category AS key, revision, markdown
       FROM roundup_revisions ORDER BY week_run_id, category, revision`,
  ],
  [
    'article_revisions',
    `SELECT week_run_id::text || '/' || category AS key, revision, markdown
       FROM article_revisions ORDER BY week_run_id, category, revision`,
  ],
];

export async function scanStoredText(db: Database): Promise<StoredTextScan> {
  return db.withClient(async (client) => {
    let scanned = 0;
    const findings: StoredTextFinding[] = [];
    for (const [table, query] of QUERIES) {
      const result = await client.query<Row>(query);
      for (const row of result.rows) {
        scanned += 1;
        const located = locateProhibitedText(row.markdown);
        if (located.length > 0)
          findings.push({ table, key: row.key, revision: row.revision, located });
      }
    }
    return { scanned, findings };
  });
}

/** The scan as printed lines: one per revision that holds a character, then the totals. */
export function formatStoredTextScan(scan: StoredTextScan): string[] {
  const lines: string[] = [];
  for (const finding of scan.findings) {
    const counts = new Map<string, number>();
    for (const located of finding.located) {
      const label = `${located.rule} ${describeCodePoint(located.codePoint)}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([label, count]) => `${label} x${count}`);
    lines.push(
      `text:scan: ${finding.table} ${finding.key} revision=${finding.revision}: ${parts.join('; ')}`,
    );
  }
  lines.push(
    `text:scan: scanned=${scan.scanned} revisions_with_characters=${scan.findings.length}`,
  );
  return lines;
}
