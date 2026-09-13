import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Strict network denial covers everything it can (Track D re-audit finding
 * M1).
 *
 * The earlier evidence strategy excluded the whole `@cas/mcp-server` package
 * from the deny-all profile because two files could not run under it, which
 * left the package under audit as the only one without a strict-denial
 * proof. One of the two, `stdio.test.ts`, only failed because a connection
 * refused with `EPERM` was classified as a query failure; finding M2 fixed
 * that and the file now passes with all network denied.
 *
 * What remains is one file that serves real synthetic redirects from
 * 127.0.0.1 and therefore needs a listening socket. This holds the exclusion
 * to that one file: a file added to the local-host run without needing a
 * listener fails the assertion below, which is what stops the earlier
 * strategy from creeping back.
 */

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The only default-suite files that cannot run under total network denial,
 * because they bind a socket. Derived from a per-file run under
 * `tools/offline-sandbox.sb`, not asserted from reading.
 */
const LOCAL_HOST_ONLY = ['redirect.stdio.test.ts'] as const;

/** Default-suite files on disk: every `*.test.ts` that is not a `*.db.test.ts`. */
function defaultSuiteFiles(): string[] {
  return readdirSync(here('.'))
    .filter((name) => name.endsWith('.test.ts') && !name.endsWith('.db.test.ts'))
    .sort();
}

/**
 * Files kept out of the strict run that do not need a listener. Empty is the
 * only acceptable answer; anything else is coverage given away for nothing.
 */
export function excludedWithoutNeed(
  excluded: readonly string[],
  needsListener: readonly string[],
): string[] {
  return excluded.filter((name) => !needsListener.includes(name)).sort();
}

describe('strict network denial covers every file that can run under it', () => {
  const packageJson = JSON.parse(readFileSync(here('../package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('excludes exactly the files that need a listener, and no others', () => {
    const denied = packageJson.scripts['test:denied'] ?? '';
    const excluded = [...denied.matchAll(/--exclude='\*\*\/([^']+)'/g)]
      .map((match) => match[1] as string)
      .filter((name) => !name.startsWith('*.db.'));
    expect(excluded.sort()).toEqual([...LOCAL_HOST_ONLY].sort());
    expect(excludedWithoutNeed(excluded, LOCAL_HOST_ONLY)).toEqual([]);
  });

  it('runs exactly those files, and only those, under the local-host profile', () => {
    const localhost = packageJson.scripts['test:localhost'] ?? '';
    for (const name of LOCAL_HOST_ONLY) expect(localhost).toContain(`src/${name}`);
    const named = [...localhost.matchAll(/src\/([A-Za-z0-9.-]+\.test\.ts)/g)].map(
      (match) => match[1] as string,
    );
    expect(named.sort()).toEqual([...LOCAL_HOST_ONLY].sort());
  });

  it('leaves no default-suite file in neither run', () => {
    const onDisk = defaultSuiteFiles();
    const strict = onDisk.filter((name) => !LOCAL_HOST_ONLY.includes(name as never));
    expect([...strict, ...LOCAL_HOST_ONLY].sort()).toEqual(onDisk);
    expect(strict.length).toBeGreaterThan(15);
  });

  it('names the same split in both sandbox profiles', () => {
    const deny = readFileSync(here('../../../tools/offline-sandbox.sb'), 'utf8');
    const local = readFileSync(here('../../../tools/loopback-sandbox.sb'), 'utf8');
    for (const name of LOCAL_HOST_ONLY) {
      expect(deny).toContain(name);
      expect(local).toContain(name);
    }
    // No other test file may be named in the deny-all header, which would
    // mean a second exclusion. Whole file names only: `stdio.test.ts` is a
    // substring of `redirect.stdio.test.ts`. `coverage.test.ts` is the one
    // permitted mention, because the header points at this guard rather than
    // excluding it.
    const MENTIONED_AS_GUARD = 'coverage.test.ts';
    const namedInDeny = new Set(
      [...deny.matchAll(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.test\.ts/g)].map(
        (match) => match[0] as string,
      ),
    );
    namedInDeny.delete(MENTIONED_AS_GUARD);
    expect([...namedInDeny].sort()).toEqual([...LOCAL_HOST_ONLY].sort());
    expect(deny).toContain('Only');
    // The weaker profile must state its real address scope rather than
    // claiming loopback alone, and must say why it cannot be narrowed.
    expect(local).toContain('addresses assigned to the current machine');
    expect(local).toContain('local-interface addresses');
    expect(local).toContain('127.0.0.0/8');
    expect(local).toMatch(/is\s+NOT/);
    expect(deny).toContain('denies every network operation');
  });

  it('fails when an unnecessary file is added to the local-host exclusion', () => {
    // The falsification: the assertion above is only worth having if it
    // actually catches a file excluded without needing a listener.
    const overBroad = [...LOCAL_HOST_ONLY, 'tools.test.ts'];
    expect(excludedWithoutNeed(overBroad, LOCAL_HOST_ONLY)).toEqual(['tools.test.ts']);
    const wholePackage = defaultSuiteFiles();
    expect(excludedWithoutNeed(wholePackage, LOCAL_HOST_ONLY).length).toBeGreaterThan(15);
  });
});
