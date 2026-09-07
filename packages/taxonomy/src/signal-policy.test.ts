import { describe, expect, it } from 'vitest';

import {
  canonicalSignalPolicy,
  CLASSIFICATION_SIGNAL_POLICY_VERSION,
  CLASSIFICATION_SIGNALS,
  CVE_IDENTIFIER_PATTERN,
  CVE_SIGNAL_ID,
  POLICY_THRESHOLDS,
  SIGNAL_TIERS,
  SIGNAL_WEIGHTS,
} from './signal-policy.js';

describe('classification signal policy v1', () => {
  it('is versioned and covers all three tiers', () => {
    expect(CLASSIFICATION_SIGNAL_POLICY_VERSION).toBe('classification-signal-policy@1');
    const tiers = new Set(CLASSIFICATION_SIGNALS.map((s) => s.tier));
    expect([...tiers].sort()).toEqual([...SIGNAL_TIERS].sort());
    expect(POLICY_THRESHOLDS.decisiveHitsForInclude).toBe(1);
    expect(POLICY_THRESHOLDS.distinctContextualHitsForInclude).toBe(2);
    expect(SIGNAL_WEIGHTS.decisive).toBeGreaterThan(SIGNAL_WEIGHTS.contextual);
    expect(SIGNAL_WEIGHTS.out_of_scope).toBe(0);
  });

  it('gives every signal a stable machine-readable identifier, used once', () => {
    const ids = CLASSIFICATION_SIGNALS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('keeps every term lower case, trimmed and free of regular-expression syntax', () => {
    for (const signal of CLASSIFICATION_SIGNALS) {
      for (const term of signal.terms) {
        expect(term, term).toBe(term.toLowerCase());
        expect(term, term).toBe(term.trim());
        expect(term.length, term).toBeGreaterThan(1);
        expect(term, term).not.toMatch(/[.*+?^${}()|[\]\\]/u);
        expect(term, term).not.toMatch(/\s{2,}/u);
      }
    }
  });

  it('never repeats a term across signals or tiers, so a hit maps to one identifier', () => {
    const seen = new Map<string, string>();
    for (const signal of CLASSIFICATION_SIGNALS) {
      for (const term of signal.terms) {
        expect(seen.has(term), `${term} also in ${seen.get(term) ?? ''}`).toBe(false);
        seen.set(term, signal.id);
      }
    }
  });

  it('names no dataset, calibration week, identifier or publisher', () => {
    const forbidden = /cs\d{2}|cyberattack sunday|latestincyber|http|\buuid\b|\d{4}-\d{2}-\d{2}/u;
    for (const signal of CLASSIFICATION_SIGNALS) {
      expect(signal.id, signal.id).not.toMatch(forbidden);
      for (const term of signal.terms) expect(term, term).not.toMatch(forbidden);
    }
  });

  it('matches a CVE identifier by pattern rather than by phrase', () => {
    const cve = CLASSIFICATION_SIGNALS.find((s) => s.id === CVE_SIGNAL_ID);
    expect(cve?.tier).toBe('decisive');
    expect(cve?.terms).toEqual([]);
    const regex = new RegExp(`^(?:${CVE_IDENTIFIER_PATTERN})$`, 'u');
    expect(regex.test('cve-2026-12345')).toBe(true);
    expect(regex.test('cve-26-1')).toBe(false);
  });

  it('serializes canonically, so the ruleset hash is stable', () => {
    expect(canonicalSignalPolicy()).toBe(canonicalSignalPolicy());
    const parsed = JSON.parse(canonicalSignalPolicy()) as {
      signals: { id: string; terms: string[] }[];
    };
    const ids = parsed.signals.map((s) => s.id);
    expect([...ids]).toEqual([...ids].sort());
    for (const signal of parsed.signals) expect(signal.terms).toEqual([...signal.terms].sort());
  });
});
