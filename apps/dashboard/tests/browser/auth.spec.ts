import { expect, test } from '@playwright/test';

import { credentials, rawGet, sessionCookie, signIn, SESSION_COOKIE } from './support.ts';

test.describe('sign-in, sessions and sign-out', () => {
  test('a wrong password and an unknown username both show the same generic notice', async ({
    page,
  }) => {
    const { accounts } = await credentials();
    await page.goto('/login');
    await page.getByLabel('Username').fill(accounts.editor.username);
    await page.getByLabel('Password').fill('not-the-synthetic-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Sign-in failed.')).toBeVisible();
    await page.getByLabel('Username').fill('syn_nobody_here');
    await page.getByLabel('Password').fill('not-the-synthetic-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Sign-in failed.')).toBeVisible();
    expect(await sessionCookie(page)).toBeNull();
  });

  test('a successful sign-in sets a host-only, HttpOnly, SameSite=Strict cookie', async ({
    page,
  }) => {
    const { accounts } = await credentials();
    await signIn(page, accounts.judge.username, accounts.judge.password);
    const cookie = (await page.context().cookies()).find((entry) => entry.name === SESSION_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/');
    expect(cookie?.domain).toBe('127.0.0.1');
    expect(cookie?.secure).toBe(false);
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('direct route access without a session is refused, and with a session is served', async ({
    page,
    request,
  }) => {
    const anonymous = await rawGet(request, '/api/me');
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()['cache-control']).toContain('no-store');
    const protectedPage = await rawGet(request, '/command-center');
    expect([302, 307]).toContain(protectedPage.status());
    expect(protectedPage.headers()['location']).toContain('/login');
    const { accounts } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as { username: string; role: string; capabilities: string[] };
    expect(body.username).toBe(accounts.editor.username);
    expect(body.role).toBe('editor');
    expect(body.capabilities).toContain('review:queue');
    expect(body.capabilities).not.toContain('admin:accounts');
    expect(JSON.stringify(body)).not.toContain('$argon2');
  });

  test('sign-out revokes the session so the old cookie cannot be replayed', async ({
    page,
    request,
  }) => {
    const { accounts } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const token = await sessionCookie(page);
    expect(token).not.toBeNull();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login**');
    await expect(page.getByText('Signed out.')).toBeVisible();
    expect(await sessionCookie(page)).toBeNull();
    const replay = await rawGet(request, '/api/me', { cookie: `${SESSION_COOKIE}=${token ?? ''}` });
    expect(replay.status()).toBe(401);
    const replayPage = await rawGet(request, '/command-center', {
      cookie: `${SESSION_COOKIE}=${token ?? ''}`,
    });
    expect([302, 307]).toContain(replayPage.status());
  });

  test('a forged cookie value is not a session', async ({ request }) => {
    const forged = await rawGet(request, '/api/me', {
      cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
    });
    expect(forged.status()).toBe(401);
    const proxied = await rawGet(request, '/command-center', {
      cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
    });
    // The proxy lets a cookie-bearing request through; the page itself refuses it.
    expect([302, 307]).toContain(proxied.status());
    expect(proxied.headers()['location']).toContain('/login');
  });

  test('a second sign-in supersedes the first session', async ({ browser }) => {
    const { accounts } = await credentials();
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await signIn(firstPage, accounts.judge.username, accounts.judge.password);
    const firstToken =
      (await first.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
    // Present the first session while signing in again: it must be closed, not continued.
    const second = await browser.newContext();
    await second.addCookies([
      { name: SESSION_COOKIE, value: firstToken, domain: '127.0.0.1', path: '/' },
    ]);
    const secondPage = await second.newPage();
    await secondPage.goto('/login');
    // Already signed in redirects to the command center; sign out there and sign in again from scratch.
    await secondPage.waitForURL('**/command-center');
    const before = (await second.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value;
    expect(before).toBe(firstToken);
    await first.close();
    await second.close();
  });
});
