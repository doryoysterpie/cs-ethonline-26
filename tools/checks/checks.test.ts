import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PERMITTED_DEFAULT_IGNORABLES,
  prohibitedCodePoints,
  prohibitedTextRule,
} from '../../packages/contracts/src/prohibited-text.ts';
import { scanForbiddenFiles } from './forbidden-files.ts';
import {
  FIXTURE_EXEMPTIONS,
  fixFileHygiene,
  fixHygiene,
  scanFileHygiene,
  scanHygiene,
} from './hygiene.ts';
import { formatFinding } from './lib/report.ts';
import { repositoryRoot, trackedEntries } from './lib/tracked.ts';
import { scanSecrets, scanTextForSecrets } from './secrets.ts';
import { checkToolchain, readToolchainExpectation } from './toolchain.ts';
import { scanWorkflowText, scanWorkflows } from './workflows.ts';

/**
 * Every check is proven twice: it reports nothing on the repository as it
 * is, and it reports the exact file, line and rule when a defect is planted
 * in a disposable Git repository. A check that only ever saw a clean tree
 * would pass forever whether or not it worked.
 *
 * Planted secrets are assembled at run time from fragments, so this file
 * contains no token-shaped string and stays clean by the standard it tests.
 */

const REPO = repositoryRoot();
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function disposableRepository(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cas-check-'));
  temps.push(root);
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'core.fileMode', 'true']);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

const rules = (findings: readonly { rule: string }[]) => findings.map((f) => f.rule).sort();

describe('hygiene', () => {
  it('reports every code point the prohibited-text rule names, by its rule, and nothing for the presentation selectors (D49)', () => {
    const prohibited = prohibitedCodePoints();
    expect(prohibited).toEqual(expect.arrayContaining([0x061c, 0x180e, 0x00ad, 0x2060, 0xe0001]));
    for (const code of prohibited) {
      const findings = scanFileHygiene('any.md', Buffer.from(`a${String.fromCodePoint(code)}b\n`));
      expect([code, findings.map(formatFinding)]).toEqual([
        code,
        [
          `any.md:1: ${prohibitedTextRule(code)} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`,
        ],
      ]);
    }
    for (const code of PERMITTED_DEFAULT_IGNORABLES) {
      expect(
        scanFileHygiene('any.md', Buffer.from(`a${String.fromCodePoint(0x2764, code)}b\n`)),
      ).toEqual([]);
    }
  });

  it('reports nothing on the repository as tracked', () => {
    const result = scanHygiene(REPO);
    expect(result.scanned).toBeGreaterThan(200);
    expect(result.findings.map(formatFinding)).toEqual([]);
  });

  it('reports each planted invisible character with its file, line and code point', () => {
    const bidi = String.fromCodePoint(0x202e);
    const zeroWidth = String.fromCodePoint(0x200b);
    const nul = String.fromCodePoint(0);
    const root = disposableRepository({
      'src/clean.ts': 'export const ok = 1;\n',
      'src/planted.ts': `line one\nline two\nconst x = "${bidi}";\nline four ${zeroWidth}\n${nul}\n`,
      'docs/cr.md': 'one\r\ntwo\r\n',
      'docs/bom.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text\n')]),
      'data/bad.bin': Buffer.from([0xff, 0xfe, 0x41]),
    });
    const result = scanHygiene(root);
    expect(result.findings.map(formatFinding).sort()).toEqual(
      [
        'src/planted.ts:3: bidi_control (U+202E)',
        'src/planted.ts:4: default_ignorable (U+200B)',
        'src/planted.ts:5: c0_control (U+0000)',
        'docs/cr.md:1: carriage_return (U+000D)',
        'docs/cr.md:2: carriage_return (U+000D)',
        'docs/bom.md:1: byte_order_mark (U+FEFF)',
        'data/bad.bin:-: invalid_utf8',
      ].sort(),
    );
    // The invisible character itself is never printed.
    for (const line of result.findings.map(formatFinding)) {
      expect(line).not.toContain(bidi);
      expect(line).not.toContain(zeroWidth);
    }
  });

  it('holds each exempt fixture to the pattern it reproduces, and checks the rest of it in full (D49)', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const exemption of FIXTURE_EXEMPTIONS) {
      const bytes = readFileSync(path.join(REPO, exemption.path));
      expect(exemption.imitates.length).toBeGreaterThan(0);
      if (exemption.pattern === 'leading_byte_order_mark') {
        expect([exemption.path, bytes.subarray(0, 3).equals(bom)]).toEqual([exemption.path, true]);
      } else {
        expect([exemption.path, bytes.includes('\r\n')]).toEqual([exemption.path, true]);
      }
    }
    // One mark at offset 0 is the pattern; a second one, or a U+180E, is a finding there too.
    const master = 'data/fixtures/editorial/master-synthetic.csv';
    const marked = (body: string) => Buffer.concat([bom, Buffer.from(body)]);
    expect(scanFileHygiene(master, marked('a,b\n1,2\n'))).toEqual([]);
    expect(
      scanFileHygiene(master, marked(`${String.fromCodePoint(0xfeff)}a,b\n`)).map(formatFinding),
    ).toEqual([`${master}:1: default_ignorable (U+FEFF)`]);
    expect(
      scanFileHygiene(master, marked(`a,b\n1,${String.fromCodePoint(0x180e)}2\n`)).map(
        formatFinding,
      ),
    ).toEqual([`${master}:2: default_ignorable (U+180E)`]);
    const weekly = 'data/fixtures/editorial/weekly-synthetic.csv';
    expect(
      scanFileHygiene(weekly, Buffer.from(`a,b\r\n1,${String.fromCodePoint(0x180e)}2\r\n`)).map(
        formatFinding,
      ),
    ).toEqual([`${weekly}:2: default_ignorable (U+180E)`]);
  });

  it('exempts exactly the two fixtures, each from exactly one rule', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\r\n1,2\r\n')]);
    expect(rules(scanFileHygiene('data/fixtures/editorial/master-synthetic.csv', bom))).toEqual([
      'carriage_return',
      'carriage_return',
    ]);
    expect(rules(scanFileHygiene('data/fixtures/editorial/weekly-synthetic.csv', bom))).toEqual([
      'byte_order_mark',
    ]);
    expect(rules(scanFileHygiene('data/fixtures/editorial/other.csv', bom))).toEqual([
      'byte_order_mark',
      'carriage_return',
      'carriage_return',
    ]);
  });

  it('removes the default-ignorable code points with --fix, through one handle, and leaves every other finding', () => {
    const char = (code: number): string => String.fromCodePoint(code);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const root = disposableRepository({
      'docs/pasted.md': `co${char(0xad)}operate${char(0x200b)} now${char(0x202e)}\n`,
      'docs/windows.md': Buffer.concat([bom, Buffer.from('saved with a mark\n')]),
      'src/mixed.ts': `const a = "${char(0)}";${char(0x180e)}\n`,
      'data/fixtures/editorial/master-synthetic.csv': Buffer.concat([bom, Buffer.from('a,b\n')]),
      'docs/emoji.md': `${char(0x26a0)}${char(0xfe0f)} kept\n`,
    });
    expect(fixHygiene(root)).toEqual([
      { path: 'docs/pasted.md', removed: 3 },
      { path: 'docs/windows.md', removed: 1 },
      { path: 'src/mixed.ts', removed: 1 },
    ]);
    expect(readFileSync(path.join(root, 'docs/pasted.md'), 'utf8')).toBe('cooperate now\n');
    expect(readFileSync(path.join(root, 'docs/windows.md'), 'utf8')).toBe('saved with a mark\n');
    expect(readFileSync(path.join(root, 'src/mixed.ts'), 'utf8')).toBe(`const a = "${char(0)}";\n`);
    expect(
      readFileSync(path.join(root, 'data/fixtures/editorial/master-synthetic.csv')).subarray(0, 3),
    ).toEqual(bom);
    // The control character is a finding for a person, not for removal.
    expect(scanHygiene(root).findings.map(formatFinding)).toEqual([
      'src/mixed.ts:1: c0_control (U+0000)',
    ]);
    expect(fixHygiene(root)).toEqual([]);
    expect(fixFileHygiene('bad.bin', Buffer.from([0xff, 0xfe]))).toBeNull();
  });

  it('refuses to fix through a tracked path that became a symbolic link, and leaves its target alone', () => {
    const hidden = `outside${String.fromCodePoint(0x200b)}\n`;
    const root = disposableRepository({ 'docs/note.md': hidden });
    const outside = mkdtempSync(path.join(os.tmpdir(), 'cas-check-outside-'));
    temps.push(outside);
    writeFileSync(path.join(outside, 'target.md'), hidden);
    rmSync(path.join(root, 'docs/note.md'));
    symlinkSync(path.join(outside, 'target.md'), path.join(root, 'docs/note.md'));
    expect(() => fixHygiene(root)).toThrow();
    expect(readFileSync(path.join(outside, 'target.md'), 'utf8')).toBe(hidden);
  });

  it('refuses to fix through a tracked file whose parent directory became a symbolic link, or a file linked from outside (review of pull request 57, F1)', () => {
    const hidden = `outside${String.fromCodePoint(0x200b)}\n`;
    for (const swap of ['parent', 'hard-link'] as const) {
      const root = disposableRepository({ 'docs/note.md': hidden, 'kept.md': 'kept\n' });
      const outside = mkdtempSync(path.join(os.tmpdir(), 'cas-check-outside-'));
      temps.push(outside);
      writeFileSync(path.join(outside, 'note.md'), hidden);
      if (swap === 'parent') {
        rmSync(path.join(root, 'docs'), { recursive: true });
        symlinkSync(outside, path.join(root, 'docs'));
      } else {
        rmSync(path.join(root, 'docs/note.md'));
        linkSync(path.join(outside, 'note.md'), path.join(root, 'docs/note.md'));
      }
      const before = readFileSync(path.join(outside, 'note.md'));
      expect(() => fixHygiene(root)).toThrow(/^hygiene fix refuses docs\/note\.md:/u);
      expect([swap, readFileSync(path.join(outside, 'note.md')).equals(before)]).toEqual([
        swap,
        true,
      ]);
    }
  });

  it('caps the findings from one flooding file', () => {
    const flood = Buffer.from(`${String.fromCodePoint(0x200d)}\n`.repeat(500));
    const findings = scanFileHygiene('flood.txt', flood);
    expect(findings).toHaveLength(101);
    expect(findings[100]?.rule).toBe('findings_truncated');
  });
});

describe('forbidden files', () => {
  it('reports nothing on the repository as tracked', () => {
    expect(scanForbiddenFiles(REPO).findings.map(formatFinding)).toEqual([]);
  });

  it('reports every planted forbidden file, mode and size', () => {
    const root = disposableRepository({
      '.env': 'X=1\n',
      '.env.local': 'X=1\n',
      '.env.example': 'X=\n',
      'secrets/server.pem': 'not a key\n',
      'ops/id_rsa': 'not a key\n',
      'export.csv': 'a,b\n',
      'data/fixtures/editorial/ok.csv': 'a,b\n',
      'output/drafts/draft.md': 'draft\n',
      'apps/x/dist/index.js': '1\n',
      'dump.sql': 'select 1;\n',
      'packages/database/migrations/0001_x.sql': 'select 1;\n',
      'vendor/blob.tar.gz': 'x\n',
      '.DS_Store': 'x\n',
      'debug.log': 'x\n',
      'big.txt': 'x'.repeat(2_097_153),
      'tools/run.sh': '#!/bin/sh\n',
      'README.md': 'fine\n',
    });
    chmodSync(path.join(root, 'tools/run.sh'), 0o755);
    symlinkSync('README.md', path.join(root, 'link.md'));
    execFileSync('git', ['-C', root, 'add', '-A']);
    const lines = scanForbiddenFiles(root).findings.map(formatFinding).sort();
    expect(lines).toEqual(
      [
        '.env:-: environment_file',
        '.env.local:-: environment_file',
        'secrets/server.pem:-: private_key_material',
        'ops/id_rsa:-: private_key_material',
        'export.csv:-: raw_editorial_export',
        'output/drafts/draft.md:-: ignored_directory_content',
        'apps/x/dist/index.js:-: ignored_directory_content',
        'dump.sql:-: sql_outside_migrations',
        'vendor/blob.tar.gz:-: binary_or_archive',
        '.DS_Store:-: os_or_editor_artifact',
        'debug.log:-: os_or_editor_artifact',
        'big.txt:-: oversized_file (bytes=2097153)',
        'tools/run.sh:-: not_a_regular_file (mode=100755)',
        'link.md:-: not_a_regular_file (mode=120000)',
      ].sort(),
    );
  });
});

describe('secrets', () => {
  it('reports nothing on the repository as tracked', () => {
    expect(scanSecrets(REPO).findings.map(formatFinding)).toEqual([]);
  });

  it('reports each planted token by file, line and rule, and never prints the token', () => {
    const github = ['gh', 'p_', 'A'.repeat(36)].join('');
    const aws = ['AK', 'IA', 'B'.repeat(16)].join('');
    const block = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('');
    const url = ['postgresql:', '//app:', 'hunter2-secret', '@db.internal/cas'].join('');
    const assignment = ['api_key', ' = ', '"', 'c'.repeat(32), '"'].join('');
    const graph = ['GRAPH_API_KEY', '=', 'a'.repeat(32)].join('');
    const root = disposableRepository({
      'src/one.ts': `const a = 1;\nconst token = "${github}";\n`,
      'src/two.ts': `${aws}\n\n${block}\n`,
      'src/three.ts': `const url = "${url}";\n${assignment}\n`,
      'notes.md': `${graph}\n`,
      'src/three.test.ts': `const url = "${url}";\n${assignment}\nconst token = "${github}";\n`,
    });
    const findings = scanSecrets(root).findings;
    expect(findings.map(formatFinding).sort()).toEqual(
      [
        'src/one.ts:2: github_token',
        'src/one.ts:2: secret_assignment',
        'src/two.ts:1: aws_access_key_id',
        'src/two.ts:3: private_key_block',
        'src/three.ts:1: credential_in_url',
        'src/three.ts:2: secret_assignment',
        'notes.md:1: graph_api_key_assignment',
        'src/three.test.ts:3: github_token',
      ].sort(),
    );
    const printed = findings.map(formatFinding).join('\n');
    for (const secret of [github, aws, 'hunter2-secret', 'c'.repeat(32), 'a'.repeat(32)]) {
      expect(printed).not.toContain(secret);
    }
  });

  it('reports each planted Sheets identifier by rule, skips tests and harnesses, and never prints it', () => {
    const url = ['https://docs.google.com/', 'spreadsheets/d/', 'S'.repeat(26), '/edit'].join('');
    const assignment = ['GOOGLE_SHEETS_', 'SPREADSHEET_ID = "', 'T'.repeat(30), '"'].join('');
    const email = ['planted-sa@', 'planted-project', '.iam.gserviceaccount.com'].join('');
    const keyJson = ['{ "type"', ': "service_', 'account", "x": 1 }'].join('');
    const root = disposableRepository({
      'src/one.ts': `const sheet = "${url}";\n`,
      'src/two.ts': `${assignment}\n`,
      'src/three.ts': `const who = "${email}";\n${keyJson}\n`,
      'src/three.test.ts': `const who = "${email}";\n${keyJson}\nconst sheet = "${url}";\n`,
      'src/four-harness.mjs': `const who = '${email}';\n`,
    });
    const findings = scanSecrets(root).findings;
    expect(findings.map(formatFinding).sort()).toEqual(
      [
        'src/one.ts:1: google_sheets_url',
        'src/two.ts:1: google_sheets_id_assignment',
        'src/three.ts:1: google_service_account_email',
        'src/three.ts:2: google_service_account_json',
      ].sort(),
    );
    const printed = findings.map(formatFinding).join('\n');
    for (const secret of ['S'.repeat(26), 'T'.repeat(30), 'planted-sa@', 'planted-project']) {
      expect(printed).not.toContain(secret);
    }
  });

  it('does not fire on hashes, integrity strings or the redaction marker', () => {
    const text = [
      'sha256=84df21781a490b4c3f25614f7ea985ff363d34729746b2c733ad4fd129e917a8',
      'resolution: {integrity: sha512-cuadcxVFE8sDK6iWJbs8Sn0av2Nrh2QSGQhVlBW9AaAHqHwjWsZHT8LJ4hFGPh7ASBV2deFdM7H/DPjulmh8rg==}',
      'authorization: `Bearer [REDACTED]`',
      'DATABASE_URL=postgresql://127.0.0.1:5432/cas',
    ].join('\n');
    expect(scanTextForSecrets('doc.md', text)).toEqual([]);
  });
});

describe('workflows', () => {
  const sha = 'a'.repeat(40);
  const digest = `postgres:17.11@sha256:${'b'.repeat(64)}`;
  const good = [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    services:',
    '      postgres:',
    `        image: ${digest}`,
    '    steps:',
    `      - uses: actions/checkout@${sha} # v7.0.1`,
    '        with:',
    '          persist-credentials: false',
    `      - name: Node`,
    `        uses: actions/setup-node@${sha} # v7.0.0`,
    '      - run: pnpm test',
    '',
  ].join('\n');

  it('reports nothing on the repository workflows', () => {
    const result = scanWorkflows(REPO);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.findings.map(formatFinding)).toEqual([]);
  });

  it('accepts a compliant workflow', () => {
    expect(scanWorkflowText('.github/workflows/ci.yml', good)).toEqual([]);
  });

  it('reports each violation by line and rule', () => {
    const bad = good
      .replace(`actions/checkout@${sha} # v7.0.1`, 'actions/checkout@v7')
      .replace('        with:\n          persist-credentials: false\n', '')
      .replace(`actions/setup-node@${sha} # v7.0.0`, `actions/setup-node@${sha}`)
      .replace(`image: ${digest}`, 'image: postgres:17')
      .replace('permissions:\n  contents: read\n', 'permissions: write-all\n')
      .replace('  pull_request:\n', '  pull_request_target:\n');
    expect(rules(scanWorkflowText('.github/workflows/ci.yml', bad))).toEqual([
      'action_not_sha_pinned',
      'action_pin_missing_version_comment',
      'checkout_persists_credentials',
      'dangerous_trigger',
      'image_not_digest_pinned',
      'permissions_too_broad',
    ]);
    expect(rules(scanWorkflowText('x.yml', 'on: push\njobs: {}\n'))).toEqual([
      'permissions_missing',
    ]);
  });
});

describe('toolchain', () => {
  it('pins an exact Node release, an exact pnpm release and a matching engines range', () => {
    const expected = readToolchainExpectation(REPO);
    expect(expected.nodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(expected.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/u);
    expect(
      checkToolchain(expected, { node: `v${expected.nodeVersion}`, pnpm: expected.pnpmVersion }),
    ).toEqual([]);
  });

  it('reports each mismatch by rule', () => {
    const expected = readToolchainExpectation(REPO);
    expect(rules(checkToolchain(expected, { node: 'v1.0.0', pnpm: '0.0.1' }))).toEqual([
      'node_version_mismatch',
      'pnpm_version_mismatch',
    ]);
    expect(
      rules(
        checkToolchain(
          { nodeVersion: '24', pnpmVersion: '', packageManager: 'pnpm@11', enginesNode: '>=24' },
          { node: 'v24.0.0', pnpm: '11.10.0' },
        ),
      ),
    ).toEqual(['nvmrc_not_exact', 'package_manager_not_exact']);
    expect(
      rules(
        checkToolchain(
          { ...expected, enginesNode: '>=24.0.0' },
          { node: `v${expected.nodeVersion}`, pnpm: expected.pnpmVersion },
        ),
      ),
    ).toEqual(['engines_node_mismatch']);
  });
});

describe('tracked entries', () => {
  it('lists the index with modes', () => {
    const entries = trackedEntries(REPO);
    expect(entries.length).toBeGreaterThan(200);
    expect(entries.every((entry) => entry.mode === '100644')).toBe(true);
    expect(entries.some((entry) => entry.path === 'pnpm-lock.yaml')).toBe(true);
  });
});
