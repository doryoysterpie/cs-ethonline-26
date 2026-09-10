import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The set of files a check scans is the set Git tracks, read from the index
 * with `git ls-files -s -z`. Ignored and untracked files are not the
 * repository's content and are out of scope; a tracked file is scanned
 * whatever its name or extension.
 */

export interface TrackedEntry {
  /** Path relative to the repository root, with forward slashes. */
  readonly path: string;
  /** Index mode: `100644` regular, `100755` executable, `120000` symlink, `160000` gitlink. */
  readonly mode: string;
}

export function repositoryRoot(from: string = process.cwd()): string {
  return execFileSync('git', ['-C', from, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

export function trackedEntries(root: string): TrackedEntry[] {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-s', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries: TrackedEntry[] = [];
  for (const record of output.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('unexpected git ls-files record');
    const mode = record.slice(0, tab).split(' ')[0] ?? '';
    entries.push({ mode, path: record.slice(tab + 1) });
  }
  return entries;
}

export function readTracked(root: string, relative: string): Buffer {
  return readFileSync(path.join(root, relative));
}

export function trackedSize(root: string, relative: string): number {
  return statSync(path.join(root, relative)).size;
}
