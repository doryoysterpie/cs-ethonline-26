import { describe, expect, it } from 'vitest';

import {
  RESOURCE_LIMIT_HEADROOM,
  RESOURCE_LIMIT_MEASUREMENTS,
  RESOURCE_LIMITS,
  RESOURCE_LIMITS_VERSION,
} from './limits.js';

/**
 * The limits are pinned value by value. A change to any of them is a change
 * to the versioned policy and must arrive with a new version and a recorded
 * measurement, so the assertions here are deliberately literal.
 */
describe('resource limits', () => {
  it('publishes version resource-limits@1', () => {
    expect(RESOURCE_LIMITS_VERSION).toBe('resource-limits@1');
    expect(RESOURCE_LIMITS.version).toBe(RESOURCE_LIMITS_VERSION);
  });

  it('pins the import limits', () => {
    expect(RESOURCE_LIMITS.import).toEqual({
      fileBytes: 536_870_912,
      rowCount: 250_000,
      columnCount: 64,
      cellBytes: 1_048_576,
      retainedBytes: 536_870_912,
      recordBytes: 67_108_864,
    });
    // The parser buffer bound is derived from the two limits that compose a record.
    expect(RESOURCE_LIMITS.import.recordBytes).toBe(
      RESOURCE_LIMITS.import.columnCount * RESOURCE_LIMITS.import.cellBytes,
    );
    // The store cannot retain more than the file held.
    expect(RESOURCE_LIMITS.import.retainedBytes).toBeLessThanOrEqual(
      RESOURCE_LIMITS.import.fileBytes,
    );
  });

  it('pins the Graph response limits', () => {
    expect(RESOURCE_LIMITS.graph).toEqual({
      responseBodyBytes: 1_048_576,
      httpErrorSnippetBytes: 4_096,
      jsonMaxDepth: 32,
      jsonMaxCollectionSize: 4_096,
      jsonMaxCollections: 16_384,
      concurrentRequests: 8,
    });
    expect(RESOURCE_LIMITS.graph.httpErrorSnippetBytes).toBeLessThan(
      RESOURCE_LIMITS.graph.responseBodyBytes,
    );
  });

  it('pins the draft limits to the drafting contract structure', () => {
    expect(RESOURCE_LIMITS.draft).toEqual({
      sections: 4,
      claims: 10_000,
      outputBytes: 16_777_216,
      sidecarBytes: 16_777_216,
    });
    // 500 incidents times 20 claims per incident in drafting-behavior-contract@1.
    expect(RESOURCE_LIMITS.draft.claims).toBe(500 * 20);
  });

  it('pins the command limits', () => {
    expect(RESOURCE_LIMITS.command).toEqual({ durationMs: 1_800_000, graceMs: 5_000 });
  });

  it('gives every measured limit at least the declared headroom over its measurement', () => {
    expect(RESOURCE_LIMIT_HEADROOM).toBe(4);
    expect(RESOURCE_LIMIT_MEASUREMENTS.measuredOn).toBe('2026-09-10');
    const groups = ['import', 'graph', 'command'] as const;
    for (const group of groups) {
      const limits: Record<string, number> = { ...RESOURCE_LIMITS[group] };
      const measured: Record<string, number> = { ...RESOURCE_LIMIT_MEASUREMENTS[group] };
      for (const [key, limit] of Object.entries(limits)) {
        const observed = measured[key];
        expect(observed, `${group}.${key} has a measurement`).toBeTypeOf('number');
        expect(
          limit,
          `${group}.${key} keeps ${RESOURCE_LIMIT_HEADROOM}x headroom`,
        ).toBeGreaterThanOrEqual(RESOURCE_LIMIT_HEADROOM * (observed ?? Number.POSITIVE_INFINITY));
      }
    }
    // Draft byte limits are measured; the two structural draft limits are exact.
    expect(RESOURCE_LIMITS.draft.outputBytes).toBeGreaterThanOrEqual(
      RESOURCE_LIMIT_HEADROOM * RESOURCE_LIMIT_MEASUREMENTS.draft.outputBytes,
    );
    expect(RESOURCE_LIMITS.draft.sidecarBytes).toBeGreaterThanOrEqual(
      RESOURCE_LIMIT_HEADROOM * RESOURCE_LIMIT_MEASUREMENTS.draft.sidecarBytes,
    );
    expect(RESOURCE_LIMITS.draft.sections).toBe(RESOURCE_LIMIT_MEASUREMENTS.draft.sections);
    expect(RESOURCE_LIMITS.draft.claims).toBeGreaterThanOrEqual(
      RESOURCE_LIMIT_HEADROOM * RESOURCE_LIMIT_MEASUREMENTS.draft.claims,
    );
  });

  it('is frozen and holds positive integers only', () => {
    expect(Object.isFrozen(RESOURCE_LIMITS)).toBe(true);
    for (const group of ['import', 'graph', 'draft', 'command'] as const) {
      expect(Object.isFrozen(RESOURCE_LIMITS[group])).toBe(true);
      for (const value of Object.values(RESOURCE_LIMITS[group])) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });
});
