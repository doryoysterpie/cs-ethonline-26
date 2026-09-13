import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

export interface Credentials {
  readonly schema: string;
  readonly seeded: {
    readonly batchId: string;
    readonly classificationRunId: string;
    readonly clusteringRunId: string;
    readonly signalRunIds: readonly string[];
    readonly evidenceRunId: string;
    readonly incidentIds: readonly string[];
    readonly hostileIncidentId: string;
    readonly subjectIncidentId: string;
  };
  readonly accounts: Readonly<
    Record<
      'judge' | 'editor' | 'admin',
      { readonly username: string; readonly password: string; readonly id: string }
    >
  >;
}

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function credentials(): Promise<Credentials> {
  return JSON.parse(
    await readFile(path.join(APP_ROOT, 'test-results', 'browser', 'credentials.json'), 'utf8'),
  ) as Credentials;
}

export const SESSION_COOKIE = 'cas_session';

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/command-center');
  await expect(page.getByRole('heading', { name: 'Command center' })).toBeVisible();
}

export async function sessionCookie(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? null;
}

/** A raw GET that does not follow redirects. */
export async function rawGet(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string> = {},
) {
  return request.get(url, { maxRedirects: 0, headers });
}
