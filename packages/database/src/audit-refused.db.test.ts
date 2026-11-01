import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { appendAuditEvent, listAuditEvents, type AuditEventRow } from './dashboard-auth.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { migrationsUpTo, openIsolatedSchema } from './test-support.js';

const event = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  kind: 'draft_revision_saved',
  outcome: 'failure',
  code: 'markdown_control',
  actorAccountId: null,
  subjectAccountId: null,
  sessionId: null,
  networkKey: null,
  subjectId: null,
  ...overrides,
});

async function sqlState(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return isDatabaseError(error) ? error.code : 'not a database error';
  }
}

describe('migration 0025: a refused save’s audit event records its characters (the D50 amendment of 1 November 2026)', () => {
  it('leaves an existing event without a record, and keeps a refusal’s field and code points in order', async () => {
    const isolated = await openIsolatedSchema();
    const through24 = await migrationsUpTo(24);
    try {
      await runMigrations(isolated.db, { directory: through24.directory });
      const earlier = event({ outcome: 'success', code: 'revision_1' });
      await isolated.db.withClient((c) => appendAuditEvent(c, earlier));
      const applied = await runMigrations(isolated.db);
      expect(applied.applied).toEqual(['0025_audit_refused_characters.sql']);

      const codePoints = [0x202e, 0x0007, 0x202e, 0x009b];
      const refusal = event({ refused: { field: 'markdown', codePoints } });
      await isolated.db.withClient((c) => appendAuditEvent(c, refusal));
      const listed = await isolated.db.withClient((c) => listAuditEvents(c, 10));
      const byId = new Map(listed.map((row) => [row.id, row.refused]));
      expect(byId.get(earlier.id)).toBeNull();
      expect(byId.get(refusal.id)).toEqual({ field: 'markdown', codePoints });
      const raw = await isolated.db.withClient((c) =>
        c.query<{ refused_count: number }>('SELECT refused_count FROM audit_events WHERE id = $1', [
          refusal.id,
        ]),
      );
      expect(raw.rows[0]?.refused_count).toBe(4);

      // The append-only guard of migration 0010 stands over the record.
      expect(
        await sqlState(
          isolated.db.withClient((c) =>
            c.query('UPDATE audit_events SET refused_code_points = $2 WHERE id = $1', [
              refusal.id,
              [0x41],
            ]),
          ),
        ),
      ).toBe('P0001');
    } finally {
      await through24.cleanup();
      await isolated.close();
    }
  });

  it('refuses a record of any other shape, and a record on an event that is not a failure', async () => {
    const isolated = await openIsolatedSchema();
    try {
      await runMigrations(isolated.db);
      const insert = (outcome: string, field: unknown, count: unknown, codePoints: unknown) =>
        isolated.db.withClient((c) =>
          c.query(
            `INSERT INTO audit_events (id, at, kind, outcome, code, refused_field, refused_count,
               refused_code_points)
             VALUES ($1, now(), 'draft_revision_saved', $2, 'markdown_control', $3, $4, $5::integer[])`,
            [randomUUID(), outcome, field, count, codePoints],
          ),
        );
      for (const [outcome, field, count, codePoints] of [
        ['success', 'markdown', 1, [0x202e]],
        ['failure', 'mark down', 1, [0x202e]],
        ['failure', 'Markdown', 1, [0x202e]],
        ['failure', 'markdown', 2, [0x202e]],
        ['failure', 'markdown', 0, []],
        ['failure', 'markdown', 1, [null]],
        ['failure', 'markdown', 1, [-1]],
        ['failure', 'markdown', 1, [0x110000]],
        ['failure', 'markdown', null, [0x202e]],
        ['failure', null, 1, [0x202e]],
        ['failure', 'markdown', 1, null],
        [
          'failure',
          'markdown',
          4,
          [
            [1, 2],
            [3, 4],
          ],
        ],
      ] as const) {
        expect([
          field,
          count,
          codePoints,
          await sqlState(insert(outcome, field, count, codePoints)),
        ]).toEqual([field, count, codePoints, '23514']);
      }
      expect(await sqlState(insert('failure', 'markdown', 2, [0x202e, 0x0007]))).toBeNull();
    } finally {
      await isolated.close();
    }
  });
});
