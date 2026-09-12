import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isSheetsIntakeError, spreadsheetIdDigest } from '@cas/sheets-intake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { computePin, connectToWorkbook, loadWorkbookPolicy } from './connect.js';

/**
 * The connector fails closed, and it decides before it authenticates.
 *
 * The ordering assertion is the one that matters. A run pointed at the wrong
 * workbook must never present a credential: if the identifier check came after
 * the credential load, a misconfiguration would become an access attempt
 * against a file the owner did not authorize. These tests give the connector a
 * credential path that cannot exist, so a run that reaches the credential
 * stage fails with a different code than a run that stops at the policy.
 */

const AUTHORIZED = 'SyntheticAuthorized_0000000000000000000001';
const UNRELATED = 'SyntheticUnrelated_00000000000000000000002';

let temporary = '';
let unpinnedPolicy = '';
let pinnedPolicy = '';

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'cas-sheets-policy-'));
  unpinnedPolicy = path.join(temporary, 'unpinned.json');
  pinnedPolicy = path.join(temporary, 'pinned.json');
  await writeFile(
    unpinnedPolicy,
    JSON.stringify({ title: 'Cyberattack Sunday - RSS Intake', spreadsheetIdSha256: null }),
    'utf8',
  );
  await writeFile(
    pinnedPolicy,
    JSON.stringify({
      title: 'Cyberattack Sunday - RSS Intake',
      spreadsheetIdSha256: spreadsheetIdDigest(AUTHORIZED),
    }),
    'utf8',
  );
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

/**
 * The failing code, whichever taxonomy raised it. The connector's own refusals
 * are `SheetsIntakeError`; the worker's wrapper failures are `IngestionError`.
 */
const code = (error: unknown): string => {
  if (isSheetsIntakeError(error)) return error.code;
  if (isIngestionError(error)) return error.code;
  return String(error);
};

async function attempt(
  env: Record<string, string | undefined>,
  policyPath: string,
): Promise<unknown> {
  try {
    await connectToWorkbook({ env, policyPath, repositoryRoot: temporary });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the committed policy fails closed', () => {
  it('ships with no digest pinned, so nothing can be read yet', async () => {
    const policy = await loadWorkbookPolicy();
    expect(policy.title).toBe('Cyberattack Sunday - RSS Intake');
    expect(policy.spreadsheetIdSha256).toBeNull();
  });

  it('refuses every workbook while the digest is null', async () => {
    const error = await attempt(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED,
        GOOGLE_APPLICATION_CREDENTIALS: '/nowhere/key.json',
      },
      unpinnedPolicy,
    );
    expect(code(error)).toBe('workbook_not_pinned');
  });

  it('refuses an unauthorized identifier before loading any credential', async () => {
    const error = await attempt(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: UNRELATED,
        GOOGLE_APPLICATION_CREDENTIALS: '/nowhere/key.json',
      },
      pinnedPolicy,
    );
    // Not `credential_unreadable`: the policy decided first, and the
    // non-existent key was never opened.
    expect(code(error)).toBe('workbook_not_authorized');
  });

  it('reaches the credential stage only for the authorized identifier', async () => {
    const error = await attempt(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED,
        GOOGLE_APPLICATION_CREDENTIALS: '/nowhere/key.json',
      },
      pinnedPolicy,
    );
    expect(code(error)).toBe('credential_unreadable');
  });

  it('refuses a malformed or unreadable policy rather than defaulting', async () => {
    const malformed = path.join(temporary, 'malformed.json');
    await writeFile(malformed, 'not json', 'utf8');
    await expect(loadWorkbookPolicy(malformed)).rejects.toSatisfy(
      (error: unknown) => code(error) === 'policy_unreadable',
    );

    const wrongShape = path.join(temporary, 'shape.json');
    await writeFile(wrongShape, JSON.stringify({ title: 42 }), 'utf8');
    await expect(loadWorkbookPolicy(wrongShape)).rejects.toSatisfy(
      (error: unknown) => code(error) === 'policy_invalid',
    );

    await expect(loadWorkbookPolicy(path.join(temporary, 'absent.json'))).rejects.toSatisfy(
      (error: unknown) => code(error) === 'policy_unreadable',
    );
  });

  it('refuses a policy whose title is not the authorized file', async () => {
    const renamed = path.join(temporary, 'renamed.json');
    await writeFile(
      renamed,
      JSON.stringify({
        title: 'Some Other Workbook',
        spreadsheetIdSha256: spreadsheetIdDigest(AUTHORIZED),
      }),
      'utf8',
    );
    const error = await attempt(
      {
        GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED,
        GOOGLE_APPLICATION_CREDENTIALS: '/nowhere/key.json',
      },
      renamed,
    );
    expect(code(error)).toBe('policy_title_unexpected');
  });

  it('refuses a missing identifier or credential path before anything else', async () => {
    expect(code(await attempt({}, pinnedPolicy))).toBe('spreadsheet_id_missing');
    expect(code(await attempt({ GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED }, pinnedPolicy))).toBe(
      'credentials_missing',
    );
  });
});

describe('the pin command yields a digest and never the identifier', () => {
  it('computes the digest the policy file expects', () => {
    const pin = computePin({ GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED });
    expect(pin.digest).toBe(spreadsheetIdDigest(AUTHORIZED));
    expect(pin.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.shortDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('needs no credential, because it makes no request', () => {
    expect(() => computePin({ GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED })).not.toThrow();
  });

  it('produces nothing from which the identifier could be recovered', () => {
    const pin = computePin({ GOOGLE_SHEETS_SPREADSHEET_ID: AUTHORIZED });
    expect(JSON.stringify(pin)).not.toContain(AUTHORIZED);
    expect(JSON.stringify(pin)).not.toContain(AUTHORIZED.slice(0, 12));
  });
});
