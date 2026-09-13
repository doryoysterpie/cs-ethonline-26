/**
 * A reader for `pnpm-lock.yaml`, lockfile version 9.
 *
 * The lockfile is YAML, but the subset pnpm writes is regular: two-space
 * indentation, block mappings, a handful of flow mappings and flow lists,
 * and keys quoted with single quotes when they contain `@`. This reader
 * walks it line by line against that shape and fails closed on anything it
 * does not recognise, so a change in the format is a visible failure rather
 * than a silently incomplete bill of materials. It carries no dependency, so
 * the bill of materials it feeds is produced by the repository's own pinned
 * toolchain and nothing else.
 */

export interface LockfilePackage {
  /** `name@version`. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** Subresource integrity string, for example `sha512-...`. */
  readonly integrity: string | null;
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly libc: readonly string[];
  readonly hasBin: boolean;
}

export interface LockfileSnapshot {
  /** `name@version` plus any peer suffix, exactly as the lockfile keys it. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** Dependency name to its version specifier, peer suffix included. */
  readonly dependencies: ReadonlyMap<string, string>;
  readonly optionalDependencies: ReadonlyMap<string, string>;
  readonly optional: boolean;
}

export type DependencyKind = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface ImporterDependency {
  readonly kind: DependencyKind;
  readonly specifier: string;
  /** Resolved version specifier, or `link:<path>` for a workspace package. */
  readonly version: string;
}

export interface LockfileImporter {
  readonly path: string;
  readonly dependencies: ReadonlyMap<string, ImporterDependency>;
}

export interface Lockfile {
  readonly lockfileVersion: string;
  readonly importers: ReadonlyMap<string, LockfileImporter>;
  readonly packages: ReadonlyMap<string, LockfilePackage>;
  readonly snapshots: ReadonlyMap<string, LockfileSnapshot>;
}

const KNOWN_SECTIONS = new Set([
  'lockfileVersion',
  'settings',
  'catalogs',
  'overrides',
  'importers',
  'packages',
  'snapshots',
  'patchedDependencies',
  'packageExtensionsChecksum',
  'pnpmfileChecksum',
  'ignoredOptionalDependencies',
  'time',
]);
const DEPENDENCY_KINDS = new Set<string>(['dependencies', 'devDependencies', 'optionalDependencies']);

function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  return trimmed;
}

/** `name@version` to its parts; the version is everything after the last `@` past position 0. */
export function splitPackageKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) throw new Error(`lockfile package key without a version: ${key}`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Strips a peer-dependency suffix: `10.9.1(jiti@2.6.1)` to `10.9.1`. */
export function baseOfSpecifier(specifier: string): string {
  const paren = specifier.indexOf('(');
  return paren < 0 ? specifier : specifier.slice(0, paren);
}

function parseFlowList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error('lockfile flow list expected');
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((item) => unquote(item));
}

function keyOf(line: string): string {
  const trimmed = line.trim();
  const body = trimmed.endsWith(': {}') ? trimmed.slice(0, -4) : trimmed.replace(/:$/u, '');
  return unquote(body);
}

interface MutablePackage {
  key: string;
  name: string;
  version: string;
  integrity: string | null;
  os: string[];
  cpu: string[];
  libc: string[];
  hasBin: boolean;
}

interface MutableSnapshot {
  key: string;
  name: string;
  version: string;
  dependencies: Map<string, string>;
  optionalDependencies: Map<string, string>;
  optional: boolean;
}

interface MutableImporter {
  path: string;
  dependencies: Map<string, { kind: DependencyKind; specifier: string; version: string }>;
}

export function parseLockfile(text: string): Lockfile {
  let lockfileVersion = '';
  const importers = new Map<string, MutableImporter>();
  const packages = new Map<string, MutablePackage>();
  const snapshots = new Map<string, MutableSnapshot>();

  let section: string | null = null;
  let currentPackage: MutablePackage | null = null;
  let currentSnapshot: MutableSnapshot | null = null;
  let snapshotBlock: 'dependencies' | 'optionalDependencies' | null = null;
  let currentImporter: MutableImporter | null = null;
  let importerKind: DependencyKind | null = null;
  let importerDependency: string | null = null;

  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/u, '');
    if (line.trim().length === 0) continue;
    const indent = indentOf(line);
    const trimmed = line.trim();
    const where = `line ${index + 1}`;

    if (indent === 0) {
      const head = /^([A-Za-z]+):\s*(.*)$/u.exec(trimmed);
      if (head === null) throw new Error(`lockfile top-level line not understood at ${where}`);
      section = head[1] ?? '';
      if (!KNOWN_SECTIONS.has(section)) {
        throw new Error(`lockfile section not understood at ${where}: ${section}`);
      }
      if (section === 'lockfileVersion') lockfileVersion = unquote(head[2] ?? '');
      currentPackage = null;
      currentSnapshot = null;
      snapshotBlock = null;
      currentImporter = null;
      importerKind = null;
      importerDependency = null;
      continue;
    }

    if (section === 'packages') {
      if (indent === 2) {
        const key = keyOf(line);
        const { name, version } = splitPackageKey(key);
        currentPackage = { key, name, version, integrity: null, os: [], cpu: [], libc: [], hasBin: false };
        if (packages.has(key)) throw new Error(`lockfile package repeated at ${where}`);
        packages.set(key, currentPackage);
      } else if (indent === 4 && currentPackage !== null) {
        const property = /^([A-Za-z]+):\s*(.*)$/u.exec(trimmed);
        if (property === null) throw new Error(`lockfile package property not understood at ${where}`);
        const [, name, value = ''] = property;
        if (name === 'resolution') {
          const integrity = /integrity:\s*(sha(?:1|256|512)-[A-Za-z0-9+/=]+)/u.exec(value);
          currentPackage.integrity = integrity?.[1] ?? null;
        } else if (name === 'os') currentPackage.os = parseFlowList(value);
        else if (name === 'cpu') currentPackage.cpu = parseFlowList(value);
        else if (name === 'libc') currentPackage.libc = parseFlowList(value);
        else if (name === 'hasBin') currentPackage.hasBin = value.trim() === 'true';
      }
      continue;
    }

    if (section === 'snapshots') {
      if (indent === 2) {
        const key = keyOf(line);
        const { name, version } = splitPackageKey(baseOfSpecifier(key));
        currentSnapshot = {
          key,
          name,
          version,
          dependencies: new Map(),
          optionalDependencies: new Map(),
          optional: false,
        };
        snapshotBlock = null;
        if (snapshots.has(key)) throw new Error(`lockfile snapshot repeated at ${where}`);
        snapshots.set(key, currentSnapshot);
      } else if (indent === 4 && currentSnapshot !== null) {
        const property = /^([A-Za-z]+):\s*(.*)$/u.exec(trimmed);
        if (property === null) throw new Error(`lockfile snapshot property not understood at ${where}`);
        const [, name, value = ''] = property;
        if (name === 'dependencies' || name === 'optionalDependencies') snapshotBlock = name;
        else {
          snapshotBlock = null;
          if (name === 'optional') currentSnapshot.optional = value.trim() === 'true';
        }
      } else if (indent === 6 && currentSnapshot !== null && snapshotBlock !== null) {
        const entry = /^('[^']*'|"[^"]*"|[^:]+):\s*(.+)$/u.exec(trimmed);
        if (entry === null) throw new Error(`lockfile snapshot dependency not understood at ${where}`);
        currentSnapshot[snapshotBlock].set(unquote(entry[1] ?? ''), (entry[2] ?? '').trim());
      }
      continue;
    }

    if (section === 'importers') {
      if (indent === 2) {
        const importerPath = keyOf(line);
        currentImporter = { path: importerPath, dependencies: new Map() };
        importerKind = null;
        importerDependency = null;
        if (importers.has(importerPath)) throw new Error(`lockfile importer repeated at ${where}`);
        importers.set(importerPath, currentImporter);
      } else if (indent === 4 && currentImporter !== null) {
        const kind = keyOf(line);
        if (!DEPENDENCY_KINDS.has(kind)) {
          throw new Error(`lockfile importer block not understood at ${where}`);
        }
        importerKind = kind as DependencyKind;
      } else if (indent === 6 && currentImporter !== null && importerKind !== null) {
        importerDependency = keyOf(line);
        currentImporter.dependencies.set(importerDependency, {
          kind: importerKind,
          specifier: '',
          version: '',
        });
      } else if (indent === 8 && currentImporter !== null && importerDependency !== null) {
        const property = /^(specifier|version):\s*(.*)$/u.exec(trimmed);
        if (property === null) throw new Error(`lockfile importer property not understood at ${where}`);
        const existing = currentImporter.dependencies.get(importerDependency);
        if (existing === undefined) throw new Error(`lockfile importer state lost at ${where}`);
        if (property[1] === 'specifier') existing.specifier = unquote(property[2] ?? '');
        else existing.version = unquote(property[2] ?? '');
      }
      continue;
    }
    // settings, catalogs and the other known sections carry nothing the bill of materials needs.
  }

  if (lockfileVersion !== '9.0') {
    throw new Error(`lockfile version not supported: ${lockfileVersion || 'missing'}`);
  }
  for (const snapshot of snapshots.values()) {
    if (!packages.has(`${snapshot.name}@${snapshot.version}`)) {
      throw new Error(`lockfile snapshot without a package entry: ${snapshot.key}`);
    }
    for (const [name, specifier] of [...snapshot.dependencies, ...snapshot.optionalDependencies]) {
      if (specifier.startsWith('link:')) continue;
      if (!snapshots.has(`${name}@${specifier}`)) {
        throw new Error(`lockfile snapshot dependency unresolved: ${snapshot.key} -> ${name}`);
      }
    }
  }
  for (const pkg of packages.values()) {
    if (![...snapshots.values()].some((s) => s.name === pkg.name && s.version === pkg.version)) {
      throw new Error(`lockfile package without a snapshot: ${pkg.key}`);
    }
  }
  for (const importer of importers.values()) {
    for (const [name, dependency] of importer.dependencies) {
      if (dependency.version.length === 0) {
        throw new Error(`lockfile importer dependency without a version: ${importer.path} ${name}`);
      }
      if (dependency.version.startsWith('link:')) continue;
      if (!snapshots.has(`${name}@${dependency.version}`)) {
        throw new Error(`lockfile importer dependency unresolved: ${importer.path} ${name}`);
      }
    }
  }

  return { lockfileVersion, importers, packages, snapshots };
}
