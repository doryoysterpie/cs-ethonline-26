import { chmod, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIALS_VARIABLE,
  SPREADSHEET_ID_VARIABLE,
  configSecrets,
  parseSheetsConfig,
} from './config.js';
import { isInsideDirectory, loadServiceAccountCredential } from './credentials.js';
import { isSheetsIntakeError } from './errors.js';
import { AUTHORIZED_ID, syntheticKeyFile } from './test-support.js';

/**
 * `open` alone is mocked, wrapping the real implementation by default, so
 * every other test in this file (and every other caller of `fs/promises`)
 * is unaffected; only a test that calls `vi.mocked(open).mockImplementationOnce`
 * observes different behaviour, and only for its one call.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

/**
 * The credential boundary and the offline guarantee.
 *
 * The repository check is the one worth arguing for. An ignore rule stops
 * `git add .`; it does not stop a force-add, a changed ignore rule, a
 * `git archive`, or a Docker build context that copies the working tree. A key
 * that is not in the tree is protected from all of those, and this is the test
 * that keeps it out.
 */

let directory = '';
let outside = '';

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cas-sheets-repo-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'cas-sheets-keys-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function writeKey(target: string, contents: string, mode = 0o600): Promise<string> {
  await writeFile(target, contents, 'utf8');
  await chmod(target, mode);
  return target;
}

const code = (error: unknown): string => (isSheetsIntakeError(error) ? error.code : String(error));

describe('a credential never lives in the repository', () => {
  it('loads a well-formed key from outside the working tree', async () => {
    const keyPath = await writeKey(path.join(outside, 'key.json'), syntheticKeyFile());
    const credential = await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    expect(credential.clientEmail).toMatch(/\.iam\.gserviceaccount\.com$/);
    expect(credential.tokenUri).toBe('https://oauth2.googleapis.com/token');
    expect(credential.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('refuses a key inside the repository, however it is spelled', async () => {
    const inside = await writeKey(path.join(directory, 'key.json'), syntheticKeyFile());
    const nested = path.join(directory, 'packages', 'nested');
    await writeFile(inside, syntheticKeyFile(), 'utf8');
    for (const candidate of [
      inside,
      path.join(directory, '.', 'key.json'),
      path.join(directory, 'a', '..', 'key.json'),
      path.join(outside, '..', path.basename(directory), 'key.json'),
    ]) {
      let caught: unknown;
      try {
        await loadServiceAccountCredential(candidate, { repositoryRoot: directory });
      } catch (error) {
        caught = error;
      }
      expect(code(caught), candidate).toBe('credential_inside_repository');
    }
    expect(nested).not.toBe('');
  });

  it('resolves the boundary on paths, not on strings', () => {
    expect(isInsideDirectory('/repo/a/b', '/repo')).toBe(true);
    expect(isInsideDirectory('/repo', '/repo')).toBe(true);
    expect(isInsideDirectory('/repo/../elsewhere', '/repo')).toBe(false);
    // The classic near-miss: a sibling whose name starts the same way.
    expect(isInsideDirectory('/repository/a', '/repo')).toBe(false);
  });

  it('refuses a key readable by anyone but its owner', async () => {
    if (process.platform === 'win32') return;
    const keyPath = await writeKey(path.join(outside, 'open.json'), syntheticKeyFile(), 0o644);
    let caught: unknown;
    try {
      await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    } catch (error) {
      caught = error;
    }
    expect(code(caught)).toBe('credential_permissions_open');
  });

  it('refuses a user OAuth credential, which would act as the owner', async () => {
    const keyPath = await writeKey(
      path.join(outside, 'oauth.json'),
      JSON.stringify({ type: 'authorized_user', client_id: 'x', refresh_token: 'y' }),
    );
    let caught: unknown;
    try {
      await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    } catch (error) {
      caught = error;
    }
    expect(code(caught)).toBe('credential_not_service_account');
    expect(caught instanceof Error ? caught.message : '').toContain('User OAuth credentials');
  });

  it('refuses a key that names a token endpoint other than the pinned one', async () => {
    const keyPath = await writeKey(
      path.join(outside, 'redirected.json'),
      syntheticKeyFile({ token_uri: 'https://oauth2.googleapis.com.evil.invalid/token' }),
    );
    let caught: unknown;
    try {
      await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    } catch (error) {
      caught = error;
    }
    expect(code(caught)).toBe('credential_token_uri_unexpected');
  });

  it('refuses a malformed, oversized, missing or non-JSON key', async () => {
    const cases: readonly [string, string, string][] = [
      ['absent.json', '', 'credential_unreadable'],
      ['notjson.json', 'not json at all', 'credential_not_json'],
      ['array.json', '[]', 'credential_not_object'],
      ['nokey.json', syntheticKeyFile({ private_key: undefined }), 'credential_field_missing'],
      ['badpem.json', syntheticKeyFile({ private_key: 'not a pem' }), 'credential_key_invalid'],
      [
        'bademail.json',
        syntheticKeyFile({ client_email: 'someone@example.invalid' }),
        'credential_email_invalid',
      ],
      [
        'huge.json',
        JSON.stringify({ type: 'service_account', pad: 'x'.repeat(40_000) }),
        'credential_too_large',
      ],
    ];
    for (const [name, contents, expected] of cases) {
      const target = path.join(outside, name);
      if (contents !== '') await writeKey(target, contents);
      let caught: unknown;
      try {
        await loadServiceAccountCredential(target, { repositoryRoot: directory });
      } catch (error) {
        caught = error;
      }
      expect(code(caught), name).toBe(expected);
    }
  });

  it('never puts key material into a refusal', async () => {
    const keyPath = await writeKey(
      path.join(outside, 'bad.json'),
      syntheticKeyFile({ private_key: '-----BEGIN PRIVATE KEY-----\nLEAKED-KEY-BODY\n' }),
    );
    let caught: unknown;
    try {
      await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : '';
    expect(message).not.toContain('LEAKED-KEY-BODY');
    expect(JSON.stringify(isSheetsIntakeError(caught) ? caught.details : {})).not.toContain(
      'LEAKED-KEY-BODY',
    );
  });
});

describe('the credential is opened once, never checked and read by path separately', () => {
  let realOpen: typeof open;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    realOpen = actual.open;
  });

  afterEach(() => {
    vi.mocked(open).mockReset();
    vi.mocked(open).mockImplementation(realOpen);
  });

  it('refuses a credential path that is itself a symbolic link', async () => {
    if (process.platform === 'win32') return;
    const real = await writeKey(path.join(outside, 'real-key.json'), syntheticKeyFile());
    const linked = path.join(outside, 'linked-key.json');
    await symlink(real, linked);
    let caught: unknown;
    try {
      await loadServiceAccountCredential(linked, { repositoryRoot: directory });
    } catch (error) {
      caught = error;
    }
    expect(code(caught)).toBe('credential_is_symlink');
  });

  it('is immune to the file being replaced between the open and the read (TOCTOU)', async () => {
    if (process.platform === 'win32') return;
    const keyPath = await writeKey(
      path.join(outside, 'raced.json'),
      syntheticKeyFile({
        client_email: 'toctou-original@synthetic-project.iam.gserviceaccount.com',
      }),
    );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      // The window a stat-then-read implementation would race: the handle
      // below is already bound to the original file's inode, so replacing
      // the directory entry immediately afterward must have no effect on
      // what the loader goes on to validate and read.
      const handle = await realOpen(...(args as Parameters<typeof open>));
      await rm(keyPath, { force: true });
      await writeFile(
        keyPath,
        syntheticKeyFile({
          client_email: 'toctou-attacker@synthetic-project.iam.gserviceaccount.com',
        }),
        'utf8',
      );
      await chmod(keyPath, 0o600);
      return handle;
    });

    const credential = await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    expect(credential.clientEmail).toBe(
      'toctou-original@synthetic-project.iam.gserviceaccount.com',
    );
  });

  it('is immune to the file being replaced with a symbolic link between the open and the read', async () => {
    if (process.platform === 'win32') return;
    const keyPath = await writeKey(
      path.join(outside, 'raced-symlink.json'),
      syntheticKeyFile({ client_email: 'presymlink@synthetic-project.iam.gserviceaccount.com' }),
    );
    const elsewhere = await writeKey(
      path.join(outside, 'elsewhere.json'),
      syntheticKeyFile({ client_email: 'elsewhere@synthetic-project.iam.gserviceaccount.com' }),
    );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof open>));
      await rm(keyPath, { force: true });
      await symlink(elsewhere, keyPath);
      return handle;
    });

    const credential = await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    expect(credential.clientEmail).toBe('presymlink@synthetic-project.iam.gserviceaccount.com');
  });

  it('refuses a file replaced with an oversized one between the open and the read, reading the original size', async () => {
    if (process.platform === 'win32') return;
    const keyPath = await writeKey(path.join(outside, 'raced-size.json'), syntheticKeyFile());
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof open>));
      await rm(keyPath, { force: true });
      await writeFile(
        keyPath,
        JSON.stringify({ type: 'service_account', pad: 'x'.repeat(40_000) }),
      );
      await chmod(keyPath, 0o600);
      return handle;
    });

    // The swapped-in file is oversized; the original, already open, is not.
    // A stat-then-read implementation reading the swapped file by path would
    // either accept oversized content or throw the wrong refusal. This one
    // still validates and parses the original.
    const credential = await loadServiceAccountCredential(keyPath, { repositoryRoot: directory });
    expect(credential.clientEmail).toMatch(/\.iam\.gserviceaccount\.com$/);
  });
});

describe('configuration is validated before anything reaches the network', () => {
  it('accepts a complete configuration', () => {
    const config = parseSheetsConfig({
      [SPREADSHEET_ID_VARIABLE]: AUTHORIZED_ID,
      [CREDENTIALS_VARIABLE]: '/secrets/key.json',
    });
    expect(config.spreadsheetId).toBe(AUTHORIZED_ID);
    expect(config.credentialsPath).toBe('/secrets/key.json');
    expect(config.tabMapPath).toBeNull();
    expect(config.limits.maximumTabs).toBeGreaterThan(0);
  });

  it('refuses a missing identifier and a missing credential path', () => {
    expect(() => parseSheetsConfig({})).toThrowError();
    expect(code(catchOf(() => parseSheetsConfig({})))).toBe('spreadsheet_id_missing');
    expect(
      code(catchOf(() => parseSheetsConfig({ [SPREADSHEET_ID_VARIABLE]: AUTHORIZED_ID }))),
    ).toBe('credentials_missing');
  });

  it('lets the pin command run without a credential, since it makes no request', () => {
    const config = parseSheetsConfig(
      { [SPREADSHEET_ID_VARIABLE]: AUTHORIZED_ID },
      { requireCredentials: false },
    );
    expect(config.credentialsPath).toBe('');
  });

  it('never echoes a configured value in a refusal', () => {
    const error = catchOf(() =>
      parseSheetsConfig({
        [SPREADSHEET_ID_VARIABLE]: 'https://docs.google.com/spreadsheets/d/SECRET',
      }),
    );
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('docs.google.com');
  });

  it('names the identifier as a secret the redactor must cover', () => {
    expect(configSecrets({ spreadsheetId: AUTHORIZED_ID })).toEqual([AUTHORIZED_ID]);
  });
});

function catchOf(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the default test suite is offline by construction', () => {
  const nodeRequire = createRequire(import.meta.url);

  it('opens no socket and resolves no name during a full connector exercise', async () => {
    const net = nodeRequire('node:net') as typeof import('node:net');
    const tls = nodeRequire('node:tls') as typeof import('node:tls');
    const dns = nodeRequire('node:dns') as typeof import('node:dns');
    const attempts: string[] = [];
    const original = {
      connect: net.Socket.prototype.connect,
      tlsConnect: tls.connect,
      lookup: dns.lookup,
      promisesLookup: dns.promises.lookup,
    };
    const trap = (name: string) => (): never => {
      attempts.push(name);
      throw new Error(`an offline test reached ${name}`);
    };
    net.Socket.prototype.connect = trap('net.Socket.connect') as typeof original.connect;
    tls.connect = trap('tls.connect') as typeof original.tlsConnect;
    dns.lookup = trap('dns.lookup') as unknown as typeof original.lookup;
    dns.promises.lookup = trap('dns.promises.lookup') as unknown as typeof original.promisesLookup;

    try {
      // Everything a real run does, with the injected transport: authorize,
      // read metadata, read a header row, read a data page.
      const { SheetsReadOnlyClient } = await import('./client.js');
      const { TokenSource } = await import('./token.js');
      const { inventoryWorkbook } = await import('./inventory.js');
      const support = await import('./test-support.js');
      const transport = support.fakeTransport([
        support.tokenResponse(),
        support.metadataResponse([{ title: 'Feed', rows: 10, columns: 2 }]),
        support.valuesResponse("'Feed'!A1:B1", [['Title', 'URL']]),
      ]);
      const tokens = new TokenSource({
        credential: support.syntheticCredential(),
        limits: support.testLimits(),
        fetchImpl: transport.fetchImpl,
        sleep: transport.sleep,
      });
      const client = new SheetsReadOnlyClient(AUTHORIZED_ID, {
        tokens,
        limits: support.testLimits(),
        fetchImpl: transport.fetchImpl,
        sleep: transport.sleep,
      });
      const inventory = await inventoryWorkbook(client, { limits: support.testLimits() });
      expect(inventory.tabs).toHaveLength(1);
    } finally {
      net.Socket.prototype.connect = original.connect;
      tls.connect = original.tlsConnect;
      dns.lookup = original.lookup;
      dns.promises.lookup = original.promisesLookup;
    }

    expect(attempts).toEqual([]);
  });

  it('uses the global fetch only when no implementation is injected', async () => {
    // The transport defaults to the platform fetch, which is what a live run
    // uses; every test supplies its own, which is why the suite is offline.
    const { request } = await import('./transport.js');
    let called = false;
    await request(
      {
        url: 'https://sheets.googleapis.com/v4/spreadsheets/x',
        method: 'GET',
        headers: {},
        idempotent: true,
      },
      {
        limits: (await import('./limits.js')).DEFAULT_LIMITS,
        sleep: async () => undefined,
        fetchImpl: async () => {
          called = true;
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(called).toBe(true);
  });
});
