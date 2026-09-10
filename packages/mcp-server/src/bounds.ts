/**
 * Every bound the server enforces, in one place. Each is a fixed constant:
 * nothing here is read from the environment or from a request.
 */

/** Incident summaries per `list_incidents` page. */
export const LIST_INCIDENTS_DEFAULT_LIMIT = 20;
export const LIST_INCIDENTS_MAX_LIMIT = 50;

/** Source rows and associations one `explain_incident` result may carry. */
export const EXPLAIN_SOURCES_LIMIT = 50;
export const EXPLAIN_ASSOCIATIONS_LIMIT = 100;

/** Incidents one `draft_section` preview may consider. */
export const DRAFT_INCIDENTS_DEFAULT_LIMIT = 25;
export const DRAFT_INCIDENTS_MAX_LIMIT = 100;
/**
 * Source rows the draft query fetches per incident. The drafter writes at most
 * twenty claims per incident (its contract's `maximumClaimsPerIncident`) and
 * this server derives one claim per titled source, so a twenty-first source
 * could never reach the preview; it is not fetched.
 */
export const DRAFT_SOURCES_PER_INCIDENT_LIMIT = 20;
/** Longest Markdown preview a result may carry, in characters. */
export const DRAFT_MARKDOWN_MAX_CHARACTERS = 200_000;

/** Distinct chain targets one stored anomaly evaluation may read. */
export const ANOMALY_TARGETS_LIMIT = 128;

/** Display bounds for quoted evidence, in characters after escaping. */
export const HEADLINE_MAX_CHARACTERS = 300;
export const PUBLISHER_MAX_CHARACTERS = 120;
export const URL_MAX_CHARACTERS = 512;
export const IDENTITY_MAX_CHARACTERS = 120;
/**
 * Sentinel margin the store fetches beyond each display bound, in characters.
 * The display copy never shows more than the bound, so a secret that begins
 * inside the displayed prefix must lie entirely inside the fetched fragment
 * for the redactor to match it whole; the runtime sizes the margin from the
 * longest secret it holds (three times its length, for a percent-encoded
 * form, plus a little), within these two limits. The margin also serves as
 * the truncation sentinel: a fragment shorter than the stored value proves
 * the value was cut.
 */
export const TEXT_FETCH_MARGIN_MIN_CHARACTERS = 64;
export const TEXT_FETCH_MARGIN_MAX_CHARACTERS = 512;

/** Longest string a request may carry in any argument, in characters. */
export const ARGUMENT_STRING_MAX_CHARACTERS = 64;

/** Wall-clock budget per tool call, in milliseconds. */
export const STORED_TOOL_DEADLINE_MS = 10_000;
export const LIVE_TOOL_DEADLINE_MS = 30_000;
/** Server-side statement timeout inside every read-only transaction, in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 8_000;
/** Per-request timeout of the live Graph client, in milliseconds. */
export const LIVE_REQUEST_TIMEOUT_MS = 15_000;

/** Largest serialized structured result, in UTF-8 bytes. */
export const RESULT_MAX_BYTES = 262_144;

/** Rate limit: at most this many tool calls in any window of this length. */
export const RATE_LIMIT_CALLS = 60;
export const RATE_LIMIT_WINDOW_MS = 10_000;
/** Tool calls that may be in flight at once. */
export const MAX_CONCURRENT_CALLS = 4;

/**
 * Connections one tool call may open: exactly one. Every call opens its own
 * connection, runs its one transaction on it and destroys it, so no session
 * setting, temporary object or advisory lock can survive into another call.
 */
export const DATABASE_MAX_CONNECTIONS = 1;
