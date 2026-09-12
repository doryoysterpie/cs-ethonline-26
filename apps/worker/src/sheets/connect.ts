import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SheetsReadOnlyClient,
  TokenSource,
  assertAuthorizedSpreadsheet,
  createRedactor,
  loadServiceAccountCredential,
  parseSheetsConfig,
  spreadsheetIdDigest,
  stableDigest,
  type Redactor,
  type SheetsConfig,
  type WorkbookPolicy,
} from '@cas/sheets-intake';

import { IngestionError } from '../editorial/errors.js';

/**
 * Assembling a read-only connection to the authorized workbook.
 *
 * The order of operations here is the security design, and it is deliberate:
 *
 *   1. Read and validate configuration.
 *   2. Load the committed policy.
 *   3. Check the configured identifier against the pinned digest.
 *   4. Only then load the credential and authorize.
 *
 * Nothing authenticates before step 3 succeeds. A run pointed at the wrong
 * workbook never presents a credential anywhere, so a misconfiguration cannot
 * become an access attempt against someone else's file.
 */

/** The committed, non-secret policy file. */
export const POLICY_PATH = fileURLToPath(
  new URL('../../../../data/policy/authorized-workbook.json', import.meta.url),
);

/** The repository root, used to refuse a credential stored inside the tree. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** Reads the committed policy. A malformed policy is a refusal, never a default. */
export async function loadWorkbookPolicy(
  policyPath: string = POLICY_PATH,
): Promise<WorkbookPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(policyPath, 'utf8')) as unknown;
  } catch {
    throw configuration(
      'policy_unreadable',
      `the authorized-workbook policy at ${path.basename(policyPath)} could not be read as JSON`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configuration('policy_invalid', 'the authorized-workbook policy is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const title = record['title'];
  const pinned = record['spreadsheetIdSha256'];
  if (typeof title !== 'string') {
    throw configuration('policy_invalid', 'the authorized-workbook policy carries no title');
  }
  if (pinned !== null && typeof pinned !== 'string') {
    throw configuration(
      'policy_invalid',
      'the authorized-workbook policy carries a digest that is neither a string nor null',
    );
  }
  return {
    title,
    spreadsheetIdSha256: pinned,
    ...(typeof record['note'] === 'string' ? { note: record['note'] } : {}),
  };
}

export interface SheetsConnection {
  readonly client: SheetsReadOnlyClient;
  readonly config: SheetsConfig;
  /** Digest of the workbook identifier. Safe to print; the identifier is not. */
  readonly workbookDigest: string;
  /** The service account's address, for a report that says who is reading. */
  readonly clientEmail: string;
  readonly redact: Redactor;
}

export interface ConnectOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly policyPath?: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Opens a read-only connection, or refuses before making any request.
 *
 * The returned client is bound to one workbook and exposes two reads. There is
 * no handle here to a database, and nothing this function returns can write to
 * anything.
 */
export async function connectToWorkbook(options: ConnectOptions): Promise<SheetsConnection> {
  const config = parseSheetsConfig(options.env);
  const policy = await loadWorkbookPolicy(options.policyPath ?? POLICY_PATH);

  // The authorization decision, before any credential is touched.
  const spreadsheetId = assertAuthorizedSpreadsheet(config.spreadsheetId, policy);

  const credential = await loadServiceAccountCredential(config.credentialsPath, {
    repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
  });
  const tokens = new TokenSource({
    credential,
    limits: config.limits,
    ...(options.signal === undefined ? {} : {}),
  });
  const client = new SheetsReadOnlyClient(spreadsheetId, {
    tokens,
    limits: config.limits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return {
    client,
    config,
    workbookDigest: stableDigest(spreadsheetId),
    clientEmail: credential.clientEmail,
    // The identifier and the key body are both registered, so neither can
    // reach a printed line even if a future edit puts one into a string.
    redact: createRedactor([spreadsheetId, credential.privateKey]),
  };
}

/**
 * Computes the digest to pin, without printing the identifier.
 *
 * This is the only command that reads the identifier and produces output from
 * it, and what it produces is a one-way digest. It makes no network request
 * and needs no credential.
 */
export function computePin(env: Readonly<Record<string, string | undefined>>): {
  readonly digest: string;
  readonly shortDigest: string;
} {
  const config = parseSheetsConfig(env, { requireCredentials: false });
  return {
    digest: spreadsheetIdDigest(config.spreadsheetId),
    shortDigest: stableDigest(config.spreadsheetId),
  };
}
