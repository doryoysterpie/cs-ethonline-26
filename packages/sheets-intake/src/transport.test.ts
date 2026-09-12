import { describe, expect, it } from 'vitest';

import { SheetsReadOnlyClient } from './client.js';
import { isSheetsIntakeError } from './errors.js';
import { TokenSource } from './token.js';
import { request } from './transport.js';
import {
  AUTHORIZED_ID,
  fakeTransport,
  syntheticCredential,
  testLimits,
  tokenResponse,
} from './test-support.js';

/**
 * The transport's four guarantees, each attacked directly.
 *
 * The interesting cases here are the ones where a well-behaved client would do
 * the accommodating thing: follow the redirect, retry forever, read the whole
 * body, quote the server's explanation. Each of those is the failure, and each
 * is what these tests force.
 */

const GET = {
  url: 'https://sheets.googleapis.com/v4/spreadsheets/x',
  method: 'GET' as const,
  headers: {},
  idempotent: true,
};

describe('redirects are refused, never followed', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i and makes no second request', async (status) => {
    const transport = fakeTransport([
      { status, headers: { location: 'https://drive.google.com/file/d/x' } },
    ]);
    let caught: unknown;
    try {
      await request(GET, {
        limits: testLimits(),
        fetchImpl: transport.fetchImpl,
        sleep: transport.sleep,
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('redirect_refused');
    expect(isSheetsIntakeError(caught) ? caught.kind : '').toBe('policy');
    // One attempt, and the redirect target was never contacted.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toBe(GET.url);
  });

  it('asks the platform not to follow redirects in the first place', async () => {
    let observedRedirectMode: string | undefined;
    await request(GET, {
      limits: testLimits(),
      sleep: async () => undefined,
      fetchImpl: async (_url, init) => {
        observedRedirectMode = init.redirect;
        return new Response('{}', { status: 200 });
      },
    });
    expect(observedRedirectMode).toBe('manual');
  });
});

describe('retries are bounded and cancellable', () => {
  it('retries a transient status up to the bound, then gives up', async () => {
    const transport = fakeTransport([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    const response = await request(GET, {
      limits: testLimits({ maximumAttempts: 4 }),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    // Four attempts and no more. The transport hands the final status back
    // rather than deciding what it means; the client turns it into a typed
    // failure, which the next assertion covers.
    expect(transport.requests).toHaveLength(4);
    expect(response.status).toBe(503);
    // Exponential, and one delay fewer than there were attempts.
    expect(transport.sleeps).toEqual([500, 1000, 2000]);
  });

  it('turns an exhausted retry into a typed refusal at the client', async () => {
    const transport = fakeTransport([
      tokenResponse(),
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    const tokens = new TokenSource({
      credential: syntheticCredential(),
      limits: testLimits(),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    const client = new SheetsReadOnlyClient(AUTHORIZED_ID, {
      tokens,
      limits: testLimits({ maximumAttempts: 4 }),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    let caught: unknown;
    try {
      await client.metadata();
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.kind : '').toBe('http');
    expect(isSheetsIntakeError(caught) ? caught.details['status'] : 0).toBe(503);
  });

  it('caps a retry delay at the configured maximum', async () => {
    const transport = fakeTransport([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    await request(GET, {
      limits: testLimits({ maximumAttempts: 4, retryBaseDelayMs: 5000, retryMaximumDelayMs: 6000 }),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    }).catch(() => undefined);
    expect(transport.sleeps).toEqual([5000, 6000, 6000]);
  });

  it('does not retry a status that will not change', async () => {
    for (const status of [400, 401, 403, 404]) {
      const transport = fakeTransport([{ status }]);
      const response = await request(GET, {
        limits: testLimits(),
        fetchImpl: transport.fetchImpl,
        sleep: transport.sleep,
      });
      expect(response.status, String(status)).toBe(status);
      expect(transport.requests, String(status)).toHaveLength(1);
    }
  });

  it('does not retry a request the caller did not declare idempotent', async () => {
    const transport = fakeTransport([{ status: 503 }]);
    await request(
      { ...GET, method: 'POST', idempotent: false },
      { limits: testLimits(), fetchImpl: transport.fetchImpl, sleep: transport.sleep },
    ).catch(() => undefined);
    expect(transport.requests).toHaveLength(1);
  });

  it('stops immediately when the caller cancels before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = fakeTransport([{ status: 200 }]);
    let caught: unknown;
    try {
      await request(GET, {
        limits: testLimits(),
        fetchImpl: transport.fetchImpl,
        sleep: transport.sleep,
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('request_cancelled');
    expect(transport.requests).toEqual([]);
  });

  it('stops between retries when the caller cancels mid-flight', async () => {
    const controller = new AbortController();
    let attempts = 0;
    let caught: unknown;
    try {
      await request(GET, {
        limits: testLimits({ maximumAttempts: 5 }),
        sleep: async () => undefined,
        signal: controller.signal,
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 2) controller.abort();
          return new Response('', { status: 503 });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('request_cancelled');
    // The abort ended the loop rather than being noticed five attempts later.
    expect(attempts).toBe(2);
  });
});

describe('responses are bounded and never echoed', () => {
  it('abandons a response larger than the configured ceiling', async () => {
    const oversized = 'x'.repeat(4096);
    let caught: unknown;
    try {
      await request(GET, {
        limits: testLimits({ maximumResponseBytes: 1024 }),
        sleep: async () => undefined,
        fetchImpl: async () => new Response(oversized, { status: 200 }),
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('response_too_large');
    expect(isSheetsIntakeError(caught) ? caught.kind : '').toBe('structural');
  });

  it('never puts an API error body into an error message', async () => {
    // A body crafted to be quoted back: it carries a secret-looking value, a
    // spreadsheet URL and a line-forging escape.
    const hostileBody = JSON.stringify({
      error: {
        code: 403,
        message:
          'Client does not have permission for SyntheticAuthorized_0000000000000000000001 at https://docs.google.com/spreadsheets/d/SyntheticAuthorized_0000000000000000000001',
        status: 'PERMISSION_DENIED',
      },
    });
    const transport = fakeTransport([tokenResponse(), { status: 403, body: hostileBody }]);
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

    let caught: unknown;
    try {
      await client.metadata();
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught)).toBe(true);
    const message = caught instanceof Error ? caught.message : '';
    const serialized = JSON.stringify(isSheetsIntakeError(caught) ? caught.details : {});
    for (const leak of [
      'PERMISSION_DENIED',
      'does not have permission',
      'docs.google.com',
      AUTHORIZED_ID,
    ]) {
      expect(message, leak).not.toContain(leak);
      expect(serialized, leak).not.toContain(leak);
    }
    // What it does say is the status and what to do about it.
    expect(message).toContain('Viewer');
    expect(isSheetsIntakeError(caught) ? caught.details['status'] : 0).toBe(403);
  });

  it('never puts a failed token-exchange body into an error message', async () => {
    const transport = fakeTransport([
      {
        status: 400,
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'assertion eyJhbGciOi...',
        }),
      },
    ]);
    const tokens = new TokenSource({
      credential: syntheticCredential(),
      limits: testLimits(),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    let caught: unknown;
    try {
      await tokens.accessToken();
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : '';
    expect(message).not.toContain('invalid_grant');
    expect(message).not.toContain('eyJhbGciOi');
    expect(isSheetsIntakeError(caught) ? caught.details['status'] : 0).toBe(400);
  });

  it('does not carry a transport failure message through', async () => {
    let caught: unknown;
    try {
      await request(GET, {
        limits: testLimits({ maximumAttempts: 1 }),
        sleep: async () => undefined,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED 10.1.2.3:443 via proxy internal.example');
        },
      });
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : '';
    expect(message).not.toContain('10.1.2.3');
    expect(message).not.toContain('internal.example');
    expect(isSheetsIntakeError(caught) ? caught.kind : '').toBe('network');
  });
});

describe('the token is fetched once and reused', () => {
  it('caches a token across calls and does not re-exchange', async () => {
    const transport = fakeTransport([
      tokenResponse(),
      { status: 200, body: '{}' },
      { status: 200, body: '{}' },
    ]);
    const tokens = new TokenSource({
      credential: syntheticCredential(),
      limits: testLimits(),
      fetchImpl: transport.fetchImpl,
      sleep: transport.sleep,
    });
    await tokens.accessToken();
    await tokens.accessToken();
    const exchanges = transport.requests.filter((r) => r.url.includes('oauth2.googleapis.com'));
    expect(exchanges).toHaveLength(1);
  });

  it('sends the token as a bearer header and never in a URL', async () => {
    const transport = fakeTransport([
      tokenResponse(),
      { status: 200, body: '{"properties":{"title":"t"},"sheets":[]}' },
    ]);
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
    await client.metadata().catch(() => undefined);
    const apiRequest = transport.requests.find((r) => r.url.includes('sheets.googleapis.com'));
    expect(apiRequest?.headers['authorization']).toBe('Bearer synthetic-access-token-value');
    expect(apiRequest?.url).not.toContain('synthetic-access-token-value');
  });
});
