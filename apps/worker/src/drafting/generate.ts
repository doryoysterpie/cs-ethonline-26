import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  draftFileName,
  generateDraft,
  serializeProvenance,
  sidecarFileName,
  type DraftRequest,
  type GeneratedDraft,
} from '@cas/drafting';

import { IngestionError } from '../editorial/errors.js';

/**
 * Writing a generated draft to disk.
 *
 * Decision D3 is provisional and its conservative reading is implemented here:
 * a dated file under an ignored `output/drafts/` directory, and an existing
 * draft is never overwritten. `writeFile` is called with the exclusive flag,
 * so the refusal is the filesystem's rather than a check that could race.
 *
 * The vault path the owner may eventually choose is not decided here, and no
 * publication of any kind happens: the file is a draft, marked unpublished,
 * for a human to read.
 */

export const DEFAULT_DRAFT_DIRECTORY = 'output/drafts';

export interface WriteDraftOutcome {
  readonly draftPath: string;
  readonly sidecarPath: string;
  readonly claimsWritten: number;
  readonly claimsOmitted: number;
  readonly namesWithheld: number;
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** Generates and writes one draft, refusing to overwrite an existing file. */
export async function writeDraft(
  request: DraftRequest,
  directory: string = DEFAULT_DRAFT_DIRECTORY,
): Promise<WriteDraftOutcome & { readonly draft: GeneratedDraft }> {
  const draft = generateDraft(request);
  await mkdir(directory, { recursive: true });
  const draftPath = path.join(directory, draftFileName(request));
  const sidecarPath = path.join(directory, sidecarFileName(request));
  for (const [target, contents] of [
    [draftPath, draft.markdown],
    [sidecarPath, serializeProvenance(draft.provenance)],
  ] as const) {
    try {
      // `wx` fails when the path exists. Decision D3 forbids overwriting a
      // draft, and the filesystem enforces it rather than a prior check that
      // another writer could slip between.
      await writeFile(target, contents, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw configuration(
          'draft_exists',
          'a draft with this identifier already exists and is never overwritten',
        );
      }
      throw error;
    }
  }
  return {
    draft,
    draftPath,
    sidecarPath,
    claimsWritten: draft.provenance.counts.claimsWritten,
    claimsOmitted: draft.provenance.counts.claimsOmitted,
    namesWithheld: draft.provenance.counts.namesWithheld,
  };
}

/** A fresh draft identifier. Every generation is its own file. */
export function newDraftId(): string {
  return randomUUID().slice(0, 8);
}
