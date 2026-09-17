# Source fetch policy

Version 0.1. Written 16 September 2026. Status: **PROPOSED, not implemented**. This is the
contract CAS-005 (`docs/POST-EVENT-PLAN.md`, section 5) implements before any code fetches a
source. Of the three owner decisions in section 6, O-1 and O-3 are decided and O-2 is open; nothing in sections 2 to 5 depends on them.

## 1. Why this document exists

No code in this repository fetches a source URL today. The MCP server classifies stored URLs
before showing them and states in its own header that it never fetches one
(`packages/mcp-server/src/safety/reference.ts`). CAS-005 changes that: to write an article the
service must read every selected story's source in full, from the deployed Railway service,
at an address a publisher chose and a feed row carries.

That is a new outbound boundary, and without rules it is a request forger. A URL in the feed
is controlled by whoever controls the feed row (attacker capability C1 and C2 in
`docs/THREAT_MODEL.md`, section 8). A crafted one can point the service at Railway's private
network, a cloud metadata address, the database host, or the service itself. A large or slow
response can hold the generator open, and a decompressed body can be far larger than the bytes
on the wire. Page text is also untrusted input that will sit inside a model prompt.

This policy names each rule, its fixed reason code, and the test that falsifies it. The
security-necessity class applies to every rule in section 2: a property breaks without it, and
the mechanism is named.

## 2. Rules

The URL policy of `reference.ts` (rules R1 to R4) is adopted as written, so that the two
classifiers cannot drift apart; the fetch adds rules R5 to R17, which `reference.ts` never
needed because it never connects.

| Rule | Requirement                                                                                                                                                                                                                                                                                                                                                                                    | Reason code on refusal                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| R1   | Scheme is `http:` or `https:`.                                                                                                                                                                                                                                                                                                                                                                 | `scheme_not_permitted`                                     |
| R2   | No user information in the URL.                                                                                                                                                                                                                                                                                                                                                                | `credentials_present`                                      |
| R3   | A host that is a name is not `localhost` or under it, not under `.local`, `.internal` or `.arpa`, not a single label, and not under `.test`, `.example`, `.invalid` or `.onion`.                                                                                                                                                                                                               | `local_name`, `reserved_name`                              |
| R4   | A host that is an address literal is not loopback, private, shared, link-local, multicast or otherwise reserved, including IPv4 embedded in IPv6 mapped and NAT64 forms, exactly as `classifyIpv4` and `classifyIpv6` decide.                                                                                                                                                                  | `loopback_address` and the other four codes                |
| R5   | The name is resolved before any connection, every resolved address passes R4, and the connection is made to one of those checked addresses and no other. If any resolved address fails, the fetch is refused; the public one is not chosen. This closes DNS rebinding, where a name resolves publicly once and privately next.                                                                 | `resolved_address_refused`, `resolution_failed`            |
| R6   | Port is 443 for `https:` and 80 for `http:`.                                                                                                                                                                                                                                                                                                                                                   | `port_not_permitted`                                       |
| R7   | Redirects are never followed by the HTTP client (`redirect: "manual"`). A 3xx `Location` is re-classified under R1 to R6 and followed only if it passes, at most 3 times, and never from `https:` to `http:`.                                                                                                                                                                                  | `redirect_refused`, `redirect_limit`, `redirect_downgrade` |
| R8   | Method is `GET`. No cookie, no `Authorization`, no credential of any kind is sent. The `User-Agent` is one fixed string naming the product (section 6, O-3). `Accept` names HTML and plain text only.                                                                                                                                                                                          | none; structural                                           |
| R9   | The response `Content-Type` is `text/html`, `application/xhtml+xml` or `text/plain`.                                                                                                                                                                                                                                                                                                           | `content_type_not_permitted`                               |
| R10  | The body is read as a stream and stops at the bound. A declared `Content-Length` above the bound refuses before the first byte; a declared length below it is not trusted. The bound applies to decompressed bytes when the response is compressed. Starting bound: `RESOURCE_LIMITS.graph.responseBodyBytes` (1 MiB), revised only by a measurement recorded at S0.                           | `body_limit`                                               |
| R11  | Each fetch has its own deadline (proposed 15 seconds) and the fetch stage of one generation has a total deadline (proposed 5 minutes), both inside the command deadline of `RESOURCE_LIMITS.command`.                                                                                                                                                                                          | `fetch_timeout`, `stage_timeout`                           |
| R12  | At most 4 fetches in flight per generation, and each canonical URL is fetched once per generation.                                                                                                                                                                                                                                                                                             | none; structural                                           |
| R13  | Only the canonical URL of a source row in the persisted selection is ever fetched. No link on a page is followed, no image, script or other subresource is requested, and nothing is crawled.                                                                                                                                                                                                  | `not_in_selection`                                         |
| R14  | Text is extracted from HTML by the worker's existing path (`apps/worker/src/editorial/html-text.ts`), dropping script and style content, and the extracted text is bounded by a character limit fixed at S0 alongside the model's context decision.                                                                                                                                            | `text_limit`                                               |
| R15  | Fetched text is hostile input. It is never logged, never echoed in an error, escaped by the repository's existing display discipline before it reaches any output, and handed to the model as quoted material inside a structured input, never as instructions. The article validator rejects any citation of a row outside the selection and any citation of a source in the "not read" list. | `citation_out_of_selection`, `citation_unread`             |
| R16  | The audit event for a fetch carries the source row identifier, the outcome code, bytes read and duration. It carries no URL, no text and no header.                                                                                                                                                                                                                                            | none; structural                                           |
| R17  | A refused or failed fetch puts the source in the generation's fixed "not read" list, shown to the owner before the model is called. The generation proceeds only on the owner's confirmation. The model is told which sources were not read and the article may not cite them.                                                                                                                 | none; behavioural                                          |

Residual risk, named: a page can carry text written to influence a model. R15 confines what
the model can cite and R17 keeps a human between generation and publication (decision D3 and
plan decision P-6), but nothing here prevents page text from shaping tone or emphasis. That is
why the owner edits before pasting.

## 3. Reason codes

The fixed vocabulary, all lower-case, none reflecting input:

`scheme_not_permitted`, `credentials_present`, `local_name`, `reserved_name`,
`loopback_address`, `private_address`, `link_local_address`, `multicast_address`,
`reserved_address`, `resolved_address_refused`, `resolution_failed`, `port_not_permitted`,
`redirect_refused`, `redirect_limit`, `redirect_downgrade`, `content_type_not_permitted`,
`body_limit`, `fetch_timeout`, `stage_timeout`, `not_in_selection`, `text_limit`,
`citation_out_of_selection`, `citation_unread`, `connection_failed`.

## 4. Threat model additions

Recorded here so that CAS-005's S7 step adds them to `docs/THREAT_MODEL.md` in its own
reviewed commit, since that document belongs to the security-foundation track and is pending
audit.

| Kind       | Id  | Entry                                                                                                                                                              |
| ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Boundary   | B12 | The article generator to publisher web servers: outbound `GET` to a URL a feed row carries. Rules R1 to R17.                                                       |
| Entry      | E11 | The canonical URL of a selected source row, as a fetch target; and the response body, as page text entering a model prompt.                                        |
| Capability | C12 | Controller of a feed URL or a stored row (C1, C2) who aims the service at an internal address, a slow or enormous response, or a page written to instruct a model. |
| Asset      | A11 | Fetched page text, third-party material under its publishers' rights, held only as section 6 O-1 decides.                                                          |

## 5. Tests the implementation must have

Each is a falsification of one rule. A missing test blocks S4.

1. Literal loopback, private, link-local, multicast and reserved addresses in every encoding
   the WHATWG parser canonicalizes (`127.1`, `0x7f000001`, `2130706433`, `[::ffff:127.0.0.1]`,
   the NAT64 prefix): refused before any socket opens.
2. A name that resolves to a private address, through an injected resolver: refused, no
   connection attempted.
3. Rebinding: the injected resolver returns a public address on first resolution and a private
   one on the next; the connection goes only to the checked address.
4. A redirect to a private address, a redirect chain of four, and an `https:` to `http:`
   redirect: each refused with its code.
5. A lying `Content-Length`, a body one byte over the bound, and a compressed body whose
   decompressed size exceeds the bound: each stops at the bound with `body_limit`.
6. A response that never completes: `fetch_timeout` at the deadline, the socket closed.
7. A `Content-Type` of `image/png` and of `application/json`: refused.
8. A URL not in the selection: refused before resolution.
9. A page whose text contains instructions to the model, in a recorded fixture: the
   generation's citations still validate, and the text appears in no log or error.
10. A source in the "not read" list cited by a recorded model response: the response is
    rejected.
11. The default test suite opens no socket; every page is a recorded fixture; the
    network-denied job passes.

## 6. Open decisions for the owner

| Id  | Decision                                                   | Options                                                                                                                                                                                                                                                                                                                                  | Recommendation and class                                                                                                                                                                                             |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-1 | Where fetched text lives, and for how long                 | (a) In memory for one generation only; the revision's provenance stores a SHA-256 digest of each extracted text, so a later run can tell that a page changed without holding its text. (b) Stored per generation with a retention period, as a new asset class needing a retention job, a data-classification entry and backup exposure. | (a). Cost judgment with a rights consideration: nothing new to protect, nothing new to retain, and regeneration re-reads the live page. Digests keep reproducibility checks without the text.                        |
| O-2 | Whether publisher terms or `robots.txt` constrain fetching | (a) Read `robots.txt` for each host once per generation under the same rules, and skip a source it disallows for the product's user agent, listing it as "not read". (b) Fetch regardless.                                                                                                                                               | (a). Preference with a reputational ground (asset A9): the product's name is in the user agent. This is not legal advice; whether publisher terms permit this use is a question for a lawyer if the owner wants one. |
| O-3 | The fixed `User-Agent` string                              | The product name, a version, and a contact address or URL.                                                                                                                                                                                                                                                                               | Owner's choice; the contact should be one the owner is willing to have on record.                                                                                                                                    |

**Decided.** O-1 was decided by the owner on 16 September 2026: option (a), memory only, with
a digest of each extracted text kept in the revision's provenance. O-3 was decided the same
day: the industry-standard form, `LatestInCyber/<version> (+<live dashboard address>)`, with the
address filled in at S0. O-2 remains open; the proposed default, pending the owner's word, is
option (a), obey.

## 7. What this document is not

It is not an implementation, and nothing in it changes an existing boundary: the MCP server
still never fetches, the Graph client still refuses every redirect, and the importer still reads
only what the operator names. It is not a legal opinion on fetching third-party pages. It
becomes binding when CAS-005 records it at S0 with the owner's answers to section 6.
