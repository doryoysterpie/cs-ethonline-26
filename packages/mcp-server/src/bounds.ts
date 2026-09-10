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
/** Longest Markdown preview a result may carry, in characters. */
export const DRAFT_MARKDOWN_MAX_CHARACTERS = 200_000;

/** Distinct chain targets one stored anomaly evaluation may read. */
export const ANOMALY_TARGETS_LIMIT = 128;

/** Display bounds for quoted evidence, in characters after escaping. */
export const HEADLINE_MAX_CHARACTERS = 300;
export const PUBLISHER_MAX_CHARACTERS = 120;
export const URL_MAX_CHARACTERS = 512;
export const IDENTITY_MAX_CHARACTERS = 120;

/** Longest string a request may carry in any argument, in characters. */
export const ARGUMENT_STRING_MAX_CHARACTERS = 64;
/** Most own keys an argument object may carry before it is refused unread. */
export const ARGUMENT_KEYS_MAX = 32;
/** Longest argument key, in characters, before the object is refused unread. */
export const ARGUMENT_KEY_MAX_CHARACTERS = 64;
/** Longest tool name a request may carry before it is refused as unknown. */
export const TOOL_NAME_MAX_CHARACTERS = 128;

/** Wall-clock budget per tool call, in milliseconds. */
export const STORED_TOOL_DEADLINE_MS = 10_000;
export const LIVE_TOOL_DEADLINE_MS = 30_000;
/** How long a cancelled call may take to unwind before its result is reported anyway. */
export const UNWIND_GRACE_MS = 5_000;
/** How long shutdown waits for aborted calls to unwind before the process exits anyway. */
export const SHUTDOWN_DEADLINE_MS = 8_000;
/** Server-side statement timeout inside every read-only transaction, in milliseconds. */
export const STATEMENT_TIMEOUT_MS = 8_000;
/** Per-request timeout of the live Graph client, in milliseconds. */
export const LIVE_REQUEST_TIMEOUT_MS = 15_000;

/** Largest serialized structured result, in UTF-8 bytes. */
export const RESULT_MAX_BYTES = 262_144;
/** Largest text an error result or a protocol error message may carry, in UTF-8 bytes. */
export const ERROR_TEXT_MAX_BYTES = 4_096;

/** Rate limit: at most this many tool calls in any window of this length. */
export const RATE_LIMIT_CALLS = 60;
export const RATE_LIMIT_WINDOW_MS = 10_000;
/** Tool calls that may be in flight at once. */
export const MAX_CONCURRENT_CALLS = 4;

/** Connections the read-only pool may open. */
export const DATABASE_MAX_CONNECTIONS = 2;
/** Connections the cancellation pool may open; a cancel never waits behind a blocked read. */
export const CANCEL_POOL_CONNECTIONS = 1;

/** Bounds on the live gateway request target, checked before any socket is opened. */
export const GATEWAY_HOST_MAX_CHARACTERS = 253;
export const GATEWAY_PATH_MAX_CHARACTERS = 512;
export const GATEWAY_URL_MAX_CHARACTERS = 1_024;
