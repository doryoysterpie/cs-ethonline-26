import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Current-state consistency across the documents a reader treats as true today
 * (audit finding F6).
 *
 * Codex Desktop found `HACKATHON_REQUIREMENTS.md` still calling Check-in #1's
 * submission "still outstanding" while four other documents recorded the
 * owner's confirmation that it was sent. Nothing caught the contradiction
 * because nothing was reading these claims together. This test does.
 *
 * It reads only Markdown from the repository, so it opens no socket, needs no
 * database, no secret and no real data.
 *
 * Historical passages are deliberately out of scope: a report may and should
 * say what was true when it was written. The assertions below are about the
 * claims a reader takes as the current state, so each one names the exact
 * sentence it requires rather than banning a word everywhere.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function read(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), 'utf8');
}

const CURRENT_DOCUMENTS = [
  'README.md',
  'docs/HACKATHON_REQUIREMENTS.md',
  'docs/SPRINT_BOARD.md',
  'docs/SPRINT-4-REPORT.md',
  'docs/SPRINT-5-REPORT.md',
  'docs/CHECKIN-1-DRAFT.md',
  'docs/CHECKIN-2-DRAFT.md',
];

describe('current documentation agrees with itself', () => {
  it('records Check-in #1 as submitted and owner-confirmed, nowhere as outstanding', async () => {
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      // The exact contradiction the audit found, and its neighbours.
      for (const stale of [
        'human action, still outstanding',
        'Check-in #1 has not been submitted',
        "Check-in #1's submission is unconfirmed",
        'Check-in #1 draft, not submitted',
      ]) {
        expect(text, `${document} must not say: ${stale}`).not.toContain(stale);
      }
    }
    const requirements = await read('docs/HACKATHON_REQUIREMENTS.md');
    expect(requirements).toContain('the project owner confirmed submission on 8 September 2026');
    const draft = await read('docs/CHECKIN-1-DRAFT.md');
    expect(draft).toContain('SUBMITTED, confirmed by the project owner on 8 September 2026');
  });

  it('invents no submission time and no receipt identifier', async () => {
    // The confirmation carried neither, so both documents that state it must
    // also state that neither is known.
    for (const document of ['docs/HACKATHON_REQUIREMENTS.md', 'docs/CHECKIN-1-DRAFT.md']) {
      const text = await read(document);
      // Whitespace-tolerant: the sentence wraps across lines in the drafts.
      expect(text.replace(/\s+/gu, ' '), document).toMatch(
        /no submission time(stamp)? or receipt/i,
      );
    }
    // Nothing anywhere claims a receipt, a confirmation number or a portal
    // timestamp for the submission.
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      for (const invented of [/receipt (id|identifier|number)\s*[:=]/i, /confirmation number/i]) {
        expect(invented.test(text), `${document} must not claim one`).toBe(false);
      }
    }
  });

  it('records Check-in #2 as drafted and not submitted, with an unconfirmed cutoff', async () => {
    const draft = await read('docs/CHECKIN-2-DRAFT.md');
    expect(draft).toContain('Status: draft, not submitted.');
    expect(draft).toContain('the cutoff time is **unconfirmed**');
    expect(draft).toContain('HUMAN ACTION REQUIRED');
    expect(draft).not.toContain('Check-in #2 was submitted');
    const requirements = await read('docs/HACKATHON_REQUIREMENTS.md');
    expect(requirements).toContain('**not submitted**');
  });

  it('records Sprint 4 as accepted at its audited SHA, and Sprint 5 as unaudited', async () => {
    // Sprint 4 was accepted on 9 September 2026. What must not appear now is a
    // claim that the *current* sprint has passed an audit it has not had.
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      for (const premature of [
        /Sprint 5 (is|has been|was) (accepted|audited)/i,
        /Sprint 5 passed (its |the )?audit/i,
        /Codex Desktop issued PASS for Sprint 5/i,
      ]) {
        expect(premature.test(text), `${document} must not claim ${String(premature)}`).toBe(false);
      }
    }
    const sprint4 = await read('docs/SPRINT-4-REPORT.md');
    expect(sprint4).toContain(
      'Sprint 4 was accepted by Codex Desktop at `4a0a847748b1ff73c424934547c8e6ccd8a1cd6b`.',
    );
    const board = await read('docs/SPRINT_BOARD.md');
    expect(board).toContain('4a0a847748b1ff73c424934547c8e6ccd8a1cd6b');
  });

  it('records Sprint 5 as in progress and not complete', async () => {
    const board = await read('docs/SPRINT_BOARD.md');
    expect(board).toContain('IN PROGRESS');
    const readme = await read('README.md');
    expect(readme).toContain('**Sprint 5 in progress');
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      for (const premature of [/Sprint 5 (is )?complete/i, /Sprint 6 (has|had) begun/i]) {
        expect(premature.test(text), `${document} must not claim ${String(premature)}`).toBe(false);
      }
    }
  });

  it('states the accepted Sprint 3 base and the verified current test counts', async () => {
    const report = await read('docs/SPRINT-4-REPORT.md');
    expect(report).toContain('71394c9b8e732bc7508b6276eafcbbac414c3a07');

    // The reproduction instructions are located by their heading rather than
    // by a line number, so renumbering a section cannot silently move this
    // check onto the wrong text. The section runs to the next heading, or to
    // the end of the document when it is the last one.
    const heading = /^##\s+\d*\.?\s*Reproduction for Codex Desktop\s*$/mu;
    const start = report.search(heading);
    expect(start, 'the reproduction section must be findable by its heading').toBeGreaterThan(-1);
    const rest = report.slice(start);
    const nextHeading = rest.slice(1).search(/^##\s/mu);
    const reproduction = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);

    // The instruction a reader would follow today must state what the runner
    // actually reports: 141 PostgreSQL tests, 80 in the database package and
    // 61 in the worker.
    expect(reproduction, 'the reproduction step must state 141 PostgreSQL tests').toMatch(
      /141 tests/u,
    );
    expect(reproduction).toMatch(/80 in `@cas\/database`/u);
    expect(reproduction).toMatch(/61 in `@cas\/worker`/u);
    // Codex Desktop found this instruction still claiming the pre-correction
    // count. No stale figure may reappear in the text a reader acts on.
    for (const stale of [/\b123\b/u, /\b363\b/u]) {
      expect(
        stale.test(reproduction),
        `the reproduction section must not state ${String(stale)}`,
      ).toBe(false);
    }

    // The same figures elsewhere in the current record must agree with it.
    expect(report).toContain('| **Total**             | **390** |    **141** |');
    expect(report).toContain('The 141 PostgreSQL tests run only through');

    // Sprint 4's figures are correct at Sprint 4's SHA, and its reproduction
    // section says so in its own first step. Nothing rewrites them here.
    expect(reproduction).toMatch(/Check out `sprint-4\/clustering-incidents` at the final SHA/u);

    // The pre-correction counts remain, but only as historical before-and-after
    // evidence. That row is what the audit explicitly permitted to stay.
    expect(report).toContain(
      '| PostgreSQL tests | 123                                                                | 141',
    );
    expect(report).toContain('| Offline tests    | 363 claimed, 362 passing');
  });

  it('states the current test counts in the Sprint 5 record a reader acts on', async () => {
    // Finding F8 was a reproduction instruction that had gone stale against
    // the runner. The lesson applies to every report as it is written, not
    // only to the one the finding was raised against.
    const report = await read('docs/SPRINT-5-REPORT.md');
    expect(report).toContain('4a0a847748b1ff73c424934547c8e6ccd8a1cd6b');
    expect(report).toMatch(/\*\*482 offline tests\*\*/u);
    expect(report).toMatch(
      /\*\*173 PostgreSQL integration tests\*\*: 81 in `@cas\/database`, 92 in `@cas\/worker`/u,
    );
    // The per-package table must sum to the total it claims.
    const rows = [...report.matchAll(/^\| `@cas\/[a-z-]+`\s*\|\s*(\d+) \|$/gmu)];
    expect(rows).toHaveLength(9);
    expect(rows.reduce((total, row) => total + Number(row[1]), 0)).toBe(482);
    // And it must not claim an audit it has not had.
    expect(report).toContain('**Sprint 5 remains pending until Codex Desktop issues PASS.**');
  });

  it('states the hashes and the migration checksum consistently across documents', async () => {
    const report = await read('docs/SPRINT-5-REPORT.md');
    const decisions = await read('docs/DECISIONS.md');
    for (const value of [
      'faabdade6fb05e0fd8a3f7dcf92807731da126642954e4ddcd9db28ac8dec873',
      'f89382d6794e77a90eb11df841de234421dee2a75651d1cb95187b29b6ddade3',
      '548c810d925d113f2d5ab74f399d3dff9b22f9e144bd2202072489a030344449',
    ]) {
      expect(report, `the Sprint 5 report must state ${value}`).toContain(value);
      expect(decisions, `D25 must state ${value}`).toContain(value);
    }
  });
});
