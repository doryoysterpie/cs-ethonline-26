// Browser-test launcher. Run by Playwright's webServer under
// `node --conditions=react-server` so the compiled server tree (which carries
// the `server-only` marker) can be imported outside Next.
//
// Steps: migrate an isolated schema and seed it through the real pipeline,
// write a memory-store seed holding Argon2id hashes of three synthetic
// accounts, write the synthetic credentials for the specs to a mode-600 file
// under test-results, then start `next start`. The global teardown drops the
// schema and deletes both files. Nothing here is a real account.
import { spawn } from 'node:child_process';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMigratedSchema } from '../../dist/test/isolated-schema.js';
import { seedPipeline } from '../../dist/test/seed-pipeline.js';
import { syntheticAccount } from '../../dist/test/synthetic-accounts.js';
import { SEED_FORMAT } from '../../dist/server/auth/memory-store.js';

/**
 * CAS-009: one published round-up of three stories and one story card,
 * through the real data-access layer on PostgreSQL stores (a card names its
 * maker as an account row, which the memory store the browser signs in
 * through does not hold). The model is a recorded answer; nothing is fetched.
 */
async function seedPublishedCard(schema) {
  const { randomUUID } = await import('node:crypto');
  const { openPostgresStores } = await import('../../dist/server/auth/postgres-store.js');
  const { createRuntime } = await import('../../dist/server/runtime.js');
  const { generateRoundup, selectStory } = await import('../../dist/server/dal/mutate.js');
  const { weekTable } = await import('../../dist/server/dal/read.js');
  const { publishOutput } = await import('../../dist/server/dal/readers.js');
  const { makeCard } = await import('../../dist/server/dal/cards.js');
  const { seedLargeWeek } = await import('../../dist/test/seed-pipeline.js');
  const { insertSynthetic } = await import('../../dist/test/synthetic-accounts.js');
  const { loadTemplate, sectionOf } = await import('@cas/roundup');
  const loaded = await loadTemplate();
  const marker = sectionOf(loaded.template, 'extras').marker ?? '';
  const stores = openPostgresStores(schema.db);
  const runtime = createRuntime(
    {
      environment: 'local',
      accountStore: 'memory',
      memorySeedPath: null,
      databaseSchema: schema.name,
      trustForwardedFor: false,
      trustedProxyHops: 1,
      buildCommit: null,
    },
    stores,
    schema.db,
    {
      model: {
        async generate(request) {
          const seen = JSON.parse(request.user);
          return {
            raw: {
              rundown: seen.incidents.map((incident, i) => ({
                headline: `Card headline ${i + 1}`,
                summary: 'A summary the card never carries.',
                sources: incident.rows.map((row) => row.url),
                citations: incident.rows.map((row) => row.sourceRowId),
              })),
              extras: marker,
            },
            usage: { inputTokens: 10, outputTokens: 10 },
            model: request.model,
          };
        },
      },
    },
  );
  const account = await syntheticAccount('owner');
  await insertSynthetic(stores, account);
  // A session row for the principal: audit events name their session.
  const sessionId = randomUUID();
  await stores.sessions.insert({
    id: sessionId,
    accountId: account.record.id,
    tokenHash: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
    revokedReason: null,
  });
  const owner = {
    accountId: account.record.id,
    username: account.record.username,
    normalizedEmail: null,
    role: 'owner',
    sessionId,
    sessionToken: 'c'.repeat(43),
  };
  const week = await seedLargeWeek(schema.db, 3, 1);
  const table = await weekTable(
    runtime,
    owner,
    week.weekRunId,
    'cyberattack',
    undefined,
    undefined,
  );
  for (const row of table.rows) {
    await selectStory(runtime, owner, {
      weekRunId: week.weekRunId,
      clusteringRunId: row.clusteringRunId,
      incidentId: row.incidentId,
      state: 'selected',
      note: null,
    });
  }
  await generateRoundup(runtime, owner, {
    weekRunId: week.weekRunId,
    category: 'cyberattack',
    expectedTemplateHash: loaded.hash,
  });
  await publishOutput(runtime, owner, {
    weekRunId: week.weekRunId,
    category: 'cyberattack',
    output: 'roundup',
    revision: 1,
  });
  const { id } = await makeCard(runtime, owner, {
    weekRunId: week.weekRunId,
    category: 'cyberattack',
    output: 'roundup',
    entryIndex: 0,
  });
  return { roundup: id, weekRunId: week.weekRunId };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const output = path.join(appRoot, 'test-results', 'browser');
const seedPath = path.join(output, 'seed.json');
const credentialsPath = path.join(output, 'credentials.json');
const port = process.env.BROWSER_PORT ?? '3419';

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.trim() === '') {
  process.stderr.write('browser tests need DATABASE_URL\n');
  process.exit(2);
}

const isolated = await openMigratedSchema();
const seeded = await seedPipeline(isolated.db);
const cards = await seedPublishedCard(isolated);
await isolated.db.end();

// Each account carries a synthetic address on the reserved `.test` domain, so
// the specs sign in by one-time code: the memory store's local email path
// appends every message to a mode-600 file under test-results (CAS-010).
const accounts = {
  reader: await syntheticAccount('reader', { email: 'reader@dashboard.test' }),
  editor: await syntheticAccount('editor', { email: 'editor@dashboard.test' }),
  admin: await syntheticAccount('admin', { email: 'admin@dashboard.test' }),
};
const emailPath = path.join(output, 'email.jsonl');

await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(
  seedPath,
  JSON.stringify(
    { format: SEED_FORMAT, accounts: Object.values(accounts).map((account) => account.record) },
    null,
    2,
  ),
  { encoding: 'utf8', mode: 0o600 },
);
await writeFile(
  credentialsPath,
  JSON.stringify(
    {
      schema: isolated.name,
      seeded,
      cards,
      accounts: Object.fromEntries(
        Object.entries(accounts).map(([role, account]) => [
          role,
          {
            username: account.record.username,
            password: account.password,
            id: account.record.id,
            email: account.record.normalizedEmail,
          },
        ]),
      ),
    },
    null,
    2,
  ),
  { encoding: 'utf8', mode: 0o600 },
);

const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: '1',
  DASHBOARD_ENVIRONMENT: 'local',
  DASHBOARD_ACCOUNT_STORE: 'memory',
  DASHBOARD_MEMORY_STORE_SEED: seedPath,
  DASHBOARD_DATABASE_SCHEMA: isolated.name,
  DASHBOARD_TRUST_FORWARDED_FOR: 'false',
  DASHBOARD_LOCAL_EMAIL_FILE: emailPath,
  // The public address the card's preview tags name (CAS-009); nothing is fetched from it.
  DASHBOARD_PUBLIC_URL: 'https://dashboard.example.org',
  PORT: port,
};
delete env.NODE_OPTIONS;

const child = spawn(
  path.join(appRoot, 'node_modules', '.bin', 'next'),
  ['start', '-p', port, '-H', '127.0.0.1'],
  {
    cwd: appRoot,
    env,
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => {
  process.exit(code ?? 0);
});
