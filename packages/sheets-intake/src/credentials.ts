import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { fail } from './errors.js';

/**
 * Loading the service-account credential.
 *
 * The access model is Application Default Credentials or a mounted secret
 * file: a JSON service-account key that lives outside the repository, on a
 * path named by the environment. The owner never pastes it anywhere, and this
 * module never places any part of it into a message.
 *
 * Three refusals are structural rather than advisory:
 *
 *   - **A key inside the repository is refused**, whatever `.gitignore` says.
 *     An ignore rule protects against `git add .`; it does not protect against
 *     a future rule change, a force-add, an archive of the working tree, or a
 *     build context copied wholesale. A key that is not in the tree cannot be
 *     committed by any of those.
 *   - **A world-readable or group-readable key is refused** on POSIX hosts.
 *     A secret readable by every account on the machine is not a secret.
 *   - **A symbolic link at the credential path is refused** on POSIX hosts.
 *     The directory entry the owner names must be the key file itself, not an
 *     indirection a later local write could repoint at another file.
 *
 * The file is opened exactly once. Every check below — file type, size,
 * permissions — reads the open file descriptor (`FileHandle#stat`, an
 * `fstat`), and the key is then read from that same descriptor
 * (`FileHandle#readFile`), never by path again. A release build previously
 * checked the file by path (`stat`) and then read it again by path
 * (`readFile`); a local actor who could replace the path's target between
 * those two calls — with a different file, or with a symbolic link — defeated
 * every check, because the check and the read never touched the same file.
 * Resolving the path once, at `open`, and never again removes that window:
 * whatever this function validates is, by construction, the exact bytes it
 * reads, because both operations name the same open file descriptor rather
 * than a path that a concurrent write can repoint. `O_NOFOLLOW` makes the
 * symlink refusal atomic with the open itself, rather than a separate
 * check a replacement could still race.
 *
 * Only three fields are read: the client email, the private key and the token
 * endpoint. `project_id`, `private_key_id` and the rest are deliberately not
 * loaded, because a field that is never read cannot be leaked.
 */

export interface ServiceAccountCredential {
  /** The service account's address. Not a secret, and the one value reports may name. */
  readonly clientEmail: string;
  /** PEM private key. Never printed, never returned in an error, never stored. */
  readonly privateKey: string;
  /** The OAuth token endpoint, validated against the pinned Google origin. */
  readonly tokenUri: string;
}

/** The only token endpoint this connector will authenticate against. */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const SERVICE_ACCOUNT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const PEM_PRIVATE_KEY =
  /^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:RSA )?PRIVATE KEY-----\r?\n?$/;
/** A key file larger than this is not a service-account key. */
const MAXIMUM_KEY_BYTES = 32_768;

/**
 * True when `candidate` is inside `root`. Compared on resolved paths, so a
 * relative path, a `..` segment or a repeated separator cannot disguise a
 * location inside the repository.
 */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * True when `error` is the driver's answer to `O_NOFOLLOW` meeting a
 * symbolic link at the final path component: `ELOOP` on Linux and on
 * Darwin. Anything else — missing file, permission denied, not a
 * directory in an intermediate component — falls through to the generic
 * unreadable refusal, which names no detail of the failure.
 */
function isSymlinkRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ELOOP'
  );
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail.credential(
      'credential_field_missing',
      'the service-account key is missing a required field',
      { field: key },
    );
  }
  return value;
}

export interface LoadCredentialOptions {
  /** Repository root. A key inside it is refused. */
  readonly repositoryRoot: string;
  /** Skips the POSIX permission check. Tests only. */
  readonly skipPermissionCheck?: boolean | undefined;
}

/**
 * Reads and validates a service-account key from an explicit path.
 *
 * Every refusal names the condition and the field, never a value, and never
 * the path's contents.
 */
export async function loadServiceAccountCredential(
  keyPath: string,
  options: LoadCredentialOptions,
): Promise<ServiceAccountCredential> {
  const resolved = path.resolve(keyPath);
  if (isInsideDirectory(resolved, options.repositoryRoot)) {
    throw fail.credential(
      'credential_inside_repository',
      'the service-account key is inside the repository. Move it to a path outside the working tree; an ignore rule is not a boundary.',
    );
  }

  // Opened exactly once. `O_NOFOLLOW` refuses a symbolic link atomically, as
  // part of the open itself, on every platform that defines it; every check
  // below and the read that follows operate on this one descriptor, never on
  // `resolved` again, so nothing a concurrent local write does to the path
  // after this line can change what was validated or what is read.
  const openFlags =
    process.platform === 'win32'
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(resolved, openFlags);
  } catch (error) {
    if (isSymlinkRefusal(error)) {
      throw fail.credential(
        'credential_is_symlink',
        'the configured credential path is a symbolic link. Point it at the key file itself, not an indirection.',
      );
    }
    throw fail.credential(
      'credential_unreadable',
      'the service-account key could not be read at the configured path',
    );
  }

  let raw: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw fail.credential(
        'credential_not_a_file',
        'the configured credential path is not a file',
      );
    }
    if (info.size > MAXIMUM_KEY_BYTES) {
      throw fail.credential(
        'credential_too_large',
        'the configured credential file is too large to be a service-account key',
        { bytes: info.size, maximum: MAXIMUM_KEY_BYTES },
      );
    }
    if (options.skipPermissionCheck !== true && process.platform !== 'win32') {
      const mode = info.mode & 0o077;
      if (mode !== 0) {
        throw fail.credential(
          'credential_permissions_open',
          'the service-account key is readable beyond its owner. Restrict it to mode 0600 before use.',
        );
      }
    }
    try {
      raw = await handle.readFile({ encoding: 'utf8' });
    } catch {
      throw fail.credential(
        'credential_unreadable',
        'the service-account key could not be read at the configured path',
      );
    }
  } finally {
    await handle.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw fail.credential(
      'credential_not_json',
      'the service-account key could not be parsed as JSON',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail.credential('credential_not_object', 'the service-account key is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['type'] !== 'service_account') {
    throw fail.credential(
      'credential_not_service_account',
      'the configured credential is not a service-account key. User OAuth credentials are not accepted: this connector authenticates as a service account that the owner shared one file with.',
    );
  }

  const clientEmail = requireString(record, 'client_email');
  if (!SERVICE_ACCOUNT_EMAIL.test(clientEmail)) {
    throw fail.credential(
      'credential_email_invalid',
      'the service-account key does not carry a service-account address',
    );
  }
  const privateKey = requireString(record, 'private_key').replace(/\\n/g, '\n');
  if (!PEM_PRIVATE_KEY.test(privateKey)) {
    throw fail.credential(
      'credential_key_invalid',
      'the service-account key does not carry a PEM private key',
    );
  }
  const tokenUri = typeof record['token_uri'] === 'string' ? record['token_uri'] : GOOGLE_TOKEN_URI;
  if (tokenUri !== GOOGLE_TOKEN_URI) {
    throw fail.policy(
      'credential_token_uri_unexpected',
      'the service-account key names a token endpoint other than the pinned Google endpoint',
    );
  }

  return { clientEmail, privateKey, tokenUri };
}
