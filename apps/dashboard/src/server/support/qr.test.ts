import { describe, expect, it } from 'vitest';

import { qrMatrix, qrPath } from './qr.ts';

describe('the in-process QR code', () => {
  it('draws a version-1 symbol for a short string with the three finder patterns in place', () => {
    const matrix = qrMatrix('HELLO');
    expect(matrix.size).toBe(21);
    const finder = (top: number, left: number) => {
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 7; c += 1) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(matrix.dark[top + r]?.[left + c]).toBe(ring || core);
        }
      }
    };
    finder(0, 0);
    finder(0, 14);
    finder(14, 0);
  });

  it('is deterministic, grows with the input, and renders one path element per dark module', () => {
    const a = qrMatrix('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    const b = qrMatrix('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(a).toEqual(b);
    expect(a.size).toBeGreaterThan(21);
    const path = qrPath(a);
    const darkCount = a.dark.flat().filter(Boolean).length;
    expect(path.split('z').length - 1).toBe(darkCount);
    expect(path).toMatch(/^(?:M\d+ \d+h1v1h-1z)+$/u);
  });

  it('refuses an empty or oversized text', () => {
    expect(() => qrMatrix('')).toThrow(RangeError);
    expect(() => qrMatrix('x'.repeat(257))).toThrow(RangeError);
  });
});
