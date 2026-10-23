import 'server-only';

import type { PublicStoryCard } from '@cas/contracts';

/**
 * The card as an SVG document (CAS-009, D48): 1,200 by 630, the size link
 * previews use; text only, in the dashboard's palette, set in the one font
 * the rasterizer is given; no image, no link, no stylesheet, no reference to
 * anything outside the document. Every string is XML-escaped. The owner's
 * creative replaces this layout later; the fields stay the contract's.
 */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_FONT = 'JetBrains Mono';

const NAVY = '#162e3c';
const PANEL = '#1b3947';
const LINE = '#204351';
const INK = '#f5f3f9';
const MUTED = '#b3c8d2';
const GREEN = '#90ba4b';

export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** Words into lines of at most `width` characters; a word longer than a line is cut. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let rest = word;
    while (rest.length > width) {
      if (line.length > 0) {
        lines.push(line);
        line = '';
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    const candidate = line.length === 0 ? rest : `${line} ${rest}`;
    if (candidate.length <= width) {
      line = candidate;
    } else {
      lines.push(line);
      line = rest;
    }
  }
  if (line.length > 0) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  return kept;
}

function weekOf(card: PublicStoryCard): string {
  return `${card.weekStart.slice(0, 10)} to ${card.weekEnd.slice(0, 10)}`;
}

export function cardSvg(card: PublicStoryCard): string {
  const headline = wrap(card.headline, 38, 4);
  const publishers = card.publishers.length === 0 ? '' : card.publishers.join(' · ');
  const attribution = wrap(publishers, 60, 2);
  const kind = card.output === 'roundup' ? 'Round-up' : 'Article';
  const text = (
    x: number,
    y: number,
    size: number,
    fill: string,
    value: string,
    weight = 400,
  ): string =>
    `<text x="${x}" y="${y}" font-family="${CARD_FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(value)}</text>`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${NAVY}"/>`,
    `<rect x="40" y="40" width="${CARD_WIDTH - 80}" height="${CARD_HEIGHT - 80}" fill="${PANEL}" stroke="${LINE}" stroke-width="2"/>`,
    text(72, 104, 30, GREEN, '> LATEST IN CYBER', 700),
    text(72, 148, 22, MUTED, `${kind} · ${card.category} · week ${weekOf(card)}`),
    ...headline.map((line, i) => text(72, 236 + i * 58, 44, INK, line, 700)),
    ...attribution.map((line, i) =>
      text(72, 236 + headline.length * 58 + 30 + i * 32, 24, MUTED, line),
    ),
    text(72, CARD_HEIGHT - 76, 20, MUTED, `revision ${card.revision} · sign in to read the issue`),
    `</svg>`,
  ];
  return parts.join('\n');
}
