# Parallel Sprint 6 track: dashboard and authentication — handoff for Codex Desktop

Branch `parallel/s6-dashboard-auth`, built from Sprint 5's final commit
`6fad82c3b03325101940d9ca25575d94550e7d25` in an isolated worktree. Decision D27. This track is
**speculative**: it is not merged, not deployed, and not audited. Sprint 5 itself remains
pending Codex Desktop's audit, and the coordination note of 10 September 2026 reserves
migration 0009 for the Sprint 5 correction and pauses every authentication migration.

**No account has been provisioned. Nothing has been deployed. No migration was created.**

## 1. What the coordination note changed

The original brief reserved migration `0009_dashboard_auth.sql` and asked for account
provisioning into PostgreSQL. The coordination note that followed reserves 0009 for the Sprint 5
correction, pauses authentication migrations and persistent account seeding, and permits the
speculative UI, route structure, role interface and tests that do not depend on database
persistence. This track follows the note:

- **No 0009 file was created, renamed, committed or pushed by this track.** The main clone
  (`~/cs-ethonline-26`, another session's working directory) holds an untracked
  `packages/database/migrations/0009_evidence_integrity.sql` (SHA-256
  `b553eac744dedfed97e5eb247d0f82781daeb03455fba7a34203caca1cdec13a`, 14,612 bytes, observed
  at 04:46 local on 10 September) alongside uncommitted edits to `packages/database/src/evidence.ts`,
  `index.ts`, `migrate.test.ts`, `migrate.db.test.ts` and `schema-security.db.test.ts`. That is
  the Sprint 5 correction's work. It was neither touched nor read into this track.
- **Account, session, audit, draft-revision and queue-decision persistence is paused.** The
  store interfaces exist (`apps/dashboard/src/server/auth/store.ts`) with one in-memory
  implementation permitted only in the `local` environment. Selecting the `postgres` store fails
  with one fixed message. The PostgreSQL implementation and its migration are allocated after
  Sprint 5's accepted SHA is integrated and the next migration number is known.
- **Everything else the brief asked for is built and tested**: sessions, roles, the server-only
  data-access layer, the seven views, the mutations, the provisioning command, the browser
  controls, and the test surface. Reads and the four editorial mutations use the tables that
  exist at the base SHA through `@cas/database` and the worker's audited APIs.

## 2. Interpretation choices Codex should contest

1. **"Forced rotation"** in the note is read as: the three named accounts receive replacement
   passwords through the one-time command (a `--rotate` path replaces an existing hash and
   revokes every session of the account), and every sign-in and privilege change rotates the
   session token. It is _not_ read as a self-service change-password flow on first sign-in;
   none exists, and the brief excludes self-registration and recovery. If a first-sign-in
   password change was intended, it is a bounded addition to the session service and one page.
2. **The judge's "sanitized" incident view** carries identifiers, kind, member count, reason
   codes, decision, posting instant, data origin and the recorded subject, and no title,
   summary, publisher or URL. The draft preview, which the brief grants to a judge, does show the
   deterministic draft's headlines because the draft is made of them.
3. **The queue decision is a dashboard-only record.** A source row may hold exactly one
   `review_entries` row (unique on `source_row_id`, from the weekly snapshot import), so a
   dashboard `ReviewState` cannot be written into the weekly tables without a schema change. It
   is an append-only record in the dashboard's own store, with actor, reason code and note; that
   store is the paused persistence above.
4. **Draft-mode handlers and cache-invalidation handlers do not exist.** The brief lists them
   among surfaces to protect independently; the app has none, uses no Next draft mode and no
   `revalidatePath`, `revalidateTag` or `unstable_cache`, and `apps/dashboard/src/hygiene.test.ts`
   fails if any appears. Adding one later must go through the data-access layer.
5. **`@cas/dashboard` depends on `@cas/worker`.** The audited human review layer (merge, split,
   evidence decision, effective view, anomaly feed, draft assembly) lives in the worker
   application; duplicating it would fork audited code. The worker's manifest gains `main`,
   `exports` and re-exports; `ARCHITECTURE.md` section 5 did not foresee an application composing
   another application's functions.
6. **The two Node-only workspace packages are loaded at run time**, not bundled
   (`apps/dashboard/src/server/packages.ts`). Next bundles every workspace package regardless of
   `serverExternalPackages` (`handle-externals.js` externalizes only paths under
   `node_modules`), and `@cas/database` resolves its migration directory from `import.meta.url`,
   which a bundle cannot preserve. The bundler-ignore markers are the documented escape hatch.
7. **`argon2`'s install script is refused** (`allowBuilds: argon2: false`). The package ships
   prebuilt binaries for darwin-arm64 and linux-x64, loaded by `node-gyp-build` at require time,
   so no install-time code from the package runs.
8. **Continuous integration did not run.** `.github/workflows/ci.yml` triggers on `main` and
   `sprint-*/**` only, and the workflow was not changed. Every check below ran locally, and the
   clean-checkout reproduction in section 8 is the substitute.

## 3. Design

Read `docs/DECISIONS.md` D27 and `docs/SECURITY.md` section 15 first. The mechanism, by
file:

| Concern                | Where                                                                                         | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Roles and capabilities | `src/server/auth/roles.ts`                                                                    | Three roles, fifteen capabilities, each role's set written out; `can()` denies anything unlisted                                                                                                                                                                                                                                                                                                                 |
| Authorization boundary | `src/server/dal/guard.ts`, `read.ts`, `mutate.ts`                                             | Every function: `requireCapability` → validate identifiers → read under the owning run → DTO; source text selected as `NULL` for a principal without `view:source_text`                                                                                                                                                                                                                                          |
| Principal resolution   | `src/server/dal/principal.ts`                                                                 | Cookie → session service; pages, actions and handlers all end here; the proxy is never consulted                                                                                                                                                                                                                                                                                                                 |
| Sessions               | `src/server/auth/session.ts`                                                                  | 32 CSPRNG bytes, SHA-256 stored; sign-in always issues a new token and closes a presented live session; absolute 8 h, idle 30 min; logout, account-wide revocation, rotation; disabled or expired account ends sessions on the next request; generic failures; throttle; verifier gate; dummy hash                                                                                                               |
| Passwords              | `src/server/auth/password.ts`                                                                 | Argon2id m=19456, t=2, p=1, 32-byte tag, 16-byte fresh salt from the library; NFKC; 12 to 128 code points; no control characters; not containing the username; verification only within a ceiling (m ≤ 65536, t ≤ 4, p ≤ 2)                                                                                                                                                                                      |
| Throttle               | `src/server/auth/rate-limit.ts`                                                               | 5 failures per submitted username per 15 min; 30 attempts per network source per 15 min; bounded key set                                                                                                                                                                                                                                                                                                         |
| Cookie                 | `src/server/auth/cookie.ts`                                                                   | `cas_session` in `local`; `__Host-cas_session` + `Secure` otherwise; `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`                                                                                                                                                                                                                                                                                        |
| CSRF                   | `src/server/auth/csrf.ts`                                                                     | `Sec-Fetch-Site` must be `same-origin` if present, `Origin` must equal the host if present, neither present is refused; plus HMAC-SHA256(session token, purpose) in every form and `x-csrf-token` in every handler, constant-time compared                                                                                                                                                                       |
| Headers                | `src/server/http/headers.ts`, `src/proxy.ts`                                                  | Nonce-based CSP (`default-src 'none'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self'`, `img-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'self'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, permissions policy, COOP/CORP, HSTS only in `production`, `Cache-Control: private, no-store` on every proxied response |
| Input                  | `src/server/input.ts`                                                                         | Closed objects (unknown, repeated, symbol and accessor keys and foreign prototypes refused); UUID, enum, bounded text, integer, strict UTC instant, bounded UUID list; Next's `$ACTION_*` bookkeeping fields are the one skipped prefix                                                                                                                                                                          |
| Hostile text           | `src/server/display.ts`, `src/server/markdown/sanitize.ts`, `src/components/SafeMarkdown.tsx` | Controls, separators and bidi controls shown as escapes; Markdown → mdast → hast → allowlist sanitizer → React elements; `http`/`https` only; no images; `rel="noopener noreferrer nofollow"`                                                                                                                                                                                                                    |
| Stores                 | `src/server/auth/store.ts`, `memory-store.ts`, `stores.ts`                                    | Interfaces; memory implementation with a mode-600 seed file for accounts only; `postgres` refused with `PERSISTENCE_PAUSED_MESSAGE`                                                                                                                                                                                                                                                                              |
| Provisioning           | `src/cli/provision.ts`                                                                        | TTY-only no-echo read, twice; validate; hash; store; `--rotate`; exit 0/2/5; the password never reaches an argument, file, log or output                                                                                                                                                                                                                                                                         |
| Reads                  | `packages/database/src/dashboard.ts`                                                          | Bounded, parameterized, `withText` selects `NULL` when false, object reads joined on run and id                                                                                                                                                                                                                                                                                                                  |

Pages: `/login`, `/command-center`, `/queue`, `/queue/[classificationRunId]`, `/incidents`,
`/incidents/[clusteringRunId]`, `/incidents/[clusteringRunId]/[incidentId]`, `/evidence`,
`/evidence/[evidenceRunId]`, `/anomaly`, `/anomaly/[signalRunId]`, `/drafts`,
`/drafts/[evidenceRunId]?start&end`, `/admin/accounts`. Handlers: `GET /api/me`, `POST
/api/logout`. Server actions: sign-in, sign-out, queue review, merge, split, evidence decision,
draft save, provision, disable, assign role, set expiry, revoke sessions. Every page is
`force-dynamic`; a refused page answers 403 through `forbidden()`.

Every view labels `DataOrigin` on every run and record. The evidence view keeps three fixed
limitation sentences visible; the anomaly view prints each entry's limitation; the draft view
states that nothing is model-generated, every claim is `reported`, every name is withheld, and
contradicted incidents are counted.

## 4. Dependencies (all exact, all older than the 24-hour gate at install time)

| Package                                                                                                           | Version                            | Why                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `next`                                                                                                            | 16.3.4                             | the framework Plan 2.0 fixes                                                         |
| `react`, `react-dom`                                                                                              | 19.2.8                             | Next's peer; 19.3.0 was 15 hours old                                                 |
| `@types/react`, `@types/react-dom`                                                                                | 19.2.18, 19.2.7                    | types                                                                                |
| `argon2`                                                                                                          | 0.45.1                             | Argon2id reference-implementation binding; install script refused                    |
| `server-only`                                                                                                     | 0.0.1                              | build-time guard on server modules                                                   |
| `mdast-util-from-markdown`, `mdast-util-to-hast`, `hast-util-sanitize`, `hast-util-to-jsx-runtime`, `@types/hast` | 2.0.3, 13.2.1, 5.0.2, 2.3.6, 3.0.5 | Markdown to sanitized React elements without an HTML string                          |
| `@playwright/test`                                                                                                | 1.63.0                             | browser suite; Chromium 153 (build 1243) downloaded by `playwright install chromium` |

No schema library was added: closed-object validation follows the repository's own pattern.
`pnpm audit` and `pnpm audit --prod`: no known vulnerabilities.

## 5. Files

Added: `apps/dashboard/**` (Next app, server tree, command, tests), `packages/database/src/dashboard.ts`
and its `dashboard.db.test.ts`, `docs/SPRINT-6-DASHBOARD-AUTH-HANDOFF.md`. Changed:
`pnpm-workspace.yaml` (catalog entries, `allowBuilds`), `pnpm-lock.yaml`, `package.json`
(`test:db`), `eslint.config.js` (ignore `.next/`), `.gitignore`, `.env.example`,
`apps/worker/package.json` (`main`, `exports`), `apps/worker/src/index.ts` (re-exports only),
`packages/database/src/index.ts` (exports only), `docs/DECISIONS.md` (D27 appended),
`docs/SECURITY.md` (section 15 appended), `docs/ARCHITECTURE.md` (one table cell), `README.md`
(one section). Deleted: the Sprint 0 placeholder `apps/dashboard/src/index.ts` and
`apps/dashboard/tsconfig.build.json`, replaced by the application. No migration file was added
or changed. No audited source file of any package was modified.

## 6. Tests

Offline (`pnpm test`, no database, no network): the dashboard adds **75** tests in 17 files
under `apps/dashboard/src`; every other package's count is unchanged from Sprint 5.

| Area                           | File                                                                                       | What it pins                                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Roles                          | `auth/roles.test.ts`                                                                       | the full matrix; deny by default; every mutation refused to a judge; every admin capability refused to an editor                                                                                                                     |
| Passwords                      | `auth/password.test.ts`                                                                    | policy, code points, NFKC, PHC parameters, fresh salts, ceiling, garbage hashes, dummy hash, verifier gate                                                                                                                           |
| Tokens                         | `auth/tokens.test.ts`                                                                      | shape, entropy, hash, CSRF derivation, constant-time compare                                                                                                                                                                         |
| Sessions                       | `auth/session.test.ts`                                                                     | fixation, rotation, idle and absolute expiry, logout replay, account-wide revocation, disable and judge expiry, throttle by account and network, generic failures, no unknown username in audit, verifier saturation, touch interval |
| Throttle                       | `auth/rate-limit.test.ts`                                                                  | limits, existing vs unknown parity, window                                                                                                                                                                                           |
| Cookie, CSRF, headers, network | `auth/cookie.test.ts`, `auth/csrf.test.ts`, `http/headers.test.ts`, `http/network.test.ts` | attributes per environment, every refusal code, policy content, forwarded-for trust                                                                                                                                                  |
| Input                          | `input.test.ts`                                                                            | closed objects, framework fields, every parser                                                                                                                                                                                       |
| Display and Markdown           | `display.test.ts`, `markdown/sanitize.test.ts`                                             | escapes, truncation; script, img, svg, iframe, handlers, `javascript:`, `data:`, `vbscript:` links, code blocks, bidi                                                                                                                |
| Stores                         | `auth/memory-store.test.ts`                                                                | seed validation, mode 600, duplicates, append-only, revision conflicts                                                                                                                                                               |
| Configuration                  | `config.test.ts`                                                                           | every rule; `postgres` store paused message                                                                                                                                                                                          |
| Data-access authorization      | `dal/authorization.test.ts`                                                                | with a database handle that throws on use: every read and mutation refused without a session; every mutation refused to a judge; every admin function refused to an editor; validation before any store; account rules               |
| Hygiene                        | `hygiene.test.ts`                                                                          | no HTML-from-string, no draft mode, no invalidation, no inline style or handler, no client component, `server-only` on every impure server module, proxy free of the database, no invisible character                                |

PostgreSQL (`pnpm test:db`): `@cas/database` **90** (81 from Sprint 5 plus 9 for the dashboard
reads), `@cas/worker` **92** (unchanged), `@cas/dashboard` **11** (`dal/dal.db.test.ts`, seeded
by the real pipeline with a hostile title): source text withheld from a judge and returned to
an editor; identifier from another run reads nothing; queue derived for an editor only and a
decision refused outside the queue; merge recorded, replayed and refused when stale; split
recorded; evidence decided by an editor, refused to a judge, rationale hidden from a judge;
anomaly feed with limitations; draft preview and revisions under optimistic concurrency; every
machine table fingerprinted before and after and required equal; direct `UPDATE`/`DELETE`
against clusters, review actions, decisions and associations refused by the schema's guards.

Browser (`pnpm --filter @cas/dashboard test:browser`, production build, Chromium): **20** tests
in five files: sign-in failures generic; cookie attributes; direct route access refused and
served; sign-out revocation and replay; forged cookie; second sign-in; judge sees no queue,
administration, source text or mutation form and gets 403 pages; editor reviews and saves a
draft through the real form; administrator provisions, disables and revokes through the page
and the disabled account's session dies at once; cross-user cache separation on the same URL
with `no-store`; strict CSP and baseline headers on every response and no HSTS in `local`; no
CSP violation and every script carries the nonce; no browser source map and no secret-shaped
string in the client bundle; rendered pages carry no hash, connection string, token or
password for any role; `/api/logout` refuses cross-site, foreign origin, ambient, missing and
wrong tokens and accepts the right one; a foreign-origin post to a server action changes
nothing; the hostile stored title renders as escaped text with no image, script or link; a
hostile draft edit renders with no executable element and only `https` links; a bidirectional
override in a draft body is refused before storage.

Result on this machine (10 September 2026, Chromium 153 headless shell, production build):
**20 passed, 0 failed**, the isolated schema dropped and the seed and credential files deleted
by the teardown. Two earlier runs failed and were fixed before this one: the closed-object
reader refused Next's own `$ACTION_ID` form fields (now the one skipped prefix, pinned by a
unit test), and the runtime singleton lived in module scope, so route handlers saw an empty
session store (now anchored on `globalThis` under a registered symbol, which the `/api/me`
and `/api/logout` tests exercise).

## 7. Verification, in order, on this machine

```
corepack pnpm install --frozen-lockfile
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit
set -a && . ./.env && set +a
corepack pnpm test:db
corepack pnpm --filter @cas/dashboard test:browser
git diff --check
```

Result on this machine (10 September 2026): every step passed. `format:check` clean; `lint`
clean; `typecheck` 22 tasks; `test` 18 tasks, **559** offline tests (taxonomy 7, contracts 9,
database 24, classification 56, clustering 50, evidence 69, drafting 19, graph-evidence 102,
worker 148, dashboard 75); `build` 14 tasks including the production Next build; `audit` no
known vulnerabilities for all and for production dependencies; `test:db` **193** tests
(database 90, worker 92, dashboard 11); browser suite **20** passed; `git diff --check` clean.
Every count is copied from the runner's own summary lines.

## 8. Reproduction for Codex Desktop

From a clean clone of `parallel/s6-dashboard-auth` with Node 24, pnpm 11.10.0, a local
PostgreSQL 17 and `DATABASE_URL` naming an empty database:

```
corepack pnpm install --frozen-lockfile
corepack pnpm verify
set -a && . ./.env && set +a
corepack pnpm test:db
corepack pnpm --filter @cas/dashboard exec playwright install chromium
corepack pnpm --filter @cas/dashboard test:browser
```

To run the dashboard by hand against a migrated database (nothing is provisioned; the
memory store starts empty):

```
DASHBOARD_ENVIRONMENT=local DASHBOARD_ACCOUNT_STORE=memory \
DASHBOARD_MEMORY_STORE_SEED=/absolute/path/outside/the/repo/seed.json \
corepack pnpm --filter @cas/dashboard provision --username syn_demo --role editor
corepack pnpm --filter @cas/dashboard build
DASHBOARD_ENVIRONMENT=local DASHBOARD_ACCOUNT_STORE=memory \
DASHBOARD_MEMORY_STORE_SEED=/absolute/path/outside/the/repo/seed.json \
corepack pnpm --filter @cas/dashboard start
```

The reproduction from a clean clone was run after the commits below landed, and its result is
recorded in the final commit of the branch (`docs: record the clean-checkout reproduction`).

## 9. What is deliberately not done, and why

- **The PostgreSQL store, its migration and any provisioning of `ethglobal26`, `latestincyber`
  or `admin`**: paused by the coordination note. The migration will follow the 0005 pattern
  (`pg_catalog.format`, `%1$I`, `SET search_path = pg_catalog, <schema>, pg_temp`, never
  `SECURITY DEFINER`, every relation schema-qualified), with append-only guards on sessions,
  audit events, draft revisions and queue decisions, a CHECK that a judge row carries an expiry,
  and a direct-SQL bypass test, once its number is allocated.
- **MCP, Google Sheets, Hedera, Bazantic, production deployment**: excluded by the brief.
- **Recording an incident subject or a claim from the dashboard**: not in the brief; the worker
  command line remains the only writer.
- **A self-service password change**: see section 2, item 1.
- **Multi-process throttle and audit**: the throttle and the audit store are process-local
  until the PostgreSQL store exists; a deployment with several processes would share neither.
- **`SPRINT_BOARD.md`**: untouched; the Sprint 6 row still reads NOT STARTED because this track
  is speculative and the board is the owner's record.

## 10. Known limitations and risks for the audit

- The proxy's early redirect looks only at cookie presence; a request with any cookie value
  reaches the page, which then refuses it through the session service. That is by design and
  is tested, but the proxy must never be read as a control.
- Network-source throttling is `direct` unless `DASHBOARD_TRUST_FORWARDED_FOR=true` behind a
  proxy that sets `X-Forwarded-For`; Next exposes no peer address to a route handler.
- The generated draft (revision 0) is recomputed on every view from the evidence run; a human
  revision is stored whole. Revisions live in the paused store.
- `listClassificationRuns` in `@cas/database` is unbounded (a Sprint 3 read); the command
  center slices it to the newest 25 after the fact. A bounded variant belongs with the paused
  migration work rather than in a change to an audited file.
- The judge's draft preview shows headlines, which are stored text. If the judge must not see
  even those, the draft preview capability should be withdrawn from the role table in one line.

**Dashboard/authentication track remains pending until Codex Desktop issues PASS.**

**No account has been provisioned and nothing has been deployed.**
