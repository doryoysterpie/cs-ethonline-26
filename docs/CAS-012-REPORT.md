# CAS-012 report: every character list on the rule

**Status:** S0 design note, written 1 November 2026 before any code; **not audited**. Tracker:
`docs/tcu/CAS-012.md`. Decision: D49. Issue: #58. The note is on `cas-012/design-note`, stacked on
CAS-011's `cas-011/invisible-text`, which holds the tracker and the rule.

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

## 2. What follows the decisions

S1 to S8 wait on CAS-011's merge, since the predicate lives there. Each list then gets the test
CAS-011's consumers have: every code point the rule names is escaped, refused or reported, and
the two presentation selectors pass.
