import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { summarizeConnection } from './config.js';
import {
  assertRestoreDrillSafety,
  compareTableRowCounts,
  drillChildEnvironment,
  drillTarget,
  parseRestoreDrillTimeout,
} from './restore.js';

describe('restore drill safety', () => {
  it('allows a remote source only when the target is a distinctly named local database', () => {
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://source:secret-marker@db.internal:5432/app',
        'postgresql://localhost:5432/cas_restore_20261023',
      ),
    ).not.toThrow();
  });

  it('refuses a remote restore target without echoing either connection string', () => {
    let caught: unknown;
    const source = 'postgresql://source:source-secret@db.internal/app';
    const target = 'postgresql://restore:target-secret@restore.internal/cas_restore_test';
    try {
      assertRestoreDrillSafety(source, target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(source);
    expect(String(caught)).not.toContain(target);
    expect(String(caught)).not.toContain('source-secret');
    expect(String(caught)).not.toContain('target-secret');
  });

  it('refuses an unsafe target name and the source database itself', () => {
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://localhost:5432/application',
        'postgresql://localhost:5432/scratch',
      ),
    ).toThrow(/must begin with cas_restore_/);
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://127.0.0.1:5432/cas_restore_same',
        'postgresql://localhost:5432/cas_restore_same',
      ),
    ).toThrow(/same database/);
  });
});

describe('restore drill target (the review of pull request 65 at aa6f519, H2)', () => {
  const SOURCE = 'postgresql://source@db.internal:5432/app';

  it('checks the host a host parameter names, never only the authority', () => {
    expect(() =>
      assertRestoreDrillSafety(
        SOURCE,
        'postgresql://u@localhost/cas_restore_probe?host=remote.example',
      ),
    ).toThrow(/only loopback TCP or a local Unix socket/);
    expect(summarizeConnection('postgresql://u@localhost/db?host=remote.example').transport).toBe(
      'remote-tcp',
    );
    // A socket directory in the parameter or the authority is local, whatever the authority says.
    for (const local of [
      'postgresql://u@remote.example/cas_restore_x?host=%2Ftmp',
      'postgresql://u@%2Ftmp/cas_restore_x',
      'postgresql://u@%2Fvar%2Frun%2Fpostgresql/cas_restore_x',
      'postgresql://u@[::1]:5433/cas_restore_x',
      'postgresql://u@127.0.0.1/cas_restore_x',
    ]) {
      expect(() => assertRestoreDrillSafety(SOURCE, local), local).not.toThrow();
    }
  });

  it('refuses every parameter that could route a client elsewhere, and an ambiguous host', () => {
    for (const [url, reason] of [
      ['postgresql://u@localhost/cas_restore_x?port=6543', /unsupported libpq parameter/],
      ['postgresql://u@localhost/cas_restore_x?hostaddr=10.0.0.1', /unsupported libpq parameter/],
      ['postgresql://u@localhost/cas_restore_x?service=prod', /unsupported libpq parameter/],
      ['postgresql://u@localhost/cas_restore_x?passfile=%2Ftmp%2Fp', /unsupported libpq parameter/],
      ['postgresql://u@localhost/cas_restore_x?host=localhost&host=remote.example', /twice/],
      [
        'postgresql://u@localhost/cas_restore_x?host=localhost,remote.example',
        /more than one host/,
      ],
      ['postgresql:///cas_restore_x', /names no host/],
    ] as const) {
      expect(() => assertRestoreDrillSafety(SOURCE, url), url).toThrow(reason);
    }
    // The source is read by the same rule.
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://s@db.internal/app?hostaddr=10.0.0.1',
        'postgresql://u@localhost/cas_restore_x',
      ),
    ).toThrow(/unsupported libpq parameter/);
  });

  it('hands a child tool the target and nothing inherited that routes', () => {
    const inherited = {
      PATH: '/usr/bin',
      HOME: '/home/owner',
      PGHOST: 'remote.example',
      PGHOSTADDR: '10.0.0.1',
      PGPORT: '6543',
      PGDATABASE: 'production',
      PGSERVICE: 'prod',
      PGSERVICEFILE: '/tmp/pg_service.conf',
      PGSYSCONFDIR: '/tmp',
      PGPASSFILE: '/tmp/pgpass',
      PGOPTIONS: '-c search_path=elsewhere',
      PGTARGETSESSIONATTRS: 'read-write',
      RESTORE_DATABASE_URL: 'postgresql://u@localhost/cas_restore_x',
      BACKUP_SOURCE_DATABASE_URL: SOURCE,
      GRAPH_API_KEY: 'not-for-children',
    };
    const target = drillTarget(
      'postgresql://restore:pw@localhost:5433/cas_restore_x?sslmode=disable',
    );
    expect(drillChildEnvironment(target, false, inherited)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/owner',
      PGHOST: 'localhost',
      PGPORT: '5433',
      PGDATABASE: 'cas_restore_x',
      PGUSER: 'restore',
      PGPASSWORD: 'pw',
      PGSSLMODE: 'disable',
    });
    expect(drillChildEnvironment(drillTarget(SOURCE), true, inherited).PGOPTIONS).toBe(
      '-c default_transaction_read_only=on',
    );
  });

  it('gives the Node client and the child tools the same host, port, database and user', () => {
    for (const url of [
      'postgresql://u@localhost/cas_restore_x',
      'postgresql://u@localhost:5433/cas_restore_x?sslmode=disable',
      'postgresql://u@remote.example/cas_restore_x?host=%2Ftmp',
      'postgresql://u@%2Ftmp/cas_restore_x',
      'postgresql://u:p@127.0.0.1/cas_restore_x?application_name=drill',
      'postgresql://source@db.internal:6000/app?sslmode=require',
    ]) {
      // `connectionParameters` is the client's parsed target; it is not in the published types.
      const node = (
        new pg.Client({ connectionString: url }) as unknown as {
          readonly connectionParameters: {
            readonly host: string;
            readonly port: number;
            readonly database: string;
            readonly user: string;
          };
        }
      ).connectionParameters;
      const child = drillChildEnvironment(drillTarget(url), false, {});
      expect([child.PGHOST, child.PGPORT, child.PGDATABASE, child.PGUSER], url).toEqual([
        node.host,
        String(node.port),
        node.database,
        node.user,
      ]);
    }
  });
});

describe('restore verification', () => {
  it('reports missing, additional and changed table counts in table order', () => {
    expect(
      compareTableRowCounts(
        [
          { table: 'beta', rows: '2' },
          { table: 'alpha', rows: '1' },
        ],
        [
          { table: 'alpha', rows: '9' },
          { table: 'gamma', rows: '3' },
        ],
      ),
    ).toEqual([
      { table: 'alpha', source: '1', restored: '9' },
      { table: 'beta', source: '2', restored: null },
      { table: 'gamma', source: null, restored: '3' },
    ]);
  });

  it('bounds the external-tool timeout', () => {
    expect(parseRestoreDrillTimeout(undefined)).toBe(300_000);
    expect(parseRestoreDrillTimeout('30')).toBe(30_000);
    expect(parseRestoreDrillTimeout('3600')).toBe(3_600_000);
    for (const value of ['0', '29', '3601', '1.5', 'word']) {
      expect(() => parseRestoreDrillTimeout(value), value).toThrow(/30 to 3600/);
    }
  });
});
