import { describe, expect, it } from 'vitest';

import { isIngestionError } from './errors.js';
import { cellFor, normalizeHeaderName, resolveHeaderLayout } from './headers.js';

const WEEKLY = ['ch', 'Date Posted', 'Date Updated', 'Title', 'Summary', 'URL', 'Category', '', ''];

function structuralCode(cells: readonly string[]): string {
  try {
    resolveHeaderLayout(cells);
  } catch (error) {
    if (isIngestionError(error) && error.kind === 'structural') return error.code;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('resolveHeaderLayout', () => {
  it('accepts repeated blank headers, keeps their positions, and never maps them to a field', () => {
    const layout = resolveHeaderLayout(WEEKLY);
    expect(layout.blankPositions).toEqual([7, 8]);
    expect(layout.named.size).toBe(7);
    expect(layout.named.has('')).toBe(false);
    expect(layout.names[7]).toBeNull();
    expect(layout.cells).toEqual(WEEKLY);
    expect(layout.knownNames).toEqual([
      'ch',
      'Date Posted',
      'Date Updated',
      'Title',
      'Summary',
      'URL',
      'Category',
    ]);
    expect(layout.unknownNames).toEqual([]);
  });

  it('recognizes known fields by normalized name and keeps unknown names', () => {
    const layout = resolveHeaderLayout([
      'URL',
      ' Title ',
      'ch',
      'Date Updated',
      'Date Posted',
      'Editor Note',
    ]);
    expect(layout.named.get('Title')).toBe(1);
    expect(layout.named.get('URL')).toBe(0);
    expect(layout.unknownNames).toEqual(['Editor Note']);
    expect(cellFor(layout, ['u', 't', 'c', 'd2', 'd1', 'n'], 'Title')).toBe('t');
    expect(cellFor(layout, ['u', 't', 'c', 'd2', 'd1', 'n'], 'Author')).toBeNull();
  });

  it('rejects a duplicated non-blank header', () => {
    expect(structuralCode(['ch', 'Date Posted', 'Date Updated', 'Title', 'Title', 'URL'])).toBe(
      'header_duplicate',
    );
  });

  it('rejects missing required headers naming only known names', () => {
    let caught: unknown;
    try {
      resolveHeaderLayout(['ch', 'Date Posted', 'Date Updated', 'Title', 'Summary']);
    } catch (error) {
      caught = error;
    }
    expect(isIngestionError(caught) && caught.code === 'header_required_missing').toBe(true);
    expect((caught as Error).message).toContain('URL');
  });

  it('rejects a header with no named column', () => {
    expect(structuralCode(['', '', ''])).toBe('header_empty');
  });

  it('normalizes names with NFC and trimming', () => {
    expect(normalizeHeaderName('  Title\t')).toBe('Title');
    expect(normalizeHeaderName('é')).toBe('é');
  });
});
