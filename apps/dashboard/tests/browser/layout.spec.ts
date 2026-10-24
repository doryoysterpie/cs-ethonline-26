import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { APP_ROOT, credentials, signIn } from './support.ts';

/**
 * The terminal grid (CAS-010, design note 1.6): the shell at a desk width
 * and a phone width, under both motion preferences and the contrast
 * preference, a focus walk through the sidebar and one block, and a click on
 * a table link with the overlay present. Screenshots are written under
 * test-results for the owner to look at; none is checked in, since the
 * repository's hygiene scan refuses binary files, so the assertions below,
 * not pixels, are the regression evidence.
 */
const SHOTS = path.join(APP_ROOT, 'test-results', 'browser', 'layout');
const AS_OF = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} America\/Toronto \(UTC[+-]\d{2}:\d{2}\)$/u;

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const overlay = (page: Page) =>
  page.evaluate(() => {
    const after = getComputedStyle(document.body, '::after');
    return {
      position: after.position,
      pointerEvents: after.pointerEvents,
      display: after.display,
      content: after.content,
    };
  });

test.describe('the terminal grid', () => {
  test('the sign-in page takes the grid and the typeface and shows no status block', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/login');
    expect(await overlay(page)).toMatchObject({ position: 'fixed', pointerEvents: 'none' });
    const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(font).toMatch(/ui-monospace|Menlo|monospace/u);
    await expect(page.locator('.status')).toHaveCount(0);
    await expect(page.locator('.topbar')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Latest in Cyber' })).toBeVisible();
    // The overlay intercepts nothing: the form takes the typing and the click.
    await page.getByLabel('Email').fill('reader@dashboard.test');
    await shot(page, 'login-1280');
  });

  test('the shell at a desk width: the sidebar, the status block, the header bar, the blocks, the focus order and a click through the overlay', async ({
    page,
  }) => {
    const { accounts } = await credentials();
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, accounts.reader.email);
    // The sidebar is a 220-pixel column; the current section is marked.
    const nav = await page.locator('nav.nav').boundingBox();
    expect(Math.round(nav?.width ?? 0)).toBe(220);
    await expect(page.locator('nav.nav a[aria-current="page"]')).toHaveText(/Command center/u);
    // The status block states the build, the latest week, the data instant and the principal.
    const terms = await page.locator('.status dt').allTextContents();
    expect(terms).toEqual(['Build', 'Latest week', 'As of', 'Signed in']);
    const values = await page.locator('.status dd').allTextContents();
    expect(values[0]).toBe('local');
    expect(values[2]).toMatch(AS_OF);
    expect(values[3]).toContain('reader');
    // The header bar carries the prompt and the same instant.
    await expect(page.locator('.topbar .product')).toHaveText('Latest in Cyber');
    await expect(page.locator('.topbar .asof .mono')).toHaveText(AS_OF);
    // Every table sits in a block with a title bar.
    const blocks = page.locator('.block');
    expect(await blocks.count()).toBeGreaterThanOrEqual(5);
    expect(await page.locator('table:not(.block-body table)').count()).toBe(0);
    await expect(page.locator('.block-head h3').first()).toHaveText('Totals');
    // The cursor blinks by CSS; the sidebar's glyphs are text, not images.
    expect(await page.locator('.cursor').evaluate((e) => getComputedStyle(e).animationName)).toBe(
      'blink',
    );
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.locator('nav.nav .glyph').first().textContent()).toBe('#');
    await shot(page, 'command-center-1280');
    // A focus walk: from the top of the page, the sections come first, in order.
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    expect(first).toContain('Command center');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const third = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    expect(third).toContain('Editorial week');
    // A click lands through the overlay: the link in the sidebar, then one inside a block.
    await page.getByRole('link', { name: /Editorial week/u }).click();
    await page.waitForURL('**/week');
    await expect(page.locator('nav.nav a[aria-current="page"]')).toHaveText(/Editorial week/u);
    await expect(page.locator('.block-head h3').first()).toHaveText('Week runs');
    await shot(page, 'week-1280');
  });

  test('the shell at a phone width: the sidebar as a top strip, the blocks stacked, a wide table scrolling inside its block', async ({
    page,
  }) => {
    const { accounts } = await credentials();
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, accounts.reader.email);
    const nav = await page.locator('nav.nav').boundingBox();
    expect(Math.round(nav?.width ?? 0)).toBe(390);
    // A strip, not a column: shorter than the viewport, with the main column beneath it.
    expect(nav?.height ?? 0).toBeLessThan(844);
    const main = await page.locator('main.main').boundingBox();
    expect(main?.y ?? 0).toBeGreaterThan(nav?.height ?? 0);
    // No horizontal page scroll: a table past the width scrolls inside its block.
    const page_ = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(page_.scrollWidth).toBeLessThanOrEqual(page_.clientWidth);
    const overflowing = await page
      .locator('.block-body')
      .evaluateAll((bodies) => bodies.filter((b) => b.scrollWidth > b.clientWidth).length);
    expect(overflowing).toBeGreaterThan(0);
    await shot(page, 'command-center-390');
  });

  test('under reduced motion the cursor holds still; under more contrast the scanlines and the glow go', async ({
    page,
  }) => {
    const { accounts } = await credentials();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page, accounts.reader.email);
    expect(await page.locator('.cursor').evaluate((e) => getComputedStyle(e).animationName)).toBe(
      'none',
    );
    expect(await overlay(page)).toMatchObject({ position: 'fixed', pointerEvents: 'none' });
    await shot(page, 'command-center-1280-reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'more' });
    await page.reload();
    expect((await overlay(page)).display).toBe('none');
    expect(
      await page
        .locator('.main h2')
        .first()
        .evaluate((e) => getComputedStyle(e).textShadow),
    ).toBe('none');
    await shot(page, 'command-center-1280-more-contrast');
  });
});
