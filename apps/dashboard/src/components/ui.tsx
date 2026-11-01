import Link from 'next/link';

import { codePointName, escapeCodePoint, type DataOrigin } from '@cas/contracts';

import { safeParts } from '../server/display.ts';
import { isErrorNotice, noticeCharacters, noticeFor } from '../app/notices.ts';

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

/**
 * A fixed notice, and, for one that names characters, each of them by its
 * escape, name and position (D50): `\u{00AD} SOFT HYPHEN, line 4, column 17`.
 */
export function Notice({ code, at }: { readonly code: unknown; readonly at?: unknown }) {
  const message = noticeFor(code);
  if (message === null) return null;
  const className = isErrorNotice(code) ? 'notice notice-error' : 'notice';
  const characters = noticeCharacters(at);
  if (characters.length === 0) return <p className={className}>{message}</p>;
  return (
    <div className={className}>
      <p>{message}</p>
      <ul className="notice-characters">
        {characters.map((character, index) => {
          const name = codePointName(character.codePoint);
          return (
            <li key={index}>
              <span className="escaped">{escapeCodePoint(character.codePoint)}</span>
              {name === null ? '' : ` ${name}`}, line {character.line}, column {character.column}
            </li>
          );
        })}
      </ul>
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
