# Runbook: the hosted service on Railway

What Railway runs for this project, the variables it needs, and the sequence to rebuild it
after a provider incident. Written from the rebuild of 22 October 2026
(`INCIDENT_RESPONSE.md`, section 7), after the platform incident Railway disclosed on
21 October. Hosting is decision D30: Railway, Hobby plan. No value in this file is a secret,
and no secret is ever pasted into a chat, a commit or an issue; values travel from the place
that minted them to the Railway variable and nowhere else.

## 1. What runs

One project (`cs`), one environment (`production`), two services:

- **dashboard**, built from the repository's `Dockerfile` on every push to `main` (Node 24.21.0
  on Debian bookworm-slim, a frozen-lockfile install, a Turborepo build of the dashboard, the
  dashboard's `start` on port 3000). `railway.json` sets the Dockerfile builder, a pre-deploy
  command that runs the worker's `db migrate` then `db check` so the database is at the commit's
  migration set before any traffic moves, the health check at `/api/healthz` with a 120-second
  timeout, restart on failure at most three times, one replica. Region EU West. The public
  address is the service's Railway domain over https.
- **Postgres**, Railway's managed PostgreSQL with one volume. The dashboard reaches it over
  Railway's private network through a variable reference; no public TCP proxy is enabled on it
  (section 8).

Nothing else is deployed: the weekly pipeline runs from the owner's machine (D37), the MCP
server is not hosted, and no cron service exists.

## 2. The dashboard's variables

| Variable                        | Value                                                                        | Secret |
| ------------------------------- | ---------------------------------------------------------------------------- | ------ |
| `DATABASE_URL`                  | a reference to the Postgres service, chosen from Railway's picker            | yes    |
| `DASHBOARD_ENVIRONMENT`         | `production`                                                                 | no     |
| `DASHBOARD_ACCOUNT_STORE`       | `postgres`                                                                   | no     |
| `DASHBOARD_TRUST_FORWARDED_FOR` | `true` (Railway's edge is a trusted proxy)                                   | no     |
| `DASHBOARD_TRUSTED_PROXY_HOPS`  | `1`                                                                          | no     |
| `DASHBOARD_PUBLIC_URL`          | the service's https origin, no path, no trailing slash                       | no     |
| `AUTH_EMAIL_FROM`               | the sending address Resend verified                                          | no     |
| `RESEND_API_KEY`                | a key minted in Resend's dashboard with sending access                       | yes    |
| `AUTH_OTP_PEPPER`               | 64 hexadecimal characters from `openssl rand -hex 32` on the owner's machine | yes    |

Later units add `ANTHROPIC_API_KEY` (CAS-004) and the three `STRIPE_*` values (CAS-008) once
their code is on `main`; setting them earlier does nothing. The full reference for every name
is `.env.example`.

The database reference is typed by the picker, never by hand: type `${{` in the value field
and choose the service, then `DATABASE_URL`, from the lists Railway shows. A hand-typed name
that differs by one glyph (an upper-case I for a lower-case l, for instance) resolves to an
empty value, and the pre-deploy step then refuses with `DATABASE_URL is not set`.

## 3. Rebuilding after a provider incident

In this order. Each numbered step is one Railway action; Railway stages most of them as
pending changes and applies them on "Deploy Changes", so read the "Details" list before
applying and apply only what the step names.

1. **Wait for Railway's own status to clear.** A deploy during a platform outage can fail at
   build or at the pre-deploy migration and leave the service half-moved.
2. **Discard stray staged changes.** The "Details" view of the pending bar shows them. A TCP
   proxy staged on the dashboard service (port 5432) is one seen in practice: it belongs on no
   service here, and on the dashboard it would open a public port to nothing.
3. **Identify the database.** The Postgres service's "Settings" tab shows its creation date.
   One created before the incident holds the exposed credential and is replaced, not kept.
4. **Create the new database first.** "+ Add", "Database", "PostgreSQL"; apply; wait for
   "Online". The staged list must show the new service and its volume only.
5. **Point the dashboard at it.** `DATABASE_URL` on the dashboard service, through the picker
   (section 2). Apply. The pre-deploy step then migrates the empty database from 0001 to the
   set `main` carries, and the deployment entry reads "ACTIVE". A failure prints a fixed code
   in the deploy log, with no secret in it.
6. **Delete the old database.** Its "Settings" tab, "Delete Service", confirm by name; the
   volume goes with the service (a volume cannot be deleted on its own while its service
   exists; wiping it first is harmless). Apply.
7. **Rotate the secrets.** A new pepper from `openssl rand -hex 32`; a new Resend key, then
   delete the old key in Resend; confirm `DASHBOARD_ENVIRONMENT`, `DASHBOARD_ACCOUNT_STORE`
   and `DASHBOARD_TRUST_FORWARDED_FOR` read as section 2; add the two non-secret names the
   service lacked. One "Deploy Changes" for all of them.
8. **Inspect.** From the Postgres service's "Console" tab (a shell inside the database
   container, where `psql` exists):

   ```bash
   psql "$DATABASE_URL" -c "select rolname, rolsuper, rolcreaterole from pg_roles where rolname not like 'pg_%'" -c "select count(*) as migrations from schema_migrations"
   ```

   Expected: Railway's single `postgres` role, and the migration count `main` carries. The
   superuser role is RR6 of the threat model: the guards bind the application, not that
   credential.

9. **The first account.** From the dashboard service's "Console" tab, inside the running
   container, where the private database address and every variable are already present:

   ```bash
   cd /app/apps/dashboard && node --conditions=react-server dist/cli/account.js invite --email <address> --role admin
   ```

   It prints `account: invited email=… role=… id=…`. Sign in at `<public address>/login` with
   that address; the code arrives from `AUTH_EMAIL_FROM`. The `owner` role exists once CAS-004
   is on `main`.

10. **Record.** A row in `INCIDENT_RESPONSE.md`, section 7, with dates and codes and no value.

## 4. The checks CAS-006 owes the live service

- **The trusted-proxy proof (step 7, the owner's half).** From a second network (mobile data),
  request a sign-in code for one address and enter wrong codes until the request locks; from
  the first network, request one normally. The first network still receives a code when the
  proxy settings key clients apart. Record the date.
- **Backups (step 11).** The required schedule, evidence, and restore drill are in sections
  5–7. As of 23 October 2026, the repository proves the local logical-dump drill; it does not
  prove that any Railway backup switch is on. The owner verifies the Backups tab and records
  the evidence before K21 can close.

## 5. Plan

Hobby, USD 5 a month (D30): one small service and one small database; the volume may grow to
5 GB, roughly nine times the populated local database. The earlier runbook said backups and
point-in-time recovery required Pro. Railway's documentation checked on 23 October 2026 no
longer states that prerequisite and instead describes usage billing. The Railway project UI
and invoice remain authoritative for this account; an owner records any plan change as an
amendment to D30.

## 6. Backup policy, RPO and RTO

The production policy uses three independent recovery layers. Volume snapshots recover a bad
deploy or volume state; point-in-time recovery (PITR) recovers a timestamp between snapshots;
a provider-independent logical dump remains available if the Railway project or its volumes
are deleted. One layer is not a backup policy.

| Layer                             | Required schedule and retention                                                                                       | Recovery point objective                                                                                                 | Recovery time objective                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Railway volume backups            | Daily every 24 hours, retained 6 days; weekly every 7 days, retained 27 days; monthly every 30 days, retained 89 days | 24 hours when PITR is unavailable                                                                                        | 4 hours to restore, verify, and present a cutover decision            |
| Railway PostgreSQL PITR           | Continuous WAL archive; daily differential and weekly full base backups; last 4 full backups, approximately 4 weeks   | 5 minutes while Railway reports the archiver healthy; 24 hours after an archiver fault until the fault is resolved       | 4 hours to create and verify the sibling restore service              |
| Provider-independent logical dump | Daily at 03:00 UTC; encrypted object retention 35 days; one manual dump before every schema migration                 | 24 hours for project or volume deletion; the manual pre-migration dump bounds migration rollback to the migration window | 8 hours to provision PostgreSQL, restore, verify, and prepare cutover |

These are operating objectives, not provider guarantees. A drill falsifies the policy when
the measured recovery point exceeds the applicable RPO, the measured recovery time exceeds
the applicable RTO, any migration is pending or drifting, or any per-table count differs.
Railway currently documents the volume schedules and retention above in its
[volume backup reference](https://docs.railway.com/volumes/backups), and documents the PITR
base-backup cycle and restore behaviour in its
[PostgreSQL backup guide](https://docs.railway.com/guides/postgres-backups-restores).

### Owner-only activation and evidence

1. In the Postgres service's **Backups** tab, enable daily, weekly, and monthly volume
   schedules; record a screenshot or exported settings record that shows all three schedules
   and the date, without a connection string.
2. Enable PITR; wait for the first base backup and the datetime picker; record the earliest and
   latest restorable timestamps and the archiver's healthy state.
3. Configure the daily logical dump to a separately controlled, S3-compatible object store;
   use a database credential restricted to `CONNECT` and `SELECT`, and apply a 35-day object
   lifecycle. Neither credential is stored in this repository.
4. Trigger a manual volume backup before every migration-bearing deployment. Do not apply the
   deployment until that backup reports complete.
5. Run the isolated restore drill in section 7 monthly and after any database engine, provider,
   backup policy, or migration-runner change. Record the backup timestamp, start/end time,
   migration result, table count, and mismatches; never record row contents or credentials.

Hosted activation is a human-owned Railway change. Repository code cannot prove that the
switches are on, and this runbook does not mark them enabled without the evidence in steps
1–2.

### Escalation

- A confirmed loss of the only live copy, a deleted project/volume, or no restorable backup is
  S1: the project owner becomes incident lead within one hour, freezes writes, opens Railway
  support concurrently, and follows `INCIDENT_RESPONSE.md`, Runbook 8.
- A missed scheduled backup, unhealthy PITR archive, restore refusal, migration mismatch, or
  row-count mismatch is S2: freeze schema changes, preserve the failed artefact, notify the
  owner within four hours, and do not cut over.
- Only the owner approves a connection-string swap, source deletion, disclosure, or provider
  escalation. The implementer builds evidence on a scratch target; the auditor reviews that
  evidence independently.

## 7. Isolated logical restore drill

Install PostgreSQL 17 client tools (`pg_dump`, `pg_restore`, `createdb`, and `dropdb`). Reach a
hosted source through `railway connect postgres --tunnel-only` or another owner-approved
read-only path. Create a separate local database whose name begins `cas_restore_`; the script
refuses a remote target, the source database itself, an unsafe target name, or a target schema
that already contains a table.

```bash
createdb --maintenance-db="$LOCAL_POSTGRES_ADMIN_URL" cas_restore_yyyymmdd

BACKUP_SOURCE_DATABASE_URL="$READ_ONLY_SOURCE_URL" \
RESTORE_DATABASE_URL="$LOCAL_RESTORE_URL" \
corepack pnpm db:restore-drill

dropdb --maintenance-db="$LOCAL_POSTGRES_ADMIN_URL" cas_restore_yyyymmdd
```

Keep every value above in the shell or an ignored local environment file; do not paste a URL
into a ticket, log, or transcript. `BACKUP_SOURCE_SCHEMA` defaults to `public`.
`RESTORE_DRILL_TIMEOUT_SECONDS` defaults to 300 and accepts 30–3600.

The command opens the source at `REPEATABLE READ, READ ONLY`, exports that snapshot to
`pg_dump`, restores the custom-format dump to the empty local target in one transaction, and
then checks both databases against the committed migration files. A pass reports the current
migration count, `pending=0`, `drift=0`, and exact source/restored counts for every table. It
does not print a connection string or row contents; its temporary dump and restore list are
removed on both success and failure. The command never drops a schema or database.

Local evidence on 23 October 2026, PostgreSQL client/server 17: a deliberately seeded source
restored in 999 ms; 20 migrations were current, pending and drift were zero, 45 table counts
matched, and `url_groups` reconciled `1` to `1`. A second run against the populated target
refused before restore with `schema is not empty (tables=45)`. This proves the tool and its
overwrite guard locally; it does not prove that a hosted Railway backup exists or restores.

## 8. The public TCP proxy

The database has no public address today. A TCP proxy on the Postgres service gives it one,
protected by the database password alone, reachable from the whole internet; the service that
the incident exposed had one. It is needed only when the owner's machine must reach the
database: the weekly import (CAS-001 step 14) and the manual pipeline runs (D37). Enable it
then, on the Postgres service's "Settings", "Networking", and prefer leaving it off between
runs; the decision is recorded when it is first taken.

## 9. What is never done

- A secret value in a chat, a commit, an issue, a log excerpt or a screenshot. Deploy logs
  print fixed codes for this reason.
- A hand-typed service reference (section 2).
- Railway's "Diagnose" button on a failed deployment: it sends the log to a third-party
  assistant, and the log already names the cause.
- A deploy while Railway's status banner is up.
- A restore over the source database, a remote target, or a target with existing application
  tables.
