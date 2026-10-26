# CAS-009 report: shareable story cards

**Unit:** CAS-009 (`docs/POST-EVENT-PLAN.md`, section 5). **Tracker:** `docs/tcu/CAS-009.md`.
**Issue:** [#11](https://github.com/doryoysterpie/cs-ethonline-26/issues/11). **Decisions:** D6
(the public allowlist), D42 (the published mark), D48 (the seven of section 1.5).
**State:** in build. The unit was admitted with the sprint on 21 October 2026 and starts once
CAS-007 is complete, which it is since 23 October 2026. The owner designs the creatives; this
unit builds the functionality only. The owner resolved section 1.5 on 23 October 2026 (D48);
section 1.6 records what the answers changed in the mechanism.

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

### 1.6 The decisions, resolved, and what they changed

Resolved by the owner on 23 October 2026 and recorded as D48: 1 (a); 2 (b), under the stack check;
3 (a); 4 (a), the counter counting origin hits; 5 (a), with `X-Robots-Tag: noindex` and no
sitemap; 6 (a) for unpublication, amended for supersession; 7 (a), amended with idempotency.
What the answers change in section 1.3:

- **One story per card.** Decisions 6 and 7 bind a card to an output and one entry and make
  creation idempotent per that pair, so a card is one story's card, shared by every reader who
  makes it: one public address per story. A reader who wants several stories shares several
  cards. The record keeps who made it first.
- **Bound to the entry, re-rendered from the current revision.** The card stores the week, the
  category, the output and the entry's index, never a revision. Every request reads the current
  published revision: unpublished, 404; a deterministic revision (revision 0, whose headlines are
  the sources' own titles), 404, by decision 3; the entry absent, 404. An entry's index is stable
  across every revision of an output: one generation writes revisions 0 and 1 and refuses a
  second, and every edited revision copies the slots of the one before it and changes only the
  markdown (`saveRoundupRevision`, `saveArticleRevision`).
- **The headline from the published text.** Because an edit changes the markdown and not the
  slots, the headline is read from the published markdown, parsed by the parser the dashboard
  already uses (`mdast-util-from-markdown`), never from the slots: a round-up entry is the bold
  line that opens a block whose sources lines carry exactly the entry's URLs, an article is its
  first-level heading. An entry the owner removed or restructured past recognition is absent
  and answers 404, so a correction is never contradicted by a card. The publishers' names come
  from those URLs, each its host name, the attribution the published text itself carries.
- **The image.** The PNG is rasterized from the card's own SVG with the published revision it
  shows: at creation, and again only when a correction changes the current revision, then served
  from the cache. "Once at creation" and "re-renders from the current revision" meet there:
  one rasterization per card and revision.
- **Counting.** The page counts each origin view; the images do not count; a cached response is
  not counted.

### 1.7 Files touched, and not touched

Touched: migration 0021 and `packages/database/src/cards.ts`; `apps/dashboard/src/server/dal/cards.ts`
(make, read, count); the published page's pick form and action; `app/cards/[id]/page.tsx`
and `app/cards/[id].svg/route.ts`; the proxy's public paths; the limits; two audit kinds;
`docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, the README, this report,
the tracker. Not touched: anything under `packages/roundup`, `packages/article`,
`packages/source-reader`; the capability table; the headers; the dependency set.

### 1.8 Verification plan

Against PostgreSQL: a card made from a published round-up by a reader and by an editor;
picks outside the revision refused; a card of an unpublished or superseded output answering
not found; the counter; the audit event without entries. Offline: the allowlist contract (a
card serializes exactly the allowed fields and nothing else, proven on a hostile entry); the
SVG escaping every text; the public path in the proxy. In the browser: a reader makes a card
and a fresh, signed-out context opens it and downloads the SVG. Then the verify loop, a clean
clone and CI.

### 1.9 A question the build raised: the robots file, resolved

CAS-007's `robots.txt` (`robots-policy@1`) disallowed every path for every agent, the AI crawlers
by name and everyone else under `User-agent: *`. The social preview bots that read a card's
`og:image` honour that file, so under it a shared card was a bare link on the platforms decision
2 names. Changing it changes CAS-007's merged policy, so it was put to the owner, who resolved it
on 23 October 2026 (D48, 8): (a). The file (`robots-policy@2`) adds `Allow: /cards/` under
`User-agent: *` ahead of `Disallow: /`; the named AI crawlers' groups are unchanged, so they stay
out of cards as out of everything. The owner's grounds go beyond previews: under the old file a
search engine could not fetch a card and so never saw its `noindex`, while a card linked from
elsewhere could still be indexed as a bare address; allowing the path is what makes `noindex`
effective. The `Allow` line comes first for parsers that take the first match; under RFC 9309
the longest match gives the same answer. The condition, that the preview images resolve under
`/cards/` as absolute addresses, holds: `og:image` and `twitter:image` are both
`<DASHBOARD_PUBLIC_URL>/cards/<id>/image.png`, asserted in the browser.

**A known limit, recorded (D48, 9).** "Not found at once" holds at the origin. The images are
cacheable for five minutes, so a downstream cache may serve an unpublished card's image for up
to five minutes, and platforms cache link previews for their own periods, outside the product's
control. The card page itself is sent `no-store` and is never cached by the dashboard's headers.

## 2. Stack check and data contract, S1 and S2 (steps 3 and 4)

**Stack check (step 3).** Decision 2 chose a PNG for link previews under this check; it passes,
with two dependencies, both in the workspace catalogue and the lockfile, both under the
release-age gate and the bill of materials (345 components, `CHECK OK`, `pnpm audit` clean).

- `@resvg/resvg-wasm` 2.6.2 (MPL-2.0; published 26 March 2024; no dependencies, no install
  script; 2.5 MB unpacked). The resvg renderer compiled to WebAssembly: it rasterizes the card's
  own SVG to PNG in the server process, about 50 milliseconds for a card, and has no input or
  output of its own, so nothing an SVG names can be fetched. Rejected: `@resvg/resvg-js` 2.6.2,
  the same renderer as a native addon, which brings twelve platform packages and a native binary
  into the server; `sharp`, larger and native, reading SVG through librsvg; a headless browser in
  production.
- `@expo-google-fonts/jetbrains-mono` 0.4.1 (MIT AND OFL-1.1; published 12 September 2025; no
  dependencies, no install script; 3.4 MB, of which two TrueType files are read, regular and
  bold). The rasterizer needs TrueType bytes; the production image has no fonts, and the
  repository's hygiene scan refuses a committed binary. Rejected: `@fontsource/jetbrains-mono`,
  which ships only WOFF, which resvg cannot read; fonts installed with `apt` in the Docker image,
  outside the lockfile and the bill of materials; `dejavu-fonts-ttf`, whose licence field is not
  an SPDX expression.

The rasterizer was probed before adoption: a 1,200 by 630 card with an external image reference
rendered in 54 milliseconds from the font buffer alone, and the reference was not fetched.
`@resvg/resvg-wasm` joins `serverExternalPackages` so Next loads it from its own directory.

**Data contract (step 4).** Migration 0021 (`0021_story_cards.sql`, SHA-256
`6866f5f7bcd678b4dda8e8aed4a7ee33cdaa0fc602fbd51bc5c02186cc6a27d0`): `story_cards`, one row per
story (unique on week run, category, output and entry index; an article's entry is 0), a 22-
character URL-safe identifier from 128 random bits, the maker and the instant, and a view count
that only rises; `story_card_images`, one PNG per card and revision, at most 1 MiB, with its
digest, append-only; the audit kind `card_created`. Guards refuse every other update and every
delete. Migration 0022 (`0022_publication_sequence.sql`, SHA-256 `40079de7f3b5a31159bb9a9609943c9a03cdc45b34a99c8fd6edf7a433d67f70`), added after the owner's review
of the open image-cache failure (section 7): `output_publications` gains `seq`, a number
PostgreSQL assigns at insert from one sequence, unique, never supplied by the application, and
the current publication is the record with the greatest `seq` rather than the greatest
`created_at`, an instant the application writes from its own clock. The public field set is a contract in `@cas/contracts` (`story-card@1`,
`toPublicStoryCard`): it copies exactly the eight allowlisted fields, each shape-checked, and drops
anything else on its input.

## 3. The card, S3 (step 5)

`packages/database/src/cards.ts` records a card or returns the one a concurrent request recorded
first (`ON CONFLICT` on the story), counts a view, and caches an image. In the dashboard,
`server/cards/story.ts` reads a story from the published markdown as section 1.6 describes,
`server/cards/svg.ts` lays the card out as an SVG of text only, every string XML-escaped, and
`server/cards/raster.ts` rasterizes it, the WebAssembly module initialised once per process and
held on `globalThis` because Next compiles route handlers and server actions as separate module
graphs. `server/dal/cards.ts` makes a card (the capability check, the input, the story resolved
from the current publication, the existing card returned before the limit is consulted, the
insert, the audit event, the image cached), serves the public card (the per-source limit, the
record, the story resolved again, the contract, one view counted) and serves its images.

## 4. Tests, S4 (step 6)

Offline: the contract (exactly the allowlisted fields from a hostile input; each wrong shape
refused); the story extraction, on markdown from the real round-up renderer (escapes resolved,
URL order ignored, a URL inside a summary not a sources line, a partial or larger set not the
entry, a corrected headline followed, a removed or restructured entry absent, an article's
headline and only its Sources section's URLs, publishers once each by host, display text one
bounded line); the SVG (every string escaped, nothing outside the document, the wrapping); the
rasterizer (a 1,200 by 630 PNG, twice in one process); the authorization enumeration (no session
refused; every role past the gate; a malformed address refused before any read). Against
PostgreSQL, the database package (one card per story, a second request returning the first, four
concurrent requests one card, views upward only, nothing rewritten or deleted, the shapes, the
image cache) and the data-access layer: a reader makes a card and every other role receives the
same address; the public read is exactly the allowlist with the published headline and the hosts,
counting each view; the published page lists the shareable stories; one audit event without text;
a correction published shows at the same address while an unpublished one does not; an entry the
owner removed, a deterministic revision and an unpublished output answer not found, and a
republished correction serves again; the PNG rasterized at creation, served from the cache, and
rasterized once more for a correction; the SVG escaping the owner's text; the per-source limit on
pages and images; one new card per account in the window, an existing card returned without
spending it; one trip event for each limit. In the browser, against the production build, the
launcher publishes a round-up and makes a card through the data-access layer, and
`tests/browser/cards.spec.ts` opens it with no session (section 7).

## 5. The interface, S5 (step 7)

The published page gains a "Share a story" block listing the stories of the published revision,
each with a "Make a card" button, which posts the story and redirects to the card. The card page,
`/cards/[id]`, is the dashboard's first page served without a session: the proxy admits `/cards/`
without a cookie and adds `X-Robots-Tag: noindex, nofollow`; the page carries `robots` noindex,
the Open Graph title, description and image (the PNG's absolute address under
`DASHBOARD_PUBLIC_URL`, omitted when it is unset) and the large-image Twitter card; it shows the
headline, the publishers, the week and the category, the image, a link back to the published
page (which needs a sign-in) and to the sign-up page, and the two downloads. The page and its
metadata share one read through React's request cache, so a view is counted once. The images are
served by two route handlers, `/cards/[id]/image.png` and `/cards/[id]/image.svg` (the SVG as an
attachment), cacheable for five minutes, so a cached fetch is not counted (decision 4); the page
is never cached. A refusal is a fixed answer: 404 for an unknown address or a story no longer
shown, 429 with `Retry-After` on an image past the per-source limit, the page a fixed notice.

## 6. Security baseline, S6 (step 8)

What crosses to the public is the contract's eight fields; the headline and the publishers come
from the published text, the one thing the owner chose to make public, and a deterministic
revision, whose headlines are the sources' own titles, never renders. A card follows unpublishing
and correction at once, because nothing about the published text is stored with it. Input is
validated at the boundary (the address's shape before any read; the story's identifiers, output
and entry index before any read). Limits are enforced where input is read: per network source
on the card and its images (300 in fifteen minutes), per account on new cards (20). Audit events
carry the card's identifier and its output, never text. The SVG is the dashboard's own document,
text only, escaped; the rasterizer has no network; the PNG is bounded at 1 MiB. No secret is
involved. The content security policy is unchanged and applies to the card page and its images.
The robots file is unchanged (section 1.9).

## 7. Verification, S8 (step 9)

On the branch, 23 October 2026, from the runner: `corepack pnpm verify` exit 0 (1,174 offline
tests, 32 tool tests: the contracts 18, the database 32 offline, the dashboard 137, with the
contract, the story extraction, the SVG, the rasterizer and the authorization case among them;
format, lint, typecheck, the repository checks and the production build); `corepack pnpm test:db`
exit 0 (339: database 116, worker 119, dashboard 55 with the three card cases among them,
mcp-server 49); `playwright test` 30 of 30 against the production build, the three card specs
among them (a signed-out browser opens the card with `X-Robots-Tag: noindex, nofollow`, the
`robots` metadata, the Open Graph title and image and the large-image Twitter card, the image
loaded at 1,200 pixels wide, no summary and no source address in the page, and exactly one view
counted for one page load; the PNG and the SVG served without a session, the PNG cacheable for
five minutes; unknown and malformed addresses 404; a reader sees the published round-up's three
stories with a card button each). A card rendered through the compiled modules was looked at and
matches section 1.3.

**The open image-cache failure.** One run of the full database suite failed once on the
image-cache case: after a correction was published, the cache held only the first revision's
image. It passed alone four times and in three further full runs. The owner set the merge
condition on 23 October 2026: the current revision and the cache key must come from one read in
one transaction, and the render must use that same read, or a stale read could store and serve a
corrected-away headline. Before the change the key and the rendered text already came from one
in-memory read, so a revision's key could never hold another revision's text; but that read was
several statements outside one transaction, and the current publication was chosen by the
greatest `created_at`, which the application stamps from its own clock. Two changes make the
condition literal:

- **One snapshot.** The card's record, the current publication, the revision's text and the
  cached image are read in one repeatable-read transaction (`publicCard`, and `makeCard`'s
  resolution). An image is stored only from that read's text under that read's revision
  (`storeImage`), and a cached image is served only for the revision the same read found
  current. Test: a sentinel image stored under revision 2 before revision 2 is published is
  served exactly while revision 2 is current, and revision 1's image before and after.
- **A monotonic order.** Migration 0022: the current publication is the record with the greatest
  database-assigned `seq`. Test: three records with one timestamp, and one stamped earlier than
  all of them but written last, each decide in turn as they are written. This rules out the
  owner's hypothesis, a timestamp tie, and also a clock that steps back or two instances whose
  clocks disagree.

The failure itself was not reproduced, so its cause is not established; the timestamp order is
the likeliest and is now removed. It stays recorded as open until **ten consecutive full runs of
`corepack pnpm test:db`**, a number named here before the first of them, pass at the head offered
for review; the result is recorded below and on the tracker.

The clean clone, the CI run and the pull request are on the tracker's evidence record.
