# CAS-011 report: one invisible-character rule

**Status:** built on `cas-011/invisible-text`, from `main` at `7c867b7`; **not audited**.
Tracker: `docs/tcu/CAS-011.md`. Decision: D49. Issue: #56.

## 1. Scope and decisions (S0)

### 1.1 Where the unit comes from

The round-up's third review observed U+180E MONGOLIAN VOWEL SEPARATOR surviving the export
(`docs/CAS-004-REPORT.md`, section 7.3). The correction was bounded to the repository's table,
`data/policy/prohibited-text.json`, which did not name the character, and the class was left
for the owner. The story card (CAS-009) then shipped two lists of its own, in its contract and
in the dashboard's display text; both let U+061C ARABIC LETTER MARK through, which the table
forbade. On 1 November 2026 the owner chose option (b): the Unicode property for characters
that render as nothing, one predicate, three consumers (D49).

### 1.2 In and out

In: one module, `packages/contracts/src/prohibited-text.ts`, and its three consumers: the
hygiene check over tracked files (`tools/checks/hygiene.ts`), the round-up export
(`packages/roundup/src/text.ts`) and the story card (`packages/contracts/src/story-card.ts`, the
public contract, and `apps/dashboard/src/server/cards/story.ts`, the display text). A fix mode
for the hygiene check. The Unicode version in the bill of materials
(`tools/supply-chain/sbom.ts`).

Out, unchanged: stored text (threat model RR13), the database and its migrations, the
dashboard's display escapes (`apps/dashboard/src/server/display.ts`), the body refusal of
drafts, round-ups and articles (`apps/dashboard/src/server/dal/mutate.ts`), the MCP server's
escapes (`packages/mcp-server/src/safety/text.ts`), and the worker's source scanner with the
stored-note refusal it mirrors (`apps/worker/src/hygiene/scan.ts`, migration 0007). Section 1.4
puts the four lists to the owner.

Files touched: the module and its test (added); `packages/contracts/src/index.ts`,
`story-card.ts` and its test; `packages/roundup/package.json`, `src/text.ts`, `src/roundup.test.ts`;
`apps/dashboard/src/server/cards/story.ts` and its test; `tools/checks/hygiene.ts`,
`checks.test.ts`; `tools/supply-chain/sbom.ts`, `supply-chain.test.ts`; `package.json` (the
`hygiene:fix` script); `pnpm-lock.yaml` (three lines); `supply-chain/` (regenerated). Removed,
by D49's condition: `data/policy/prohibited-text.json`. Documents: D49, this report, the tracker,
the plan's section 5, `README.md`, `docs/ARCHITECTURE.md` section 25, `docs/SECURITY.md` section
25 and the export bullet, `docs/THREAT_MODEL.md` RR13.

### 1.3 The decision, as built

| D49                                                | Where                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default_Ignorable_Code_Point but U+FE0E and U+FE0F | one character class under the `v` flag, the property less the two selectors (`prohibited-text.ts`); `PERMITTED_DEFAULT_IGNORABLES` names them                                |
| The fixed rules kept                               | `\p{Cc}` less tab, line feed and carriage return; U+2028 and U+2029; U+FFF9 to U+FFFB; `\p{Noncharacter_Code_Point}`                                                         |
| U+200D refused bare, stripped in sequences         | no exception in the class; a test shows a joined family emoji decomposing into its three people                                                                              |
| One predicate, one module, three consumers         | `prohibitedTextRule`, `hasProhibitedText`, `removeProhibitedText`; the card's two lists deleted; the table removed                                                           |
| From the runtime; the version recorded             | no table in the repository; `cas:runtime:unicode` in `supply-chain/sbom.cdx.json` (17.0 under Node 24.21.0, ICU 78.3)                                                        |
| A test over every code point, per consumer         | `prohibitedCodePoints()` enumerates the rule from the runtime; the contracts test holds it to the property and to `\p{Cc}`; each consumer's test walks all 4,305 code points |
| No exemption for the rule; fixtures hold escapes   | the class has no exception path; every test builds its characters with `String.fromCodePoint`                                                                                |
| A fix path                                         | `corepack pnpm hygiene:fix`                                                                                                                                                  |
| Out of scope, named                                | confusables; whitespace that renders as a space (the export and the card already collapse it); C0 and C1 were already covered                                                |

### 1.4 Two questions for the owner

**Question 1: do the fixtures' path exemptions stay?** D49's fifth condition reads "no
exemption list and no per-file opt-out". The hygiene check has two: a
leading byte-order mark in `data/fixtures/editorial/master-synthetic.csv` and carriage returns
in `data/fixtures/editorial/weekly-synthetic.csv`. Both fixtures imitate the real exports the
importer must accept. The exemptions cover the path rules (`byte_order_mark`,
`carriage_return`), not the new one; this unit leaves them as they were.

- (a) Keep them. The rule itself has no exemption, and the two fixtures keep proving the
  importer handles a marked, CRLF export. **Recommended.**
- (b) Retire them. The fixtures lose the mark and the CRLF line endings, and the importer tests
  write both at run time from escapes.

**Question 2: do the four other lists move onto the rule?** Each holds its own set, and none of
them names U+180E: the dashboard's display escapes, which show bidirectional controls as visible
escapes; the body refusal of drafts, round-ups and articles; the MCP server's escapes; and the
worker's source scanner, which checks controls only. Each does something different with the
characters (escape, refuse, scan), so moving one is not a substitution.

- (a) Name them out of scope in D49, as now, and queue a later unit that decides each one's
  action. The body refusal is the one with a product cost: on the rule, a soft hyphen pasted
  into the round-up editor would be refused at save, as a bidirectional control is today.
  **Recommended.**
- (b) Move all four onto the rule in this unit, before its review, each keeping its action.

## 2. Stack check and data contract (S1, S2)

No third-party dependency. The rule uses the regular-expression engine of the pinned Node
24.21.0: the `v` flag for set difference, and the properties `Default_Ignorable_Code_Point`,
`Bidi_Control`, `Noncharacter_Code_Point` and `Cc`. Their data is the ICU that Node bundles
(`node -p process.versions`: unicode 17.0, icu 78.3). The class is built with `new RegExp`
because the compilation target, ES2022, predates the flag. `@cas/roundup` gains `@cas/contracts`
as a workspace dependency, as eleven packages already have it; the lockfile gains three lines
and the bill of materials one edge.

The contract is `prohibited-text@2` in `@cas/contracts` (the table was `prohibited-text@1`):
`PROHIBITED_TEXT_RULES` (`c0_control`, `c1_control`, `line_separator`, `bidi_control`,
`default_ignorable`, `interlinear_annotation`, `noncharacter`), `prohibitedTextRule(codePoint)`,
`hasProhibitedText(value)`, `removeProhibitedText(value)`, `prohibitedCodePoints()` and
`PERMITTED_DEFAULT_IGNORABLES`. The file holds none of the characters it names and imports
nothing. The hygiene check imports it as source by its path, because that check runs before
any build. No migration.

Under Unicode 17.0 the rule names 4,305 code points: 4,172 default-ignorable ones, 62 controls,
2 separators, 3 interlinear annotation characters and 66 noncharacters. The table named 150.

## 3. Implementation (S3, S5)

- **The hygiene check** labels each code point by `prohibitedTextRule`; printable ASCII is
  passed without a call. A finding still names the file, the line, the rule and the code point,
  never the character. The new findings are labelled `default_ignorable`; `zero_width` is gone.
- **The fix mode.** `corepack pnpm hygiene:fix` (`node tools/checks/hygiene.ts --fix`) finds the
  tracked regular files that carry a default-ignorable code point, opens each without following
  a link, refuses anything but a regular file, reads, judges and rewrites it through that one
  handle, prints the path and the number removed, then runs the check. A leading byte-order mark
  is removed except in the one fixture exempt from that rule. Controls, separators,
  noncharacters, carriage returns and invalid UTF-8 stay findings for a person.
- **The export.** `escapeInline` turns line breaks into spaces, removes what the rule names,
  collapses whitespace and escapes Markdown, as before; `inlineSlotTextIssue` refuses a
  model-written slot that carries any of it. The table reader is gone.
- **The card.** The contract refuses a headline that carries anything the rule names, and tab,
  line feed or carriage return, since a card's text is one line. The display text turns line
  breaks into spaces and removes what the rule names, where it used to replace its own list
  with spaces.
- **The bill of materials** records `cas:runtime:unicode`; the generator is `cas-sbom-generator@2`.

## 4. Tests (S4)

- `prohibited-text.test.ts` (four tests): every code point the runtime reports as
  Default_Ignorable_Code_Point is prohibited but U+FE0E and U+FE0F, and `prohibitedCodePoints()`
  equals the rule over the whole range; every control but the three, and all 66 noncharacters;
  the rule of 31 named code points (U+061C, U+180E, U+00AD, U+034F, U+3164, U+E0001, U+E0100
  among them); removal of every occurrence, emoji presentation kept, a joined sequence
  decomposed.
- The card contract: every one of the 4,305 code points refused in a headline; the selectors
  accepted; U+061C and a tab refused.
- The export: every code point removed by `escapeInline` and refused by `inlineSlotTextIssue`
  (the separators as a space and a line break); the selectors kept.
- The card's display text: every code point removed; the selectors kept; U+061C and U+180E
  removed from a published round-up headline read through the markdown.
- The hygiene check: every code point a finding with its rule; the selectors no finding;
  `--fix` removes a soft hyphen, a zero-width space, a bidirectional control, a Windows
  byte-order mark and U+180E, keeps the exempt fixture's mark and a selector, leaves a NUL a
  finding, and has nothing to do on a second run; a tracked path that became a link is refused
  and its target left alone.
- The bill of materials carries the property.

Counts from the runner, 1 November 2026, in the working tree: `verify` exit 0, 1,190 offline
tests (contracts 23, five added; round-up 15, its policy-table test rewritten; dashboard 146,
one added), 34 tool tests (one rewritten, two added); `test:db` exit 0, 341 (database 117,
worker 119, dashboard 56, mcp-server 49), no test added; `test:browser` 30 passed.

## 5. End-to-end proof (S5)

Recorded in section 7 once run in the clean clone: the check refusing a tracked file with a
planted soft hyphen and byte-order mark, `hygiene:fix` removing both, and the check passing.

## 6. Security baseline (S6)

- No secret, no network, no new input boundary. The rule is pure.
- The fix mode writes tracked regular files only, through a handle opened with `O_NOFOLLOW`
  and checked with `fstat`; a link is refused (test). Its output is a path and a count.
- The hygiene check never prints the character it found.
- `pnpm audit` is clean at low (section 7).

## 7. Verification (S8)

Pending: the counts, the clean clone and CI are recorded here and on the tracker when run.

## 8. What the rule does not cover

- Stored text keeps every character exactly (RR13); the export and the card are renderings.
- Confusables, and whitespace that renders as a space, are outside D49 (section 1.3).
- The four lists of section 1.4.
- The set follows the running Node: a Node built against a system ICU of another version
  reports another set, and the bill-of-materials check fails on it. CI installs the release
  `.nvmrc` pins (24.21.0) through `actions/setup-node`; the reproduction steps use the same.
