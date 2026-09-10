import * as z from 'zod/v4';

import { ARGUMENT_STRING_MAX_CHARACTERS } from './bounds.js';
import { ToolError, type SafeDetail } from './safety/errors.js';
import { hasControlCharacter } from './safety/text.js';

/**
 * The hardened argument boundary, applied before any argument value is read.
 *
 * The MCP SDK validates arguments against the same strict schema before a
 * handler runs, and a JSON-RPC message can only ever produce a plain object.
 * This check exists for the other entry: the exported `invokeTool` function
 * can be handed any JavaScript value, and the audited packages in this
 * repository were each asked to close that door. So, in order:
 *
 *   1. the value must be a plain object whose prototype is `Object.prototype`
 *      or null; arrays, functions and class instances are refused;
 *   2. it may carry no symbol key;
 *   3. every own property name must be in the tool's allowlist, read with
 *      `getOwnPropertyNames` so a non-enumerable key cannot hide;
 *   4. every property must be a data descriptor: an accessor is refused
 *      before it can run;
 *   5. every value must be a primitive; a nested object or array is refused,
 *      because no tool takes one;
 *   6. every string is bounded and may carry no C0, DEL, C1, U+2028 or
 *      U+2029 character, so a traversal string, an ANSI sequence or a line
 *      separator never reaches a schema message;
 *   7. only then does the schema run.
 *
 * A rejection names the rule and, for a schema failure, the argument name
 * from the allowlist. It never echoes a value.
 */

export const ARGUMENT_REJECTIONS = {
  notPlainObject: 'not_plain_object',
  prototypeNotPlain: 'prototype_not_plain',
  symbolKey: 'symbol_key',
  unexpectedKey: 'unexpected_key',
  accessorProperty: 'accessor_property',
  nonPrimitiveValue: 'non_primitive_value',
  stringTooLong: 'string_too_long',
  controlCharacter: 'control_character',
  schemaViolation: 'schema_violation',
} as const;
export type ArgumentRejection = (typeof ARGUMENT_REJECTIONS)[keyof typeof ARGUMENT_REJECTIONS];

function reject(reason: ArgumentRejection, extra: Record<string, SafeDetail> = {}): never {
  throw new ToolError('invalid_arguments', { reason, ...extra });
}

const ISSUE_PHRASES: Readonly<Record<string, string>> = {
  invalid_type: 'wrong type',
  invalid_format: 'malformed',
  too_small: 'out of bounds',
  too_big: 'out of bounds',
  invalid_value: 'not an allowed value',
  unrecognized_keys: 'unexpected key',
  custom: 'rejected by a cross-field rule',
};

/** The own property names a strict object schema admits. */
export function allowedArgumentNames(schema: z.ZodType): ReadonlySet<string> {
  const inner = schema as unknown as {
    shape?: Record<string, unknown>;
    def?: { shape?: Record<string, unknown> };
  };
  const shape = inner.shape ?? inner.def?.shape ?? unwrapShape(schema);
  return new Set(Object.keys(shape ?? {}));
}

function unwrapShape(schema: z.ZodType): Record<string, unknown> | undefined {
  // A schema wrapped by a pipe or a transform exposes its object through the
  // inner definition; a plain object exposes its shape directly.
  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  const inner = def?.['innerType'] as { shape?: Record<string, unknown> } | undefined;
  if (inner?.shape !== undefined) return inner.shape;
  const type = def?.['type'];
  if (type === 'object' && typeof def?.['shape'] === 'object' && def['shape'] !== null) {
    return def['shape'] as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Enforces the boundary above, then parses. Returns the schema's output,
 * with defaults applied.
 */
export function validateArguments<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw === 'function') {
    reject(ARGUMENT_REJECTIONS.notPlainObject);
  }
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    reject(ARGUMENT_REJECTIONS.prototypeNotPlain);
  }
  if (Object.getOwnPropertySymbols(raw).length > 0) reject(ARGUMENT_REJECTIONS.symbolKey);

  const allowed = allowedArgumentNames(schema);
  const record = raw as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(record);
  for (const name of names) {
    if (!allowed.has(name)) reject(ARGUMENT_REJECTIONS.unexpectedKey);
  }
  // Descriptors are inspected before any value is read, so an accessor is
  // refused rather than invoked.
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      reject(ARGUMENT_REJECTIONS.accessorProperty, { argument: name });
    }
  }
  const plain: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (value === undefined) continue;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      reject(ARGUMENT_REJECTIONS.nonPrimitiveValue, { argument: name });
    }
    if (typeof value === 'string') {
      if (value.length > ARGUMENT_STRING_MAX_CHARACTERS) {
        reject(ARGUMENT_REJECTIONS.stringTooLong, { argument: name });
      }
      if (hasControlCharacter(value))
        reject(ARGUMENT_REJECTIONS.controlCharacter, { argument: name });
    }
    plain[name] = value;
  }

  const parsed = schema.safeParse({ ...plain });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const argument = first?.path[0];
    const name = typeof argument === 'string' && allowed.has(argument) ? argument : null;
    reject(ARGUMENT_REJECTIONS.schemaViolation, {
      argument: name,
      problem: ISSUE_PHRASES[first?.code ?? ''] ?? 'rejected',
      ...(first?.code === 'custom' &&
      typeof first.message === 'string' &&
      first.message.length <= 64
        ? { rule: first.message }
        : {}),
    });
  }
  return parsed.data as z.output<S>;
}
