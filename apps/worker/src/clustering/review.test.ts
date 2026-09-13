import { describe, expect, it } from 'vitest';

import { run } from '../cli.js';
import { EXIT_CODES, isIngestionError } from '../editorial/errors.js';
import { assertReviewNote, REVIEW_NOTE_MAX_LENGTH } from './note.js';
import { canonicalReviewPayload, reviewPayloadDigest, type ReviewActionPayload } from './review.js';

/**
 * The review-note policy and the canonical action payload, offline.
 *
 * Neither needs a database, a socket or a secret. The PostgreSQL suite proves
 * the same policy in the database and holds the canonical payload to the
 * digest migration 0007 computes for the identical row.
 *
 * Prohibited characters are built from code points so this file holds no
 * control byte of its own, as `editorial/display.ts` does.
 */

const char = (code: number): string => String.fromCharCode(code);

/** One representative of every class the policy refuses. */
const PROHIBITED: readonly [name: string, value: string][] = [
  ['NUL', char(0x00)],
  ['tab', char(0x09)],
  ['newline', char(0x0a)],
  ['vertical tab', char(0x0b)],
  ['form feed', char(0x0c)],
  ['carriage return', char(0x0d)],
  ['escape', char(0x1b)],
  ['unit separator', char(0x1f)],
  ['delete', char(0x7f)],
  ['C1 padding', char(0x80)],
  ['C1 control sequence introducer', char(0x9b)],
  ['C1 application program command', char(0x9f)],
  ['line separator', char(0x2028)],
  ['paragraph separator', char(0x2029)],
];

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

describe('the review note policy', () => {
  it('treats absence as null and refuses an empty note', () => {
    expect(assertReviewNote(undefined)).toBeNull();
    expect(assertReviewNote(null)).toBeNull();
    expect(() => assertReviewNote('')).toThrowError(/1 to 280|between 1 and 280/u);
  });

  it('accepts the shortest and the longest permitted note and stores it unchanged', () => {
    expect(assertReviewNote('a')).toBe('a');
    const longest = 'a'.repeat(REVIEW_NOTE_MAX_LENGTH);
    expect(assertReviewNote(longest)).toBe(longest);
    // No normalization: what the reviewer wrote is what is stored.
    const spaced = '  Merged after checking the vendor advisory.  ';
    expect(assertReviewNote(spaced)).toBe(spaced);
  });

  it('refuses a note one character past the bound', () => {
    expect(() => assertReviewNote('a'.repeat(REVIEW_NOTE_MAX_LENGTH + 1))).toThrowError();
  });

  it('refuses every prohibited character class', () => {
    for (const [name, value] of PROHIBITED) {
      for (const note of [value, `line${value}break`, `trailing${value}`, `${value}leading`]) {
        let thrown: unknown;
        try {
          assertReviewNote(note);
        } catch (error) {
          thrown = error;
        }
        expect(isIngestionError(thrown), name).toBe(true);
        const error = thrown as { code: string; message: string };
        expect(error.code, name).toBe('note_invalid');
        // The error names the condition; it never echoes the note.
        expect(error.message, name).toBe('a review note must not contain a control character');
        expect(error.message, name).not.toContain('line');
        expect(error.message, name).not.toContain(value);
      }
    }
  });
});

describe('the command line applies the same note policy', () => {
  async function exec(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      // Set, so the command reaches its own argument validation rather than
      // stopping at configuration. Nothing here opens a handle: every value is
      // validated first.
      env: { DATABASE_URL: 'postgresql://127.0.0.1:5432/cas' },
      io: { log: (l) => out.push(l), error: (l) => err.push(l) },
    });
    return { code, out, err };
  }

  it('refuses a merge and a split note carrying any prohibited character', async () => {
    for (const [name, value] of PROHIBITED) {
      const note = `checked${value}advisory`;
      const merge = await exec([
        'clustering',
        'merge',
        '--run',
        UUID_A,
        '--incidents',
        `${UUID_B},${UUID_C}`,
        '--reason',
        'same_incident',
        '--note',
        note,
      ]);
      expect(merge.code, name).toBe(EXIT_CODES.configuration);
      expect(merge.out, name).toEqual([]);
      expect(merge.err.join('\n'), name).toContain('note_invalid');

      const split = await exec([
        'clustering',
        'split',
        '--run',
        UUID_A,
        '--incident',
        UUID_B,
        '--members',
        UUID_C,
        '--reason',
        'not_same_incident',
        '--note',
        note,
      ]);
      expect(split.code, name).toBe(EXIT_CODES.configuration);
      expect(split.out, name).toEqual([]);
      expect(split.err.join('\n'), name).toContain('note_invalid');
    }
  });

  it('refuses an empty and an over-long note', async () => {
    for (const note of ['', 'a'.repeat(REVIEW_NOTE_MAX_LENGTH + 1)]) {
      const r = await exec([
        'clustering',
        'merge',
        '--run',
        UUID_A,
        '--incidents',
        `${UUID_B},${UUID_C}`,
        '--reason',
        'same_incident',
        '--note',
        note,
      ]);
      expect(r.code).toBe(EXIT_CODES.configuration);
      expect(r.err.join('\n')).toContain('note_invalid');
    }
  });
});

describe('the canonical review payload', () => {
  const base: ReviewActionPayload = {
    operation: 'merge',
    clusteringRunId: UUID_A,
    reasonCode: 'same_incident',
    actor: 'owner',
    note: 'first note',
    expectedRevision: 0,
    incidentIds: [UUID_B, UUID_C],
    membershipIds: [],
  };

  const variants: readonly [name: string, payload: ReviewActionPayload][] = [
    ['operation', { ...base, operation: 'split', membershipIds: [UUID_C] }],
    ['run', { ...base, clusteringRunId: UUID_B }],
    ['reason', { ...base, reasonCode: 'not_same_incident' }],
    ['actor', { ...base, actor: 'auditor' }],
    ['note', { ...base, note: 'different note' }],
    ['absent note', { ...base, note: null }],
    ['empty note', { ...base, note: '' }],
    ['expected revision', { ...base, expectedRevision: 1 }],
    ['absent expected revision', { ...base, expectedRevision: null }],
    ['incident ids', { ...base, incidentIds: [UUID_B] }],
    ['membership ids', { ...base, membershipIds: [UUID_B] }],
  ];

  it('changes for every field it carries, and collides for none of them', () => {
    const digests = new Map<string, string>();
    digests.set(reviewPayloadDigest(base), 'base');
    for (const [name, payload] of variants) {
      const digest = reviewPayloadDigest(payload);
      expect(digest, `${name} must change the digest`).not.toBe(reviewPayloadDigest(base));
      const previous = digests.get(digest);
      expect(previous, `${name} collides with ${previous ?? ''}`).toBeUndefined();
      digests.set(digest, name);
    }
    expect(digests.size).toBe(variants.length + 1);
  });

  it('distinguishes an absent note from an empty one', () => {
    expect(canonicalReviewPayload({ ...base, note: null })).toContain('note:absent');
    expect(canonicalReviewPayload({ ...base, note: '' })).toContain('note:present:0:');
    expect(canonicalReviewPayload({ ...base, expectedRevision: null })).toContain(
      'revision:absent',
    );
    expect(canonicalReviewPayload({ ...base, expectedRevision: 0 })).toContain('revision:0');
  });

  it('ignores identifier order and case, so logically identical sets stay identical', () => {
    expect(reviewPayloadDigest({ ...base, incidentIds: [UUID_C, UUID_B] })).toBe(
      reviewPayloadDigest(base),
    );
    expect(
      reviewPayloadDigest({ ...base, incidentIds: [UUID_C.toUpperCase(), UUID_B.toUpperCase()] }),
    ).toBe(reviewPayloadDigest(base));
    expect(reviewPayloadDigest({ ...base, clusteringRunId: UUID_A.toUpperCase() })).toBe(
      reviewPayloadDigest(base),
    );
  });

  it('counts and length-prefixes so a note cannot imitate a field boundary', () => {
    const forged = 'x';
    const payload = canonicalReviewPayload({ ...base, note: forged });
    expect(payload).toContain(`note:present:${forged.length}:${forged}`);
    expect(payload).toContain(`incidents:2:`);
    expect(payload).toContain(`memberships:0:`);
    // A note that spells out another field's line cannot be mistaken for one,
    // because its own line declares its length first.
    const spoof = 'x actor:auditor';
    expect(canonicalReviewPayload({ ...base, note: spoof })).toContain(
      `note:present:${Buffer.byteLength(spoof, 'utf8')}:${spoof}`,
    );
    expect(reviewPayloadDigest({ ...base, note: spoof })).not.toBe(
      reviewPayloadDigest({ ...base, actor: 'auditor' }),
    );
  });

  it('counts the note in UTF-8 bytes rather than in code units', () => {
    const wide = 'é☃';
    expect(canonicalReviewPayload({ ...base, note: wide })).toContain(
      `note:present:${Buffer.byteLength(wide, 'utf8')}:${wide}`,
    );
    expect(Buffer.byteLength(wide, 'utf8')).not.toBe(wide.length);
  });
});
