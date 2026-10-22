/**
 * The fixed vocabulary of the fetch policy (docs/FETCH-POLICY.md, section 3),
 * plus the codes CAS-005 added at S0 with their reasons recorded in
 * docs/CAS-005-REPORT.md, section 1.4: `malformed` (the classifier's own
 * verdict for a URL that does not parse), `robots_disallowed` and
 * `robots_unavailable` (the obey decision, O-2), `content_encoding_not_permitted`
 * (a body in an encoding the reader cannot bound) and `status_not_ok` (a
 * response that is not a page). No code ever reflects input.
 */
export const READ_CODES = [
  'malformed',
  'scheme_not_permitted',
  'credentials_present',
  'local_name',
  'reserved_name',
  'loopback_address',
  'private_address',
  'link_local_address',
  'multicast_address',
  'reserved_address',
  'resolved_address_refused',
  'resolution_failed',
  'port_not_permitted',
  'redirect_refused',
  'redirect_limit',
  'redirect_downgrade',
  'content_type_not_permitted',
  'content_encoding_not_permitted',
  'status_not_ok',
  'body_limit',
  'fetch_timeout',
  'stage_timeout',
  'not_in_selection',
  'text_limit',
  'robots_disallowed',
  'robots_unavailable',
  'connection_failed',
] as const;
export type ReadCode = (typeof READ_CODES)[number];

export class ReadError extends Error {
  constructor(
    readonly code: ReadCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReadError';
  }
}

export function isReadError(error: unknown): error is ReadError {
  return error instanceof ReadError;
}
