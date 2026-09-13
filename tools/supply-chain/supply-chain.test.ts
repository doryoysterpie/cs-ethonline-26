import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repositoryRoot } from '../checks/lib/tracked.ts';
import { baseOfSpecifier, parseLockfile, splitPackageKey, unquote } from './lockfile.ts';
import {
  buildSbom,
  crossCheck,
  integrityToHash,
  licenseChoice,
  purlOf,
  readWorkspaces,
  type SbomInputs,
} from './sbom.ts';

const REPO = repositoryRoot();

/** A lockfile in miniature, with every shape the real one uses. */
const SYNTHETIC_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  default:
    alpha:
      specifier: 1.0.0
      version: 1.0.0

importers:

  .:
    devDependencies:
      alpha:
        specifier: 'catalog:'
        version: 1.0.0(beta@2.0.0)

  packages/lib:
    dependencies:
      '@cas/contracts':
        specifier: workspace:*
        version: link:../contracts
      '@scope/beta':
        specifier: 2.0.0
        version: 2.0.0

  packages/contracts: {}

packages:

  '@scope/beta@2.0.0':
    resolution: {integrity: sha512-AAECAwQFBgcICQoLDA0ODw==}
    engines: {node: '>=18'}
    hasBin: true

  alpha@1.0.0:
    resolution: {integrity: sha512-/w==}
    peerDependencies:
      beta: ^2.0.0
    peerDependenciesMeta:
      beta:
        optional: true

  native-bin@3.0.0:
    resolution: {integrity: sha512-AQ==}
    cpu: [x64, arm64]
    os: [linux]
    libc: [glibc]

snapshots:

  '@scope/beta@2.0.0': {}

  alpha@1.0.0(beta@2.0.0):
    dependencies:
      '@scope/beta': 2.0.0
    optionalDependencies:
      native-bin: 3.0.0
    transitivePeerDependencies:
      - supports-color

  native-bin@3.0.0:
    optional: true
`;

function syntheticInputs(licenses: Record<string, string>): SbomInputs {
  return {
    lockfileText: SYNTHETIC_LOCKFILE,
    root: { path: '.', name: 'root-app', version: '0.0.0', license: 'Apache-2.0' },
    workspaces: [
      { path: 'packages/lib', name: '@cas/lib', version: '0.0.0', license: null },
      { path: 'packages/contracts', name: '@cas/contracts', version: '0.0.0', license: null },
    ],
    licenses: new Map(Object.entries(licenses)),
  };
}

describe('lockfile reader', () => {
  it('reads keys, integrity, platform constraints, snapshots and importers', () => {
    const lock = parseLockfile(SYNTHETIC_LOCKFILE);
    expect(lock.lockfileVersion).toBe('9.0');
    expect([...lock.packages.keys()]).toEqual(['@scope/beta@2.0.0', 'alpha@1.0.0', 'native-bin@3.0.0']);
    expect(lock.packages.get('@scope/beta@2.0.0')).toEqual({
      key: '@scope/beta@2.0.0',
      name: '@scope/beta',
      version: '2.0.0',
      integrity: 'sha512-AAECAwQFBgcICQoLDA0ODw==',
      os: [],
      cpu: [],
      libc: [],
      hasBin: true,
    });
    expect(lock.packages.get('native-bin@3.0.0')).toMatchObject({
      os: ['linux'],
      cpu: ['x64', 'arm64'],
      libc: ['glibc'],
    });
    const alpha = lock.snapshots.get('alpha@1.0.0(beta@2.0.0)');
    expect(alpha?.name).toBe('alpha');
    expect(alpha?.version).toBe('1.0.0');
    expect([...(alpha?.dependencies ?? [])]).toEqual([['@scope/beta', '2.0.0']]);
    expect([...(alpha?.optionalDependencies ?? [])]).toEqual([['native-bin', '3.0.0']]);
    expect(lock.snapshots.get('native-bin@3.0.0')?.optional).toBe(true);
    expect(lock.importers.get('packages/lib')?.dependencies.get('@cas/contracts')).toEqual({
      kind: 'dependencies',
      specifier: 'workspace:*',
      version: 'link:../contracts',
    });
    expect(lock.importers.get('.')?.dependencies.get('alpha')?.version).toBe('1.0.0(beta@2.0.0)');
    expect(lock.importers.get('packages/contracts')?.dependencies.size).toBe(0);
  });

  it('fails closed on a format it does not understand', () => {
    expect(() => parseLockfile(SYNTHETIC_LOCKFILE.replace("'9.0'", "'6.0'"))).toThrowError(
      /lockfile version not supported/u,
    );
    expect(() => parseLockfile(`${SYNTHETIC_LOCKFILE}\nmystery:\n  a: 1\n`)).toThrowError(
      /section not understood/u,
    );
    expect(() =>
      parseLockfile(SYNTHETIC_LOCKFILE.replace("  '@scope/beta@2.0.0': {}\n", '')),
    ).toThrowError(/unresolved|without a snapshot/u);
  });

  it('splits keys and specifiers the way pnpm writes them', () => {
    expect(splitPackageKey('@types/node@24.13.3')).toEqual({ name: '@types/node', version: '24.13.3' });
    expect(splitPackageKey('eslint@10.9.1')).toEqual({ name: 'eslint', version: '10.9.1' });
    expect(baseOfSpecifier('4.1.11(@types/node@24.13.3)(vite@8.2.2(@types/node@24.13.3))')).toBe('4.1.11');
    expect(unquote("'@eslint/js'")).toBe('@eslint/js');
    expect(unquote('plain')).toBe('plain');
  });

  it('reads the repository lockfile completely and consistently', () => {
    const lock = parseLockfile(readFileSync(path.join(REPO, 'pnpm-lock.yaml'), 'utf8'));
    expect(lock.packages.size).toBeGreaterThan(100);
    expect(lock.snapshots.size).toBe(lock.packages.size);
    for (const pkg of lock.packages.values()) expect(pkg.integrity).toMatch(/^sha512-/u);
    expect([...lock.importers.keys()]).toContain('.');
    expect([...lock.importers.keys()]).toContain('apps/worker');
    expect(lock.importers.get('apps/worker')?.dependencies.get('@cas/database')?.version).toBe(
      'link:../../packages/database',
    );
  });
});

describe('bill of materials', () => {
  const licenses = { '@scope/beta@2.0.0': 'MIT', 'alpha@1.0.0': '(MIT OR Apache-2.0)' };

  it('is byte-for-byte reproducible from the same inputs', () => {
    const first = buildSbom(syntheticInputs(licenses));
    const second = buildSbom(syntheticInputs(licenses));
    expect(second.sbom).toBe(first.sbom);
    expect(second.licenses).toBe(first.licenses);
    expect(first.sbom).not.toMatch(/timestamp|serialNumber/u);
  });

  it('builds CycloneDX 1.6 components, hashes, licences and the dependency graph', () => {
    const output = buildSbom(syntheticInputs(licenses));
    const document = JSON.parse(output.sbom) as {
      bomFormat: string;
      specVersion: string;
      metadata: { component: { 'bom-ref': string }; properties: { name: string; value: string }[] };
      components: Record<string, unknown>[];
      dependencies: { ref: string; dependsOn: string[] }[];
    };
    expect(document.bomFormat).toBe('CycloneDX');
    expect(document.specVersion).toBe('1.6');
    expect(document.metadata.component['bom-ref']).toBe('workspace:root-app');
    expect(document.metadata.properties.map((p) => p.name)).toContain('cas:lockfile:sha256');
    const refs = document.components.map((c) => c['bom-ref']);
    expect(refs).toEqual([
      'workspace:@cas/contracts',
      'workspace:@cas/lib',
      'pkg:npm/%40scope/beta@2.0.0',
      'pkg:npm/alpha@1.0.0',
      'pkg:npm/native-bin@3.0.0',
    ]);
    const beta = document.components.find((c) => c['name'] === '@scope/beta');
    expect(beta?.['hashes']).toEqual([{ alg: 'SHA-512', content: '000102030405060708090a0b0c0d0e0f' }]);
    expect(beta?.['licenses']).toEqual([{ license: { id: 'MIT' } }]);
    const alpha = document.components.find((c) => c['name'] === 'alpha');
    expect(alpha?.['licenses']).toEqual([{ expression: '(MIT OR Apache-2.0)' }]);
    const native = document.components.find((c) => c['name'] === 'native-bin');
    expect(native?.['licenses']).toBeUndefined();
    expect(native?.['properties']).toEqual([
      { name: 'cas:platform:os', value: 'linux' },
      { name: 'cas:platform:cpu', value: 'x64,arm64' },
      { name: 'cas:platform:libc', value: 'glibc' },
      { name: 'cas:license:source', value: 'not-inventoried:platform-constrained' },
    ]);
    const graph = new Map(document.dependencies.map((d) => [d.ref, d.dependsOn]));
    expect(graph.get('workspace:root-app')).toEqual([
      'pkg:npm/alpha@1.0.0',
      'workspace:@cas/contracts',
      'workspace:@cas/lib',
    ]);
    expect(graph.get('workspace:@cas/lib')).toEqual([
      'pkg:npm/%40scope/beta@2.0.0',
      'workspace:@cas/contracts',
    ]);
    expect(graph.get('pkg:npm/alpha@1.0.0')).toEqual([
      'pkg:npm/%40scope/beta@2.0.0',
      'pkg:npm/native-bin@3.0.0',
    ]);
    expect(output.summary).toMatchObject({
      components: 3,
      workspaceComponents: 2,
      licensed: 2,
      platformConstrained: 1,
    });
    expect(output.licenses).toContain('| native-bin | 3.0.0 | os=linux cpu=x64|arm64 libc=glibc | alpha@1.0.0 |');
    expect(output.licenses).toContain('### MIT (1)');
  });

  it('fails closed when a licence is unavailable for an unconstrained package', () => {
    expect(() => buildSbom(syntheticInputs({ 'alpha@1.0.0': 'MIT' }))).toThrowError(
      /licence unavailable for @scope\/beta@2.0.0/u,
    );
  });

  /**
   * The synthetic lockfile with a chain below the constrained binary:
   * native-bin depends on wasm-shim, which depends on wasm-runtime. Neither
   * declares a constraint of its own, which is the shape of sharp's
   * WebAssembly fallback and @emnapi/runtime in the real lockfile. Each
   * extra edge makes one of them installed everywhere again.
   */
  function withInheritedChain(extra: 'none' | 'alpha-needs-runtime' | 'lib-needs-shim'): SbomInputs {
    let text = SYNTHETIC_LOCKFILE.replace(
      '    libc: [glibc]\n\nsnapshots:\n',
      '    libc: [glibc]\n\n  wasm-runtime@1.0.0:\n    resolution: {integrity: sha512-Ag==}\n\n  wasm-shim@1.0.0:\n    resolution: {integrity: sha512-Aw==}\n\nsnapshots:\n',
    ).replace(
      '  native-bin@3.0.0:\n    optional: true\n',
      '  native-bin@3.0.0:\n    dependencies:\n      wasm-shim: 1.0.0\n    optional: true\n\n  wasm-runtime@1.0.0:\n    optional: true\n\n  wasm-shim@1.0.0:\n    dependencies:\n      wasm-runtime: 1.0.0\n    optional: true\n',
    );
    if (extra === 'alpha-needs-runtime') {
      text = text.replace(
        "    dependencies:\n      '@scope/beta': 2.0.0\n    optionalDependencies:",
        "    dependencies:\n      '@scope/beta': 2.0.0\n      wasm-runtime: 1.0.0\n    optionalDependencies:",
      );
    }
    if (extra === 'lib-needs-shim') {
      text = text.replace(
        "      '@scope/beta':\n        specifier: 2.0.0\n        version: 2.0.0\n",
        "      '@scope/beta':\n        specifier: 2.0.0\n        version: 2.0.0\n      wasm-shim:\n        specifier: 1.0.0\n        version: 1.0.0\n",
      );
    }
    expect(text, 'the chain must actually be spliced into the fixture').toContain('wasm-shim: 1.0.0');
    return { ...syntheticInputs(licenses), lockfileText: text };
  }

  it('records a package reachable only through constrained packages as not inventoried', () => {
    const inputs = withInheritedChain('none');
    const output = buildSbom(inputs);
    expect(buildSbom(inputs).sbom).toBe(output.sbom);
    const document = JSON.parse(output.sbom) as {
      components: Record<string, unknown>[];
      dependencies: { ref: string; dependsOn: string[] }[];
    };
    for (const name of ['wasm-shim', 'wasm-runtime']) {
      const component = document.components.find((c) => c['name'] === name);
      expect(component?.['licenses'], name).toBeUndefined();
      expect(component?.['properties'], name).toEqual([
        { name: 'cas:license:source', value: 'not-inventoried:platform-constrained-parents' },
      ]);
    }
    const graph = new Map(document.dependencies.map((d) => [d.ref, d.dependsOn]));
    expect(graph.get('pkg:npm/native-bin@3.0.0')).toEqual(['pkg:npm/wasm-shim@1.0.0']);
    expect(graph.get('pkg:npm/wasm-shim@1.0.0')).toEqual(['pkg:npm/wasm-runtime@1.0.0']);
    expect(output.summary).toMatchObject({
      components: 5,
      licensed: 2,
      platformConstrained: 1,
      platformInherited: 2,
    });
    expect(output.licenses).toContain(
      '| Packages reachable only through those, licence not inventoried offline | 2 |',
    );
    expect(output.licenses).toContain(
      '| wasm-shim | 1.0.0 | none of its own; reachable only through platform-constrained packages | native-bin@3.0.0 |',
    );
    expect(output.licenses).toContain(
      '| wasm-runtime | 1.0.0 | none of its own; reachable only through platform-constrained packages | wasm-shim@1.0.0 |',
    );
  });

  it('still fails closed when one parent of such a package is installed everywhere', () => {
    expect(() => buildSbom(withInheritedChain('alpha-needs-runtime'))).toThrowError(
      /licence unavailable for wasm-runtime@1.0.0/u,
    );
  });

  it('still fails closed when a workspace depends on such a package directly', () => {
    const inputs = withInheritedChain('lib-needs-shim');
    const withRuntime = { ...inputs, licenses: new Map([...inputs.licenses, ['wasm-runtime@1.0.0', 'MIT']]) };
    expect(() => buildSbom(withRuntime)).toThrowError(/licence unavailable for wasm-shim@1.0.0/u);
  });

  it('encodes package URLs, hashes and licence choices as the specifications require', () => {
    expect(purlOf('@types/node', '24.13.3')).toBe('pkg:npm/%40types/node@24.13.3');
    expect(purlOf('eslint', '10.9.1')).toBe('pkg:npm/eslint@10.9.1');
    expect(integrityToHash('sha512-/w==')).toEqual({ alg: 'SHA-512', content: 'ff' });
    expect(integrityToHash('md5-abc')).toBeNull();
    expect(licenseChoice('Apache-2.0')).toEqual({ license: { id: 'Apache-2.0' } });
    expect(licenseChoice('MIT OR Apache-2.0')).toEqual({ expression: 'MIT OR Apache-2.0' });
    expect(licenseChoice('Custom licence text')).toEqual({ license: { name: 'Custom licence text' } });
  });

  it('cross-checks component sets strictly and edges as a superset of the pnpm document', () => {
    const own = buildSbom(syntheticInputs(licenses)).sbom;
    const pnpmLike = (components: string[], edges: Record<string, string[]>) =>
      JSON.stringify({
        components: components.map((purl) => ({ purl })),
        dependencies: Object.entries(edges).map(([ref, dependsOn]) => ({ ref, dependsOn })),
      });
    const all = ['pkg:npm/%40scope/beta@2.0.0', 'pkg:npm/alpha@1.0.0', 'pkg:npm/native-bin@3.0.0'];
    const agree = crossCheck(
      own,
      pnpmLike(all, { 'pkg:npm/alpha@1.0.0': ['pkg:npm/%40scope/beta@2.0.0'] }),
    );
    expect(agree).toEqual({
      pnpmComponents: 3,
      ownComponents: 3,
      onlyInPnpm: [],
      onlyInOwn: [],
      missingEdges: [],
      extraEdges: 1,
    });
    const disagree = crossCheck(
      own,
      pnpmLike([...all.slice(0, 2), 'pkg:npm/ghost@9.9.9'], {
        'pkg:npm/%40scope/beta@2.0.0': ['pkg:npm/alpha@1.0.0'],
      }),
    );
    expect(disagree.onlyInPnpm).toEqual(['pkg:npm/ghost@9.9.9']);
    expect(disagree.onlyInOwn).toEqual(['pkg:npm/native-bin@3.0.0']);
    expect(disagree.missingEdges).toEqual(['pkg:npm/%40scope/beta@2.0.0 -> pkg:npm/alpha@1.0.0']);
  });

  it('finds every workspace manifest the lockfile has an importer for', () => {
    const lock = parseLockfile(readFileSync(path.join(REPO, 'pnpm-lock.yaml'), 'utf8'));
    const workspaces = readWorkspaces(REPO);
    for (const importer of lock.importers.keys()) {
      if (importer === '.') continue;
      expect(workspaces.map((w) => w.path)).toContain(importer);
    }
    expect(workspaces.map((w) => w.name)).toContain('@cas/worker');
  });
});
