# CAS-010 report: the dashboard's terminal grid

**Unit:** CAS-010 (`docs/POST-EVENT-PLAN.md`, section 5). **Tracker:** `docs/tcu/CAS-010.md`.
**Issue:** [#30](https://github.com/doryoysterpie/cs-ethonline-26/issues/30). **Decision:** D47.
**State:** S0 only. The owner admitted this unit on 22 October 2026 for its design note, with
one condition: no implementation pull request opens until the review queue of pull requests
24 to 28 is back under a day. The note is written now so that CAS-009's story cards have a grid
to land in.

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
  not written unless the shortcut exists; the shortcut needs script, and the decision is the
  owner's (section 1.4).
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
The sign-in pages sit outside the shell; whether they take the treatment is the owner's call
(section 1.4).

### 1.4 Decisions this note raises, for the owner before S1

1. **The clock.** A static server instant labelled "as of" (recommended: no script), or a
   ticking clock through a small nonce-bearing inline script.
2. **The search shortcut.** Omit the "/" shortcut and its label (recommended), or add it through
   the same small script.
3. **The status block.** The build hash, the latest week and the principal (recommended), or
   more; uptime, load and log level are refused as unmeasured.
4. **The typeface.** The system monospaced stack (recommended: zero bytes, the policy
   unchanged), or one self-hosted font file.
5. **The sign-in pages.** The same treatment (recommended, so the first screen matches), or
   untouched.

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
