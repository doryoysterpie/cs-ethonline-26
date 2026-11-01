# CAS-012 report: every character list on the rule

**Status:** Built on `cas-012/lists`, pull request 61. The review of `db10902` returned CHANGES
REQUIRED, four P2 findings and one P3, corrected on the same branch (section 9); re-review
pending; **not accepted**. Tracker: `docs/tcu/CAS-012.md`. Decisions: D49, D50. Issue: #58.
Section 1 is the S0 design note, written before any code on `cas-012/design-note` and merged in
pull request 59; sections 2 to 8 record the build and section 9 the corrections.

## 1. Design note (S0)

### 1.1 Where the unit comes from

CAS-011 put the hygiene check, the round-up export and the story card on one predicate, the
prohibited-text rule (`packages/contracts/src/prohibited-text.ts`, `prohibited-text@2`): every
code point the running Node reports as Default_Ignorable_Code_Point but U+FE0E and U+FE0F, with
the controls other than tab, line feed and carriage return, the line and paragraph separators,
the interlinear annotation characters and the noncharacters. D49 names nine other lists that keep
sets of their own, none covering U+180E or the rest of the property. The owner opened this unit
on 1 November 2026 to put them on the rule, each keeping its own action, with no new list in the
meantime.

### 1.2 The nine lists

| List                                         | What it guards                                                                               | Its set today                                                                                                 | Action                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `apps/dashboard/src/server/display.ts`       | stored text shown in the dashboard (`safeText`)                                              | C0, C1, U+2028, U+2029, U+202A to U+202E, U+2066 to U+2069                                                    | escape, visibly                |
| `apps/dashboard/src/server/dal/mutate.ts`    | a draft, round-up or article body the owner saves                                            | the same, tab, line feed and carriage return excepted                                                         | refuse the save                |
| `packages/mcp-server/src/safety/text.ts`     | every string the MCP server returns                                                          | C0, C1, the separators, U+061C, U+200E, U+200F, the embeddings and isolates, U+200B, U+2060 to U+2064, U+FEFF | escape, visibly                |
| `apps/worker/src/hygiene/scan.ts`            | the worker's source files                                                                    | C0 but tab and line feed, C1, the separators                                                                  | scan, report file and line     |
| `apps/worker/src/editorial/display.ts`       | the worker's output; a review note or a claim (`assertReviewNote`)                           | C0, C1, the separators                                                                                        | escape; refuse a note or claim |
| `apps/dashboard/src/server/input.ts`         | every bounded text input (`boundedText`, `optionalText`): notes, rationales, the week search | C0, C1, the separators                                                                                        | refuse the request             |
| `apps/dashboard/src/server/auth/password.ts` | a password (`validatePassword`)                                                              | C0, C1, the separators                                                                                        | refuse the password            |
| `packages/graph-evidence/src/display.ts`     | that package's output                                                                        | C0, C1, the separators                                                                                        | escape, visibly                |
| `packages/sheets-intake/src/display.ts`      | that package's output                                                                        | C0, C1, the separators                                                                                        | escape, visibly                |

Below these, the database's own constraints refuse the C0 and C1 controls and the separators in
stored fields: the import's basename and review label (migration 0002), review notes (0007), the
evidence rationale (0008), the claim statement (0009) and the Sheets tab title (0012). PostgreSQL's regular
expressions have no Unicode property, so those constraints cannot follow the rule, and no applied
migration changes. After this unit the application refuses more than the database does, which is
the order it already relies on: the constraint is the floor, not the policy.

### 1.3 What changes and what does not

- Each list takes its set from `prohibitedTextRule` or `hasProhibitedText`, and keeps its own
  action. A consumer that needs tab, line feed or carriage return treated as a control today
  (the display escapes, which show a line break as `\n`) keeps that behaviour on top of the rule.
- The five escape tables share one form today: named labels for `\n`, `\r`, `\t` and `\x1b`,
  `\xHH` below U+0100 and `\u` with four or more hex digits above. Beyond U+FFFF that form is
  ambiguous: U+E0001 prints as `\ue0001`, which reads as U+E000 followed by "1". The rule's set
  reaches U+E0FFF, so the generic form must be unambiguous (question 3).
- The MCP server's skill file (`packages/mcp-server/SKILL.md`) lists its set by code point, and
  its documentation test holds the file to the emitted set. The listing becomes a statement of
  the rule.
- Not changed: stored text (threat model RR13), the three consumers of CAS-011, the rule itself,
  the database constraints, and every route, role and capability.

### 1.4 The decisions this note raises

**Question 1: the save path.** When the owner saves a draft, round-up or article body that
carries a character the rule names, what happens? Today a bidirectional control is refused and a
soft hyphen or a zero-width space is stored. The export strips them from slot text already, and
editor input is not a tracked file.

- (a) Refuse every character the rule names, as a bidirectional control is refused today. A
  soft hyphen pasted from an article stops the save until the owner finds it.
- (b) Strip every one on save and report how many were removed, by rule, in the page's notice.
  The stored body is what the owner sees; a bidirectional control is removed rather than
  refused.
- (c) Keep refusing the controls and the bidirectional controls, as today, and strip and report
  the other default-ignorable characters. The refusal the browser tests prove stays as it is,
  and pasted soft hyphens and zero-width spaces never stop a save. **Recommended.**

**Question 2: the other refusals.** The bounded inputs (notes, rationales, the week search) and
the worker's review note and claim refuse the controls and separators today. Should they refuse
everything the rule names?

- (a) Yes: one line of text the owner writes carries nothing invisible, and refusal tells the
  owner where. **Recommended** for the bounded inputs and the worker's note and claim.
- (b) Strip on the same terms as question 1's answer.

The password is apart. A password is never displayed, so an invisible character in one hides
nothing from a reader or a reviewer; refusing it only turns away a password someone chose. The
note recommends leaving `validatePassword` on the controls and separators and recording it as
the one list the rule does not govern, with that reason. The owner's condition was every list on
the rule, so this is the owner's call.

**Question 3: the generic escape form.** For a character with no named label:

- (a) `\u{XXXX}` for every code point at or above U+0080, as the owner's answer named; the
  outputs that print `\u202e` today print `\u{202e}`. **Recommended.**
- (b) Keep `\uXXXX` within the Basic Multilingual Plane and brace only above it.

**The answers, 1 November 2026** (D50). Question 1: (c), with the refused set defined by property
(`\p{Cc}` less tab, line feed and carriage return, plus `\p{Bidi_Control}`), each removed
character listed in the notice by code point, name and position, the strip made before the
revision is computed, and a one-time read-only scan of stored texts reported here. Question 2:
the bounded inputs and the worker's note and claim refuse the whole rule, naming the character
and position, the worker logging in the source scanner's form; the password refuses the whole
rule too, at set and change only, after its NFKC normalisation, against the note's
recommendation, on the owner's grounds (reproducibility, RFC 8265). Question 3: (a), one form,
`\u{XXXX}` in uppercase with at least four digits, the name appended only where the character is the subject of the line, and a
distinct style for an escape in the dashboard grid.

### 1.5 Two points the answers raised against recorded text, settled on 1 November 2026

**Point 1: U+200D in an emoji sequence.** The answer to question 1 counts "U+200D between two
Extended_Pictographic code points" among D49's carve-outs. D49 dropped that refinement on the
owner's own condition: the table had stripped U+200D since CAS-004 and no broken sequence was
reported. CAS-011 strips it everywhere, and its review passed that behaviour.

- (a) D49 stands: U+200D is stripped with a notice like any other default-ignorable character,
  and a joined emoji decomposes. One behaviour, as the answer asks. **Recommended.**
- (b) Add the carve-out now: CAS-011's rule, its four consumers and their tests change to keep
  U+200D between two Extended_Pictographic code points, in pull request 57 or in this unit.

**Point 2: tab, line feed and carriage return in the displays.** The answer to question 3 says
U+0009, U+000A and U+000D are never escaped. All five displays escape them today as `\n`, `\r`
and `\t` (the dashboard's, the MCP server's, the worker's, and those of `@cas/graph-evidence` and
`@cas/sheets-intake`), so that a value cannot forge a line in a page, a terminal, a log or the
MCP server's output (the Sprint 6 hostile-text rule).

- (a) The rule's characters take the one form; the three line characters keep their escapes
  where a display is one line, written in the same form (`\u{000A}`), so the displays still
  cannot be made to forge a line. **Recommended.**
- (b) Never escape them: a one-line display then shows a line break as a real break, or the
  display collapses it to a space.

**The answers.** Point 1: (a), D49 stands; the answer to question 1 misstated its carve-outs,
which are U+FE0E and U+FE0F. A stripped U+200D is listed in the save notice like any other, and
a joined sequence, if ever wanted, enters as an amendment to D49 with the rule, its consumers and
their tests changed together. Point 2: (a); one-line displays escape the three characters as
`\u{0009}`, `\u{000A}` and `\u{000D}`, multi-line displays keep them, an escape inside a
displayed value is bare, and the escape is applied once, at the rendering boundary, never before
a format that escapes on its own. D50 records both.

## 2. Stack check and data contract (S1, S2)

Built on `cas-012/lists` from `main` at `bdf608c`, after CAS-011 (pull request 57) and this note
(pull request 59) merged. No dependency is added or changed: the rule, the escape form and the
names are first-party code in `@cas/contracts`, which every one of the nine lists' packages
already depends on or, for the dashboard, already imports.

The contract is `text-escape@1` (`packages/contracts/src/text-escape.ts`), beside
`prohibited-text@2`:

- `escapeCodePoint(codePoint)`: `\u{XXXX}`, uppercase, at least four digits.
- `codePointName(codePoint)` and `describeCodePoint(codePoint)`: the escape followed by the
  Unicode name, or a control's alias, from a table generated from the Unicode character database
  (`unicode-names.ts`, section 9.3) that names every assigned code point the rule names but three
  that have neither. The names are labels: which characters are escaped is the rule's.
- `codePointLength(value)`: a value's length in code points, the measure of every bound beside
  the rule, as PostgreSQL's `length()` counts (section 9.2).
- `escapeOneLine(value)`: every code point the rule names, and tab, line feed and carriage
  return, written as a bare escape; `escapeMultiLine(value)`: the rule's code points only.
- `locateProhibitedText(value)`: each code point the rule names with its rule, line and column,
  counted in code points, for a notice or a refusal.

`prohibited-text@2` gains `replaceProhibitedText(value, replace, { oneLine })`, and its one-line
class is built from the same set as the rule's own, less the two selectors only, so the two
cannot drift. The database constraints stay as section 1.2 says. Migration 0024 adds the record
of what each save removed, as numbers (section 9.1); it changes no stored text.

## 3. Implementation (S3, S5)

Each list keeps its action and takes its set from the rule.

- **The five displays** (the dashboard's `safeText` and `safeParts`, the MCP server's
  `toSingleLine` and `quoteEvidence`, the worker's `toSingleLine` and `safeDisplay`, and the
  `safeDisplay` of `@cas/graph-evidence` and `@cas/sheets-intake`) escape through
  `escapeOneLine`: every character the rule names, and tab, line feed and carriage return, in
  the one form. A bound never splits an escape (`escapedCut`). The dashboard renders each
  escape in its own `span.escaped`, muted and underlined, apart from body text. The MCP server
  escapes the angle brackets in the same form, `\u{003C}` and `\u{003E}`.
- **The refusals** name the first refused character as `where:line:column: rule \u{XXXX}
NAME`. Each applies the rule before its length bound, and the bound counts code points (section
  9.2). `boundedText` refuses the rule and the three line characters, with code
  `<field>_control`. `validatePassword` refuses them after NFKC, at set and change; `verifyPassword`
  never checks. `assertReviewNote` refuses them in a note, and in a claim statement as
  `statement`.
- **The save path** (`cleanedBody` in `server/markdown/body.ts`, for drafts, round-ups and
  articles) refuses a character labelled `c0_control`, `c1_control` or `bidi_control`, which are
  `\p{Cc}` less the three and `\p{Bidi_Control}`, with code `markdown_control`. It removes
  every other character the rule names before the revision is computed and returns each
  removal; then it bounds the body as stored, in code points (section 9.2). A body that holds
  nothing once they are removed is refused as `markdown_length`. The revision keeps every
  removal (section 9.1).
- **The notice.** The three save actions redirect with `saved_cleaned` or `edited_cleaned` and
  the `revision` when something was removed, and the page lists every removal from the record
  that revision keeps (section 9.1). A refusal redirects with `invalid_character` and `at`, a
  list of `CODEPOINT-LINE-COLUMN` entries (`app/notices.ts`), the first twenty, with `more`
  counting the rest; the `Notice` component lists each as its escape, name, line and column and
  states how many more there were. The actions behind the queue, incident, evidence and
  selection notes and the account form pass a refusal's characters the same way; the week
  search, which holds its refusal on the page, lists all of them.
- **The worker's scanner** (`hygiene/scan.ts`) reports each code point the rule names with its
  column, in the shared form. It now keeps a byte-order mark that opens a line, which its
  decoder used to strip silently; the coverage test found that.
- **The scan of stored texts.** `text scan` (`corepack pnpm text:scan`, `text/scan-stored.ts`)
  reads `draft_revisions`, `roundup_revisions` and `article_revisions` and prints, for each
  revision holding a character the rule names, the table, the key, the revision and each code
  point with its rule and count, never the text.

## 4. Tests (S4)

Each list has the test CAS-011's consumers have: every code point the rule names, as the runtime
enumerates it, is escaped, refused or reported, and the two presentation selectors pass. The
lists are the dashboard display, the MCP escapes, the worker's display, scanner and note
refusal, the graph-evidence and sheets-intake displays, the bounded inputs and the password.
Besides, the following are covered:

- the contract: the form round-trips through a string literal and a `u`-flag expression, names
  are added only by `describeCodePoint`, a literal backslash sequence stays text in the parts
  form, the cut never splits an escape, and positions are counted in code points;
- the notice: the parameter's encoding and its strict decoding, which refuses a printable code
  point, text, a zero position, lowercase hexadecimal and a value past U+10FFFF (the last one
  raised before the range was checked first);
- the save path, against PostgreSQL: a pasted soft hyphen and zero-width space are removed and
  listed with their positions, re-saving the cleaned text removes nothing, and a right-to-left
  override refuses the save with its position;
- the browser: a draft carrying a right-to-left override is refused with its name and position,
  a draft carrying a soft hyphen is saved without it, with the notice listing it, and a draft
  carrying 25 zero-width spaces is saved without them, with the notice listing all 25 from the
  revision (section 9.1);
- the scan: a stub database shows the report names code points and counts and never text;
- the corrections of section 9: the name table against every assigned code point the running
  rule names, the code-point bounds at an astral boundary in each of the four places, the save
  path over every code point the rule names, and migration 0024 and its record.

The MCP truncation and bounds tests change count, because an escape now takes eight characters
where it took six. The draft preview's fixture now truncates five hostile fields at the
300-character bound, and the result counts them.

## 5. Interface (S5)

The notices, the refusals and the escaped displays are exercised in the browser suite, three
new cases among its 32. The scan, against a fresh local PostgreSQL 17 database migrated to 0023, 1
November 2026: `corepack pnpm text:scan` printed `text:scan: scanned=0
revisions_with_characters=0` and exited 0, its three queries reading the real tables. The
owner's run against the hosted database is the one that reports the stored revisions.

## 6. Security baseline (S6)

- Nothing a person typed travels in the notice's query string: the parameter decodes only to
  code points the rule names or the three line characters, and to positions; `more` and
  `revision` decode only to whole numbers.
- The removal record holds code points and positions, never a character, and migration 0024's
  check refuses any other shape and any record on a revision no owner edited.
- Refusal messages name the field and the character, never the value.
- The password check runs at set and change only, so a change of the property at a Node upgrade
  cannot lock an account out.
- The scan only reads; it opens no transaction that writes.
- No dependency changed; `pnpm audit` is clean (section 7).

## 7. Verification (S8)

At `db10902`, 1 November 2026: `verify` exit 0, 1,212 offline tests and 37 tool tests; `test:db`
349 (database 124, worker 119, dashboard 57, mcp-server 49); `test:browser` 31 passed; the same
in a clean clone (install, the bill-of-materials check, `pnpm audit`, `verify`, `test:db`,
`test:browser`); CI run 41296920925 and CodeQL run 41296920964 green. The independent review
reproduced everything but the browser suite, which its host's Chromium sandbox would not launch.
The counts after the corrections are in section 9.6; the clean clone and CI of the corrected
head are on the tracker.

## 8. What the unit does not cover

- **The MCP server's JSON fields**, settled by the owner the same day (the D50 amendment). The
  MCP server escapes quoted evidence before it serialises the result, as on `main` before this
  unit: the display escape serves whoever reads the decoded string, JSON's escaping serves its
  parser, and the two stack. A round trip through a JSON parser proves a client reads the
  display-escaped text with nothing the rule names in it (`json-roundtrip.test.ts`, this branch took
  pull request 62's head, so GitHub records 62 as merged into `cas-012/lists`).
- **Other lists**, outside the nine and unchanged: `packages/sheets-intake/src/a1.ts`
  (`isUnrepresentable`, the controls a range address may not hold) and the source scan in
  `apps/dashboard/src/hygiene.test.ts`. The MCP server's test helper `hasRawControl` is on the
  rule now.
- **The Markdown renderer** (`SafeMarkdown`) holds no list. It renders a stored body as it is,
  and it is fed only cleaned text by the save path from now on; what bodies saved earlier hold,
  the scan reports.
- **The database's constraints** stay the floor (section 1.2).

## 9. Review of pull request 61 at `db10902` (1 November 2026)

Codex reviewed `db10902` (record `2026-11-01-CAS-012-pr-61.md`): CHANGES REQUIRED, four P2 and
one P3. `verify`, the bill-of-materials check, `pnpm audit`, the 349 database tests and
`text:scan` passed on the reviewer's host; the shared predicate, the escape form and the parts
form were supported. Each finding is corrected below, with its tests.

### 9.1 P2: the notice dropped every removal after the twentieth

`noticeCharactersParameter` cut the list at twenty, and nothing counted the rest, so a save that
removed 25 characters listed 20. D50 requires each removal listed, never only a count.

Corrected with a record kept on the revision. Migration 0024 adds `removed_characters` to
`draft_revisions`, `roundup_revisions` and `article_revisions`: every character the save removed,
as `[code point, line, column]`, the position counted in code points in the text submitted. The
record holds numbers only, never a character, and its check refuses any entry that is not three
whole numbers from 1 with a code point no greater than U+10FFFF; a generated or deterministic
revision may hold only the empty record. Existing revisions take the empty record, which is
true of them: no save before this unit removed anything. A column with a constant default
rewrites no row, so the append-only guards stand and no published text changes. The save writes
the record in the same insert as the revision; the redirect names the `revision`, and the draft,
round-up and article pages list every removal from that revision's record, the first twenty and
the rest behind a disclosure. With no record (a revision that does not exist, or a bad number),
the notice says only that the text was saved.

A refusal stores nothing, so its characters still travel in the redirect: the first twenty, and
`more`, the number of the rest, which the notice states ("And 7 more, named when the text is
submitted again without the ones above"). Nothing is dropped silently. Where the page holds the
refusal itself (the week search), every character is listed. This reads D50's "a refusal names
the character and position the same way" as naming each listed character in that form; whether
a refusal must list every character, as a removal must, is put to the owner.

Tests: a pure save of 25 zero-width spaces returns all 25; the round-up save against PostgreSQL
keeps every strippable code point's removal on the revision and reads it back, and the raw row
holds the numbers; migration 0024 against a schema migrated to 0023 gives the existing revision
the empty record and refuses nine malformed records and a record on a generated revision; the
draft store returns its record; the notice parameters count and name the revision and decode
nothing else; the browser saves a draft with 25 zero-width spaces and finds 25 listed, five
behind the disclosure, with no `at` in the URL.

### 9.2 P2: lengths counted UTF-16 code units and ran before the rule

`boundedText`, the worker's `assertReviewNote` and the three saves measured `string.length`
before the rule ran. 279 letters and U+E0067 are 280 code points and 281 code units, so the
title and the note refused the value as too long instead of naming U+E0067, and a body at its
maximum carrying a removable astral character was refused instead of stripped. The comment in
`input.ts` that the code-unit bound matched PostgreSQL's `length()` was false: PostgreSQL counts
characters.

Corrected in all four places, and in `validatePassword`, which counted code points but checked
the length first. Each now applies the rule first, so a refused character is named wherever it
stands, and then bounds the value in code points (`codePointLength` in `@cas/contracts`). A
code-unit check comes first only to bound the work: twice the maximum for a single-line value,
which can refuse nothing the code-point bound would accept since nothing there is stripped; four
times the maximum for a body, so a submission past that is refused as too long before any
character is examined. A body is bounded as stored, after the strip.

Tests, each at an astral boundary: 279 letters and U+E0067 are refused by the bounded input and
the note as `title:1:280: default_ignorable \u{E0067} TAG LATIN SMALL LETTER G` and
`note:1:280: ...`; 279 letters and U+1F600 are accepted; one more letter is too long; a body of
ten letters and U+E0067 under a maximum of ten is saved as ten letters with the removal listed;
a password of 128 letters and U+200B names U+200B at column 129; a lone surrogate counts as one,
as iteration counts it.

### 9.3 P2: notices, refusals and logs left out standard names

`codePointName` held 47 names and the two variation-selector ranges, so `describeCodePoint` gave
U+E0067 no name, and the test required that.

Corrected with a generated table, `packages/contracts/src/unicode-names.ts`: the Unicode Name of
every code point the rule names that has one, and, for a control, which has no Name, its alias of
type `control` in NameAliases.txt, with tab, line feed and carriage return, which a one-line
display escapes; 470 entries. U+0080, U+0081 and U+0099 have no Name and no control alias (their
only aliases are of type `figment`, never standardised) and are written as a bare escape, as are
unassigned code points and noncharacters. The names come from Python 3.13.15's `unicodedata`
(Unicode 15.1.0). A name never changes once assigned, and no code point the rule names was
assigned after 15.1.0, so the table stands under the 17.0 the runtime reports. The 62 control
aliases each resolve through `unicodedata.lookup` and agree with Perl's `charnames::viacode`.
The generator, run with the rule's assigned code points (and the three line characters) as JSON
and the control aliases as JSON, writes the table's rows:

```python
import json, sys, unicodedata

CONTROL_ALIASES = json.load(open(sys.argv[2]))  # {"0x0000": "NULL", ...}, type "control"
code_points = json.load(open(sys.argv[1]))
rows = []
for cp in code_points:
    name = unicodedata.name(chr(cp), None) or CONTROL_ALIASES.get(f'0x{cp:04x}')
    if name is None:
        continue
    if CONTROL_ALIASES.get(f'0x{cp:04x}') and unicodedata.lookup(name) != chr(cp):
        raise SystemExit(f'alias does not resolve: {cp:04X} {name}')
    rows.append(f"  [0x{cp:04x}, '{name}'],")
sys.stdout.write('\n'.join(rows) + '\n')
```

Tests: every code point the running rule names that Node reports as `\p{Assigned}`, and the
three line characters, has a name, but exactly U+0080, U+0081 and U+0099; the table holds nothing
the rule does not name and nothing unassigned; U+E0067 is `TAG LATIN SMALL LETTER G`, and the
tag, variation-selector and control ranges are named at their ends.

### 9.4 P2: the save consumer had no exhaustive test

The acceptance requires each consumer's test to walk every code point the runtime rule names;
the save path's covered three. The cleaning is now its own module,
`apps/dashboard/src/server/markdown/body.ts`, and its test walks the rule: every code point in
`\p{Cc}` less the three and in `\p{Bidi_Control}`, taken from the property and not from the rule's
labels, refuses the save with its line and column; every other is stripped and listed where it
stood; U+FE0E, U+FE0F, tab, line feed and carriage return are kept; one body carrying every
strippable code point is stored with none of them and lists each removal. The PostgreSQL test of
section 9.1 saves that body through the round-up and reads the record back.

### 9.5 P3: the report and the tracker contradicted the branch

The report called itself a design note on `cas-012/design-note`, and the tracker named that
branch, left steps 3 and S8 open and recorded no counts, clean clone, CI or review. Both now
describe `cas-012/lists`, its commits, the counts, the clean clone, CI and this review, and the
acceptance stays open until the re-review.

### 9.6 Verification after the corrections

Counts from the runner, 1 November 2026, in the working tree at the corrections: `verify` exit
0, 1,226 offline tests and 37 tool tests; `test:db` 351 (database 126, worker 119, dashboard 57,
mcp-server 49); `test:browser` 32 passed. One browser run before that timed out starting its
web server after a successful build; the next run, with no change between them, passed all 32.
The clean clone and CI of the corrected head are on the tracker.
