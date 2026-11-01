# CAS-011 report: one invisible-character rule

**Status:** built on `cas-011/invisible-text`, from `main` at `7c867b7`, pull request 57, merged at `7530d1c`; the last finding corrected in pull request 60, which passed at `9346f4f` and merged at `12ce7a7`; **accepted** (section 12).
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
stored-note refusal it mirrors (`apps/worker/src/hygiene/scan.ts`, migration 0007), and five
more lists of controls and separators found when the answer to section 1.4 was applied. D49
names all nine by path; CAS-012 puts them on the rule.

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
| No blanket exemption; fixtures hold escapes        | each fixture exemption scoped to one pattern and recorded with its input (`FIXTURE_EXEMPTIONS`), held by a test; code builds its characters with `String.fromCodePoint`      |
| A fix path                                         | `corepack pnpm hygiene:fix`                                                                                                                                                  |
| Out of scope, named                                | confusables; whitespace that renders as a space (the export and the card already collapse it); C0 and C1 were already covered                                                |

### 1.4 Two questions for the owner, answered on 1 November 2026

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

**The answers.** Question 1: (a), with the exemption narrowed to its pattern, made load-bearing,
and the condition amended (D49, condition 5). The byte-order mark's exemption already covered
exactly one U+FEFF at offset 0, and the rest of that fixture was checked in full; it is now
recorded with the input it imitates (`FIXTURE_EXEMPTIONS`). A test holds the master fixture to
its leading mark and the weekly fixture to its CRLF line endings, and shows a second mark or a
U+180E in either fixture is still a finding. The carriage-return exemption is the line-ending
check's and is unchanged: U+000D is not a character this rule names.

Question 2: (a), with the unit opened now rather than queued: CAS-012
(`docs/tcu/CAS-012.md`), whose first decision is the save path, refuse or strip and report. The
question named four lists. Applying the answer found five more, each a list of the controls and
separators with no invisible characters at all: the dashboard's bounded inputs and passwords,
the worker's display and review-note refusal, and the displays of `@cas/graph-evidence` and
`@cas/sheets-intake`. D49 names all nine by path, with what each does, and CAS-012 covers all
nine. No code in this unit changes for question 2.

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
- **The fix mode.** `corepack pnpm hygiene:fix` (`node tools/checks/hygiene.ts --fix`) opens each
  tracked file through one handle and checks the handle, not the path, before reading it: the
  file is regular with one link, its path resolves to the repository's real path plus the
  tracked path with no link in any component, and the file at that path is the handle's (device
  and inode). Anything else is refused with one message. No existing file is ever written: the
  corrected bytes go into a new file created beside the target with its mode, both files are
  checked again, and a rename puts the new file in the target's place, so every link to the
  original keeps the original bytes. The command prints the path and the number removed, then
  runs the check. A leading byte-order mark
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
- The fixture exemptions (D49, condition 5): the master fixture starts with its byte-order mark
  and the weekly fixture has CRLF line endings, so neither exemption outlives its reason; a
  second mark or a U+180E in either fixture is a finding.
- The bill of materials carries the property.

Counts from the runner, 1 November 2026, in the working tree: `verify` exit 0, 1,190 offline
tests (contracts 23, five added; round-up 15, its policy-table test rewritten; dashboard 146,
one added), 35 tool tests (one rewritten, three added; the third with the answers of section 1.4); `test:db` exit 0, 341 (database 117,
worker 119, dashboard 56, mcp-server 49), no test added; `test:browser` 30 passed.

## 5. End-to-end proof (S5)

In the clean clone at `8651890`, 1 November 2026: a byte-order mark and a soft hyphen were
planted in the tracked `README.md` with escapes. `node tools/checks/hygiene.ts` then failed with
`README.md:1: byte_order_mark (U+FEFF)`, `README.md:1: default_ignorable (U+00AD)` and
`hygiene: scanned=699 findings=2 FAILED`. `corepack pnpm hygiene:fix` printed
`README.md: removed 2 default-ignorable code point(s)` and `hygiene: scanned=699 findings=0 OK`,
and `git diff --quiet README.md` exited 0: the file was restored byte for byte.

## 6. Security baseline (S6)

- No secret, no network, no new input boundary. The rule is pure.
- The fix mode never writes to an existing file; it replaces a tracked file by renaming a new
  file over it. A link in any path component, a file already linked from elsewhere, or a path
  swapped before the open is refused, and a link made to the original at any moment keeps the
  original bytes (tests for each; sections 9 and 10). The one case Node's path-based calls cannot
  exclude is another process swapping a directory of the checkout between the last check and the
  rename: a change to the checkout while the command runs is outside its threat model, a
  developer's command over their own working tree. Its output is a path and a count.
- The hygiene check never prints the character it found.
- `pnpm audit` is clean at low (section 7).

## 7. Verification (S8)

Clean clone of `cas-011/invisible-text` at `8651890`, 1 November 2026, Node 24.21.0 and pnpm
11.10.0: `install --frozen-lockfile` exit 0; `supply-chain:check` CHECK OK, 346 components;
`audit:deps` no known vulnerabilities; `verify` exit 0, 1,190 offline tests and 34 tool tests;
`test:db` exit 0, 341 (database 117, worker 119, dashboard 56, mcp-server 49); `test:browser`
30 passed. CI at `8651890`: run 41276066151 green on every job (Verify, Supply chain, both
PostgreSQL lanes), CodeQL run 41276066146 green, no open code-scanning alert.

The diff from `main` at `7c867b7`: two files added (the module and its test), one removed
(`data/policy/prohibited-text.json`), the rest modified as section 1.2 lists; no file renamed.

## 8. What the rule does not cover

- Stored text keeps every character exactly (RR13); the export and the card are renderings.
- Confusables, and whitespace that renders as a space, are outside D49 (section 1.3).
- The nine lists D49 names, which CAS-012 puts on the rule.
- The set follows the running Node: a Node built against a system ICU of another version
  reports another set, and the bill-of-materials check fails on it. CI installs the release
  `.nvmrc` pins (24.21.0) through `actions/setup-node`; the reproduction steps use the same.

## 9. Review of pull request 57 at `030c8d6` (1 November 2026)

Codex reviewed `030c8d6` (record `2026-11-01-cas-011-pr-57.md`): CHANGES REQUIRED, one Medium.
The rule, its four consumers, the fixture exemptions, the bill-of-materials pin and D49's scope
were supported. F1: `hygiene:fix` opened each file with `O_NOFOLLOW`, which refuses a link in the
last path component only. With a tracked file's parent directory replaced by a link, the fix
read the outside file by path, opened it, and rewrote it; the reviewer reproduced it with the
real function.

Corrected the same day in `tools/checks/hygiene.ts`. The pre-read by path is gone: every file is
opened through `openTracked`, and the checks are made on the handle once it is open. The file
must be regular with exactly one link; its path must resolve to the repository's real path plus
the tracked path, so no component is a link; and the file at that path must be the handle's
(device and inode). A swap before the open leaves the handle on another file, and one after it
changes the resolved path, so either is refused. A file to fix is reopened for writing under the
same checks and rewritten from what that handle holds. The test replaces a tracked file's parent
directory with a link to an outside directory, and in a second case replaces the file with a hard
link to an outside file; both are refused with the outside file byte for byte unchanged. On
`030c8d6`'s fix path the first case fails, the outside file rewritten. Tool tests: 36.

## 10. Re-review of pull request 57 at `7ab3697` (1 November 2026)

Codex re-reviewed `7ab3697` (the same record, its re-review section): CHANGES REQUIRED, one Medium
and one Low; the first review's F1 closed, the regression failing on `030c8d6` as claimed.

- **F1 (Medium): a hard link made after the link count was sampled saw the rewrite.**
  `openTracked` sampled `nlink` once and the fix then rewrote that inode in place; the reviewer
  made an outside link at the second check of the target and the outside name received the
  corrected bytes. Corrected: no existing file is written any more. `replaceTracked` writes the
  corrected bytes to a new file created beside the target (`O_CREAT | O_EXCL | O_NOFOLLOW`, the
  target's mode), checks both files again, and renames the new one over the target, so the
  original inode, and every link to it, keeps its bytes. The claim is narrowed to what the
  replacement guarantees: a swap of a directory of the checkout between that last check and the
  rename is outside the command's threat model (section 6). Test:
  `tools/checks/hygiene-race.test.ts` wraps `statSync` and makes the outside link at the second
  check of the target, the reviewer's moment; the outside bytes stay as they were and the
  checkout's file is fixed. On `7ab3697` it fails, the outside name rewritten.
- **F2 (Low): a link in the last component raised Node's own `ELOOP`.** The open now sits inside
  the refusal: `ELOOP`, `ENOTDIR` and `ENOENT` on the way to a tracked file become
  `hygiene fix refuses <path>: not a regular file of this checkout`, and any other error passes
  through as itself. The final-component test asserts the exact message; on `7ab3697` it fails.

Tool tests: 37.

## 11. The combined re-review of `6276df0` (1 November 2026)

Codex reviewed pull requests 55 and 57 together (record
`2026-11-01-pr-55-d572aaf-pr-57-6276df0.md`): 55 PASS at `d572aaf`; 57 CHANGES REQUIRED at
`6276df0`, with F1 and F2 of the re-review closed and one new Medium. Pull request 57 had already
merged at `7530d1c`, so the correction is a new pull request from `main`, on `cas-011/write-all`.

- **F3 (Medium): a short write could replace the tracked file with a truncated one.**
  `replaceTracked` called `writeSync` once and ignored the number of bytes it took, which Node
  documents as possibly fewer than asked. A write that took three bytes was then renamed over the
  tracked file and the fix reported success. Corrected: `writeAll` repeats the write from where
  the last one stopped, advancing the buffer offset and the file position together, until every
  byte is taken; a write that takes none throws, and the replacement is then removed, never
  renamed. Test: `tools/checks/hygiene-write.test.ts` cuts every write to three bytes at most, and
  the whole corrected text reaches the replacement in three calls; a write that takes nothing
  stops the fix with `hygiene fix could not write the replacement for docs/note.md`, the tracked
  file unchanged and no replacement left behind. Both fail on `6276df0`. Tool tests: 39.

## 12. Re-review of pull request 60 at `9346f4f` (1 November 2026)

Codex re-reviewed pull request 60 (record `2026-11-01-pr-60-9346f4f.md`), bounded to F3 of the
combined re-review: PASS, no findings. The short-write path in `replaceTracked`, its regression
tests and the earlier fix-mode behaviour were supported. The owner merged pull request 60 at
`12ce7a7` the same day, and CAS-011 is accepted.
