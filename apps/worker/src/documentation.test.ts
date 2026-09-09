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

  it('records Sprint 4 as pending an independent audit, never as accepted', async () => {
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      // Affirmative claims only. A document saying Sprint 4 is *not* accepted
      // is the point, so the negations must survive this check.
      for (const premature of [
        /Sprint 4 (is|has been|was) (accepted|audited)/i,
        /Sprint 4 passed (its |the )?audit/i,
        /Codex Desktop issued PASS for Sprint 4/i,
      ]) {
        expect(premature.test(text), `${document} must not claim ${String(premature)}`).toBe(false);
      }
    }
    const report = await read('docs/SPRINT-4-REPORT.md');
    expect(report).toContain('Sprint 4 remains pending until Codex Desktop issues PASS.');
  });

  it('records that Sprint 5 has not begun', async () => {
    const report = await read('docs/SPRINT-4-REPORT.md');
    expect(report).toContain('Sprint 5 has not begun.');
    for (const document of CURRENT_DOCUMENTS) {
      const text = await read(document);
      expect(text, `${document} must not announce Sprint 5 work`).not.toContain(
        'Sprint 5 is underway',
      );
    }
  });

  it('states Sprint 3 as the accepted base at its audited SHA', async () => {
    const report = await read('docs/SPRINT-4-REPORT.md');
    expect(report).toContain('71394c9b8e732bc7508b6276eafcbbac414c3a07');
  });
});
