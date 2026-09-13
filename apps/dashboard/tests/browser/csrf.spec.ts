import { createHmac } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { credentials, signIn, SESSION_COOKIE } from './support.ts';

/** The same derivation the server uses; a test computes it only from a token it legitimately holds. */
function csrfFor(token: string): string {
  return createHmac('sha256', token).update('cas-dashboard-csrf@1', 'utf8').digest('base64url');
}

test.describe('cross-site request forgery', () => {
  test('a mutation handler refuses a cross-site or foreign-origin request, and one without the token', async ({
    page,
    request,
  }) => {
    const { accounts } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const token =
      (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ??
      '';
    const cookie = `${SESSION_COOKIE}=${token}`;

    const crossSite = await request.post('/api/logout', {
      headers: { cookie, 'sec-fetch-site': 'cross-site', 'x-csrf-token': csrfFor(token) },
    });
    expect(crossSite.status()).toBe(403);

    const foreignOrigin = await request.post('/api/logout', {
      headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrfFor(token) },
    });
    expect(foreignOrigin.status()).toBe(403);

    const ambient = await request.post('/api/logout', {
      headers: { cookie, 'x-csrf-token': csrfFor(token) },
    });
    expect(ambient.status()).toBe(403);

    const noToken = await request.post('/api/logout', {
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(noToken.status()).toBe(403);

    const wrongToken = await request.post('/api/logout', {
      headers: { cookie, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfFor('b'.repeat(43)) },
    });
    expect(wrongToken.status()).toBe(403);

    // The session is still alive after every refusal.
    const alive = await request.get('/api/me', { headers: { cookie } });
    expect(alive.status()).toBe(200);

    const accepted = await request.post('/api/logout', {
      headers: { cookie, 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfFor(token) },
    });
    expect(accepted.status()).toBe(204);
    expect(accepted.headers()['set-cookie']).toContain('Max-Age=0');
    const gone = await request.get('/api/me', { headers: { cookie } });
    expect(gone.status()).toBe(401);
  });

  test('a mutation handler refuses an unauthenticated request outright', async ({ request }) => {
    const response = await request.post('/api/logout', {
      headers: { 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'x' },
    });
    expect(response.status()).toBe(401);
  });

  test('a server action posted from a foreign origin is refused by the framework and by the action', async ({
    page,
    request,
  }) => {
    const { accounts } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const token =
      (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ??
      '';
    // A plain cross-origin form post to a page carrying server actions: Next
    // rejects the action invocation before it runs, and nothing signs out.
    const response = await request.post('/command-center', {
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      data: `csrfToken=${encodeURIComponent(csrfFor(token))}`,
      maxRedirects: 0,
    });
    expect(response.status()).not.toBe(303);
    const alive = await request.get('/api/me', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(alive.status()).toBe(200);
  });
});
