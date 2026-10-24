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
  migration set before any traffic moves, the readiness check at `/api/readyz` with a 120-second
  platform timeout (the endpoint's database probe is bounded to two seconds), restart on failure
  at most three times, one replica. `/api/healthz` remains the process-liveness check. Region EU West. The public
  address is the service's Railway domain over https.
- **Postgres**, Railway's managed PostgreSQL with one volume. The dashboard reaches it over
  Railway's private network through a variable reference; no public TCP proxy is enabled on it
  (section 6).

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

## 4. The two checks CAS-006 owes the live service

- **The trusted-proxy proof (step 7, the owner's half).** From a second network (mobile data),
  request a sign-in code for one address and enter wrong codes until the request locks; from
  the first network, request one normally. The first network still receives a code when the
  proxy settings key clients apart. Record the date.
- **Backups (step 11).** On Railway, creating backups, scheduling them and point-in-time
  recovery need the Pro plan; Hobby can view and restore backups that already exist. The
  owner's decision of 22 October 2026 defers the upgrade to the launch: the refined dashboard
  opened to the public for reader sign-up and the supporter tier (CAS-007, CAS-008). Until then
  the hosted database has no backup and the weekly copy-ready export is the copy
  (`RISK_REGISTER.md`, K21). Backups are on before the first public account exists; the
  restore-to-scratch check runs then.

## 5. Plan

Hobby, USD 5 a month (D30): one small service and one small database; the volume may grow to
5 GB, roughly nine times the populated local database. Pro (USD 20) is the plan with backups.
A plan change is a change to D30, recorded there.

## 6. The public TCP proxy

The database has no public address today. A TCP proxy on the Postgres service gives it one,
protected by the database password alone, reachable from the whole internet; the service that
the incident exposed had one. It is needed only when the owner's machine must reach the
database: the weekly import (CAS-001 step 14) and the manual pipeline runs (D37). Enable it
then, on the Postgres service's "Settings", "Networking", and prefer leaving it off between
runs; the decision is recorded when it is first taken.

## 7. What is never done

- A secret value in a chat, a commit, an issue, a log excerpt or a screenshot. Deploy logs
  print fixed codes for this reason.
- A hand-typed service reference (section 2).
- Railway's "Diagnose" button on a failed deployment: it sends the log to a third-party
  assistant, and the log already names the cause.
- A deploy while Railway's status banner is up.
