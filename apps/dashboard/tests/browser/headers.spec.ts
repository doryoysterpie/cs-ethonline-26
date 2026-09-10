import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { APP_ROOT, credentials, rawGet, signIn } from './support.ts';

async function walk(directory: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

test.describe('browser controls', () => {
  test('every response carries the strict policy and baseline headers, without HSTS locally', async ({
    request,
  }) => {
    for (const url of ['/login', '/command-center', '/api/me']) {
      const response = await rawGet(request, url);
      const headers = response.headers();
      const csp = headers['content-security-policy'] ?? '';
      expect(csp, url).toContain("default-src 'none'");
      expect(csp, url).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/u);
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(csp, url).toContain("base-uri 'none'");
      expect(csp, url).toContain("form-action 'self'");
      expect(csp, url).not.toContain('unsafe-inline');
      expect(csp, url).not.toContain('unsafe-eval');
      expect(headers['x-content-type-options'], url).toBe('nosniff');
      expect(headers['x-frame-options'], url).toBe('DENY');
      expect(headers['referrer-policy'], url).toBe('no-referrer');
      expect(headers['permissions-policy'], url).toContain('camera=()');
      expect(headers['cross-origin-opener-policy'], url).toBe('same-origin');
      expect(headers['cache-control'], url).toContain('no-store');
      expect(headers['strict-transport-security'], url).toBeUndefined();
      expect(headers['x-powered-by'], url).toBeUndefined();
    }
  });

  test('the page runs under the nonce policy without a policy violation', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) violations.push(message.text());
    });
    const { accounts } = await credentials();
    await signIn(page, accounts.judge.username, accounts.judge.password);
    await page.goto('/incidents');
    await expect(page.getByRole('heading', { name: 'Incident explorer' })).toBeVisible();
    expect(violations).toEqual([]);
    const nonces = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script')).map(
        (script) => script.nonce || script.src.length > 0,
      ),
    );
    expect(nonces.every(Boolean)).toBe(true);
  });

  test('the production build ships no browser source map and no secret-shaped string', async () => {
    const staticRoot = path.join(APP_ROOT, '.next', 'static');
    const files = await walk(staticRoot);
    expect(files.some((file) => file.endsWith('.map'))).toBe(false);
    const scripts = files.filter((file) => file.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const file of scripts) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toContain('$argon2');
      expect(text, file).not.toContain('DATABASE_URL');
      expect(text, file).not.toContain('postgres://');
      expect(text, file).not.toContain('postgresql://');
      expect(text, file).not.toContain('DASHBOARD_MEMORY_STORE_SEED');
      expect(text, file).not.toContain('cas_test_');
      expect(text, file).not.toContain('passwordHash');
    }
  });

  test('rendered pages carry no hash, connection string or session token for any role', async ({
    browser,
  }) => {
    const { accounts, seeded } = await credentials();
    for (const role of ['judge', 'editor', 'admin'] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await signIn(page, accounts[role].username, accounts[role].password);
      const token =
        (await context.cookies()).find((cookie) => cookie.name === 'cas_session')?.value ?? '';
      for (const url of [
        '/command-center',
        `/incidents/${seeded.clusteringRunId}`,
        `/evidence/${seeded.evidenceRunId}`,
        role === 'admin' ? '/admin/accounts' : '/anomaly',
      ]) {
        await page.goto(url);
        const html = await page.content();
        expect(html, `${role} ${url}`).not.toContain('$argon2');
        expect(html, `${role} ${url}`).not.toContain('postgres');
        expect(html, `${role} ${url}`).not.toContain('DATABASE_URL');
        expect(html, `${role} ${url}`).not.toContain(token);
        expect(html, `${role} ${url}`).not.toContain(accounts[role].password);
      }
      await context.close();
    }
  });
});
