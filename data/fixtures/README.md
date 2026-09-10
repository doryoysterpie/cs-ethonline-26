# data/fixtures

Synthetic fixtures used by tests and by fixture-origin imports. Rules, from
`docs/DATA_INPUTS.md` section 11 and `docs/SECURITY.md` section 3:

- Fixtures are synthetic. They contain no title, summary, description, URL or row copied,
  shortened, anonymized or otherwise derived from the Excel/RSS exports, the weekly snapshot
  sheets or any publication. Hostnames use the reserved `.example` domain.
- Fixtures are imported only with the `fixture` data origin, so they can never be displayed
  as live data.
- Fixtures reproduce the representative schemas and every known source hazard, so provenance
  and preservation handling is exercised by tests.

## `editorial/` (Sprint 2)

Generated deterministically; identical bytes on every regeneration. Line endings and the
byte-order mark are part of the fixture. Timestamps use non-round seconds so that no fixture
cell can coincide with a cell of a real export, which a count-only check confirms.

| File                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `master-synthetic.csv`                   | Master schema plus one unknown column (`Editor Note`), UTF-8 BOM, LF line endings, 12 rows: quoted commas, escaped quotes, an embedded newline, HTML with entities and script/style content, missing optional values, an exact duplicate URL, tracking-parameter URL variants, a 48,400-character summary (the pattern `long-synthetic-text-` repeated 2,420 times), a prompt-injection-looking title, SQL-injection-looking description and summary, an invalid timestamp, a naive timestamp, an invalid URL, a disallowed scheme, an empty title, and an unrecognized master `ch` token |
| `weekly-synthetic.csv`                   | Weekly schema with two trailing blank headers, no BOM, CRLF line endings, 8 rows: `TRUE`, `FALSE`, blank and unknown (`YES`) review tokens, an invalid URL and an invalid timestamp on rows that still carry a review token, an exact duplicate URL, a tracking-parameter variant, HTML with entities                                                                                                                                                                                                                                                                                     |
| `structural-unclosed-quote.csv`          | A quoted field that never closes; rejected before any write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `structural-duplicate-header.csv`        | `Title` appears twice; rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `structural-missing-required-header.csv` | No `URL` header; rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `structural-inconsistent-columns.csv`    | A data row with fewer cells than the header; rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `structural-empty.csv`                   | Zero bytes; rejected as having no header                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Expected count-only results are asserted in `apps/worker/src/editorial/validate.test.ts` and
the database round-trip tests. Invalid UTF-8 and NUL-character inputs are generated by tests
in a temporary directory rather than committed.

## `evidence/` (Sprint 5)

Generated deterministically; identical bytes on every regeneration. Nothing here is copied
or derived from a provider response, an export or a publication. The gateway host is the
reserved `.example` name `gateway.fixture.example`, the deployment identifiers and block
hashes are invented, and the observation timestamps use non-round seconds.

These fixtures are `replay` origin. A replay is never a live observation: the origin is a
required argument with no default, it is stored on the signal run and on every signal, and
it is printed on every anomaly line.

### `snapshots/replay-01.json` … `replay-12.json`

Twelve daily standardized-TVL snapshots, 24 hours apart, from `2026-08-24T03:17:41Z` to
`2026-09-04T03:17:41Z`, over the seven live identities decision D23 retained. Replayed
against the as-of instant `2026-09-04T09:11:23Z` they produce one of every anomaly label:

| Target                   | Present on     | Produces               | Why                                                       |
| ------------------------ | -------------- | ---------------------- | --------------------------------------------------------- |
| `ethereum:aave-v3`       | days 1–12      | `normal`               | ordinary daily movement, last reading `0.29%`             |
| `ethereum:spark-lend`    | days 1–12      | `positive_spike`       | `31.5%` against a baseline of ordinary noise              |
| `ethereum:compound-v3`   | days 1–12      | `negative_spike`       | `-27.8%` against a baseline of ordinary noise             |
| `ethereum:makerdao`      | days 1–12      | `positive_spike`       | a baseline that never moved, so only the 5% floor decides |
| `ethereum:liquity`       | days 10–12     | `insufficient_history` | two prior observations, fewer than the seven required     |
| `base:seamless-protocol` | days 1–5, 8–12 | `missing_observation`  | a 72-hour hole, reported rather than smoothed over        |
| `base:moonwell`          | days 1–9       | `stale_observation`    | last reading older than the 36-hour freshness limit       |

The last three are the point of the set: too little history, a gap and an old reading are
each reported as themselves, and none of them is ever a spike.

### `reporting-windows.json`

Five scenarios of explicitly bounded weekly windows. No editorial week is inferred from
them; the bounds are data the caller supplies, because decision D10 has not fixed one.

| Scenario                              | Volume                 | Concentration    | Purpose                                                               |
| ------------------------------------- | ---------------------- | ---------------- | --------------------------------------------------------------------- |
| `volume-spike`                        | `positive_spike`       | `normal`         | 210 stories against a baseline near 40                                |
| `story-concentration`                 | `normal`               | `positive_spike` | ordinary volume, 46 stories collapsing into 9 incidents               |
| `high-incident-count-no-volume-spike` | `normal`               | `normal`         | 44 incidents and nothing raised: incident count alone is not a signal |
| `insufficient-windows`                | `insufficient_history` | not reached      | two prior windows, fewer than the three required                      |
| `flat-baseline`                       | `positive_spike`       | `normal`         | a baseline that never moved, decided by the absolute threshold        |

### `correlation.json`

Eight incidents and seven signals covering every correlation outcome and every evidence
state. Three incidents correlate and are then decided: one accepted `supports` resolves to
`corroborated`, one accepted `conflicts` resolves to `contradicted`, one accepted `context`
resolves to `onchain_observed`. Five are refused, one for each reason the contract has: no
recorded protocol, a matching protocol on a different chain, an observation outside the
declared window, a movement below the magnitude floor, and an incident with no recorded
report time. All five resolve to `reported_only`, and so does every incident until a person
accepts something.

Expected results are asserted in `packages/evidence/src/replay.test.ts` against the shipped
contract, and the snapshots are ingested end to end in the Sprint 5 database tests.
