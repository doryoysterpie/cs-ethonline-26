import { validation, type DashboardError } from './errors.ts';

/**
 * Closed input validation for every server action and route handler.
 *
 * The pattern is the one `@cas/classification` and `@cas/clustering` settled
 * on: a plain object whose own string keys are exactly the declared set,
 * with no symbol keys, no accessor properties and no prototype other than
 * `Object.prototype` or `null`. Anything else is refused whatever it is
 * called. A refusal names a fixed code and never echoes a key or a value.
 *
 * Field parsers below return the validated value or throw the same kind of
 * error. They never normalise silently: a value is accepted as supplied or
 * refused.
 */

export type ClosedRecord<K extends string> = Readonly<Record<K, unknown>>;

/** The server-action bookkeeping fields Next appends to a submitted form. */
const FRAMEWORK_FIELD = /^\$ACTION_/u;

/**
 * Reads a `FormData` or a JSON body into a plain record with exactly the
 * declared keys. Missing keys are present with `undefined`; a parser decides
 * whether that is acceptable. Unknown keys are refused.
 */
export function readClosedObject<K extends string>(
  value: unknown,
  keys: readonly K[],
): ClosedRecord<K> {
  const allowed = new Set<string>(keys);
  const out: Record<string, unknown> = {};
  if (value instanceof FormData) {
    for (const key of value.keys()) {
      // Next adds its own `$ACTION_ID_…`, `$ACTION_REF_…` and `$ACTION_…:…`
      // fields to every server-action form; they name the action, carry no
      // user data, and are consumed by the framework before the action runs.
      if (FRAMEWORK_FIELD.test(key)) continue;
      if (!allowed.has(key))
        throw validation('unknown_field', 'the request carries an unknown field');
      const all = value.getAll(key);
      if (all.length !== 1)
        throw validation('repeated_field', 'a field was supplied more than once');
      out[key] = all[0];
    }
  } else {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw validation('not_an_object', 'the request body must be an object');
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw validation('foreign_prototype', 'the request body has an unexpected prototype');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw validation('symbol_key', 'the request body carries a symbol key');
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!allowed.has(key))
        throw validation('unknown_field', 'the request carries an unknown field');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw validation('accessor_field', 'the request body carries an accessor property');
      }
      out[key] = descriptor.value;
    }
  }
  for (const key of keys) if (!(key in out)) out[key] = undefined;
  return out as ClosedRecord<K>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A lower-case UUID. */
export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw validation(`${field}_invalid`, `${field} must be a UUID`);
  }
  return value;
}

/** A lower-case UUID, or `null` for an absent or empty value. */
export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, field);
}

/** One of a closed set of strings. */
export function enumOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throw validation(`${field}_invalid`, `${field} must be one of the permitted values`);
}

const char = (code: number): string => String.fromCodePoint(code);
const CONTROL = new RegExp(
  `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`,
  'u',
);

/**
 * A bounded string that carries no control character. The bound is in code
 * units, matching PostgreSQL's `length()` on the stored value.
 */
export function boundedText(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): string {
  if (typeof value !== 'string') throw validation(`${field}_invalid`, `${field} must be text`);
  if (value.length < bounds.min || value.length > bounds.max) {
    throw validation(
      `${field}_length`,
      `${field} must be between ${bounds.min} and ${bounds.max} characters`,
    );
  }
  if (CONTROL.test(value)) {
    throw validation(`${field}_control`, `${field} must not contain a control character`);
  }
  return value;
}

/** `boundedText`, or `null` when the value is absent or empty. */
export function optionalText(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, field, bounds);
}

/** A whole number within an inclusive range, given as a number or a decimal string. */
export function integer(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d{1,15}$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw validation(`${field}_invalid`, `${field} must be a whole number in range`);
  }
  return parsed;
}

/** A strict RFC 3339 instant in UTC, returned in canonical form. */
export function instant(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/u.test(value)
  ) {
    throw validation(
      `${field}_invalid`,
      `${field} must be a UTC instant such as 2026-09-14T00:00:00Z`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw validation(
      `${field}_invalid`,
      `${field} must be a UTC instant such as 2026-09-14T00:00:00Z`,
    );
  }
  return new Date(parsed).toISOString();
}

/** `instant`, or `null` when absent or empty. */
export function optionalInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return instant(value, field);
}

/** A bounded list of distinct UUIDs, supplied as a JSON array or a comma-separated string. */
export function uuidList(value: unknown, field: string, max: number): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [];
  if (raw.length === 0)
    throw validation(`${field}_empty`, `${field} must name at least one identifier`);
  if (raw.length > max)
    throw validation(`${field}_too_many`, `${field} names more identifiers than permitted`);
  const ids = raw.map((entry) => uuid(entry, field));
  if (new Set(ids).size !== ids.length) {
    throw validation(`${field}_repeated`, `${field} names an identifier more than once`);
  }
  return ids;
}

export type Validator<T> = (value: unknown) => T;

/** Wraps a thrown error so a caller can distinguish validation from anything else. */
export function isValidationError(error: unknown): error is DashboardError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'validation'
  );
}
