# data/fixtures

Reserved for synthetic, normalized fixtures used by tests and by replay runs.

Empty after Sprint 0. Rules for anything added here, from `docs/DATA_INPUTS.md` and
`docs/SECURITY.md`:

- Fixtures are synthetic. They must not contain third-party article bodies, summaries,
  descriptions or any row copied from the Excel/RSS exports or the weekly snapshot sheets.
- Fixtures must carry a `fixture` data origin so they can never be displayed as live data.
- Fixtures must retain the provenance fields the pipeline preserves for real records, so that
  provenance handling is exercised by tests.
