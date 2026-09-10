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
await isolated.db.end();

const accounts = {
  judge: await syntheticAccount('judge'),
  editor: await syntheticAccount('editor'),
  admin: await syntheticAccount('admin'),
};

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
      accounts: Object.fromEntries(
        Object.entries(accounts).map(([role, account]) => [
          role,
          { username: account.record.username, password: account.password, id: account.record.id },
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
