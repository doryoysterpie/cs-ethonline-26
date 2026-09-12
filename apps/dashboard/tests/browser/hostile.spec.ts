import { expect, test } from '@playwright/test';

import { credentials, signIn } from './support.ts';

test.describe('hostile stored content', () => {
  test('a hostile stored title renders as inert, visible text for an editor', async ({ page }) => {
    const { accounts, seeded } = await credentials();
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await signIn(page, accounts.editor.username, accounts.editor.password);
    await page.goto(`/incidents/${seeded.clusteringRunId}/${seeded.hostileIncidentId}`);
    const cell = page.getByRole('cell', { name: /alert\('x'\)/u });
    await expect(cell).toBeVisible();
    const text = await cell.textContent();
    // The markup is text, the bidi override and the escape introducer are visible escapes.
    expect(text).toContain("<script>alert('x')</script>");
    expect(text).toContain('\\u202e');
    expect(text).toContain('\\x1b[31m');
    expect(text).toContain('<img src=x onerror=alert(2)>');
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.locator('td script').count()).toBe(0);
    expect(dialogs).toEqual([]);
    // The stored URL is shown as text, never as a link.
    expect(await page.locator('a[href*="seed.example"]').count()).toBe(0);
  });

  test('a hostile draft edit is rendered through the allowlist sanitizer', async ({ page }) => {
    const { accounts, seeded } = await credentials();
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const url = `/drafts/${seeded.evidenceRunId}?start=2026-09-02T00:00:00Z&end=2026-09-09T00:00:00Z`;
    await page.goto(url);
    const hostile = [
      '# Hostile draft',
      '',
      '<script>alert("draft")</script>',
      '',
      '<img src="https://evil.example/x.png" onerror="alert(1)">',
      '',
      '<svg onload="alert(2)"></svg>',
      '',
      '[js](javascript:alert(3)) and [ok](https://example.org/x)',
      '',
      '<iframe src="https://evil.example"></iframe>',
      '',
      '<a href="https://example.org" onclick="alert(4)">clicky</a>',
    ].join('\n');
    await page.getByLabel('Markdown').fill(hostile);
    await page.getByRole('button', { name: /^Save revision/u }).click();
    await page.waitForURL('**/drafts/**notice=saved**');
    const preview = page.locator('.markdown');
    await expect(preview).toContainText('Hostile draft');
    expect(await preview.locator('script, img, svg, iframe, object, embed').count()).toBe(0);
    const anchors = await preview.locator('a').evaluateAll((nodes) =>
      nodes.map((node) => ({
        href: node.getAttribute('href'),
        rel: node.getAttribute('rel'),
        onclick: node.getAttribute('onclick'),
      })),
    );
    // A refused protocol leaves an inert anchor without href; any href that survives is https.
    expect(
      anchors.every((anchor) => anchor.href === null || anchor.href.startsWith('https://')),
    ).toBe(true);
    expect(anchors.some((anchor) => anchor.href === 'https://example.org/x')).toBe(true);
    expect(anchors.every((anchor) => anchor.rel === 'noopener noreferrer nofollow')).toBe(true);
    expect(anchors.every((anchor) => anchor.onclick === null)).toBe(true);
    expect(anchors.some((anchor) => anchor.href?.startsWith('javascript:'))).toBe(false);
    expect(dialogs).toEqual([]);
    // The rendered preview carries no handler attribute. The editor's textarea
    // below it legitimately shows the stored source as escaped text, so the
    // check is scoped to the preview's markup rather than the whole page.
    const previewMarkup = await preview.evaluate((node) => node.innerHTML);
    expect(previewMarkup).not.toContain('onerror=');
    expect(previewMarkup).not.toContain('onload=');
    expect(previewMarkup).not.toContain('onclick=');
    expect(previewMarkup).not.toContain('javascript:');
    expect(previewMarkup).not.toContain('<script');
  });

  test('a draft body carrying a bidirectional override is refused before it is stored', async ({
    page,
  }) => {
    const { accounts, seeded } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    const url = `/drafts/${seeded.evidenceRunId}?start=2026-09-03T00:00:00Z&end=2026-09-10T00:00:00Z`;
    await page.goto(url);
    await page.getByLabel('Markdown').fill(`# ok ${String.fromCodePoint(0x202e)} reversed`);
    await page.getByRole('button', { name: /^Save revision/u }).click();
    await page.waitForURL('**notice=invalid**');
    await expect(page.getByText('The request was not valid.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save revision 1' })).toBeVisible();
  });
});
