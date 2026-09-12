import { expect, test } from '@playwright/test';

import { credentials, rawGet, signIn, SESSION_COOKIE } from './support.ts';

test.describe('role boundaries in the browser', () => {
  test('a judge sees sanitized views only: no queue, no administration, no source text, no mutation forms', async ({
    page,
  }) => {
    const { accounts, seeded } = await credentials();
    await signIn(page, accounts.judge.username, accounts.judge.password);
    await expect(page.getByRole('link', { name: 'Review queue' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Accounts and sessions' })).toHaveCount(0);

    const queue = await page.goto('/queue');
    expect(queue?.status()).toBe(403);
    await expect(page.getByRole('heading', { name: 'Forbidden' })).toBeVisible();
    const queueRun = await page.goto(`/queue/${seeded.classificationRunId}`);
    expect(queueRun?.status()).toBe(403);
    const admin = await page.goto('/admin/accounts');
    expect(admin?.status()).toBe(403);

    await page.goto(`/incidents/${seeded.clusteringRunId}/${seeded.hostileIncidentId}`);
    await expect(page.getByRole('heading', { name: /^Incident/u })).toBeVisible();
    await expect(page.getByText('Source text is not shown for this role')).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain('reversed');
    expect(html).not.toContain('Brightwater');
    expect(html).not.toContain('seed.example');
    await expect(page.getByRole('button', { name: 'Record merge' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record split' })).toHaveCount(0);

    await page.goto(`/evidence/${seeded.evidenceRunId}`);
    await expect(page.getByRole('heading', { name: /^Evidence run/u })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record decision' })).toHaveCount(0);
    await expect(
      page.getByText('A suggestion is not evidence until a named person accepts it.'),
    ).toBeVisible();

    await page.goto(
      `/drafts/${seeded.evidenceRunId}?start=2026-09-01T00:00:00Z&end=2026-09-08T00:00:00Z`,
    );
    await expect(page.getByRole('heading', { name: /^Draft for evidence run/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save revision/u })).toHaveCount(0);
    await expect(page.locator('.markdown')).toContainText('unpublished');
  });

  test('an editor reviews but cannot administer', async ({ page }) => {
    const { accounts, seeded } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    await expect(page.getByRole('link', { name: 'Review queue' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Accounts and sessions' })).toHaveCount(0);
    const admin = await page.goto('/admin/accounts');
    expect(admin?.status()).toBe(403);

    await page.goto(`/incidents/${seeded.clusteringRunId}/${seeded.hostileIncidentId}`);
    await expect(page.getByRole('button', { name: 'Record merge' })).toBeVisible();
    await expect(page.getByText('Source text is not shown for this role')).toHaveCount(0);

    // A draft edit through the real form, with the session-bound CSRF token the page carries.
    await page.goto(
      `/drafts/${seeded.evidenceRunId}?start=2026-09-01T00:00:00Z&end=2026-09-08T00:00:00Z`,
    );
    await page.getByLabel('Markdown').fill('# Edited in the browser\n\nA plain sentence.');
    await page.getByRole('button', { name: 'Save revision 1' }).click();
    await page.waitForURL('**/drafts/**notice=saved**');
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.locator('.markdown')).toContainText('Edited in the browser');
    await expect(page.getByRole('button', { name: 'Save revision 2' })).toBeVisible();
  });

  test('an administrator provisions, disables and revokes through the page', async ({
    page,
    browser,
  }) => {
    const { accounts } = await credentials();
    await signIn(page, accounts.admin.username, accounts.admin.password);
    await page.goto('/admin/accounts');
    await expect(page.getByRole('heading', { name: 'Accounts and sessions' })).toBeVisible();
    const username = `syn_ui_${Date.now().toString(36)}`;
    const password = `browser-synthetic-${Date.now().toString(36)}-passphrase`;
    await page.getByLabel(/^Username/u).fill(username);
    await page.getByLabel('Role').last().selectOption('editor');
    await page.getByLabel('Password (12 to 128 characters)').fill(password);
    await page.getByLabel('Password again').fill(password);
    await page.getByRole('button', { name: 'Provision' }).click();
    await page.waitForURL('**/admin/accounts?notice=provisioned');
    await expect(page.getByText('Account provisioned.')).toBeVisible();
    // The accounts table is the first table; the audit table below also names the account.
    const accountsTable = page.getByRole('table').first();
    const row = accountsTable.getByRole('row', { name: new RegExp(username, 'u') });
    await expect(row).toBeVisible();

    // The new account can sign in elsewhere.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, username, password);

    // Disabling it ends that session at once.
    await page.goto('/admin/accounts');
    await page
      .getByRole('table')
      .first()
      .getByRole('row', { name: new RegExp(username, 'u') })
      .getByRole('button', { name: 'Disable' })
      .click();
    await page.waitForURL('**/admin/accounts?notice=disabled');
    const me = await otherPage.request.get('/api/me');
    expect(me.status()).toBe(401);
    await other.close();

    // The audit trail names kinds and actors, never a password.
    const html = await page.content();
    expect(html).toContain('account_provisioned');
    expect(html).toContain('account_disabled');
    expect(html).not.toContain(password);
    expect(html).not.toContain('$argon2');
  });

  test('the same protected URL is rendered separately per user, never from a shared cache', async ({
    browser,
    request,
  }) => {
    const { accounts, seeded } = await credentials();
    const url = `/incidents/${seeded.clusteringRunId}/${seeded.hostileIncidentId}`;
    const judge = await browser.newContext();
    const judgePage = await judge.newPage();
    await signIn(judgePage, accounts.judge.username, accounts.judge.password);
    const judgeResponse = await judgePage.goto(url);
    expect(judgeResponse?.headers()['cache-control']).toContain('no-store');
    const judgeHtml = await judgePage.content();
    expect(judgeHtml).toContain('Source text is not shown for this role');

    const editor = await browser.newContext();
    const editorPage = await editor.newPage();
    await signIn(editorPage, accounts.editor.username, accounts.editor.password);
    const editorResponse = await editorPage.goto(url);
    expect(editorResponse?.headers()['cache-control']).toContain('no-store');
    const editorHtml = await editorPage.content();
    expect(editorHtml).not.toContain('Source text is not shown for this role');
    expect(editorHtml).toContain('Record merge');

    // And a judge visiting after the editor still gets the judge rendering.
    await judgePage.goto(url);
    expect(await judgePage.content()).toContain('Source text is not shown for this role');

    const judgeToken =
      (await judge.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
    const direct = await rawGet(request, url, { cookie: `${SESSION_COOKIE}=${judgeToken}` });
    expect(direct.status()).toBe(200);
    expect(await direct.text()).toContain('Source text is not shown for this role');
    await judge.close();
    await editor.close();
  });
});
