import { expect, test } from '@playwright/test';

/**
 * The transition from the email screen to the code screen.
 *
 * Regression coverage for a real production defect: `/login/verify` was
 * never added to the proxy's public-path allowlist, so the proxy's own
 * cookie-presence redirect bounced the pre-session verify screen straight
 * back to `/login` before its page component ever ran, even though the
 * request-code action itself had already succeeded and sent the email. The
 * URL bar showed `/login/verify`; the rendered page was still the email
 * form. No unit test catches this, because it lives entirely in the proxy's
 * routing decision, not in the action or the page.
 */
test.describe('the email-to-code transition', () => {
  test('an approved-shaped email reaches the code screen, with no email field there and nothing sensitive in the URL', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('info.ma37abi@gmail.com');
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.waitForURL('**/login/verify**');
    expect(page.url()).not.toContain('info.ma37abi');
    expect(page.url()).not.toMatch(/[0-9]{6}/);
    await expect(page.getByLabel('Code')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
  });

  test('an unapproved email follows the exact same visible transition', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody-approved@example.com');
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.waitForURL('**/login/verify**');
    expect(page.url()).not.toContain('nobody-approved');
    await expect(page.getByLabel('Code')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
  });
});
