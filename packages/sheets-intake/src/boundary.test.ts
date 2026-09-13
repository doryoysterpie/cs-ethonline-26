import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SheetsReadOnlyClient, METADATA_FIELD_MASK } from './client.js';
import { isSheetsIntakeError } from './errors.js';
import { assertAuthorizedSpreadsheet, spreadsheetIdDigest } from './policy.js';
import { SHEETS_READONLY_SCOPE, TokenSource, buildAssertion } from './token.js';
import { ALLOWED_ORIGINS, assertAllowedUrl } from './transport.js';
import {
  AUTHORIZED_ID,
  AUTHORIZED_POLICY,
  UNPINNED_POLICY,
  UNRELATED_ID,
  fakeTransport,
  metadataResponse,
  syntheticCredential,
  testLimits,
  tokenResponse,
} from './test-support.js';

/**
 * The access-model boundary.
 *
 * These are the properties the owner's instruction turns on, and each is
 * asserted against the source as it will ship rather than against a
 * description of it. Two of them — no Drive surface, no write scope — are
 * checked by reading every source file in the package, because the claim is
 * about what the code *cannot* do, and a claim of that shape is only worth
 * what its search is worth.
 */

const SOURCE_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

/**
 * The files `tsconfig.build.json` compiles into the shipped package. Tests and
 * test support are excluded, because the claim is about what the built
 * connector can reach, and a test that names a forbidden host in order to
 * prove it is refused is evidence for the claim rather than against it.
 */
async function packageSources(): Promise<{ file: string; text: string }[]> {
  const names = (await readdir(SOURCE_DIRECTORY)).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'test-support.ts',
  );
  return Promise.all(
    names.map(async (name) => ({
      file: name,
      text: await readFile(path.join(SOURCE_DIRECTORY, name), 'utf8'),
    })),
  );
}

describe('the workbook is a whitelist of one', () => {
  it('accepts the authorized identifier', () => {
    expect(assertAuthorizedSpreadsheet(AUTHORIZED_ID, AUTHORIZED_POLICY)).toBe(AUTHORIZED_ID);
  });

  it('refuses a different identifier before any request is made', async () => {
    const transport = fakeTransport([tokenResponse(), metadataResponse([{ title: 'Feed' }])]);
    let caught: unknown;
    try {
      assertAuthorizedSpreadsheet(UNRELATED_ID, AUTHORIZED_POLICY);
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught)).toBe(true);
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('workbook_not_authorized');
    expect(isSheetsIntakeError(caught) ? caught.kind : '').toBe('policy');
    // The decisive assertion: nothing was attempted.
    expect(transport.requests).toEqual([]);
  });

  it('refuses every identifier while no digest is pinned', () => {
    for (const id of [AUTHORIZED_ID, UNRELATED_ID]) {
      let caught: unknown;
      try {
        assertAuthorizedSpreadsheet(id, UNPINNED_POLICY);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('workbook_not_pinned');
    }
  });

  it('refuses a URL, a malformed identifier and an empty one', () => {
    const cases: readonly [string, string][] = [
      [
        'https://docs.google.com/spreadsheets/d/SyntheticAuthorized_0000000000000000000001/edit',
        'spreadsheet_id_is_url',
      ],
      ['contains spaces and punctuation!', 'spreadsheet_id_malformed'],
      ['short', 'spreadsheet_id_malformed'],
      ['   ', 'spreadsheet_id_missing'],
    ];
    for (const [id, code] of cases) {
      let caught: unknown;
      try {
        assertAuthorizedSpreadsheet(id, AUTHORIZED_POLICY);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught) ? caught.code : '', id).toBe(code);
    }
  });

  it('refuses a policy that names a file other than the authorized one', () => {
    let caught: unknown;
    try {
      assertAuthorizedSpreadsheet(AUTHORIZED_ID, {
        title: 'Some Other Workbook',
        spreadsheetIdSha256: spreadsheetIdDigest(AUTHORIZED_ID),
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('policy_title_unexpected');
  });

  it('names neither the configured identifier nor the pin in its refusal', () => {
    try {
      assertAuthorizedSpreadsheet(UNRELATED_ID, AUTHORIZED_POLICY);
      expect.unreachable('the unrelated identifier must be refused');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(UNRELATED_ID);
      expect(message).not.toContain(AUTHORIZED_ID);
      expect(message).not.toContain(AUTHORIZED_POLICY.spreadsheetIdSha256 ?? '');
    }
  });
});

describe('no Drive surface and no write surface exist', () => {
  it('names exactly two allowed origins, both Google API hosts', () => {
    expect([...ALLOWED_ORIGINS].sort()).toEqual([
      'https://oauth2.googleapis.com',
      'https://sheets.googleapis.com',
    ]);
  });

  it('refuses every other origin, Google-owned ones included', () => {
    for (const url of [
      'https://www.googleapis.com/drive/v3/files',
      'https://drive.google.com/file/d/x',
      'https://docs.google.com/spreadsheets/d/x',
      'https://sheets.googleapis.com.evil.example/v4/spreadsheets',
      'http://sheets.googleapis.com/v4/spreadsheets',
      'https://user:pass@sheets.googleapis.com/v4/spreadsheets',
      'https://example.invalid/',
    ]) {
      let caught: unknown;
      try {
        assertAllowedUrl(url);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught), url).toBe(true);
      expect(isSheetsIntakeError(caught) ? caught.kind : '', url).toBe('policy');
    }
  });

  it('contains no Drive host, path or scope anywhere in the package source', async () => {
    const forbidden = [
      'drive.google.com',
      'googleapis.com/drive',
      '/drive/v3',
      'auth/drive',
      'files.list',
      'includeGridData',
    ];
    for (const { file, text } of await packageSources()) {
      for (const needle of forbidden) {
        // The doc comments say what is absent; the check is on code, so a
        // sentence naming the prohibition is not a violation of it.
        const inCode = text
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
          .join('\n');
        expect(inCode.includes(needle), `${file} must not reference ${needle}`).toBe(false);
      }
    }
  });

  it('requests exactly one scope, and it is read-only', async () => {
    expect(SHEETS_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    const scopePattern = /https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]+/g;
    const found = new Set<string>();
    for (const { text } of await packageSources()) {
      for (const match of text.matchAll(scopePattern)) found.add(match[0]);
    }
    expect([...found]).toEqual([SHEETS_READONLY_SCOPE]);
  });

  it('puts the read-only scope in the signed assertion', () => {
    const credential = syntheticCredential();
    const assertion = buildAssertion(credential, 1_760_000_000);
    const [, claims] = assertion.split('.');
    const decoded = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded['scope']).toBe(SHEETS_READONLY_SCOPE);
    expect(decoded['aud']).toBe('https://oauth2.googleapis.com/token');
    expect(decoded['iss']).toBe(credential.clientEmail);
    expect(decoded['exp']).toBeGreaterThan(decoded['iat'] as number);
  });

  it('exposes no method that could write', () => {
    const methods = new Set<string>();
    let prototype: object | null = SheetsReadOnlyClient.prototype as object;
    while (prototype !== null && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) methods.add(name);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    expect([...methods].sort()).toEqual(['constructor', 'metadata', 'values']);
    for (const forbidden of ['update', 'batchUpdate', 'append', 'clear', 'create', 'delete']) {
      expect(methods.has(forbidden), forbidden).toBe(false);
    }
  });

  it('issues only GET requests against the Sheets host', async () => {
    const transport = fakeTransport([tokenResponse(), metadataResponse([{ title: 'Feed' }])]);
    const tokens = new TokenSource({
      credential: syntheticCredential(),
      limits: testLimits(),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    const client = new SheetsReadOnlyClient(AUTHORIZED_ID, {
      tokens,
      limits: testLimits(),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    await client.metadata();

    const [tokenRequest, apiRequest] = transport.requests;
    expect(tokenRequest?.method).toBe('POST');
    expect(tokenRequest?.url).toBe('https://oauth2.googleapis.com/token');
    expect(apiRequest?.method).toBe('GET');
    expect(apiRequest?.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')).toBe(true);
    // The field mask is what keeps a metadata call from returning cells.
    expect(apiRequest?.url).toContain(encodeURIComponent(METADATA_FIELD_MASK));
    expect(METADATA_FIELD_MASK).not.toContain('data');
  });
});
