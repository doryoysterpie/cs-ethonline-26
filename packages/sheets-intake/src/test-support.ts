import { generateKeyPairSync } from 'node:crypto';

import type { ServiceAccountCredential } from './credentials.js';
import { DEFAULT_LIMITS, type SheetsLimits } from './limits.js';
import type { WorkbookPolicy } from './policy.js';
import { spreadsheetIdDigest } from './policy.js';
import type { FetchLike } from './transport.js';

/**
 * Synthetic fixtures. Every value here is invented.
 *
 * Nothing in this file is copied from the authorized workbook, and nothing is
 * a real credential: the RSA key pair is generated in the test process and
 * discarded with it, and the identifiers are literals chosen to look like
 * Google identifiers without being any. This module is excluded from the
 * built package by `tsconfig.build.json`.
 */

/** A synthetic identifier shaped like a Google file identifier. */
export const AUTHORIZED_ID = 'SyntheticAuthorized_0000000000000000000001';
/** A second one, which the policy must refuse. */
export const UNRELATED_ID = 'SyntheticUnrelated_00000000000000000000002';

export const AUTHORIZED_POLICY: WorkbookPolicy = Object.freeze({
  title: 'Cyberattack Sunday - RSS Intake',
  spreadsheetIdSha256: spreadsheetIdDigest(AUTHORIZED_ID),
});

export const UNPINNED_POLICY: WorkbookPolicy = Object.freeze({
  title: 'Cyberattack Sunday - RSS Intake',
  spreadsheetIdSha256: null,
});

/** A generated key pair, so assertion signing is exercised for real. */
export function syntheticCredential(): ServiceAccountCredential {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    clientEmail: 'synthetic-intake@synthetic-project.iam.gserviceaccount.com',
    privateKey,
    tokenUri: 'https://oauth2.googleapis.com/token',
  };
}

/** A service-account key file's JSON, for credential-loading tests. */
export function syntheticKeyFile(overrides: Record<string, unknown> = {}): string {
  const credential = syntheticCredential();
  return JSON.stringify({
    type: 'service_account',
    project_id: 'synthetic-project',
    private_key_id: 'synthetic-key-id',
    private_key: credential.privateKey,
    client_email: credential.clientEmail,
    client_id: '000000000000000000000',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

export function testLimits(overrides: Partial<SheetsLimits> = {}): SheetsLimits {
  return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeTransport {
  readonly fetchImpl: FetchLike;
  /** Every request the code under test attempted, in order. */
  readonly requests: RecordedRequest[];
  /** Delays the fake made, so a retry schedule can be asserted without waiting. */
  readonly sleeps: number[];
  readonly sleep: (ms: number) => Promise<void>;
}

export interface FakeResponse {
  readonly status?: number | undefined;
  readonly body?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  /** Throw instead of answering, to simulate a transport failure. */
  readonly throws?: Error | undefined;
}

/**
 * A fetch that answers from a script and records what it was asked.
 *
 * It opens no socket. Every offline test uses this, so the default suite is
 * offline by construction rather than by intent, and a test that reached the
 * network would have to bypass this module to do it.
 */
export function fakeTransport(script: readonly FakeResponse[]): FakeTransport {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  let index = 0;
  return {
    requests,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      const headers = init.headers as Record<string, string> | undefined;
      requests.push({
        url,
        method: init.method ?? 'GET',
        headers: { ...(headers ?? {}) },
      });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step === undefined) return new Response('{}', { status: 200 });
      if (step.throws !== undefined) throw step.throws;
      return new Response(step.body ?? '{}', {
        status: step.status ?? 200,
        headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
      });
    },
  };
}

/** A successful token-exchange body. */
export function tokenResponse(): FakeResponse {
  return {
    status: 200,
    body: JSON.stringify({ access_token: 'synthetic-access-token-value', expires_in: 3600 }),
  };
}

export interface SyntheticTab {
  readonly title: string;
  readonly rows?: number | undefined;
  readonly columns?: number | undefined;
  readonly hidden?: boolean | undefined;
  readonly sheetType?: string | undefined;
  readonly frozenRowCount?: number | undefined;
}

/** A metadata response body for a synthetic workbook. */
export function metadataResponse(
  tabs: readonly SyntheticTab[],
  overrides: { title?: string; timeZone?: string | null } = {},
): FakeResponse {
  return {
    status: 200,
    body: JSON.stringify({
      properties: {
        title: overrides.title ?? 'Cyberattack Sunday - RSS Intake',
        locale: 'en_CA',
        ...(overrides.timeZone === null
          ? {}
          : { timeZone: overrides.timeZone ?? 'America/Toronto' }),
      },
      sheets: tabs.map((tab, index) => ({
        properties: {
          sheetId: 1000 + index,
          title: tab.title,
          index,
          sheetType: tab.sheetType ?? 'GRID',
          ...(tab.hidden === true ? { hidden: true } : {}),
          gridProperties: {
            rowCount: tab.rows ?? 100,
            columnCount: tab.columns ?? 8,
            frozenRowCount: tab.frozenRowCount ?? 1,
          },
        },
      })),
    }),
  };
}

/** A values response body. */
export function valuesResponse(
  range: string,
  values: readonly (readonly unknown[])[],
): FakeResponse {
  return { status: 200, body: JSON.stringify({ range, majorDimension: 'ROWS', values }) };
}
