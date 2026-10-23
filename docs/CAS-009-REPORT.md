# CAS-009 report: shareable story cards

**Unit:** CAS-009 (`docs/POST-EVENT-PLAN.md`, section 5). **Tracker:** `docs/tcu/CAS-009.md`.
**Issue:** [#11](https://github.com/doryoysterpie/cs-ethonline-26/issues/11). **Decisions:** D6
(the public allowlist), D42 (the published mark), and the ones this note raises.
**State:** S0 only. The unit was admitted with the sprint on 21 October 2026 and starts once
CAS-007 is complete, which it is since 23 October 2026. The owner designs the creatives; this
unit builds the functionality only. Nothing below is built until the owner resolves section
1.5.

## 1. Design note, S0, written before code (step 1)

### 1.1 What the unit does, in one paragraph

A reader who is signed in opens a published round-up or article, ticks the stories that caught
their interest, and receives a card: a page of its own at an address that works without
signing in, so it can be posted anywhere, listing those stories as the owner published them,
with the week, the category and a link back to the published page. The card is a record the
dashboard keeps (who made it, from which published revision, which entries), rendered on
request from that record and the published text, in the terminal grid, as a section block
(CAS-010, design note 1.7). The reader shares the address or the card's downloadable image.
Nothing on a card is anything a reader could not already read, and nothing a reader could not
read is on the dashboard's public face.

### 1.2 What a reader can pick, and what a card can carry, under D6 and D42

A reader sees two kinds of thing on this dashboard. The four sanitized views carry incident
identifiers, kinds, counts, dates and state badges, and never a headline, a link, a note or any
corpus text (`docs/SECURITY.md`, section 21); a card made from them would be a list of
identifiers, which is not a story to anyone. The published outputs (D42) carry text the owner
chose to make public: a round-up's entries, each with a headline the model reformulated from
the selection's titles under the prompt contract and the owner may have edited, a summary, and
the publishers' names of its sources; an article's headline and standfirst, written under D41
and D4's naming bar. A card therefore draws on the published outputs and on nothing else: the
published mark is the owner's line between what is public and what is not, and the card does
not move it.

D6 fixes the public allowlist to public incident metadata, no notes, no corpus text, and
requires a strict allowlist contract in `@cas/contracts` for anything serialized to the public.
The card's contract is such an allowlist: the week's window, the category, the output kind and
its published revision, and per picked entry the published headline and the publisher names
of its sources. The entry's summary, the sources' URLs, the citations' row identifiers, the
selection notes and every stored source title are outside the allowlist and never serialized
(decisions 1 and 3 ask the owner to confirm or narrow this).

### 1.3 The mechanism

- **Picking.** The published page (`/published/[weekRunId]?category&output`) gains a form
  listing the output's entries (the round-up's rundown; the article as one entry) with a
  checkbox each and a "Make a card" button, for a principal who holds `view:published`. The
  action validates the picks against the published revision (an index outside it is refused),
  records the card and redirects to it. No new capability (decision 7).
- **The record.** Migration 0021 adds `story_cards`: a random 128-bit identifier in its URL
  form, the account that made it, the week run, the category, the output and the published
  revision at creation, the picked entry indices, and the instant; append-only, never updated,
  never deleted. A card belongs to its revision: if the owner unpublishes the output, or marks
  a later revision, the card answers 404 from the next request (D42's rule that unmarking takes
  effect at once; decision 6).
- **The card page.** `/cards/[id]` is the dashboard's first page served without a session
  (decision 5): the proxy's public paths gain it; the data-access read takes no principal,
  reads the card and the current publication, and refuses when the publication no longer
  matches. It renders in the grid as a section block whose title bar carries the week and the
  category and whose rows are the picked entries, headline and publishers each, with the
  product name and the address of the published page beneath; the owner's creative replaces
  the block's look later, in the stylesheet, without touching the data. Requests are limited
  per network source (the signup limiter's shape, a new `cardViews` limiter), the response is
  cacheable for an hour since it carries nothing personal, and `robots.txt` keeps its
  disallow list, which covers cards as it covers everything else.
- **The image.** The same card as an SVG document, text only, system fonts, generated in
  process and served as `image/svg+xml` with the download disposition from `/cards/[id].svg`,
  so a reader has a file to attach where a link preview is not enough. No rasterizer and no
  dependency; a PNG, which some platforms' link previews require, would need one and is
  decision 2's alternative.
- **What is measured.** The making of a card is an audit event with the card's identifier and
  the count of entries, never the entries; a view is counted on the card's row in a counter
  column, one integer, never who viewed it or from where (decision 4). The published pages
  and the command centre do not change for this.

### 1.4 What does not change

The capability table, the published mark and its pages, the limits on readers' reads, the
round-up and article contracts, the fetch policy, the content security policy (the SVG is
served as a document with the same headers, no inline script, no external reference), the
dependency set.

### 1.5 Decisions this note raises

The plan's four, and three the design adds. Each is asked once with options and the
recommendation first.

1. **Which fields are public on a card** (the plan's decision 1, under D6). (a) The published
   headline and the publishers' names per entry, the week, the category, the output and its
   revision, and nothing else; the summary, the URLs, the citations and every stored title
   excluded. (b) As (a) plus the entry's published summary. (c) As (a) plus the sources' URLs.
   Recommendation: (a). A card is a pointer back to the published page, not a copy of it.
2. **How the card is rendered** (decision 2), given that the owner designs the creative. (a) A
   page in the grid at a public address, plus a text-only SVG download, no dependency; the
   owner's creative lands in the stylesheet and the SVG template. (b) As (a) plus a
   server-rendered PNG for platforms whose link previews need one, which adds a rasterizer
   dependency with a native binary (`@resvg/resvg-js` or `sharp`) under its own stack check.
   (c) The page only, no image. Recommendation: (a) for this unit, with (b) as a later unit if
   link previews prove to matter.
3. **Whether third-party headlines may appear** (decision 3). (a) Only the published outputs'
   own text appears: a round-up entry's headline as published (the model's reformulation, the
   owner's edits) and an article's headline; the stored source titles never. (b) The stored
   source titles too, attributed to their publishers. (c) No headlines at all: publishers,
   counts and the category only. Recommendation: (a); it keeps the card inside D6 and inside
   what readers already see.
4. **What is measured** (decision 4). (a) An audit event per card made, with the identifier and
   the entry count, and a per-card view counter, one integer, no viewer identity and no
   address. (b) The audit event only. (c) Nothing. Recommendation: (a); the count is the
   question the owner will ask, and it stores nothing about anyone.
5. **A public page without a session.** The card is the dashboard's first page served to
   anyone. (a) Yes: a random 128-bit identifier in the address, a per-source limit, a
   cacheable response, no index of cards anywhere. (b) No: cards are viewable only by signed-in
   readers, which makes them shareable among readers only. Recommendation: (a); "shareable" is
   the unit's objective.
6. **A card's lifetime.** (a) A card follows its publication: unpublish the output or mark a
   later revision and the card answers 404 from the next request. (b) A card is a snapshot
   that outlives its publication. Recommendation: (a); D42 says unmarking takes effect at once,
   and a card that outlived it would be a second public face.
7. **Who may make a card.** (a) Every principal holding `view:published`, readers included, no
   new capability; a per-account limit on making (twenty per fifteen minutes). (b) A new
   capability, assigned by role. Recommendation: (a).

### 1.6 Files touched, and not touched

Touched: migration 0021 and `packages/database/src/cards.ts`; `apps/dashboard/src/server/dal/cards.ts`
(make, read, count); the published page's pick form and action; `app/cards/[id]/page.tsx`
and `app/cards/[id].svg/route.ts`; the proxy's public paths; the limits; two audit kinds;
`docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, the README, this report,
the tracker. Not touched: anything under `packages/roundup`, `packages/article`,
`packages/source-reader`; the capability table; the headers; the dependency set.

### 1.7 Verification plan

Against PostgreSQL: a card made from a published round-up by a reader and by an editor;
picks outside the revision refused; a card of an unpublished or superseded output answering
not found; the counter; the audit event without entries. Offline: the allowlist contract (a
card serializes exactly the allowed fields and nothing else, proven on a hostile entry); the
SVG escaping every text; the public path in the proxy. In the browser: a reader makes a card
and a fresh, signed-out context opens it and downloads the SVG. Then the verify loop, a clean
clone and CI.
