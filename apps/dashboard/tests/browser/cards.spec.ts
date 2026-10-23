import { openDatabase, parseDatabaseConfig } from '@cas/database';
import { expect, test } from '@playwright/test';

import { credentials, signIn } from './support.ts';

/**
 * The story card end to end (CAS-009, D48): the launcher published a
 * round-up and made a card for its first story through the data-access
 * layer; a browser with no session opens it here, as anyone with the
 * address would.
 */
async function views(schema: string, id: string): Promise<number> {
  const db = openDatabase(parseDatabaseConfig(process.env, { schema }), { maxConnections: 1 });
  try {
    const result = await db.withClient((client) =>
      client.query<{ views: string }>(
        `SELECT views::text AS views FROM story_cards WHERE id = $1`,
        [id],
      ),
    );
    return Number(result.rows[0]?.views ?? '-1');
  } finally {
    await db.end();
  }
}

test.describe('story cards', () => {
  test('a signed-out browser opens a card: the published headline and its publishers, never indexed, the preview tags, one counted view', async ({
    browser,
  }) => {
    const { cards, schema } = await credentials();
    const id = cards.roundup;
    const context = await browser.newContext();
    expect(await context.cookies()).toEqual([]);
    const page = await context.newPage();
    const before = await views(schema, id);
    const response = await page.goto(`/cards/${id}`);
    expect(response?.status()).toBe(200);
    expect(page.url()).toContain(`/cards/${id}`);
    const headers = response?.headers() ?? {};
    expect(headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    await expect(page.getByRole('heading', { level: 1, name: 'Card headline 1' })).toBeVisible();
    await expect(page.getByText(/^Reported by /u)).toBeVisible();
    const meta = (selector: string) => page.locator(selector).getAttribute('content');
    expect(await meta('meta[name="robots"]')).toBe('noindex, nofollow');
    expect(await meta('meta[property="og:title"]')).toBe('Card headline 1');
    expect(await meta('meta[property="og:image"]')).toBe(
      `https://dashboard.example.org/cards/${id}/image.png`,
    );
    expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
    // Both preview images resolve under /cards/, as absolute addresses (the owner's condition).
    expect(await meta('meta[name="twitter:image"]')).toBe(
      `https://dashboard.example.org/cards/${id}/image.png`,
    );
    // The allowlist: no summary, no source address, no status block, no sign-in shell.
    const html = await page.content();
    expect(html).not.toContain('A summary the card never carries');
    expect(html).not.toMatch(/https?:\/\/seed\./u);
    await expect(page.locator('.status')).toHaveCount(0);
    // The image on the page loaded from the same origin, 1,200 by 630.
    const image = page.locator('img.card-image');
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(
      1200,
    );
    // One origin view for one page load, the metadata and the page sharing one read.
    expect(await views(schema, id)).toBe(before + 1);
    await context.close();
  });

  test('the card’s images are served without a session, cacheable for five minutes, and an unknown address is not found', async ({
    request,
  }) => {
    const { cards } = await credentials();
    const id = cards.roundup;
    const png = await request.get(`/cards/${id}/image.png`);
    expect(png.status()).toBe(200);
    expect(png.headers()['content-type']).toBe('image/png');
    expect(png.headers()['cache-control']).toBe('public, max-age=300');
    expect(png.headers()['x-robots-tag']).toBe('noindex, nofollow');
    expect((await png.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const svg = await request.get(`/cards/${id}/image.svg`);
    expect(svg.status()).toBe(200);
    expect(svg.headers()['content-type']).toContain('image/svg+xml');
    expect(svg.headers()['content-disposition']).toContain('attachment');
    const body = await svg.text();
    expect(body).toContain('Card headline 1');
    expect(body).not.toMatch(/href|<script|url\(/u);
    // The robots file lets every agent but the named AI crawlers reach cards, and nothing else.
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('User-agent: *\nAllow: /cards/\nDisallow: /\n');
    expect(robots).toContain('User-agent: GPTBot\nDisallow: /\n');
    for (const path of [
      `/cards/${'A'.repeat(22)}`,
      '/cards/not-a-card',
      `/cards/${'A'.repeat(22)}/image.png`,
    ]) {
      const missing = await request.get(path, { maxRedirects: 0 });
      expect(missing.status(), path).toBe(404);
    }
  });

  test('a signed-in reader sees the published round-up’s stories, each with a card button', async ({
    page,
  }) => {
    const { accounts, cards } = await credentials();
    await signIn(page, accounts.reader.email);
    await page.goto(`/published/${cards.weekRunId}?category=cyberattack&output=roundup`);
    await expect(page.getByRole('heading', { level: 3, name: 'Share a story' })).toBeVisible();
    for (const headline of ['Card headline 1', 'Card headline 2', 'Card headline 3']) {
      await expect(page.getByRole('cell', { name: headline, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Make a card' })).toHaveCount(3);
  });
});
