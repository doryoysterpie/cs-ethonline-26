import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One finding of a repository check. `detail` is fixed vocabulary or a
 * count, never content from the file: a check that prints what it found
 * would reprint the secret or the invisible character it exists to catch.
 */
export interface Finding {
  readonly path: string;
  readonly line: number | null;
  readonly rule: string;
  readonly detail: string | null;
}

export function finding(
  filePath: string,
  line: number | null,
  rule: string,
  detail: string | null = null,
): Finding {
  return { path: filePath, line, rule, detail };
}

export function formatFinding(item: Finding): string {
  const line = item.line === null ? '-' : String(item.line);
  const detail = item.detail === null ? '' : ` (${item.detail})`;
  return `${item.path}:${line}: ${item.rule}${detail}`;
}

/** Prints every finding and one summary line; returns the process exit code. */
export function conclude(
  name: string,
  scanned: number,
  findings: readonly Finding[],
  log: (line: string) => void = (line) => console.log(line),
): number {
  for (const item of findings) log(formatFinding(item));
  const verdict = findings.length === 0 ? 'OK' : 'FAILED';
  log(`${name}: scanned=${scanned} findings=${findings.length} ${verdict}`);
  return findings.length === 0 ? 0 : 1;
}

/** True when the module was started directly by `node`, not imported. */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && path.resolve(entry) === fileURLToPath(importMetaUrl);
}
