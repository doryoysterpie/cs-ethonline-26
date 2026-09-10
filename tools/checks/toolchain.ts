import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { conclude, finding, isMain, type Finding } from './lib/report.ts';
import { repositoryRoot } from './lib/tracked.ts';

/**
 * Toolchain reproducibility.
 *
 * The repository pins one exact Node release in `.nvmrc` and one exact pnpm
 * release in `packageManager`, and `engines.node` names the release line
 * those pins sit on. This check asserts that the process running it is that
 * Node and that the pnpm on the path is that pnpm, so a verification run is
 * a run of the pinned toolchain and not of whatever happened to be
 * installed.
 *
 * An integrity suffix on `packageManager` (`pnpm@11.10.0+sha512.…`) is the
 * corepack convention and is accepted here, but it is not used: pnpm 11.10.0
 * refuses to parse it ("expected a semver version"), reproduced on
 * 10 September 2026, so the pin is the exact version alone until pnpm
 * accepts the suffix (docs/SECURITY-FOUNDATION-REPORT.md).
 */

export interface ToolchainExpectation {
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly packageManager: string;
  readonly enginesNode: string;
}

export interface ToolchainActual {
  readonly node: string;
  readonly pnpm: string;
}

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;
const PACKAGE_MANAGER = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[A-Za-z0-9+/=]{20,})?$/u;

export function readToolchainExpectation(root: string): ToolchainExpectation {
  const nodeVersion = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    packageManager?: unknown;
    engines?: { node?: unknown };
  };
  const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
  const pinned = PACKAGE_MANAGER.exec(packageManager);
  return {
    nodeVersion,
    pnpmVersion: pinned?.[1] ?? '',
    packageManager,
    enginesNode: typeof manifest.engines?.node === 'string' ? manifest.engines.node : '',
  };
}

export function checkToolchain(expected: ToolchainExpectation, actual: ToolchainActual): Finding[] {
  const findings: Finding[] = [];
  const exact = EXACT_VERSION.exec(expected.nodeVersion);
  if (exact === null) {
    findings.push(finding('.nvmrc', 1, 'nvmrc_not_exact'));
  } else {
    if (actual.node !== `v${expected.nodeVersion}`) {
      findings.push(finding('.nvmrc', 1, 'node_version_mismatch'));
    }
    const major = Number(exact[1]);
    if (expected.enginesNode !== `>=${expected.nodeVersion} <${major + 1}`) {
      findings.push(finding('package.json', null, 'engines_node_mismatch'));
    }
  }
  if (!PACKAGE_MANAGER.test(expected.packageManager)) {
    findings.push(finding('package.json', null, 'package_manager_not_exact'));
  } else if (actual.pnpm !== expected.pnpmVersion) {
    findings.push(finding('package.json', null, 'pnpm_version_mismatch'));
  }
  return findings;
}

export function actualToolchain(): ToolchainActual {
  const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  return { node: process.version, pnpm };
}

if (isMain(import.meta.url)) {
  const expected = readToolchainExpectation(repositoryRoot());
  const findings = checkToolchain(expected, actualToolchain());
  console.log(
    `toolchain: node=${process.version} pnpm=${actualToolchain().pnpm} nvmrc=${expected.nodeVersion} packageManager=${expected.packageManager.split('+')[0] ?? ''}`,
  );
  process.exitCode = conclude('toolchain', 2, findings);
}
