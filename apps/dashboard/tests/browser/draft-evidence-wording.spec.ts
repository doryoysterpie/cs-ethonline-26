import { expect, test } from '@playwright/test';

import { credentials, signIn } from './support.ts';

/**
 * The Sprint 5 evidence-state defect, corrected: a source headline no
 * longer reads as though it independently carries its incident's evidence
 * status. Proven here at the rendered page, not only at the unit level in
 * `packages/drafting/src/draft.test.ts`.
 */
test.describe('draft evidence wording', () => {
  test('states the evidence status once per incident, and never as a fact about a specific headline', async ({
    page,
  }) => {
    const { accounts, seeded } = await credentials();
    await signIn(page, accounts.editor.username, accounts.editor.password);
    // A period no other browser test writes a revision to, so the page shows
    // the freshly generated draft rather than a previously saved one.
    const url = `/drafts/${seeded.evidenceRunId}?start=2026-09-04T00:00:00Z&end=2026-09-11T00:00:00Z`;
    await page.goto(url);
    const preview = page.locator('.markdown');
    await expect(preview).toContainText('Incident-level assessment:');
    const text = await preview.textContent();
    expect(text).toBeTruthy();
    // The corrected wording never points at "a specific claim below" or "a
    // named claim": the previous sentence did, and pointed at nothing, since
    // it was rendered after every headline had already been listed.
    expect(text).not.toContain('a specific claim below');
    expect(text).not.toContain('a specific claim');
    expect(text).not.toContain('a named claim');
    // The provenance section states the same distinction in its own words:
    // a claim carries no evidence state of its own.
    expect(text).toContain('never an evidence state of its own');
    expect(text).toContain('Graph evidence (incident-level):');
  });
});
