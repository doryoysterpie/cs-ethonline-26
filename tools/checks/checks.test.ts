import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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

import { scanForbiddenFiles } from './forbidden-files.ts';
import {
  PROHIBITED_CODE_POINTS,
  readProhibitedTextPolicy,
  scanFileHygiene,
  scanHygiene,
} from './hygiene.ts';
import { formatFinding } from './lib/report.ts';
import { repositoryRoot, trackedEntries } from './lib/tracked.ts';
import { scanMainRuleset, scanMainRulesetText, workflowJobNames } from './rulesets.ts';
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
  it('reads its table from data/policy/prohibited-text.json, which names U+2060 zero-width', () => {
    const policy = readProhibitedTextPolicy();
    expect(policy.version).toBe('prohibited-text@1');
    expect(PROHIBITED_CODE_POINTS.get(0x2060)).toBe('zero_width');
    expect(PROHIBITED_CODE_POINTS.get(0x200b)).toBe('zero_width');
    expect(PROHIBITED_CODE_POINTS.get(0x202e)).toBe('bidi_control');
    expect(PROHIBITED_CODE_POINTS.get(0x09)).toBeUndefined();
    expect(PROHIBITED_CODE_POINTS.get(0x10ffff)).toBe('noncharacter');
    expect(PROHIBITED_CODE_POINTS.size).toBe(
      policy.rules.reduce(
        (n, entry) =>
          n +
          entry.ranges.reduce(
            (m, [a, b]) => m + Number.parseInt(b, 16) - Number.parseInt(a, 16) + 1,
            0,
          ),
        0,
      ),
    );
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
        'src/planted.ts:4: zero_width (U+200B)',
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

describe('main ruleset', () => {
  const rulesetPath = path.join(REPO, '.github/rulesets/main.json');
  const workflowTexts = {
    '.github/workflows/ci.yml': readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'),
    '.github/workflows/codeql.yml': readFileSync(
      path.join(REPO, '.github/workflows/codeql.yml'),
      'utf8',
    ),
  };

  it('requires the protected-main controls and every emitted release-check context', () => {
    expect(scanMainRuleset(REPO).findings.map(formatFinding)).toEqual([]);
  });

  it('extracts literal job display names, which are the required-check contexts', () => {
    expect(workflowJobNames(workflowTexts['.github/workflows/codeql.yml'])).toEqual([
      'Analyze (javascript-typescript)',
    ]);
    expect(workflowJobNames(workflowTexts['.github/workflows/ci.yml'])).toEqual([
      'Verify',
      'PostgreSQL integration',
      'PostgreSQL integration, password authentication',
      'Browser E2E',
      'Supply chain',
    ]);
  });

  it('reports weakened review, ref, force-push, deletion and status-check controls', () => {
    const ruleset = JSON.parse(readFileSync(rulesetPath, 'utf8')) as {
      conditions: { ref_name: { include: string[] } };
      rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
    };
    ruleset.conditions.ref_name.include = ['refs/heads/release'];
    ruleset.rules = ruleset.rules.filter(
      (rule) => rule.type !== 'deletion' && rule.type !== 'non_fast_forward',
    );
    const pull = ruleset.rules.find((rule) => rule.type === 'pull_request')?.parameters;
    if (pull === undefined) throw new Error('fixture has no pull request rule');
    pull.required_approving_review_count = 0;
    pull.dismiss_stale_reviews_on_push = false;
    pull.require_last_push_approval = false;
    pull.required_review_thread_resolution = false;
    const status = ruleset.rules.find((rule) => rule.type === 'required_status_checks')?.parameters;
    if (status === undefined) throw new Error('fixture has no required status rule');
    status.strict_required_status_checks_policy = false;
    status.required_status_checks = [
      { context: 'Verify', integration_id: 1 },
      { context: 'Invented check', integration_id: 15368 },
    ];

    expect(rules(scanMainRulesetText(JSON.stringify(ruleset), workflowTexts))).toEqual([
      'deletion_rule_missing',
      'independent_last_push_review_not_required',
      'main_condition_mismatch',
      'non_fast_forward_rule_missing',
      'one_review_not_required',
      'required_check_missing',
      'required_status_check_source_mismatch',
      'required_status_checks_mismatch',
      'review_thread_resolution_not_required',
      'stale_reviews_not_dismissed',
      'strict_status_policy_not_required',
    ]);
  });

  it('reports a required context whose workflow job was renamed', () => {
    const renamed = {
      ...workflowTexts,
      '.github/workflows/ci.yml': workflowTexts['.github/workflows/ci.yml'].replace(
        '    name: Browser E2E',
        '    name: Browser suite',
      ),
    };
    expect(rules(scanMainRulesetText(readFileSync(rulesetPath, 'utf8'), renamed))).toContain(
      'required_check_missing',
    );
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
