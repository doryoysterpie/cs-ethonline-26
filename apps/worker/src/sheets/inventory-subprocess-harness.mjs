// A genuine, separate Node process driving the compiled CLI's `sheets
// inventory` path end to end against a faked Google, with no vitest process
// around it to keep the event loop alive on this harness's behalf.
//
// That separateness is the point. `packages/sheets-intake/src/transport.ts`
// used to `.unref()` its retry-delay timer, which is invisible to an
// in-process test: the vitest worker process has its own sockets and
// handles open regardless, so the timer firing or not firing never changed
// whether *that* process exited. This harness has no other work. If the
// awaited call below never settles, this process exits on its own (Node's
// "unsettled top-level await" diagnostic, non-zero) instead of hanging, and
// none of the expected output is printed — the exact, observable shape of
// the bug this regression guards against.
//
// Every credential, key, identifier and workbook fixture here is invented
// synthetic material generated in this process and discarded with it.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const SHEETS_INTAKE_DIST = fileURLToPath(
  new URL('../../../../packages/sheets-intake/dist/index.js', import.meta.url),
);

/**
 * - 'success-after-retry': the metadata request answers 503 once, then 200.
 *   Forces exactly one real, unfaked retry-delay sleep — the path the
 *   `.unref()` bug abandoned.
 * - 'rejected-token': the token exchange answers 401 (not a retryable
 *   status), so it fails on the first attempt with no sleep at all.
 */
const mode = process.env['HARNESS_MODE'] ?? 'success-after-retry';

const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'cas-sheets-harness-repo-'));
const keysDirectory = await mkdtemp(path.join(os.tmpdir(), 'cas-sheets-harness-keys-'));

const SYNTHETIC_SPREADSHEET_ID = 'SyntheticSubprocessHarness_00000000000001';
const SYNTHETIC_TOKEN = 'harness-synthetic-access-token';
const SYNTHETIC_CLIENT_EMAIL = 'harness@synthetic-project.iam.gserviceaccount.com';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyPath = path.join(keysDirectory, 'key.json');
await writeFile(
  keyPath,
  JSON.stringify({
    type: 'service_account',
    client_email: SYNTHETIC_CLIENT_EMAIL,
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
  'utf8',
);
await chmod(keyPath, 0o600);

const { spreadsheetIdDigest } = await import(SHEETS_INTAKE_DIST);
const policyPath = path.join(repositoryRoot, 'policy.json');
await writeFile(
  policyPath,
  JSON.stringify({
    title: 'Cyberattack Sunday - RSS Intake',
    spreadsheetIdSha256: spreadsheetIdDigest(SYNTHETIC_SPREADSHEET_ID),
  }),
  'utf8',
);

let metadataCalls = 0;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    if (mode === 'rejected-token') {
      return new Response('', { status: 401 });
    }
    return new Response(JSON.stringify({ access_token: SYNTHETIC_TOKEN, expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/values/')) {
    return new Response(
      JSON.stringify({ range: 'Feed!A1:D1', majorDimension: 'ROWS', values: [['a', 'b']] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')) {
    metadataCalls += 1;
    if (mode === 'success-after-retry' && metadataCalls === 1) {
      return new Response('', { status: 503 });
    }
    const body = {
      properties: { title: 'Cyberattack Sunday - RSS Intake', locale: 'en_US', timeZone: 'UTC' },
      sheets: [
        {
          properties: {
            sheetId: 1,
            title: 'Feed',
            index: 0,
            sheetType: 'GRID',
            hidden: false,
            gridProperties: { rowCount: 10, columnCount: 4, frozenRowCount: 1 },
          },
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`harness fetch received an unexpected URL: ${url}`);
};

const { run } = await import(`${WORKER_DIST}cli.js`);
const { connectToWorkbook } = await import(`${WORKER_DIST}sheets/connect.js`);

const code = await run(['sheets', 'inventory'], {
  env: {
    GOOGLE_SHEETS_SPREADSHEET_ID: SYNTHETIC_SPREADSHEET_ID,
    GOOGLE_APPLICATION_CREDENTIALS: keyPath,
  },
  io: {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  },
  connectToWorkbook: (options) => connectToWorkbook({ ...options, policyPath, repositoryRoot }),
});

process.exitCode = code;
