# CAS-010 report: the dashboard's terminal grid

**Unit:** CAS-010 (`docs/POST-EVENT-PLAN.md`, section 5). **Tracker:** `docs/tcu/CAS-010.md`.
**Issue:** [#30](https://github.com/doryoysterpie/cs-ethonline-26/issues/30). **Decision:** D47.
**State:** in review, pull request 34. The owner admitted this unit on 22 October 2026 for its design note, with
one condition: no implementation pull request opens until the review queue of pull requests
24 to 28 is back under a day. The note was written first so that CAS-009's story cards have a
grid to land in; the queue emptied on 22 October 2026 when the owner merged 26, 27 and 28, and
the build began the same day on `cas-010/layout`.

## 1. Design note, S0, written before code (step 1)

Written against D47: the "clean terminal grid" template the owner supplied on 22 October 2026
(the image is in the owner's vault, `01_Specs/cs-ethonline-26/design/`), in the dashboard's
existing palette and nothing else, with effects that CSS alone provides.

### 1.1 What the unit does, in one paragraph

The dashboard keeps its information architecture, its routes, its data-access layer, its
capability table and its policy headers, and changes its presentation: a sidebar that lists
the sections with an honest status block beneath, a header bar with the product name and the
request's instant, every table wrapped in a section block with a title bar and a sort control,
a footer bar carrying the filters, and the terminal treatment over all of it, a monospaced
face, section titles in the emphasis colour, scanlines, a soft glow on titles, a blinking
prompt. Nothing is fetched, no script is added for the look, no font is downloaded, and every
colour is one of the nine tokens of `apps/dashboard/src/app/globals.css`.

### 1.2 The template, element by element, against what exists

- **Sidebar.** The product name (`Latest in Cyber`, not the template's name) and a one-line
  tag; the section list is the existing navigation in the existing order (command centre,
  review queue, incident explorer, editorial week, evidence states, anomaly feed, drafts,
  published, support, donate, accounts and sessions, access requests), each gated by the
  capability it is gated by today; glyphs are monospaced characters, not an icon font; the
  current section is marked. Beneath, the status block shows what the dashboard can state
  truthfully: the build (`RAILWAY_GIT_COMMIT_SHA`'s first seven characters when Railway sets
  it, otherwise "local"), the latest week run (its window and status, with the data-origin
  badge the pages already carry), and the principal's name and role. The template's uptime,
  system load and log level are not shown: the dashboard measures none of them, and a number
  it does not measure is a fabrication. The template's "type help for commands" prompt has no
  command line behind it; the search field is its analogue.
- **Header bar.** The prompt glyph, the product name, and the instant the page was rendered,
  in UTC, from the server. The clock does not tick: a ticking clock needs client-side script,
  and the dashboard ships none of its own; the instant is labelled "as of". The cursor blinks
  by a CSS animation, and does not under `prefers-reduced-motion: reduce`.
- **Section blocks.** Every table a page renders today becomes a block: a title bar (glyph,
  title, the sort control at the right), the table beneath with the columns it has now. The
  command centre's four blocks are its four tables (evidence runs, clustering runs, graph
  signal runs, classification runs); the week page's block is the sift table. Sorting stays
  server-side through the query parameters the pages already read (`sort=` on the week page)
  and gains the same form on the other blocks; the template's "signal marks" column maps to
  the state cells and origin badges that exist (corroborated, contradicted, live, fixture,
  replay), never to invented icons.
- **Footer bar.** The filters as links that set query parameters (the categories and states
  a page already filters by), the sort by, the page size where a page has one, and the search
  field where a page searches today (the week table). The template's "press / to search" is
  not written: the shortcut would need script, and the owner chose to omit both the shortcut
  and the label (decision 2).
- **Typography.** A monospaced system stack for the whole shell (`ui-monospace`, `SFMono-Regular`,
  `Menlo`, `Consolas`, `Liberation Mono`, `monospace`): zero bytes downloaded, and `font-src
'self'` stays as it is. Section titles are set in capitals by `text-transform`, so the
  document keeps sentence case for a screen reader. The existing `.mono` class becomes the
  default and the body copy (notices, limitations, the Markdown preview) keeps a measured line
  length.
- **Effects.** Scanlines: one fixed, full-viewport pseudo-element carrying a repeating linear
  gradient at a low alpha, `pointer-events: none`, so it can never intercept a click or a
  focus. Glow: a `text-shadow` on section titles and the prompt only, in the emphasis colour
  at low alpha, never on body text. Blink: one keyframe animation on the prompt glyph. All
  three are removed under `prefers-reduced-motion: reduce` (the blink) and
  `prefers-contrast: more` (the scanlines and the glow), and the contrast ratios the stylesheet
  records are re-measured with the scanline overlay in place before any value ships.
- **Colours.** The nine tokens as they are: `navy` (the page), `panel` and `panel-raised` (the
  sidebar and the blocks), `line`, `ink` and `muted`, `sky` (links, the accent), `orange`
  (warnings), `yellow`, `green` (the emphasis: section titles, the online dot, the prompt),
  `magenta` (danger, the crypto feed). The template's lime on black is not adopted: the
  emphasis stays `--green` on `--navy`. A test holds the stylesheet to those tokens (section
  1.6).
- **Narrow screens.** The shell's fixed 220-pixel sidebar column becomes a top strip under
  900 pixels and the blocks stack; the tables scroll horizontally inside their block rather
  than breaking the page. The dashboard is used on a desk, but a phone must not be unusable.

### 1.3 What does not change

Routes and pages, the data-access layer and its DTOs, the Markdown sanitiser, the capability
table (D42, D43), the limits, the content security policy (no inline style, no new script
origin, `font-src 'self'`), the dependency set (nothing added), the sign-in pages' behaviour.
The sign-in pages sit outside the shell; they take the grid and the typeface so the first
screen matches, and no status block: no build hash and no principal on a page before
authentication (decision 5).

### 1.4 Decisions this note raised, resolved by the owner on 22 October 2026

1. **The clock: (a), amended.** One instant, labelled "as of", static, in America/Toronto with
   the UTC offset shown, matching D10's clock; and it is the data instant, the completion of
   the last successful import, not the render instant, since freshness is the only thing a
   reader needs from it.
2. **The search shortcut: (a).** Omitted, label included: a label without the script would
   promise a shortcut that does not exist.
3. **The status block: (a).** The build, the latest week, the principal, and the "as of"
   instant of decision 1, which covers "last import" without a separate line.
4. **The typeface: (a).** The system monospaced stack; the policy unchanged.
5. **The sign-in pages: (a), amended.** The same grid and typeface so the first screen
   matches, and no status block before authentication: no build hash and no principal on a
   pre-authentication page.

### 1.5 Files touched, and not touched

Touched: `apps/dashboard/src/app/globals.css` (most of the change), the protected layout (the
sidebar, the status block, the header bar), `components/ui.tsx` (a `SectionBlock` and a
`FilterBar`), every protected page where a table is wrapped in a block and a sort or filter
link is added, the sign-in pages as decided, the browser tests, this report, the README's
screenshots if any. Not touched: anything under `server/`, the packages, the migrations, the
policy files, `next.config.ts`, the headers.

### 1.6 Verification plan

Browser tests through the existing Playwright runner: the command centre and the week page at
1280 and 390 pixels wide, under both motion preferences, compared as screenshots to the
checked-in references; a focus-order walk through the sidebar and one block; a click on a
table link with the overlay present. A stylesheet test that every colour literal in
`globals.css` sits inside `:root` and that every other colour reference names a token. The
headers test unchanged. A dependency test that the lockfile and the bill of materials did not
change. The contrast ratios re-measured and recorded in the stylesheet's header comment. Then
the verify loop, a clean clone and CI.

### 1.7 The interface CAS-009 lands in

A story card is a section block of its own: the block's title bar carries the card's name, the
block's rows are the stories the reader picked, each row the four fields a row has today
(feed, title, source, date) under D6's public allowlist. CAS-009 adds the card's rendering and
its sharing; it does not add a layout.

## 2. Stack check and data contract, S1 and S2 (steps 3 and 4)

**Stack check (step 3).** No dependency is added, removed or changed: the typeface is the system
monospaced stack (`ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `Liberation Mono`,
`monospace`), zero bytes downloaded, `font-src 'self'` unchanged; the effects are CSS alone. The
browser-test runner the verification plan names is already present: `@playwright/test`, pinned
in the workspace catalogue, whose installed binary prints `Version 1.63.0`
(`corepack pnpm exec playwright --version`, 22 October 2026), on Node `v24.21.0` and pnpm
`11.10.0`; its configuration (`apps/dashboard/playwright.config.ts`) runs against the
production build with an isolated migrated schema and never in `pnpm test` or CI. The bill of
materials and the lockfile are expected unchanged at the end of the unit, and the
supply-chain check proves it.

**Data contract (step 4).** Not applicable: the unit changes presentation only. No migration, no
new table or column, no new query; the status block reads what the data-access layer already
returns to the principal, and a line the principal may not read is not shown. Stated here so
the step is not skipped silently.

## 3. The stylesheet and the shell, S3 (step 5)

`apps/dashboard/src/app/globals.css` is rewritten on the template, element by element as section
1.2 laid it out, with the nine tokens of `:root` as they were and nothing renamed. The typeface is
the system monospaced stack, named once as `--mono` and downloaded from nowhere, so `font-src
'self'` stands. Two effects are declared beside the tokens as transparencies rather than colours:
`--scanline`, black at 8%, which a fixed full-viewport pseudo-element on `body` lays on every
third pixel row with `pointer-events: none`, so it can take neither a click nor a focus; and
`--glow`, the emphasis token at 45% through `color-mix`, behind the brand, the section titles and
the prompt only, never behind body text. The prompt's cursor blinks by one keyframe animation.
Under `prefers-reduced-motion: reduce` the cursor holds still; under `prefers-contrast: more` the
overlay and the glow go; under forced colours the overlay goes as well. The contrast ratios were
re-measured with the overlay in place and are recorded in the stylesheet's header: a black
scanline darkens these dark surfaces, so every ratio of light text rises on a lined row, and the
floor of the set stays magenta on the raised surface at 4.50:1 on an unlined row.

The shell (`app/(protected)/layout.tsx`) is a two-column grid: a 220-pixel sidebar spanning both
rows, the header bar above the main column. The sidebar's links are plain anchors, full
navigations, so choosing a section renders the shell again with that section marked and the
status block fresh. The browser test found that under a client-side navigation (a `Link` inside
a page, or the sidebar as `Link`s, and a template no more than a layout) the shell is not rendered
again, so the mark stood still; marking it on the client would be the dashboard's first script
of its own, which the note rules out, so the mark follows the sidebar and full loads, and a
page's own link across sections keeps the previous mark until the next. The sidebar lists the sections in the existing order,
each gated by the capability it was gated by, each with a monospaced glyph rather than an icon,
the current section marked by `aria-current="page"`; the current path reaches the server
component through a request header the proxy sets (`x-cas-pathname`), so no client script is
needed to mark it. Beneath the list the status block states only what the dashboard can state:
the build (`RAILWAY_GIT_COMMIT_SHA`'s first seven characters when Railway sets it, read into the
configuration as `buildCommit`, otherwise "local"), the latest week run with its window, status
and origin badge, the "as of" instant of decision 1, and the principal. The header bar carries the
prompt, the product name and the same instant. The instant is the completion of the last
successful import (`latestCompletedImportBatch`, a new read in `@cas/database`), rendered by
`formatAsOf` in `America/Toronto` with the zone named and its UTC offset shown, so the line reads
`2026-10-23 02:52 America/Toronto (UTC-04:00)`; a dash when no import has completed. The status
is read by `shellStatus` in the data-access layer, which requires a signed-in principal and
nothing more, since every role may see those lines; it does not count against a reader's read
limit, because every page that renders the shell is itself limited. Under 900 pixels the sidebar
becomes a top strip with the sections wrapping and the status block in two columns, and the
blocks stack. The sign-in pages (decision 5) take the body's typeface and overlay and the
block's look, and carry no status block.

## 4. Tests, S4 (step 6)

Offline: `globals.test.ts` holds the stylesheet to its rules (every colour literal inside `:root`,
every token referenced declared there, the overlay fixed with `pointer-events: none`, the cursor's
animation `none` under reduced motion, the overlay and the glow gone under more contrast, no
`url(`, `@import` or `@font-face`, the system stack as the one typeface); `display.test.ts` holds
the formatter to the zone and the offset across a standard-time and a daylight-time instant;
`config.test.ts` holds the build commit to a 40-character hash and nothing else; the
authorization enumeration gains `shellStatus`. Against PostgreSQL, `dal.db.test.ts` proves the
status for every role: the build "local", the latest week once one exists, the data instant equal
to the seeded import's completion, nothing for an unauthenticated caller, and no stored text in
the view.

In the browser, through the existing Playwright runner against the production build:
`tests/browser/layout.spec.ts` walks the sign-in page and the shell at 1,280 and 390 pixels wide,
under both motion preferences and the contrast preference, through the focus order of the sidebar
and through two clicks with the overlay present (section 6 records the run). The runner's harness
needed two repairs to run at all, since it predated the passwordless sign-in and the `reader`
role: the launcher seeds `reader`, `editor` and `admin` accounts with synthetic addresses on the
reserved `.test` domain, and the memory store's email path, which dropped every message, now
appends each one to a local file the developer names (`DASHBOARD_LOCAL_EMAIL_FILE`, memory store
only, so local only; mode 600; `local-email.test.ts`), from which the specs read the one-time
code. A developer running the memory store locally can sign in the same way, which was not
possible before. The older specs were moved to the code sign-in and the reader role so they type-check; their
password-era assertions were a follow-up, closed on the pull request stacked on this one
(`tests/browser-harness`): the specs now sign in by code, share one session per address so the
login throttle's thirty requests per source are never reached across a run, assert the grid's
headings by level, and provision without the password-era second sign-in; every browser spec
passes (27 of 27). The same pull request closes code-scanning alert 9 and bounds two tests that
flaked under CI contention, recorded as CAS-006 follow-ups. Screenshots are written
under `test-results/browser/layout/` for the owner to look at and are not checked in: the
repository's hygiene scan refuses binary files, so the design note's "checked-in references" are
replaced by the assertions the spec makes on layout, computed style and behaviour.

## 5. The interface, S5 (step 7)

Every table a protected page renders is wrapped in a `SectionBlock` (`components/ui.tsx`): a
title bar with a glyph, the title the page's heading gave the table or, where the table had none,
the page's subject (Totals, Evidence runs, Incidents, Queue entries, Published outputs, and so
on), and the table beneath, scrolling inside the block on a narrow screen. The command centre's
five tables are five blocks; the evidence run's four, the drafts' two, the accounts page's two,
each other page's one. The week page's category and sort choices, which were a paragraph of
links, are `ChoiceLinks` in a `FilterBar` beneath the sift table's block, beside the row count
and the search form the page had; the links set the same query parameters the page already
reads, so sorting and filtering stay server-side with no script. The sign-in pages are as
decided. Nothing under `server/` changed for the interface, the capability table is untouched,
and no route moved.

## 6. Security baseline, S6 (step 8)

No inline style and no inline script were added (none exists: `grep style=` over the pages is
empty); the content security policy is unchanged and the headers test holds it; no font is
fetched and the stylesheet names no `url(`; the overlay never intercepts input (`pointer-events:
none`, asserted offline and in the browser). The pathname header the proxy sets is the request's
own path, carried to the server component and never rendered. The build commit shown is public
on the repository. The local email file exists only with the memory store, which the
configuration refuses outside `local`; its path is the developer's choice and `test-results/` is
ignored by Git. No dependency was added, removed or changed; the supply-chain check proves the
bill of materials unchanged.

## 7. Verification, S8 (step 9)

On the branch, 23 October 2026, from the runner: `corepack pnpm verify` exit 0 (1,164 offline
tests, 32 tool tests: the dashboard 129, the stylesheet, the formatter, the configuration, the
local email file and the authorization enumeration among them; format, lint, typecheck, the
repository checks and the production build); `corepack pnpm test:db` exit 0 (334: database 114,
worker 119, dashboard 52 with the shell status among them, mcp-server 49). In the browser,
`corepack pnpm exec playwright test tests/browser/layout.spec.ts` against the production build
with an isolated migrated schema: four tests, all passed in 7.2 seconds (the sign-in page; the
shell at 1,280 pixels with the sidebar, the status block, the header bar, the blocks, the focus
order and a click through the overlay; the shell at 390 pixels with the strip, the stacked blocks
and a table scrolling inside its block; reduced motion and more contrast); six screenshots under
`test-results/browser/layout/`, looked at and matching the note. The first browser run found the
current-section mark standing still after a client-side navigation, which section 3 records with
its resolution. The clean clone, the CI run and the pull request are on the tracker's evidence
record.

## 8. Correction after the combined audit of `main` at `8105678` (31 October 2026)

The combined audit's F3 (Low) is against this unit; F1 and F2 are against CAS-009
(`docs/CAS-009-REPORT.md`, section 8). The local email file was created mode 600, but appending
to a file that already existed kept its wider mode, so a `0644` file stayed readable by other
local users. The provider now opens the file without following a symbolic link and without
blocking on a pipe, refuses anything but a regular file, and narrows it to mode 600 through the
same handle before each line is written. `local-email.test.ts`: an existing `0644` file is
narrowed and keeps what it held; a symbolic link and a directory are refused and nothing is
written through the link. Both fail on `main`'s code. The provider still runs only with the
memory store, which the configuration refuses outside `local`.
