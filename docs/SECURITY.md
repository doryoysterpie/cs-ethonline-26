# Security policy

This document states the security rules the project holds itself to from Sprint 0 onward.
Every later sprint inherits them. A rule here is not advisory. Code or documentation that
contradicts it is a defect.

## 1. Retrieved text is untrusted evidence, never instructions

Every string that enters the system from outside, including RSS titles, summaries,
descriptions, article bodies, publisher categories, Graph query results, MCP tool inputs and
anything a model returns after reading such text, is evidence about the world. It is never a
command to the pipeline, to a model prompt, to an agent or to an operator. Prompts that
include retrieved text must frame it as quoted data, and no component may act on an
instruction found inside it. The full data-handling rules are in `DATA_INPUTS.md`.

## 2. Secrets are prohibited from the repository

No API key, token, private key, connection string, seed phrase or secret suffix may appear in
tracked files, commit messages, workflow files, documentation or logs. Local secrets live only
in `.env`, which `.gitignore` excludes. `.env.example` declares names, never values. Production
secrets, when a deployment exists, come from the hosting platform's secret store. A secret
that reaches Git history is treated as compromised and rotated, regardless of how quickly the
commit is removed.

## 3. Fixtures cannot contain third-party article bodies

Files under `data/fixtures` are synthetic. They may imitate the shape of the Excel/RSS exports
and the weekly snapshot sheets, but they may not contain any title, summary, description,
body text or row copied from a real export, a real feed or a real publication. The raw exports
themselves, and any complete third-party article text, are excluded from Git by `.gitignore`
and by policy (`PRIOR_INPUTS.md`, `DATA_INPUTS.md`).

## 4. Live, fixture and replay data must be visibly distinct

Every record the system processes or shows carries a data origin from the shared contract in
`@cas/contracts`: `live`, `fixture` or `replay`. Only a record obtained from a live Graph
provider response, with its request provenance retained, may carry `live`. Dashboards, MCP
outputs, feed responses and drafts must label the origin. Nothing may present fixture or
replay data as live, and no default may silently substitute one origin for another.

## 5. The public x402 feed is a payment gate, not confidential access control

The planned x402-gated feed (Sprint 8 at the earliest) charges for access to public incident
metadata. It provides no confidentiality. Nothing that must stay private, including private
editorial notes, corpus text or unpublished victim names, may be placed behind it on the
assumption that payment implies authorization. Decision D6 in `DECISIONS.md` governs what the
feed exposes.

## 6. Automatic publication is prohibited

The system produces an editable draft. A human turns the draft into the published issue. No
component may post, publish, schedule or push content to any publication channel. This
prohibition is a hackathon non-goal and a standing safety rule, not a missing feature.

## 7. Security-sensitive failures must be explicit

A failed live fetch, a missing credential, an unparseable input file, a provenance gap, an
untrusted-input rejection or a model refusal must surface as an explicit error with a cause.
No component may represent such a failure as an empty successful result, an empty list, a
zero count or a silently substituted fixture.

## 8. Supply chain

Every third-party version is pinned exactly through the pnpm catalog and the lockfile.
`pnpm-workspace.yaml` sets `minimumReleaseAge` to 24 hours so a freshly published package
version cannot be resolved into the project. Continuous integration installs with
`--frozen-lockfile` and runs with read-only repository permissions. GitHub Actions are pinned
to full commit SHAs. Do not lower or remove any of these controls to make an install succeed;
choose an older version instead.

## 9. Chain posture

Any chain interaction is testnet-only until the project owner explicitly approves otherwise.
Only public incident metadata and hashes may be written on chain. No personal data is ever
written on chain.

## Reporting a vulnerability

Report privately to the repository owner. Do not open a public issue describing an
unpatched vulnerability.
