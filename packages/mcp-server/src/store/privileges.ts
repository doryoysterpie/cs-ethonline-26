import type { Queryable } from '@cas/database';

/**
 * Least privilege, verified at the database.
 *
 * A production start-up must run as a dedicated reader role, and this module
 * is the check that proves it: not "the transaction was declared read-only",
 * which bounds one transaction, but "the credential itself cannot write,
 * create, own or escalate", which bounds every statement the credential could
 * ever send. The check runs on the server's own connection, so it measures the
 * effective role of the session that will do the reading, membership and
 * `SET ROLE` included.
 *
 * Every catalogue function is named by schema (`pg_catalog.`), so a function
 * of the same name in an application schema cannot answer in its place, and
 * every result is a fixed check code with a boolean. No role name, table name
 * or credential leaves this module in an error.
 *
 * The provisioning template `packages/mcp-server/sql/mcp-reader-role.sql`
 * grants exactly what these checks require, and a test holds the two lists
 * together.
 */

/** The application tables the four tools read. SELECT on these, and on nothing else. */
export const REQUIRED_TABLES = [
  'clustering_runs',
  'evidence_review_actions',
  'evidence_runs',
  'graph_signal_runs',
  'graph_signals',
  'incident_clusters',
  'incident_evidence_states',
  'incident_memberships',
  'incident_signal_associations',
  'incident_subjects',
  'source_rows',
] as const;

export const PRIVILEGE_CHECKS = [
  'not_superuser',
  'not_createrole',
  'not_createdb',
  'not_bypassrls',
  'not_replication',
  'database_connect',
  'no_database_create',
  'no_database_temp',
  'schema_usage',
  'no_schema_create',
  'not_schema_owner',
  'not_relation_owner',
  'required_tables_present',
  'select_on_required',
  'no_select_elsewhere',
  'no_table_writes',
  'no_sequence_privileges',
  'no_write_capable_membership',
] as const;
export type PrivilegeCheck = (typeof PRIVILEGE_CHECKS)[number];

export interface PrivilegeReport {
  readonly ok: boolean;
  readonly checks: readonly { readonly code: PrivilegeCheck; readonly ok: boolean }[];
  readonly failed: readonly PrivilegeCheck[];
}

/**
 * One statement answering every check. `$1` is the application schema name,
 * `$2` the required table names. "Write" means INSERT, UPDATE or REFERENCES on
 * any column, or DELETE, TRUNCATE or TRIGGER on the table; `has_*_privilege`
 * already counts privileges inherited through role membership, and the last
 * check covers memberships a `NOINHERIT` role could still assume with
 * `SET ROLE`.
 */
const PRIVILEGE_MATRIX = `
WITH me AS (
  SELECT r.oid, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user
),
app AS (
  SELECT c.oid, c.relname, c.relowner, c.relkind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1::pg_catalog.text
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
schemas AS (
  SELECT n.oid, n.nspname, n.nspowner
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
),
actable AS (
  SELECT r.oid, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
    FROM pg_catalog.pg_roles r, me
   WHERE r.oid <> me.oid AND pg_catalog.pg_has_role(me.oid, r.oid, 'MEMBER')
),
writes(privilege) AS (
  VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
)
SELECT code, ok FROM (
  SELECT 1 AS n, 'not_superuser' AS code, NOT me.rolsuper AS ok FROM me
  UNION ALL SELECT 2, 'not_createrole', NOT me.rolcreaterole FROM me
  UNION ALL SELECT 3, 'not_createdb', NOT me.rolcreatedb FROM me
  UNION ALL SELECT 4, 'not_bypassrls', NOT me.rolbypassrls FROM me
  UNION ALL SELECT 5, 'not_replication', NOT me.rolreplication FROM me
  UNION ALL SELECT 6, 'database_connect',
    pg_catalog.has_database_privilege(me.oid, pg_catalog.current_database(), 'CONNECT') FROM me
  UNION ALL SELECT 7, 'no_database_create',
    NOT pg_catalog.has_database_privilege(me.oid, pg_catalog.current_database(), 'CREATE') FROM me
  UNION ALL SELECT 8, 'no_database_temp',
    NOT pg_catalog.has_database_privilege(me.oid, pg_catalog.current_database(), 'TEMP') FROM me
  UNION ALL SELECT 9, 'schema_usage',
    pg_catalog.has_schema_privilege(me.oid, $1::pg_catalog.text, 'USAGE') FROM me
  UNION ALL SELECT 10, 'no_schema_create', NOT EXISTS (
    SELECT 1 FROM schemas s, me WHERE pg_catalog.has_schema_privilege(me.oid, s.oid, 'CREATE'))
  UNION ALL SELECT 11, 'not_schema_owner', NOT EXISTS (
    SELECT 1 FROM schemas s, me
     WHERE s.nspname = $1::pg_catalog.text AND pg_catalog.pg_has_role(me.oid, s.nspowner, 'MEMBER'))
  UNION ALL SELECT 12, 'not_relation_owner', NOT EXISTS (
    SELECT 1 FROM app, me WHERE pg_catalog.pg_has_role(me.oid, app.relowner, 'MEMBER'))
  UNION ALL SELECT 13, 'required_tables_present',
    (SELECT pg_catalog.count(*) FROM app
      WHERE app.relkind IN ('r', 'p') AND app.relname = ANY ($2::pg_catalog.text[]))
      = pg_catalog.cardinality($2::pg_catalog.text[])
  UNION ALL SELECT 14, 'select_on_required', NOT EXISTS (
    SELECT 1 FROM app, me
     WHERE app.relname = ANY ($2::pg_catalog.text[])
       AND NOT pg_catalog.has_table_privilege(me.oid, app.oid, 'SELECT'))
  UNION ALL SELECT 15, 'no_select_elsewhere', NOT EXISTS (
    SELECT 1 FROM app, me
     WHERE app.relkind <> 'S' AND app.relname <> ALL ($2::pg_catalog.text[])
       AND pg_catalog.has_any_column_privilege(me.oid, app.oid, 'SELECT'))
  UNION ALL SELECT 16, 'no_table_writes', NOT EXISTS (
    SELECT 1 FROM app, me, writes w
     WHERE app.relkind <> 'S'
       AND ((w.privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
             AND pg_catalog.has_any_column_privilege(me.oid, app.oid, w.privilege))
         OR (w.privilege IN ('DELETE', 'TRUNCATE', 'TRIGGER')
             AND pg_catalog.has_table_privilege(me.oid, app.oid, w.privilege))))
  UNION ALL SELECT 17, 'no_sequence_privileges', NOT EXISTS (
    SELECT 1 FROM app, me
     WHERE app.relkind = 'S'
       AND (pg_catalog.has_sequence_privilege(me.oid, app.oid, 'USAGE')
         OR pg_catalog.has_sequence_privilege(me.oid, app.oid, 'UPDATE')))
  UNION ALL SELECT 18, 'no_write_capable_membership', NOT EXISTS (
    SELECT 1 FROM actable a
     WHERE a.rolsuper OR a.rolcreaterole OR a.rolcreatedb OR a.rolbypassrls
        OR pg_catalog.has_database_privilege(a.oid, pg_catalog.current_database(), 'CREATE')
        OR EXISTS (SELECT 1 FROM schemas s WHERE pg_catalog.has_schema_privilege(a.oid, s.oid, 'CREATE'))
        OR EXISTS (SELECT 1 FROM app WHERE pg_catalog.pg_has_role(a.oid, app.relowner, 'MEMBER'))
        OR EXISTS (
          SELECT 1 FROM app, writes w
           WHERE app.relkind <> 'S'
             AND ((w.privilege IN ('INSERT', 'UPDATE', 'REFERENCES')
                   AND pg_catalog.has_any_column_privilege(a.oid, app.oid, w.privilege))
               OR (w.privilege IN ('DELETE', 'TRUNCATE', 'TRIGGER')
                   AND pg_catalog.has_table_privilege(a.oid, app.oid, w.privilege)))))
) checks
ORDER BY n`;

function isCheck(value: unknown): value is PrivilegeCheck {
  return typeof value === 'string' && (PRIVILEGE_CHECKS as readonly string[]).includes(value);
}

/**
 * Runs the matrix on the given connection and reports it. A check the
 * database did not answer counts as failed, so an incomplete answer can never
 * pass.
 */
export async function verifyDatabasePrivileges(
  client: Queryable,
  schema: string,
): Promise<PrivilegeReport> {
  const result = await client.query<{ code: string; ok: boolean | null }>(PRIVILEGE_MATRIX, [
    schema,
    [...REQUIRED_TABLES],
  ]);
  const answered = new Map<PrivilegeCheck, boolean>();
  for (const row of result.rows) {
    if (isCheck(row.code)) answered.set(row.code, row.ok === true);
  }
  const checks = PRIVILEGE_CHECKS.map((code) => ({ code, ok: answered.get(code) === true }));
  const failed = checks.filter((check) => !check.ok).map((check) => check.code);
  return { ok: failed.length === 0, checks, failed };
}
