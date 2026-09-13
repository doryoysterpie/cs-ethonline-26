import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isMain } from '../checks/lib/report.ts';
import { repositoryRoot } from '../checks/lib/tracked.ts';
import { baseOfSpecifier, parseLockfile, type Lockfile } from './lockfile.ts';

/**
 * A reproducible CycloneDX 1.6 bill of materials and a licence inventory,
 * generated from `pnpm-lock.yaml` and the installed package manifests by
 * the repository's own toolchain.
 *
 * Reproducible means: the same lockfile and the same frozen install produce
 * the same bytes on every platform. The component list, versions, integrity
 * hashes and dependency graph come from the lockfile alone. Licence
 * identifiers come from the installed manifests through `pnpm licenses`,
 * and only for packages the lockfile does not constrain to an operating
 * system, CPU or C library; a platform-constrained optional package is
 * installed on one platform and not another, so its licence is recorded as
 * not inventoried rather than as whatever the generating machine happened to
 * see. The document carries no timestamp and no random serial number.
 *
 * `--check` regenerates in memory and fails when the committed files differ,
 * which is how continuous integration proves the committed bill of
 * materials is the lockfile's.
 */

export const SBOM_PATH = 'supply-chain/sbom.cdx.json';
export const LICENSES_PATH = 'supply-chain/LICENSES.md';
export const GENERATOR_NAME = 'cas-sbom-generator';
export const GENERATOR_VERSION = '1';

export interface WorkspaceManifest {
  /** Path relative to the repository root, as the lockfile's importer key. */
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
}

export interface SbomInputs {
  readonly lockfileText: string;
  readonly root: WorkspaceManifest;
  readonly workspaces: readonly WorkspaceManifest[];
  /** `name@version` to the licence string of its installed manifest. */
  readonly licenses: ReadonlyMap<string, string>;
}

export interface SbomSummary {
  readonly components: number;
  readonly workspaceComponents: number;
  readonly licensed: number;
  readonly platformConstrained: number;
  /** Unconstrained packages reachable only through platform-constrained ones. */
  readonly platformInherited: number;
  readonly lockfileSha256: string;
}

export interface SbomOutput {
  readonly sbom: string;
  readonly licenses: string;
  readonly summary: SbomSummary;
}

/** Package URL for an npm package; a scope's `@` is percent-encoded as the specification requires. */
export function purlOf(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function integrityToHash(integrity: string): { alg: string; content: string } | null {
  const match = /^(sha1|sha256|sha512)-([A-Za-z0-9+/=]+)$/u.exec(integrity);
  if (match === null) return null;
  const alg = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' }[match[1] ?? ''] ?? null;
  if (alg === null) return null;
  return { alg, content: Buffer.from(match[2] ?? '', 'base64').toString('hex') };
}

const SPDX_ID = /^[A-Za-z0-9.+-]+$/u;

/** A CycloneDX licence choice: an SPDX identifier, an SPDX expression, or a plain name. */
export function licenseChoice(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (SPDX_ID.test(trimmed)) return { license: { id: trimmed } };
  if (/[()]|\b(?:AND|OR|WITH)\b/u.test(trimmed)) return { expression: trimmed };
  return { license: { name: trimmed } };
}

function workspaceRef(name: string): string {
  return `workspace:${name}`;
}

function resolveLink(importerPath: string, link: string): string {
  const target = path.posix.normalize(path.posix.join(importerPath, link.slice('link:'.length)));
  return target === '.' ? '.' : target.replace(/^\.\//u, '');
}

function constrained(pkg: { os: readonly string[]; cpu: readonly string[]; libc: readonly string[] }) {
  return pkg.os.length > 0 || pkg.cpu.length > 0 || pkg.libc.length > 0;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildSbom(inputs: SbomInputs): SbomOutput {
  const lock: Lockfile = parseLockfile(inputs.lockfileText);
  const lockfileSha256 = createHash('sha256').update(inputs.lockfileText).digest('hex');
  const workspaceByPath = new Map<string, WorkspaceManifest>([['.', inputs.root]]);
  for (const workspace of inputs.workspaces) workspaceByPath.set(workspace.path, workspace);

  // Optional parents of platform-constrained packages, from the graph itself.
  const optionalParents = new Map<string, Set<string>>();
  for (const snapshot of lock.snapshots.values()) {
    for (const [name, specifier] of snapshot.optionalDependencies) {
      const child = `${name}@${baseOfSpecifier(specifier)}`;
      const parents = optionalParents.get(child) ?? new Set<string>();
      parents.add(`${snapshot.name}@${snapshot.version}`);
      optionalParents.set(child, parents);
    }
  }

  // Every parent of every package, over regular and optional edges alike, and
  // the packages a workspace depends on directly, which are installed everywhere.
  const allParents = new Map<string, Set<string>>();
  for (const snapshot of lock.snapshots.values()) {
    for (const [name, specifier] of [...snapshot.dependencies, ...snapshot.optionalDependencies]) {
      if (specifier.startsWith('link:')) continue;
      const child = `${name}@${baseOfSpecifier(specifier)}`;
      const parents = allParents.get(child) ?? new Set<string>();
      parents.add(`${snapshot.name}@${snapshot.version}`);
      allParents.set(child, parents);
    }
  }
  const directlyRequired = new Set<string>();
  for (const importer of lock.importers.values()) {
    for (const [name, dependency] of importer.dependencies) {
      if (dependency.version.startsWith('link:')) continue;
      directlyRequired.add(`${name}@${baseOfSpecifier(dependency.version)}`);
    }
  }

  // A package that declares no constraint of its own, but that only
  // platform-constrained packages depend on, is installed exactly where they
  // are: on no platform in particular, so CI's runner lacks its manifest as
  // surely as a developer's machine does. Reading its licence would make the
  // document depend on the generating machine, so it inherits the
  // not-inventoried status. Computed to a fixed point, so a chain of such
  // packages is followed to its end. A package with even one parent outside
  // the set, or one a workspace depends on directly, still needs a licence
  // and still fails closed without one.
  const notEverywhere = new Set<string>(
    [...lock.packages.values()].filter((pkg) => constrained(pkg)).map((pkg) => pkg.key),
  );
  const inherited = new Set<string>();
  let grew: boolean;
  do {
    grew = false;
    for (const key of [...lock.packages.keys()].sort(compare)) {
      if (notEverywhere.has(key) || directlyRequired.has(key)) continue;
      const parents = allParents.get(key);
      if (parents === undefined || parents.size === 0) continue;
      if ([...parents].every((parent) => notEverywhere.has(parent))) {
        notEverywhere.add(key);
        inherited.add(key);
        grew = true;
      }
    }
  } while (grew);

  const components: Record<string, unknown>[] = [];
  let licensed = 0;
  let platformConstrained = 0;
  let platformInherited = 0;
  const byLicense = new Map<string, { name: string; version: string }[]>();
  const notInventoried: { name: string; version: string; constraint: string; parents: string[] }[] =
    [];
  for (const key of [...lock.packages.keys()].sort(compare)) {
    const pkg = lock.packages.get(key);
    if (pkg === undefined) continue;
    const component: Record<string, unknown> = {
      type: 'library',
      'bom-ref': purlOf(pkg.name, pkg.version),
      name: pkg.name,
      version: pkg.version,
      purl: purlOf(pkg.name, pkg.version),
    };
    if (pkg.integrity !== null) {
      const hash = integrityToHash(pkg.integrity);
      if (hash !== null) component['hashes'] = [hash];
    }
    const properties: { name: string; value: string }[] = [];
    if (constrained(pkg)) {
      platformConstrained += 1;
      if (pkg.os.length > 0) properties.push({ name: 'cas:platform:os', value: pkg.os.join(',') });
      if (pkg.cpu.length > 0) properties.push({ name: 'cas:platform:cpu', value: pkg.cpu.join(',') });
      if (pkg.libc.length > 0) properties.push({ name: 'cas:platform:libc', value: pkg.libc.join(',') });
      properties.push({ name: 'cas:license:source', value: 'not-inventoried:platform-constrained' });
      const constraint = [
        pkg.os.length > 0 ? `os=${pkg.os.join('|')}` : null,
        pkg.cpu.length > 0 ? `cpu=${pkg.cpu.join('|')}` : null,
        pkg.libc.length > 0 ? `libc=${pkg.libc.join('|')}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' ');
      notInventoried.push({
        name: pkg.name,
        version: pkg.version,
        constraint,
        parents: [...(optionalParents.get(key) ?? [])].sort(compare),
      });
    } else if (inherited.has(key)) {
      platformInherited += 1;
      properties.push({
        name: 'cas:license:source',
        value: 'not-inventoried:platform-constrained-parents',
      });
      notInventoried.push({
        name: pkg.name,
        version: pkg.version,
        constraint: 'none of its own; reachable only through platform-constrained packages',
        parents: [...(allParents.get(key) ?? [])].sort(compare),
      });
    } else {
      const license = inputs.licenses.get(key);
      if (license === undefined) {
        throw new Error(`licence unavailable for ${key}: install the workspace with the frozen lockfile first`);
      }
      component['licenses'] = [licenseChoice(license)];
      properties.push({ name: 'cas:license:source', value: 'installed-manifest' });
      licensed += 1;
      const group = byLicense.get(license) ?? [];
      group.push({ name: pkg.name, version: pkg.version });
      byLicense.set(license, group);
    }
    if (pkg.hasBin) properties.push({ name: 'cas:pnpm:hasBin', value: 'true' });
    component['properties'] = properties;
    components.push(component);
  }

  const workspaceComponents: Record<string, unknown>[] = [];
  for (const workspace of [...inputs.workspaces].sort((a, b) => compare(a.name, b.name))) {
    workspaceComponents.push({
      type: 'library',
      'bom-ref': workspaceRef(workspace.name),
      name: workspace.name,
      version: workspace.version,
      licenses: [licenseChoice(workspace.license ?? inputs.root.license ?? 'NOASSERTION')],
      properties: [
        { name: 'cas:workspace:path', value: workspace.path },
        { name: 'cas:license:source', value: 'workspace-manifest' },
      ],
    });
  }

  // Dependency graph: importers first, then one entry per package merging its snapshots.
  const dependencies = new Map<string, Set<string>>();
  const depend = (ref: string, on: string) => {
    const set = dependencies.get(ref) ?? new Set<string>();
    set.add(on);
    dependencies.set(ref, set);
  };
  for (const importer of lock.importers.values()) {
    const manifest = workspaceByPath.get(importer.path);
    if (manifest === undefined) throw new Error(`lockfile importer without a manifest: ${importer.path}`);
    const ref = workspaceRef(manifest.name);
    dependencies.set(ref, dependencies.get(ref) ?? new Set<string>());
    for (const [name, dependency] of importer.dependencies) {
      if (dependency.version.startsWith('link:')) {
        const target = workspaceByPath.get(resolveLink(importer.path, dependency.version));
        if (target === undefined) throw new Error(`workspace link unresolved: ${importer.path} ${name}`);
        depend(ref, workspaceRef(target.name));
      } else {
        depend(ref, purlOf(name, baseOfSpecifier(dependency.version)));
      }
    }
  }
  const rootRef = workspaceRef(inputs.root.name);
  for (const workspace of inputs.workspaces) depend(rootRef, workspaceRef(workspace.name));
  for (const snapshot of lock.snapshots.values()) {
    const ref = purlOf(snapshot.name, snapshot.version);
    dependencies.set(ref, dependencies.get(ref) ?? new Set<string>());
    for (const [name, specifier] of [...snapshot.dependencies, ...snapshot.optionalDependencies]) {
      if (specifier.startsWith('link:')) continue;
      depend(ref, purlOf(name, baseOfSpecifier(specifier)));
    }
  }

  const document = {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      tools: {
        components: [{ type: 'application', name: GENERATOR_NAME, version: GENERATOR_VERSION }],
      },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: inputs.root.name,
        version: inputs.root.version,
        licenses: [licenseChoice(inputs.root.license ?? 'NOASSERTION')],
      },
      properties: [
        { name: 'cas:lockfile:path', value: 'pnpm-lock.yaml' },
        { name: 'cas:lockfile:sha256', value: lockfileSha256 },
        { name: 'cas:lockfile:version', value: lock.lockfileVersion },
        { name: 'cas:generator', value: `${GENERATOR_NAME}@${GENERATOR_VERSION}` },
      ],
    },
    components: [...workspaceComponents, ...components],
    dependencies: [...dependencies.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([ref, on]) => ({ ref, dependsOn: [...on].sort(compare) })),
  };

  const summary: SbomSummary = {
    components: components.length,
    workspaceComponents: workspaceComponents.length,
    licensed,
    platformConstrained,
    platformInherited,
    lockfileSha256,
  };
  return {
    sbom: `${JSON.stringify(document, null, 2)}\n`,
    licenses: renderLicenses(inputs, byLicense, notInventoried, summary),
    summary,
  };
}

function renderLicenses(
  inputs: SbomInputs,
  byLicense: ReadonlyMap<string, { name: string; version: string }[]>,
  notInventoried: readonly { name: string; version: string; constraint: string; parents: string[] }[],
  summary: SbomSummary,
): string {
  const lines: string[] = [];
  lines.push('# Licence inventory');
  lines.push('');
  lines.push(
    `Generated by \`tools/supply-chain/sbom.ts\` from \`pnpm-lock.yaml\` (SHA-256 \`${summary.lockfileSha256}\`) and the installed package manifests. Do not edit by hand: run \`corepack pnpm supply-chain:generate\` and commit the result; \`corepack pnpm supply-chain:check\` fails when this file or \`sbom.cdx.json\` no longer matches the lockfile.`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Quantity | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Third-party packages in the lockfile | ${summary.components} |`);
  lines.push(`| With a licence from the installed manifest | ${summary.licensed} |`);
  lines.push(`| Platform-constrained optional packages, licence not inventoried offline | ${summary.platformConstrained} |`);
  lines.push(`| Packages reachable only through those, licence not inventoried offline | ${summary.platformInherited} |`);
  lines.push(`| Workspace packages (${inputs.root.license ?? 'NOASSERTION'}) | ${summary.workspaceComponents + 1} |`);
  lines.push('');
  lines.push('| Licence | Packages |');
  lines.push('| --- | --- |');
  for (const license of [...byLicense.keys()].sort(compare)) {
    lines.push(`| ${license} | ${byLicense.get(license)?.length ?? 0} |`);
  }
  lines.push('');
  lines.push('## Packages by licence');
  for (const license of [...byLicense.keys()].sort(compare)) {
    const entries = [...(byLicense.get(license) ?? [])].sort(
      (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
    );
    lines.push('');
    lines.push(`### ${license} (${entries.length})`);
    lines.push('');
    lines.push('| Package | Version |');
    lines.push('| --- | --- |');
    for (const entry of entries) lines.push(`| ${entry.name} | ${entry.version} |`);
  }
  lines.push('');
  lines.push('## Platform-constrained optional packages');
  lines.push('');
  lines.push(
    'These packages are installed only where their operating system, CPU or C library matches, or are reachable only through packages that are, so their manifests are not present on every platform and their licence is not read offline. A constrained package names the optional parent it belongs to; a package with no constraint of its own names the constrained packages it is reachable through.',
  );
  lines.push('');
  lines.push('| Package | Version | Constraint | Optional dependency of |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of [...notInventoried].sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  )) {
    lines.push(
      `| ${entry.name} | ${entry.version} | ${entry.constraint} | ${entry.parents.join(', ') || 'none recorded'} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}`;
}

/** Reads every workspace manifest named by `pnpm-workspace.yaml`'s `apps/*` and `packages/*` globs. */
export function readWorkspaces(root: string): WorkspaceManifest[] {
  const found: WorkspaceManifest[] = [];
  for (const parent of ['apps', 'packages']) {
    const directory = path.join(root, parent);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(directory, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      found.push({ path: `${parent}/${entry.name}`, ...readManifest(manifestPath) });
    }
  }
  return found;
}

function readManifest(manifestPath: string): { name: string; version: string; license: string | null } {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    license?: unknown;
  };
  return {
    name: typeof manifest.name === 'string' ? manifest.name : path.basename(path.dirname(manifestPath)),
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    license: typeof manifest.license === 'string' ? manifest.license : null,
  };
}

/** `name@version` to licence, from `pnpm licenses list --json` over the frozen install. */
export function readInstalledLicenses(root: string): Map<string, string> {
  const output = execFileSync('pnpm', ['licenses', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(output) as Record<
    string,
    { name?: unknown; versions?: unknown; license?: unknown }[]
  >;
  const licenses = new Map<string, string>();
  for (const [license, entries] of Object.entries(parsed)) {
    for (const entry of entries) {
      if (typeof entry.name !== 'string' || !Array.isArray(entry.versions)) continue;
      for (const version of entry.versions) {
        if (typeof version === 'string') licenses.set(`${entry.name}@${version}`, license);
      }
    }
  }
  return licenses;
}

export function gatherInputs(root: string): SbomInputs {
  return {
    lockfileText: readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'),
    root: { path: '.', ...readManifest(path.join(root, 'package.json')) },
    workspaces: readWorkspaces(root),
    licenses: readInstalledLicenses(root),
  };
}

interface CycloneDxLike {
  readonly components?: readonly { readonly purl?: unknown }[];
  readonly dependencies?: readonly { readonly ref?: unknown; readonly dependsOn?: unknown }[];
}

export interface CrossCheckResult {
  readonly pnpmComponents: number;
  readonly ownComponents: number;
  readonly onlyInPnpm: readonly string[];
  readonly onlyInOwn: readonly string[];
  /** Edges pnpm records that this document lacks: `from -> to`. Any one is a failure. */
  readonly missingEdges: readonly string[];
  /** Edges this document records beyond pnpm's: resolved peers and optional peers. */
  readonly extraEdges: number;
}

/**
 * Compares this document with the one pnpm's own generator derives from the
 * same lockfile. The third-party component sets must be identical, and every
 * edge pnpm records must be present here. This document may carry more
 * edges, because it follows the lockfile's snapshots exactly, peer
 * resolutions included, where pnpm's generator drops resolved peers and, as
 * observed on 10 September 2026 for `pg@8.23.0`, some regular dependencies.
 * pnpm's document is also not reproducible as shipped (a fresh timestamp and
 * a random serial number on every run, no licences without the store), which
 * is why it is the cross-check rather than the artifact.
 */
export function crossCheck(own: string, pnpmDocument: string): CrossCheckResult {
  const purls = (document: CycloneDxLike): Set<string> =>
    new Set(
      (document.components ?? [])
        .map((c) => (typeof c.purl === 'string' ? c.purl : null))
        .filter((purl): purl is string => purl !== null && purl.startsWith('pkg:npm/')),
    );
  const edges = (document: CycloneDxLike, within: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>();
    for (const entry of document.dependencies ?? []) {
      if (typeof entry.ref !== 'string' || !within.has(entry.ref)) continue;
      for (const on of Array.isArray(entry.dependsOn) ? (entry.dependsOn as unknown[]) : []) {
        if (typeof on === 'string' && within.has(on)) out.add(`${entry.ref} -> ${on}`);
      }
    }
    return out;
  };
  const ownDocument = JSON.parse(own) as CycloneDxLike;
  const theirs = JSON.parse(pnpmDocument) as CycloneDxLike;
  const ownSet = purls(ownDocument);
  const theirSet = purls(theirs);
  // pnpm lists the workspace root under a purl too; only third-party purls are compared.
  const common = new Set([...ownSet].filter((purl) => theirSet.has(purl)));
  const ownEdges = edges(ownDocument, common);
  const theirEdges = edges(theirs, common);
  return {
    pnpmComponents: theirSet.size,
    ownComponents: ownSet.size,
    onlyInPnpm: [...theirSet].filter((purl) => !ownSet.has(purl)).sort(compare),
    onlyInOwn: [...ownSet].filter((purl) => !theirSet.has(purl)).sort(compare),
    missingEdges: [...theirEdges].filter((edge) => !ownEdges.has(edge)).sort(compare),
    extraEdges: [...ownEdges].filter((edge) => !theirEdges.has(edge)).length,
  };
}

function pnpmGeneratedSbom(root: string): string {
  return execFileSync(
    'pnpm',
    ['sbom', '--sbom-format', 'cyclonedx', '--sbom-spec-version', '1.6', '--lockfile-only'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

if (isMain(import.meta.url)) {
  const root = repositoryRoot();
  const check = process.argv.includes('--check');
  const cross = process.argv.includes('--cross-check');
  const output = buildSbom(gatherInputs(root));
  const targets: [string, string][] = [
    [SBOM_PATH, output.sbom],
    [LICENSES_PATH, output.licenses],
  ];
  let failures = 0;
  for (const [relative, content] of targets) {
    const target = path.join(root, relative);
    if (check) {
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current !== content) {
        failures += 1;
        console.log(`${relative}: ${current === null ? 'missing' : 'differs from the lockfile'}`);
      }
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  }
  if (cross) {
    const result = crossCheck(output.sbom, pnpmGeneratedSbom(root));
    const agree =
      result.onlyInPnpm.length === 0 &&
      result.onlyInOwn.length === 0 &&
      result.missingEdges.length === 0;
    for (const purl of result.onlyInPnpm) console.log(`cross-check: only pnpm lists ${purl}`);
    for (const purl of result.onlyInOwn) console.log(`cross-check: only this document lists ${purl}`);
    for (const edge of result.missingEdges) console.log(`cross-check: edge missing here: ${edge}`);
    console.log(
      `cross-check: pnpm=${result.pnpmComponents} own=${result.ownComponents} extraEdgesHere=${result.extraEdges} ${agree ? 'AGREE' : 'DISAGREE'}`,
    );
    if (!agree) failures += 1;
  }
  const s = output.summary;
  const verdict = check ? (failures === 0 ? 'CHECK OK' : 'CHECK FAILED') : 'WRITTEN';
  console.log(
    `sbom: components=${s.components} workspace=${s.workspaceComponents} licensed=${s.licensed} platformConstrained=${s.platformConstrained} platformInherited=${s.platformInherited} lockfileSha256=${s.lockfileSha256} ${verdict}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
