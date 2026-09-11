import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { TOOL_ERROR_CODES } from './safety/errors.js';

/**
 * The repository's own documents, held to what the code does.
 *
 * `skill.test.ts` holds `SKILL.md`, the contract a host reads. This file holds
 * the documents a reviewer reads: the README, the architecture and security
 * rules, the track report, the sprint board, the decision log and the
 * requirement matrix. The audit's F16 was that these drifted from the code and
 * from each other, and that the drift always ran in the flattering direction:
 * a smaller error vocabulary, a larger claim, a status further along than the
 * one the project actually held.
 *
 * Two kinds of check live here. The first is factual: a statement the code can
 * contradict, such as the error vocabulary or the test totals. The second is a
 * containment check: a status the project must keep stating, such as the
 * rejected candidate, the unfinished Sprint 5 and the absence of any
 * deployment. A document that stops saying one of those fails here.
 */

const run = promisify(execFile);
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): Promise<string> => readFile(here(relative), 'utf8');

/** One line, one space: a Markdown reflow must not be able to fail a prose check. */
const flat = (text: string): string => text.replace(/\s+/gu, ' ');

const SKILL = '../SKILL.md';
const README = '../../../README.md';
const ARCHITECTURE = '../../../docs/ARCHITECTURE.md';
const SECURITY = '../../../docs/SECURITY.md';
const REPORT = '../../../docs/MCP-TOOLING-TRACK-REPORT.md';
const BOARD = '../../../docs/SPRINT_BOARD.md';
const DECISIONS = '../../../docs/DECISIONS.md';
const REQUIREMENTS = '../../../docs/HACKATHON_REQUIREMENTS.md';

/** Every document this file governs, for the checks that must hold across all of them. */
const ALL = [SKILL, README, ARCHITECTURE, SECURITY, REPORT, BOARD, DECISIONS, REQUIREMENTS];

/**
 * Vitest's own collection, as the authority on how many tests exist. A
 * documented total is only worth writing down if something derives it; parsing
 * `it(` out of source would count what the source says, not what the runner
 * collects, which is exactly the difference the audit found.
 */
interface Collected {
  readonly tests: number;
  readonly files: number;
}

async function collect(config?: string): Promise<Collected> {
  const args = ['list', '--json'];
  if (config !== undefined) args.push('--config', config);
  const { stdout } = await run(
    process.execPath,
    [here('../node_modules/vitest/vitest.mjs'), ...args],
    {
      cwd: here('..'),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    },
  );
  const entries = JSON.parse(stdout.slice(stdout.indexOf('['))) as { file: string }[];
  return { tests: entries.length, files: new Set(entries.map((entry) => entry.file)).size };
}

/** The one place a documented count is written, so a drift shows up in one diff. */
const DOCUMENTED = {
  offlineTests: 184,
  offlineFiles: 19,
  databaseTests: 49,
  databaseFiles: 4,
} as const;

describe('the documented test totals', () => {
  it('match what the runner collects, offline and against PostgreSQL', async () => {
    const [offline, database] = await Promise.all([collect(), collect('vitest.db.config.ts')]);
    expect({ tests: offline.tests, files: offline.files }).toEqual({
      tests: DOCUMENTED.offlineTests,
      files: DOCUMENTED.offlineFiles,
    });
    expect({ tests: database.tests, files: database.files }).toEqual({
      tests: DOCUMENTED.databaseTests,
      files: DOCUMENTED.databaseFiles,
    });
  }, 600_000);

  it('are the figures the report, the README and the architecture print', async () => {
    const [report, readme, architecture] = await Promise.all([
      read(REPORT),
      read(README),
      read(ARCHITECTURE),
    ]);
    const { offlineTests, offlineFiles, databaseTests, databaseFiles } = DOCUMENTED;
    // The report's current-state section, not its historical sections.
    const current = report.slice(report.indexOf('## 16. Audit correction'));
    expect(flat(current)).toContain(
      `@cas/mcp-server\`, offline | ${offlineTests} | ${offlineFiles} |`,
    );
    expect(flat(current)).toContain(
      `@cas/mcp-server\`, PostgreSQL | ${databaseTests} | ${databaseFiles} |`,
    );
    expect(readme).toContain(`${offlineTests} offline tests, ${databaseTests} PostgreSQL`);
    expect(flat(architecture)).toContain(`${offlineTests} offline tests in ${offlineFiles} files`);
    expect(flat(architecture)).toContain(
      `${databaseTests} PostgreSQL tests in ${databaseFiles} files`,
    );
    // The rejected candidate's figures must not still be presented as current.
    expect(readme).not.toContain('70 offline tests');
    expect(current).not.toContain('70 tests in seven files,');
  });
});

describe('the documented error vocabulary', () => {
  it('is the emitted set, in SKILL.md, and its size is stated correctly elsewhere', async () => {
    const skill = await read(SKILL);
    const section = /## Errors\n([\s\S]*?)\n## /u.exec(skill)?.[1] ?? '';
    const listed = new Set([...section.matchAll(/`([a-z_]+)`/gu)].map((match) => match[1]));
    expect([...listed].sort()).toEqual([...TOOL_ERROR_CODES].sort());
    expect(TOOL_ERROR_CODES).toHaveLength(22);
    for (const document of [SKILL, SECURITY, REPORT, DECISIONS]) {
      const text = await read(document);
      // The rejected candidate's count must not be presented as current.
      if (document === REPORT) {
        const current = text.slice(text.indexOf('## 16. Audit correction'));
        expect(current, document).toContain('twenty-two');
        expect(current, document).not.toMatch(/vocabulary of nineteen|nineteen fixed codes/u);
      } else {
        expect(text, document).toMatch(/twenty-two/u);
        expect(text, document).not.toMatch(/nineteen fixed codes/u);
      }
    }
  });
});

describe('the corrected behaviour the documents must state', () => {
  it('states that a duplicate JSON key is not detected and resolves last-key-wins', async () => {
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('not detected');
    expect(flat(skill)).toContain('last value');
    const report = await read(REPORT);
    const current = report.slice(report.indexOf('## 16. Audit correction'));
    expect(flat(current)).toContain('duplicate JSON key is not detected');
    // The withdrawn claim must be named as withdrawn, not silently dropped.
    expect(flat(current)).toContain('is withdrawn');
  });

  it('scopes determinism to a fixed snapshot and explicit inputs, and requires asOf', async () => {
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('fixed database snapshot');
    expect(flat(skill)).toMatch(/`asOf`[^.]*required|required[^.]*`asOf`/u);
    expect(skill).not.toMatch(/the same request yields the same bytes\./iu);
    expect(skill).not.toMatch(/defaults to the server clock/iu);
    const security = await read(SECURITY);
    expect(flat(security)).toContain('no stored evaluation reads the server clock');
  });

  it('states that a stored origin is recorded and not verified', async () => {
    for (const document of [SKILL, README, SECURITY]) {
      const text = await read(document);
      expect(text, document).toMatch(/recorded/u);
      expect(text, document).toMatch(/not (independently )?verified|does not verify/u);
    }
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('never an authenticated live acquisition');
    expect(flat(skill)).toContain('rejected_pending_correction');
  });

  it('tells the truth about victim names and the claim-provenance sidecar', async () => {
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('claimsWithoutStructuredVictimName');
    expect(flat(skill)).toContain('may contain names');
    expect(flat(skill)).toContain('No name redaction');
    expect(flat(skill)).toContain('per-claim provenance sidecar');
    expect(skill).not.toMatch(/every name is withheld/iu);
    const security = await read(SECURITY);
    expect(flat(security)).toContain('no name is redacted from quoted text');
  });

  it('requires a restricted production database role', async () => {
    const security = await read(SECURITY);
    expect(flat(security)).toContain('least-privilege role');
    expect(flat(security)).toContain('mcp-reader-role.sql');
    expect(flat(security)).toContain('database_role_overprivileged');
    const decisions = await read(DECISIONS);
    expect(flat(decisions)).toContain('dedicated reader role');
    const report = await read(REPORT);
    const current = report.slice(report.indexOf('## 16. Audit correction'));
    // The audit's complaint was that the role was described as optional.
    expect(flat(current)).toContain('required production control');
  });

  it('states that no provider redirect is ever followed', async () => {
    const security = await read(SECURITY);
    expect(flat(security)).toContain('redirect: "manual"');
    expect(flat(security)).toContain('zero requests to the destination');
    for (const document of [README, DECISIONS]) {
      const text = await read(document);
      expect(text, document).toMatch(/redirect/u);
    }
  });

  it('states the cancellation semantics, including what a permit waits for', async () => {
    const security = await read(SECURITY);
    expect(flat(security)).toContain('pg_cancel_backend');
    expect(flat(security)).toContain('released only once that work has actually unwound');
    expect(flat(security)).toContain('`call_cancelled`');
    const architecture = await read(ARCHITECTURE);
    expect(flat(architecture)).toContain('CallScope');
  });
});

describe('the containment every document must keep stating', () => {
  it('names the track as isolated, unmerged and unaccepted', async () => {
    for (const document of [
      README,
      ARCHITECTURE,
      SECURITY,
      REPORT,
      BOARD,
      DECISIONS,
      REQUIREMENTS,
    ]) {
      const text = await read(document);
      expect(flat(text), document).toMatch(/pending [^.]{0,60}?(re-?)?audit/iu);
    }
    const report = await read(REPORT);
    expect(flat(report)).toContain('REJECTED');
    expect(flat(report)).toContain('NOT accepted');
    const board = await read(BOARD);
    expect(flat(board)).toContain('REJECTED');
    expect(flat(board)).toContain('not merged');
  });

  it('says the candidate was rejected and names the corrections that answer it', async () => {
    for (const document of [README, ARCHITECTURE, REPORT, BOARD, DECISIONS, REQUIREMENTS]) {
      const text = await read(document);
      expect(text, document).toMatch(/rejected/iu);
    }
    const decisions = await read(DECISIONS);
    expect(flat(decisions)).toContain('D28 amendment, 2026-09-10');
    expect(flat(decisions)).toContain('F1 to F16');
    // The amendment allocates no new decision number.
    expect(flat(decisions)).toContain('No decision number is allocated');
    expect(decisions).not.toMatch(/^## D29/mu);
  });

  it('says Sprint 5 has not passed its own audit', async () => {
    for (const document of [README, REPORT, BOARD, REQUIREMENTS]) {
      const text = await read(document);
      expect(flat(text), document).toMatch(
        /Sprint 5[^.]{0,240}?(under correction|not passed|has not)/u,
      );
    }
    const skill = await read(SKILL);
    expect(skill).not.toMatch(/Sprint 5 (was|is|has been) accepted/iu);
  });

  it('says no remote MCP service has been enabled or deployed', async () => {
    for (const document of [README, SECURITY, REPORT]) {
      const text = await read(document);
      expect(flat(text), document).toContain('No remote MCP service has been enabled or deployed');
    }
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('local stdio only');
    expect(flat(skill)).toContain('no remote reachability');
  });

  it('never claims the server or the track has been audited', async () => {
    for (const document of ALL) {
      const text = await read(document);
      expect(flat(text), document).not.toMatch(
        /has been audited|audit(ed)? passed|issued PASS for/iu,
      );
    }
    const skill = await read(SKILL);
    expect(flat(skill)).toContain('This server has not been audited.');
  });
});

describe('the historical evidence the report keeps', () => {
  it('labels its pre-correction sections as historical rather than deleting them', async () => {
    const report = await read(REPORT);
    const preamble = report.slice(0, report.indexOf('## 1. Provenance'));
    expect(flat(preamble)).toContain('HISTORICAL EVIDENCE');
    expect(flat(preamble)).toContain('7f03a34f3d4816ba72d041f1541818cae990eaf8');
    expect(flat(preamble)).toContain('Section 16 carries the current state');
    // The historical sections are still there to be read against the findings.
    for (const heading of ['## 1. Provenance', '## 5. Tests', '## 10. Hashes']) {
      expect(report, heading).toContain(heading);
    }
    // And the superseded figures are still present, inside them.
    expect(report).toContain('edb68f5268e419e1b4294f4a4290c31e2d8ea9f06e3db872bc180ee299ae9b3a');
  });
});
