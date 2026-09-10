import { quoteEvidence } from './text.js';

/**
 * Inert Markdown: how quoted evidence enters the draft preview.
 *
 * The draft preview is Markdown, and Markdown is a language: a headline that
 * contains `![alt](url)` is an image a renderer fetches, `[text](url)` is a
 * link a reader follows, `# heading`, `**bold**`, a code fence, an HTML tag,
 * an entity such as `&#x3C;` or a bare `https://` URL each mean something to
 * some renderer. Retrieved text must mean nothing. So every retrieved value
 * that is placed inside the preview is first rendered as quoted evidence
 * (`text.ts`: controls, separators, bidirectional controls and angle brackets
 * become visible escapes) and then every ASCII punctuation character with a
 * structural meaning in CommonMark, GitHub-flavoured Markdown or a common
 * extension is backslash-escaped. CommonMark section 2.4 guarantees that a
 * backslash-escaped ASCII punctuation character is the literal character, so
 * the rendered text is exactly the evidence and no construct can form from
 * it. The escaped set is:
 *
 *   `\`   the escape character itself, so a stored backslash cannot cancel an
 *         escape that follows it;
 *   `` ` `` code spans;  `*` `_` emphasis;  `[` `]` `(` `)` links, images and
 *   footnotes;  `<` `>` HTML and autolinks;  `#` headings;  `!` images;
 *   `|` tables;  `~` strikethrough;  `^` superscript;  `$` mathematics;
 *   `=` highlight;  `:` scheme autolinks and emoji shortcodes;  `@` mentions
 *   and mail autolinks;  `.` `www.` autolinks;  `&` entity references;
 *   `{` `}` attribute blocks.
 *
 * Every other ASCII punctuation character (`, ; ? % / - + ' "`) has no
 * structural meaning inside a line and is left readable. A quoted value is
 * always a single line, so block constructs that need a line start (lists,
 * block quotes, fences, thematic breaks, setext underlines, tables) cannot be
 * started by evidence, whose lines always begin with the drafter's own text.
 *
 * A source reference is shown as a code span instead: code is rendered
 * verbatim and never autolinked, so the reference is readable and copyable
 * without becoming a link. The fence is one backtick longer than any backtick
 * run inside the content, which is how CommonMark makes a code span hold any
 * text.
 *
 * Nothing here fetches, resolves or follows anything. The preview text is
 * data about what was reported; the notice the preview carries says so.
 */

/** ASCII punctuation with a structural meaning in CommonMark, GFM or a common extension. */
const MARKDOWN_ACTIVE = /[\\`*_[\]()<>#!|~^$=:@.&{}]/g;

/** Backslash-escapes every Markdown-active ASCII punctuation character of a display copy. */
export function escapeMarkdown(display: string): string {
  return display.replace(MARKDOWN_ACTIVE, (character) => `\\${character}`);
}

/**
 * Renders one retrieved value as inert inline Markdown: quoted evidence,
 * bounded, then escaped. `null` stays `null`.
 */
export function inertInline(value: string | null | undefined, maxLength: number): string | null {
  const quoted = quoteEvidence(value, maxLength);
  return quoted === null ? null : escapeMarkdown(quoted.text);
}

/**
 * Wraps a display copy in a code span whose fence is longer than any backtick
 * run inside it. A copy that begins or ends with a space or a backtick is
 * padded with one space on each side, which CommonMark strips again, so the
 * rendered content is the copy exactly.
 */
export function codeSpan(display: string): string {
  // An empty copy has no empty code span; one space is the nearest inert form.
  if (display.length === 0) return '` `';
  const longest = Math.max(0, ...(display.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const allSpaces = display.trim().length === 0;
  const pad =
    !allSpaces &&
    (display.startsWith('`') ||
      display.endsWith('`') ||
      display.startsWith(' ') ||
      display.endsWith(' '))
      ? ' '
      : '';
  return `${fence}${pad}${display}${pad}${fence}`;
}
