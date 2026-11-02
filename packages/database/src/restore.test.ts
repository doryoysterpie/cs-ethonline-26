import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { summarizeConnection } from './config.js';
import {
  assertRestoreDrillSafety,
  assertNoAmbientLibpq,
  compareTableRowCounts,
  drillChildEnvironment,
  drillConnectionString,
  drillTarget,
  parseRestoreDrillTimeout,
} from './restore.js';

describe('restore drill safety', () => {
  it('allows a remote source only when the target is a distinctly named local database', () => {
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://source:secret-marker@db.internal:5432/app',
        'postgresql://restore@localhost:5432/cas_restore_20261023',
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
        'postgresql://app@localhost:5432/application',
        'postgresql://restore@localhost:5432/scratch',
      ),
    ).toThrow(/must begin with cas_restore_/);
    expect(() =>
      assertRestoreDrillSafety(
        'postgresql://restore@127.0.0.1:5432/cas_restore_same',
        'postgresql://restore@localhost:5432/cas_restore_same',
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
      ['postgresql://localhost/cas_restore_x', /names no user/],
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

  describe('the Node client and the child tools resolve one target (review of 26dad9d, H2)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    type Parameters = {
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string | null | undefined;
    };
    // `connectionParameters` is the client's parsed target; it is not in the published types.
    const nodeTarget = (connectionString: string): Parameters =>
      (
        new pg.Client({ connectionString }) as unknown as {
          readonly connectionParameters: Parameters;
        }
      ).connectionParameters;

    it('refuses to run while any libpq variable is set, naming the variables, never their values', () => {
      expect(() => assertNoAmbientLibpq({ PATH: '/usr/bin', HOME: '/home/owner' })).not.toThrow();
      for (const name of [
        'PGPORT',
        'PGHOST',
        'PGHOSTADDR',
        'PGUSER',
        'PGPASSWORD',
        'PGPASSFILE',
        'PGSSLMODE',
        'PGSERVICE',
        'PGDATABASE',
        'PGOPTIONS',
      ]) {
        expect(() => assertNoAmbientLibpq({ [name]: 'secret-value' }), name).toThrow(
          new RegExp(`\\(${name}\\)`, 'u'),
        );
      }
      expect(() => assertNoAmbientLibpq({ PGPORT: '6543', PGUSER: 'x' })).toThrow(/PGPORT, PGUSER/);
      expect(() => assertNoAmbientLibpq({ PGPASSWORD: 'secret-value' })).not.toThrow(
        /secret-value/,
      );
    });

    const URLS = [
      'postgresql://u@localhost/cas_restore_x',
      'postgresql://u@localhost:5433/cas_restore_x?sslmode=disable',
      'postgresql://u@remote.example/cas_restore_x?host=%2Ftmp',
      'postgresql://u@%2Ftmp/cas_restore_x',
      'postgresql://u:p@127.0.0.1/cas_restore_x?application_name=drill&options=-c%20x%3Dy',
      'postgresql://u@[::1]:5433/cas_restore_x',
      'postgresql://source:s3cr%40t@db.internal:6000/app?sslmode=require',
    ];

    it('names every routing field explicitly, so no inherited variable can change where the Node client connects', () => {
      // The reviewer's case: the URL names no port, and the parent environment holds another.
      vi.stubEnv('PGPORT', '6543');
      vi.stubEnv('PGHOST', 'remote.example');
      vi.stubEnv('PGUSER', 'someone-else');
      vi.stubEnv('PGDATABASE', 'production');
      for (const url of URLS) {
        const target = drillTarget(url);
        const explicit = drillConnectionString(target);
        const node = nodeTarget(explicit);
        const child = drillChildEnvironment(target, false, {});
        expect([node.host, String(node.port), node.database, node.user], url).toEqual([
          child.PGHOST,
          child.PGPORT,
          child.PGDATABASE,
          child.PGUSER,
        ]);
        // The explicit form reads back to the same target.
        expect(drillTarget(explicit), url).toEqual(target);
      }
    });

    it('gives both the same password in the only environment the drill runs in, one with no libpq variable', () => {
      // A password the URL omits is the one field the explicit form cannot pin: the Node client
      // would take an inherited PGPASSWORD. The drill refuses to run with one set
      // (assertNoAmbientLibpq), so both then read the same password file, or none.
      for (const name of Object.keys(process.env).filter((key) => key.startsWith('PG'))) {
        vi.stubEnv(name, undefined);
      }
      expect(() => assertNoAmbientLibpq(process.env)).not.toThrow();
      for (const url of URLS) {
        const target = drillTarget(url);
        const node = nodeTarget(drillConnectionString(target));
        const child = drillChildEnvironment(target, false, {});
        expect([node.password ?? null, url]).toEqual([child.PGPASSWORD ?? null, url]);
      }
    });
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
