import Link from 'next/link';

import { codePointName, escapeCodePoint, type DataOrigin } from '@cas/contracts';

import { safeParts } from '../server/display.ts';
import {
  NOTICE_CHARACTERS_MAX,
  isCleanedNotice,
  isErrorNotice,
  noticeCharacters,
  noticeFor,
  noticeField,
  noticeMore,
  type NoticeCharacter,
} from '../app/notices.ts';

/** The data origin, shown on every record the dashboard renders. */
export function Origin({ value }: { readonly value: DataOrigin }) {
  return <span className={`origin origin-${value}`}>{value}</span>;
}

/**
 * Hostile stored text, escaped and bounded. Each escape renders in its own
 * style, apart from body text, so a literal backslash sequence in the value is
 * never taken for one (D50, point 3).
 */
export function Text({
  value,
  max,
}: {
  readonly value: unknown;
  readonly max?: number | undefined;
}) {
  return (
    <>
      {safeParts(value, max).map((part, index) =>
        part.escape ? (
          <span key={index} className="escaped">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** One named character: `\u{00AD} SOFT HYPHEN, field markdown, line 4, column 17`. */
function NamedCharacter({
  character,
  field,
}: {
  readonly character: NoticeCharacter;
  readonly field: string | null;
}) {
  const name = codePointName(character.codePoint);
  return (
    <li>
      <span className="escaped">{escapeCodePoint(character.codePoint)}</span>
      {name === null ? '' : ` ${name}`}
      {field === null ? '' : `, field ${field}`}, line {character.line}, column {character.column}
    </li>
  );
}

/**
 * A fixed notice, and, for one that names characters, each of them by its
 * escape, name and position, never a character of the text (D50 and its
 * amendment of 1 November 2026): `\u{00AD} SOFT HYPHEN, field markdown, line 4,
 * column 17`. A save's notice lists every character the save removed from its
 * body, from the record its revision keeps (`removed`), past the first twenty
 * behind a disclosure; with no record it says only that the text was saved. A
 * refusal lists what its redirect carried (`field`, `at`), the first twenty in
 * the order they stood, and states exactly how many more there were (`more`),
 * or, on a page that holds the refusal itself, all of them (`characters`).
 * Past the cap, a refusal adds that a broken copy is the likely cause.
 */
export function Notice({
  code,
  at,
  more,
  field,
  characters,
  removed,
}: {
  readonly code: unknown;
  readonly at?: unknown;
  readonly more?: unknown;
  readonly field?: unknown;
  readonly characters?: readonly NoticeCharacter[];
  readonly removed?: readonly NoticeCharacter[];
}) {
  const cleaned = isCleanedNotice(code);
  const listed = cleaned ? (removed ?? []) : (characters ?? noticeCharacters(at));
  const shown =
    cleaned && listed.length === 0 ? (code === 'saved_cleaned' ? 'saved' : 'edited') : code;
  const message = noticeFor(shown);
  if (message === null) return null;
  const className = isErrorNotice(shown) ? 'notice notice-error' : 'notice';
  if (listed.length === 0) return <p className={className}>{message}</p>;
  // A save's removals are always from its body.
  const named = cleaned ? 'markdown' : noticeField(field);
  const first = listed.slice(0, NOTICE_CHARACTERS_MAX);
  const rest = listed.slice(NOTICE_CHARACTERS_MAX);
  const unlisted = !cleaned && characters === undefined ? noticeMore(more) : 0;
  const overflow = !cleaned && (unlisted > 0 || rest.length > 0);
  return (
    <div className={className}>
      <p>{message}</p>
      <ul className="notice-characters">
        {first.map((character, index) => (
          <NamedCharacter key={index} character={character} field={named} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details>
          <summary>{rest.length} more</summary>
          <ul className="notice-characters">
            {rest.map((character, index) => (
              <NamedCharacter key={index} character={character} field={named} />
            ))}
          </ul>
        </details>
      ) : null}
      {unlisted > 0 ? (
        <p>And {unlisted} more, named when the text is submitted again without the ones above.</p>
      ) : null}
      {overflow ? (
        <p>
          More than {NOTICE_CHARACTERS_MAX} refused characters usually means a broken copy; copying
          the text again from its source is the expected fix.
        </p>
      ) : null}
    </div>
  );
}

export function Limitation({ children }: { readonly children: React.ReactNode }) {
  return <p className="limitation">{children}</p>;
}

export function Csrf({ token }: { readonly token: string }) {
  return <input type="hidden" name="csrfToken" value={token} />;
}

export function Instant({ value }: { readonly value: string | null }) {
  return <span className="mono">{value ?? '—'}</span>;
}

/**
 * The prompt glyph of the terminal grid (CAS-010): a fixed character, the
 * cursor blinking by CSS alone and holding still under a reduced-motion
 * preference. Decorative: hidden from assistive technology.
 */
export function Prompt() {
  return (
    <span className="prompt" aria-hidden="true">
      &gt;
      <span className="cursor" />
    </span>
  );
}

/**
 * A section block (CAS-010, design note 1.2): a title bar with a glyph, the
 * title, and the controls at the right (sort and filter links a page already
 * reads from its query string), then the block's content, a table most often,
 * which scrolls inside the block on a narrow screen rather than breaking the
 * page. The title is a level-3 heading, so the page keeps its outline.
 */
export function SectionBlock({
  title,
  glyph = '▣',
  controls,
  children,
}: {
  readonly title: React.ReactNode;
  readonly glyph?: string | undefined;
  readonly controls?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="block">
      <header className="block-head">
        <span className="glyph" aria-hidden="true">
          {glyph}
        </span>
        <h3>{title}</h3>
        {controls === undefined ? null : <div className="block-controls">{controls}</div>}
      </header>
      <div className="block-body">{children}</div>
    </section>
  );
}

/** The bar beneath a block that carries its filters, the sort, the page size and the search a page has. */
export function FilterBar({ children }: { readonly children: React.ReactNode }) {
  return <div className="filter-bar">{children}</div>;
}

/**
 * One choice among fixed options, as links that set the query parameters the
 * page already reads: the current option is marked, the others are links.
 * Server-side, no script: the choice is the request.
 */
export function ChoiceLinks({
  label,
  current,
  options,
}: {
  readonly label: string;
  readonly current: string;
  readonly options: readonly {
    readonly key: string;
    readonly label: string;
    readonly href: string;
  }[];
}) {
  return (
    <span className="choice">
      <span className="choice-label">{label}</span>
      {options.map((option, index) => (
        <span key={option.key}>
          {index === 0 ? '' : ' · '}
          {option.key === current ? (
            <strong aria-current="true">{option.label}</strong>
          ) : (
            <Link href={option.href}>{option.label}</Link>
          )}
        </span>
      ))}
    </span>
  );
}
