import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { syntheticAccount } from '../../test/synthetic-accounts.ts';
import { isDashboardError } from '../errors.ts';
import { assertSeedAccount, openMemoryStores, SEED_FORMAT } from './memory-store.ts';

let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cas-dashboard-seed-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('memory stores', () => {
  it('persists accounts to the seed file with mode 600 and reloads them', async () => {
    const seed = path.join(directory, 'seed.json');
    const stores = await openMemoryStores(seed);
    const editor = await syntheticAccount('editor');
    await stores.accounts.insert(editor.record);
    const mode = (await stat(seed)).mode & 0o777;
    expect(mode).toBe(0o600);
    const text = await readFile(seed, 'utf8');
    expect(text).toContain(SEED_FORMAT);
    expect(text).not.toContain(editor.password);
    const reopened = await openMemoryStores(seed);
    expect((await reopened.accounts.findByUsername(editor.record.username))?.id).toBe(
      editor.record.id,
    );
  });

  it('refuses a duplicate username and a malformed seed', async () => {
    const stores = await openMemoryStores(null);
    const first = await syntheticAccount('editor', { username: 'syn_dup' });
    const second = await syntheticAccount('admin', { username: 'syn_dup' });
    await stores.accounts.insert(first.record);
    await expect(stores.accounts.insert(second.record)).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'account_exists',
    );
    const bad = path.join(directory, 'bad.json');
    await writeFile(bad, '{"format":"other","accounts":[]}', 'utf8');
    await expect(openMemoryStores(bad)).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'seed_format',
    );
    await writeFile(bad, 'not json', 'utf8');
    await expect(openMemoryStores(bad)).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'seed_not_json',
    );
  });

  it('validates every seed account as a closed record', async () => {
    const good = (await syntheticAccount('judge')).record;
    expect(assertSeedAccount(good)).toEqual(good);
    const codeOf = (value: unknown): string => {
      try {
        assertSeedAccount(value);
      } catch (error) {
        if (isDashboardError(error)) return error.code;
      }
      return 'accepted';
    };
    expect(codeOf({ ...good, extra: 1 })).toBe('seed_account_keys');
    expect(codeOf({ ...good, role: 'root' })).toBe('seed_account_role');
    expect(codeOf({ ...good, passwordHash: 'plaintext-synthetic' })).toBe('seed_account_hash');
    expect(
      codeOf({ ...good, passwordHash: good.passwordHash.replace('m=19456', 'm=9999999') }),
    ).toBe('seed_account_hash');
    expect(codeOf({ ...good, expiresAt: null })).toBe('seed_judge_expiry');
    expect(codeOf({ ...good, username: 'Bad Name' })).toBe('seed_account_username');
    expect(codeOf({ ...good, createdAt: 'yesterday' })).toBe('seed_account_created');
    expect(codeOf([])).toBe('seed_account_shape');
  });

  it('keeps sessions, audit events and draft revisions append-only', async () => {
    const stores = await openMemoryStores(null);
    await stores.audit.append({
      id: 'e1',
      at: '2026-09-10T00:00:00.000Z',
      kind: 'logout',
      outcome: 'success',
      code: 'x',
      actorAccountId: null,
      subjectAccountId: null,
      sessionId: null,
      networkKey: null,
      subjectId: null,
    });
    const [event] = await stores.audit.list(1);
    expect(Object.isFrozen(event)).toBe(true);
    await stores.drafts.append({
      draftKey: 'k',
      revision: 1,
      markdown: 'one',
      savedByAccountId: 'a',
      savedAt: '2026-09-10T00:00:00.000Z',
    });
    await expect(
      stores.drafts.append({
        draftKey: 'k',
        revision: 1,
        markdown: 'two',
        savedByAccountId: 'b',
        savedAt: '2026-09-10T00:00:01.000Z',
      }),
    ).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'draft_revision_conflict',
    );
    await expect(
      stores.drafts.append({
        draftKey: 'k',
        revision: 3,
        markdown: 'three',
        savedByAccountId: 'b',
        savedAt: '2026-09-10T00:00:01.000Z',
      }),
    ).rejects.toSatisfy(
      (error) => isDashboardError(error) && error.code === 'draft_revision_conflict',
    );
    expect((await stores.drafts.latest('k'))?.markdown).toBe('one');
    await stores.sessions.insert({
      id: 's1',
      accountId: 'a',
      tokenHash: 'h1',
      createdAt: '2026-09-10T00:00:00.000Z',
      lastSeenAt: '2026-09-10T00:00:00.000Z',
      absoluteExpiresAt: '2026-09-10T08:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
    });
    await expect(
      stores.sessions.insert({
        id: 's2',
        accountId: 'a',
        tokenHash: 'h1',
        createdAt: '2026-09-10T00:00:00.000Z',
        lastSeenAt: '2026-09-10T00:00:00.000Z',
        absoluteExpiresAt: '2026-09-10T08:00:00.000Z',
        revokedAt: null,
        revokedReason: null,
      }),
    ).rejects.toSatisfy((error) => isDashboardError(error) && error.code === 'session_exists');
  });
});
