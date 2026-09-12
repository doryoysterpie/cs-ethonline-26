import path from 'node:path';

import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { repositoryRoot, trackedEntries, trackedSize, type TrackedEntry } from './lib/tracked.ts';

/**
 * Files the repository must never track.
 *
 * `.gitignore` keeps an honest contributor from adding a secret file, a raw
 * editorial export or a build product by accident; it does nothing against
 * `git add -f`, a renamed file or a rule that was later edited. This check
 * reads the index itself and refuses the categories `docs/SECURITY.md`
 * excludes: environment files, private key material, raw editorial exports
 * outside the synthetic fixtures, content of the ignored output and data
 * directories, SQL outside the migrations directory, archives and binaries,
 * operating-system and editor artifacts, and any file over the size cap.
 * Every tracked entry must also be a regular, non-executable file: no
 * symbolic link, no submodule, no executable bit.
 */

/** No tracked file may exceed this; the largest today is under 70 KB. */
export const MAX_TRACKED_FILE_BYTES = 2_097_152;

export interface PathRule {
  readonly rule: string;
  readonly matches: (relativePath: string) => boolean;
}

const extensionOf = (relativePath: string): string =>
  path.posix.extname(relativePath).toLowerCase();
const basenameOf = (relativePath: string): string => path.posix.basename(relativePath);
const underDirectory = (relativePath: string, directory: string): boolean =>
  relativePath.startsWith(`${directory}/`) || relativePath.includes(`/${directory}/`);

const KEY_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.gpg',
  '.p8',
  '.asc',
]);
const EXPORT_EXTENSIONS = new Set(['.csv', '.tsv', '.xlsx', '.xlsm', '.xls']);
const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.wasm',
  '.jar',
  '.class',
  '.pyc',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.dump',
]);
const IGNORED_DIRECTORIES = [
  'output',
  'data/raw',
  'data/private',
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
];

export const FORBIDDEN_PATH_RULES: readonly PathRule[] = [
  {
    rule: 'environment_file',
    matches: (p) => /^\.env(\..+)?$/u.test(basenameOf(p)) && basenameOf(p) !== '.env.example',
  },
  {
    rule: 'private_key_material',
    matches: (p) =>
      KEY_EXTENSIONS.has(extensionOf(p)) || /^id_(rsa|dsa|ecdsa|ed25519)$/u.test(basenameOf(p)),
  },
  {
    rule: 'raw_editorial_export',
    matches: (p) => EXPORT_EXTENSIONS.has(extensionOf(p)) && !p.startsWith('data/fixtures/'),
  },
  {
    rule: 'ignored_directory_content',
    matches: (p) =>
      IGNORED_DIRECTORIES.some(
        (directory) => p.startsWith(`${directory}/`) || underDirectory(p, directory),
      ),
  },
  {
    rule: 'sql_outside_migrations',
    matches: (p) =>
      extensionOf(p) === '.sql' &&
      !p.startsWith('packages/database/migrations/') &&
      !OPERATOR_SQL.has(p),
  },
  { rule: 'binary_or_archive', matches: (p) => BINARY_EXTENSIONS.has(extensionOf(p)) },
  {
    rule: 'os_or_editor_artifact',
    matches: (p) =>
      basenameOf(p) === '.DS_Store' || basenameOf(p) === 'Thumbs.db' || extensionOf(p) === '.log',
  },
];

/**
 * SQL that is deliberately not a migration, listed by exact path.
 *
 * The rule exists so schema changes cannot arrive outside the checksummed
 * migration chain, and that intent is preserved: nothing here touches a
 * schema. `mcp-reader-role.sql` creates a database ROLE, which is a cluster
 * object rather than a schema object, and it is run once by an operator
 * holding privileges the application deliberately never has. Making it a
 * migration would hand the application's own role the power to create roles
 * and grant privileges, which is the opposite of what it is for.
 */
const OPERATOR_SQL: ReadonlySet<string> = new Set(['packages/mcp-server/sql/mcp-reader-role.sql']);

export interface ForbiddenFilesResult {
  readonly scanned: number;
  readonly findings: readonly Finding[];
}

export function scanForbiddenFiles(
  root: string,
  entries: readonly TrackedEntry[] = trackedEntries(root),
  sizeOf: (root: string, relative: string) => number = trackedSize,
): ForbiddenFilesResult {
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (entry.mode !== '100644') {
      findings.push(finding(entry.path, null, 'not_a_regular_file', `mode=${entry.mode}`));
    }
    for (const rule of FORBIDDEN_PATH_RULES) {
      if (rule.matches(entry.path)) findings.push(finding(entry.path, null, rule.rule));
    }
    if (entry.mode === '100644' || entry.mode === '100755') {
      const size = sizeOf(root, entry.path);
      if (size > MAX_TRACKED_FILE_BYTES) {
        findings.push(finding(entry.path, null, 'oversized_file', `bytes=${size}`));
      }
    }
  }
  return { scanned: entries.length, findings };
}

if (isMain(import.meta.url)) {
  const result = scanForbiddenFiles(repositoryRoot());
  process.exitCode = conclude('forbidden-files', result.scanned, result.findings);
}
