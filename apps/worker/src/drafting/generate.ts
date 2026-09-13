import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRAFT_MARKDOWN_NAME,
  DRAFT_SIDECAR_NAME,
  draftDirectoryName,
  generateDraft,
  serializeProvenance,
  type DraftRequest,
  type GeneratedDraft,
} from '@cas/drafting';

import { IngestionError } from '../editorial/errors.js';

/**
 * Publishing a generated draft to disk (audit finding F3).
 *
 * Decision D3 is provisional and its conservative reading is implemented
 * here: a dated, identified directory under one authorised root, and an
 * existing draft is never overwritten. What the audit found was that the
 * previous writer took any directory a caller named, followed a symbolic link
 * to wherever it pointed, and joined a raw identifier onto the path, so a
 * draft could be written outside the directory it was asked to write in. None
 * of that is possible now, and each refusal is the filesystem's rather than a
 * check that another writer could slip between:
 *
 *   - The root is fixed by this module, not by the caller. A test may name a
 *     root; the command line cannot.
 *   - Every existing component of the root is inspected with `lstat` and must
 *     be a real directory. A symbolic link anywhere in the path, the root
 *     itself included, refuses publication. Missing tail components are
 *     created one at a time with mode 0700 and inspected the same way.
 *   - The draft identifier and the date are validated by `@cas/drafting`
 *     against strict allowlists before they become a path component, so
 *     `..`, a separator, an encoded separator, an absolute path or an unsafe
 *     name never reach `path.join`.
 *   - Both files are written into a freshly created staging directory with
 *     exclusive creation (`O_EXCL`, which also refuses a planted symbolic
 *     link) and mode 0600, flushed with `fsync` and closed.
 *   - Only once both writes succeeded is the staging directory renamed onto
 *     the final one, atomically. A non-empty final directory makes the rename
 *     fail, so a published pair is never replaced. If either write fails,
 *     neither file is published and the staging directory is removed.
 *
 * No publication of any other kind happens: the file is a draft, marked
 * unpublished, for a human to read.
 */

/** The one authorised root: `output/drafts/` at the repository root, ignored by Git. */
export const DRAFT_ROOT = fileURLToPath(new URL('../../../../output/drafts/', import.meta.url));

export interface PublishDraftOptions {
  /** A root other than the authorised one. Tests only; the command line never sets it. */
  readonly root?: string | undefined;
  /** Test seams for injecting a failure between the two staged writes. */
  readonly hooks?:
    | {
        readonly beforeSidecarWrite?: (() => Promise<void>) | undefined;
      }
    | undefined;
}

export interface PublishedDraft {
  readonly directory: string;
  readonly draftPath: string;
  readonly sidecarPath: string;
  readonly claimsWritten: number;
  readonly claimsOmitted: number;
  readonly namesWithheld: number;
  readonly draft: GeneratedDraft;
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Walks the root from the filesystem root down. Every existing component must
 * be a real directory, never a symbolic link; a missing component is created
 * with mode 0700 and then inspected as if it had existed. A component that
 * appears between the check and the creation is inspected too, so a link
 * planted in that window is refused rather than followed.
 */
async function ensureAuthorisedRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((part) => part.length > 0);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat = await lstat(current).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (stat === null) {
      await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== 'EEXIST') throw error;
      });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink()) {
      throw configuration(
        'draft_root_symlink',
        'the draft root crosses a symbolic link and is refused',
      );
    }
    if (!stat.isDirectory()) {
      throw configuration('draft_root_not_directory', 'the draft root is not a directory');
    }
  }
  return absolute;
}

/** Exclusive creation, restrictive mode, written in full, flushed, closed. */
async function writeExclusive(target: string, contents: string): Promise<void> {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Removes a staging directory this module created, and nothing else. */
async function discardStaging(root: string, staging: string): Promise<void> {
  if (path.dirname(staging) !== root || !path.basename(staging).startsWith('.staging-')) return;
  const stat = await lstat(staging).catch(() => null);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return;
  await rm(staging, { recursive: true, force: true });
}

/**
 * Generates one draft and publishes its Markdown and provenance sidecar as a
 * pair, or publishes nothing.
 */
export async function publishDraft(
  request: DraftRequest,
  options: PublishDraftOptions = {},
): Promise<PublishedDraft> {
  // Validated before any filesystem access: the name is a single component
  // by construction or the request is refused.
  let directoryName: string;
  try {
    directoryName = draftDirectoryName(request);
  } catch (error) {
    throw configuration(
      'draft_identity_invalid',
      error instanceof Error ? error.message : 'draft identity rejected',
    );
  }
  if (
    path.basename(directoryName) !== directoryName ||
    directoryName.includes('..') ||
    path.isAbsolute(directoryName)
  ) {
    throw configuration(
      'draft_identity_invalid',
      'draft identity rejected: not a single path component',
    );
  }

  const draft = generateDraft(request);
  const root = await ensureAuthorisedRoot(options.root ?? DRAFT_ROOT);
  const finalDirectory = path.join(root, directoryName);

  // Refused early when anything already sits at the destination, whatever it
  // is; the rename below refuses again if something appears in between.
  const existing = await lstat(finalDirectory).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    throw configuration(
      'draft_exists',
      'a draft with this identifier already exists and is never overwritten',
    );
  }

  const staging = path.join(root, `.staging-${directoryName}-${randomBytes(6).toString('hex')}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const stat = await lstat(staging);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw configuration('draft_root_symlink', 'the staging directory is not a real directory');
    }
    await writeExclusive(path.join(staging, DRAFT_MARKDOWN_NAME), draft.markdown);
    await options.hooks?.beforeSidecarWrite?.();
    await writeExclusive(
      path.join(staging, DRAFT_SIDECAR_NAME),
      serializeProvenance(draft.provenance),
    );
    try {
      await rename(staging, finalDirectory);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR') {
        throw configuration(
          'draft_exists',
          'a draft with this identifier already exists and is never overwritten',
        );
      }
      throw error;
    }
  } catch (error) {
    await discardStaging(root, staging);
    throw error;
  }

  return {
    draft,
    directory: finalDirectory,
    draftPath: path.join(finalDirectory, DRAFT_MARKDOWN_NAME),
    sidecarPath: path.join(finalDirectory, DRAFT_SIDECAR_NAME),
    claimsWritten: draft.provenance.counts.claimsWritten,
    claimsOmitted: draft.provenance.counts.claimsOmitted,
    namesWithheld: draft.provenance.counts.namesWithheld,
  };
}

/** A fresh draft identifier: eight lower-case hexadecimal characters. */
export function newDraftId(): string {
  return randomUUID().replace(/-/gu, '').slice(0, 8);
}
