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
      'reader' | 'editor' | 'admin',
      {
        readonly username: string;
        readonly password: string;
        readonly id: string;
        readonly email: string;
      }
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

/** The last one-time code the local email path wrote for an address. */
export async function lastCodeFor(email: string): Promise<string> {
  const file = path.join(APP_ROOT, 'test-results', 'browser', 'email.jsonl');
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
  const messages = lines.map((line) => JSON.parse(line) as { to: string; text: string });
  const last = messages.filter((message) => message.to === email).at(-1);
  const code = /\b(\d{6})\b/u.exec(last?.text ?? '')?.[1];
  if (code === undefined) throw new Error(`no code was written for ${email}`);
  return code;
}

/** Signs in by one-time code: the address, then the code the local email path wrote. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.waitForURL('**/login/verify**');
  await page.getByLabel('Code').fill(await lastCodeFor(email));
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
