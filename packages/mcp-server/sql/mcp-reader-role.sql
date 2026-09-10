-- CAS Chainwatch MCP server: the least-privilege reader role.
--
-- Administrator template. It holds no password and no secret, and it is not
-- an application migration: it creates a cluster-wide login role and changes
-- two database-wide defaults, both of which are an administrator's decision
-- to take, and it is applied by an administrator, not by the migration
-- runner.
--
-- Run it as a superuser or as the owner of the application schema, connected
-- to the application database:
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/mcp-server/sql/mcp-reader-role.sql
--
-- The role name defaults to cas_mcp_reader and the schema to public. To choose
-- others, set two session settings first, on the same connection:
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SET cas.mcp_role = 'cas_mcp_reader'" -c "SET cas.mcp_schema = 'public'" \
--     -f packages/mcp-server/sql/mcp-reader-role.sql
--
-- Then set the role's password interactively, never on a command line, in a
-- file, in a repository or in shell history:
--
--   psql "$ADMIN_DATABASE_URL" -c '\password cas_mcp_reader'
--
-- and verify from the server's own credential, whose DATABASE_URL names that
-- role and carries the password only through the host's secret store:
--
--   corepack pnpm mcp:verify-role
--
-- What the role gets: LOGIN; CONNECT on this database; USAGE on the
-- application schema; SELECT on exactly the eleven tables the four tools
-- read. What it does not get: superuser, CREATEROLE, CREATEDB, REPLICATION or
-- BYPASSRLS; CREATE or TEMP on the database; CREATE on any schema; any
-- privilege on any other table or sequence; any role membership. It is
-- NOINHERIT, so even a membership granted later by mistake confers nothing
-- without SET ROLE, and the server refuses a write-capable membership either
-- way.
--
-- Two revocations apply to PUBLIC, that is, to every role of this database:
-- TEMP on the database and CREATE on the public schema, both of which
-- PostgreSQL grants to everyone by default (the schema default already
-- changed in PostgreSQL 15). Privileges are additive, so the reader role can
-- only lack them if PUBLIC lacks them. Grant TEMP or CREATE back explicitly
-- to any application role that needs it.
--
-- Rerunning the template converges on the same state. The table list below
-- is held equal to REQUIRED_TABLES in src/store/privileges.ts by a test.

DO $provision$
DECLARE
  role_name text := coalesce(
    nullif(pg_catalog.current_setting('cas.mcp_role', true), ''), 'cas_mcp_reader');
  schema_name text := coalesce(
    nullif(pg_catalog.current_setting('cas.mcp_schema', true), ''), 'public');
  required text[] := ARRAY[
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
    'source_rows'
  ];
  relation text;
  membership text;
BEGIN
  IF role_name !~ '^[a-z_][a-z0-9_]{0,62}$' OR schema_name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'cas.mcp_role and cas.mcp_schema must be plain lowercase identifiers'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = schema_name) THEN
    RAISE EXCEPTION 'schema % does not exist; apply the migrations first', schema_name
      USING ERRCODE = 'raise_exception';
  END IF;
  FOREACH relation IN ARRAY required LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', schema_name, relation)) IS NULL THEN
      RAISE EXCEPTION 'required table %.% does not exist; apply the migrations first',
        schema_name, relation USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- 1. The login role, without a password. Every attribute that could widen
  --    it is refused explicitly, on creation and on every rerun.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
    EXECUTE pg_catalog.format(
      'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      role_name);
  ELSE
    EXECUTE pg_catalog.format(
      'ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
      role_name);
  END IF;

  -- 2. No membership in any other role.
  FOR membership IN
    SELECT g.rolname
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
      JOIN pg_catalog.pg_roles r ON r.oid = m.member
     WHERE r.rolname = role_name
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM %I', membership, role_name);
  END LOOP;

  -- 3. Database-wide defaults that would otherwise reach the role through PUBLIC.
  EXECUTE pg_catalog.format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';

  -- 4. Exactly what the four tools need, after clearing anything else the
  --    role may have been granted on this database and schema.
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
    pg_catalog.current_database(), role_name);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO %I',
    pg_catalog.current_database(), role_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM %I',
    schema_name, role_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM %I',
    schema_name, role_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM %I',
    schema_name, role_name);
  EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM %I', schema_name, role_name);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, role_name);
  FOREACH relation IN ARRAY required LOOP
    EXECUTE pg_catalog.format('GRANT SELECT ON TABLE %I.%I TO %I', schema_name, relation, role_name);
  END LOOP;

  RAISE NOTICE 'reader role % provisioned on schema %: set its password interactively, then run corepack pnpm mcp:verify-role',
    role_name, schema_name;
END
$provision$;
