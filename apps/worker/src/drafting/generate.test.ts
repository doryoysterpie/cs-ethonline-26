import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DraftRequest } from '@cas/drafting';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { publishDraft } from './generate.js';

/**
 * The safe draft publisher's attack matrix (audit finding F3), offline.
 *
 * Every case that could put a file somewhere other than inside the authorised
 * root, or leave half a draft behind, is attempted here against a disposable
 * directory tree, and after each one the tree is walked to prove that no file
 * appeared outside the root and no partial pair remains anywhere.
 *
 * Nothing here touches a database or a real draft root. The request is
 * synthetic and its text is invented.
 */

function request(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    draftId: 'draft-0001',
    periodStart: '2026-06-21T00:00:00.000Z',
    periodEnd: '2026-06-28T00:00:00.000Z',
    dataOrigin: 'fixture',
    incidents: [
      {
        incidentId: 'incident-1',
        clusteringRunId: 'run-1',
        batchId: 'batch-1',
        evidenceRunId: 'evidence-1',
        dataOrigin: 'fixture',
        evidenceState: 'reported_only',
        graphEvidence: 'absent',
        onChainSubject: false,
        headline: 'A synthetic organisation reports an incident',
        sources: [
          {
            sourceRowId: 'row-1',
            publisher: 'Synthetic Wire',
            url: 'https://synthetic.example/1',
            publishedAt: '2026-06-22T00:00:00.000Z',
          },
        ],
        claims: [
          {
            claimId: 'row-1',
            text: 'A synthetic organisation reports an incident',
            confidence: 'reported',
            sourceRowIds: ['row-1'],
            victimName: null,
            victimSupport: 'none',
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Every regular file under `directory`, relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(path.relative(directory, full));
    }
  }
  await walk(directory);
  return found.sort();
}

const code = (error: unknown): string => (isIngestionError(error) ? error.code : String(error));

describe('publishDraft', () => {
  let outside = '';
  let root = '';

  beforeEach(async () => {
    // Resolved once: the publisher refuses any symbolic link in the root's
    // path, and the platform's temporary directory is reached through one.
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cas-publish-')));
    root = path.join(outside, 'root');
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  /** Nothing outside `root`, and inside it only complete pairs. */
  async function assertContained(): Promise<void> {
    const all = await filesUnder(outside);
    for (const file of all) expect(file.startsWith('root' + path.sep), file).toBe(true);
    const rootExists = await lstat(root).catch(() => null);
    if (rootExists === null) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      expect(entry.name.startsWith('.staging-'), entry.name).toBe(false);
      if (!entry.isDirectory()) continue;
      const inside = (await readdir(path.join(root, entry.name))).sort();
      expect(inside, entry.name).toEqual(['draft.md', 'provenance.json']);
    }
  }

  it('publishes a complete pair under the root, deterministically', async () => {
    const first = await publishDraft(request(), { root });
    expect(path.basename(first.directory)).toBe('cyberattack-sunday-2026-06-21-draft-0001');
    expect(await readdir(first.directory)).toEqual(['draft.md', 'provenance.json']);
    const markdown = await readFile(first.draftPath, 'utf8');
    expect(markdown).toContain('This draft requires human review');
    // The same request under a second identifier differs only by that
    // identifier, in the provenance line that names it.
    const again = await publishDraft(request({ draftId: 'draft-0002' }), { root });
    expect(await readFile(again.draftPath, 'utf8')).toBe(
      markdown.replace('draft-0001', 'draft-0002'),
    );
    const sidecars = [first, again].map(async (published) =>
      readFile(published.sidecarPath, 'utf8'),
    );
    const [firstSidecar, secondSidecar] = await Promise.all(sidecars);
    expect(secondSidecar).toBe((firstSidecar ?? '').replace('draft-0001', 'draft-0002'));
    await assertContained();
  });

  it('refuses traversal, separators, absolute paths and unsafe names in the identifier', async () => {
    for (const draftId of [
      '../../escaped',
      '..',
      'a/b',
      'a\\b',
      '/tmp/escaped',
      'a%2f..%2fb',
      'a..b',
      '.hidden',
      'UPPER-case',
      'has space',
      'x',
      'y'.repeat(65),
      '',
    ]) {
      await expect(publishDraft(request({ draftId }), { root }), draftId).rejects.toSatisfy(
        (error: unknown) => code(error) === 'draft_identity_invalid',
      );
    }
    await assertContained();
  });

  it('refuses traversal and invalid calendar dates in the period', async () => {
    for (const periodStart of [
      '../../2026-06-21T00:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-00-10T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      '1999-06-21T00:00:00.000Z',
      '2026-06-21',
      'not a date',
      '2026-06-21X00:00:00Z',
    ]) {
      await expect(publishDraft(request({ periodStart }), { root }), periodStart).rejects.toSatisfy(
        (error: unknown) => code(error) === 'draft_identity_invalid',
      );
    }
    // A leap day is a real date.
    const leap = await publishDraft(request({ periodStart: '2028-02-29T00:00:00.000Z' }), { root });
    expect(path.basename(leap.directory)).toBe('cyberattack-sunday-2028-02-29-draft-0001');
    await assertContained();
  });

  it('refuses a symbolic link as the root', async () => {
    const elsewhere = path.join(outside, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, root);
    await expect(publishDraft(request(), { root })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_root_symlink',
    );
    expect(await filesUnder(elsewhere)).toEqual([]);
  });

  it('refuses a symbolic link as an intermediate directory', async () => {
    const elsewhere = path.join(outside, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(outside, 'link'));
    const linked = path.join(outside, 'link', 'root');
    await expect(publishDraft(request(), { root: linked })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_root_symlink',
    );
    expect(await filesUnder(elsewhere)).toEqual([]);
  });

  it('refuses a root that exists as a file', async () => {
    await writeFile(root, 'not a directory', 'utf8');
    await expect(publishDraft(request(), { root })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_root_not_directory',
    );
  });

  it('never overwrites an existing draft, whatever sits at the destination', async () => {
    const first = await publishDraft(request(), { root });
    const before = await readFile(first.draftPath, 'utf8');
    await expect(publishDraft(request(), { root })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_exists',
    );
    expect(await readFile(first.draftPath, 'utf8')).toBe(before);

    // A plain file, and a symbolic link, at a fresh destination.
    await writeFile(
      path.join(root, 'cyberattack-sunday-2026-06-21-draft-0002'),
      'occupied',
      'utf8',
    );
    await expect(publishDraft(request({ draftId: 'draft-0002' }), { root })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_exists',
    );
    await symlink(outside, path.join(root, 'cyberattack-sunday-2026-06-21-draft-0003'));
    await expect(publishDraft(request({ draftId: 'draft-0003' }), { root })).rejects.toSatisfy(
      (error: unknown) => code(error) === 'draft_exists',
    );
    expect(
      (await filesUnder(outside)).filter((file) => !file.startsWith('root' + path.sep)),
    ).toEqual([]);
  });

  it('publishes neither file when the second write fails, and leaves no staging behind', async () => {
    let staged: string[] = [];
    await expect(
      publishDraft(request(), {
        root,
        hooks: {
          beforeSidecarWrite: async () => {
            // The first file is on disk in staging at this moment.
            staged = await filesUnder(root);
            throw new Error('injected failure between the two writes');
          },
        },
      }),
    ).rejects.toThrowError(/injected failure/u);
    expect(staged.some((file) => file.endsWith('draft.md'))).toBe(true);
    expect(await readdir(root)).toEqual([]);
    await assertContained();
    // And the identifier is still free afterwards.
    await publishDraft(request(), { root });
    await assertContained();
  });

  it('creates the root with restrictive permissions when it is missing', async () => {
    const nested = path.join(root, 'a', 'b');
    await publishDraft(request(), { root: nested });
    for (const directory of [root, path.join(root, 'a'), nested]) {
      const stat = await lstat(directory);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o700);
    }
  });
});
