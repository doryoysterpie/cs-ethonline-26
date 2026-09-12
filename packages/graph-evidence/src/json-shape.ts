import { GraphProbeError } from './errors.js';

/**
 * Bounding the shape of a JSON document before and after it is parsed.
 *
 * The byte limit on the body bounds how much text arrives; this bounds what
 * that text may become. Nesting depth is measured with a linear scan over the
 * text, aware of strings and escapes, so a document built to exhaust a
 * recursive consumer is refused before `JSON.parse` builds anything. After
 * parsing, an explicit-stack walk counts containers and their sizes, so no
 * recursion depends on the input. Every refusal is a `limit` failure with a
 * fixed message and numeric details.
 */

export interface JsonShapeLimits {
  /** Nesting depth of containers; the root container is depth 1. */
  readonly maxDepth: number;
  /** Elements of one array or members of one object. */
  readonly maxCollectionSize: number;
  /** Arrays and objects in the whole document, counted together. */
  readonly maxCollections: number;
}

export interface JsonShape {
  readonly depth: number;
  readonly collections: number;
  readonly largestCollection: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function limitError(reason: 'depth' | 'collection_size' | 'collections', limit: number) {
  const messages = {
    depth: 'gateway response exceeds the JSON nesting depth limit',
    collection_size: 'gateway response exceeds the JSON collection size limit',
    collections: 'gateway response exceeds the JSON collection count limit',
  } as const;
  return new GraphProbeError('limit', messages[reason], { reason, limit, phase: 'parse' });
}

/**
 * Deepest container nesting in the text, found without building the tree.
 * Throws at the first opening bracket deeper than `maxDepth`. Unbalanced text
 * is left to `JSON.parse` to refuse.
 */
export function scanJsonDepth(text: string, maxDepth: number): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === BACKSLASH) escaped = true;
      else if (code === QUOTE) inString = false;
      continue;
    }
    if (code === QUOTE) {
      inString = true;
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth += 1;
      if (depth > maxDepth) throw limitError('depth', maxDepth);
      if (depth > deepest) deepest = depth;
    } else if ((code === CLOSE_BRACE || code === CLOSE_BRACKET) && depth > 0) {
      depth -= 1;
    }
  }
  return deepest;
}

/** Walks a parsed value with an explicit stack and refuses any collection over the limits. */
export function assertJsonShape(value: unknown, limits: JsonShapeLimits): JsonShape {
  let collections = 0;
  let largest = 0;
  let deepest = 0;
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  for (;;) {
    const item = stack.pop();
    if (item === undefined) break;
    const current = item.value;
    if (current === null || typeof current !== 'object') continue;
    collections += 1;
    if (collections > limits.maxCollections) throw limitError('collections', limits.maxCollections);
    if (item.depth > limits.maxDepth) throw limitError('depth', limits.maxDepth);
    if (item.depth > deepest) deepest = item.depth;
    const children = Array.isArray(current)
      ? (current as unknown[])
      : Object.values(current as Record<string, unknown>);
    if (children.length > limits.maxCollectionSize) {
      throw limitError('collection_size', limits.maxCollectionSize);
    }
    if (children.length > largest) largest = children.length;
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return { depth: deepest, collections, largestCollection: largest };
}

/**
 * `JSON.parse` behind the depth scan and the shape walk. A syntax error is
 * rethrown as itself for the caller to classify; a limit is a `GraphProbeError`.
 */
export function parseJsonBounded(text: string, limits: JsonShapeLimits): unknown {
  scanJsonDepth(text, limits.maxDepth);
  const value: unknown = JSON.parse(text);
  assertJsonShape(value, limits);
  return value;
}
