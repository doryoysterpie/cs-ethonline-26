/**
 * Mechanical text rules the validator applies: word counts and quotations.
 * Nothing here judges prose; it counts and matches.
 */

/** Words: runs of letters or digits, apostrophes and hyphens inside them allowed. */
export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches === null ? 0 : matches.length;
}

/** Whitespace collapsed, quotes and dashes unified, case folded: what two texts are compared as. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐-―−]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/** Every quoted span in the text, as written between double quotation marks. */
export function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  const pattern = /"([^"\n]{1,2000})"|“([^”\n]{1,2000})”/gu;
  for (const match of text.matchAll(pattern)) {
    const span = match[1] ?? match[2];
    if (span !== undefined) spans.push(span);
  }
  return spans;
}
