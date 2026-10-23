import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signatures, verified as Stripe documents the manual
 * procedure (docs.stripe.com/webhooks, "Verify manually", read 22 October
 * 2026): the `Stripe-Signature` header carries `t=<unix seconds>` and one or
 * more `v1=<hex>` elements; the signed payload is `<t>.<raw body>`; the
 * signature is HMAC-SHA256 under the endpoint's signing secret; every scheme
 * but `v1` is ignored; the timestamp must lie within a tolerance of the
 * clock, five minutes by Stripe's default and here.
 *
 * Pure: the clock is a parameter. Nothing here logs, and nothing here reads
 * the body as anything but bytes.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** A header longer than this is malformed on its face; Stripe's are a few hundred bytes. */
const HEADER_MAX_LENGTH = 4_096;
const TIMESTAMP_SHAPE = /^[0-9]{1,12}$/u;
const SIGNATURE_SHAPE = /^[0-9a-f]{64}$/u;

export type SignatureVerdict = 'ok' | 'malformed' | 'mismatch' | 'stale';

export interface ParsedSignature {
  readonly timestamp: number;
  /** Every `v1` signature in the header; more than one appears while a secret is being rolled. */
  readonly signatures: readonly string[];
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (header.length === 0 || header.length > HEADER_MAX_LENGTH) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const element of header.split(',')) {
    const separator = element.indexOf('=');
    if (separator < 0) return null;
    const prefix = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (prefix === 't') {
      if (timestamp !== null || !TIMESTAMP_SHAPE.test(value)) return null;
      timestamp = Number(value);
    } else if (prefix === 'v1') {
      if (!SIGNATURE_SHAPE.test(value)) return null;
      signatures.push(value);
    }
    // Any other scheme (Stripe's test-only `v0` among them) is discarded.
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** The signature Stripe would produce: used by verification and by tests building vectors. */
export function signPayload(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
}

export interface VerifyInput {
  readonly payload: string;
  readonly header: string | null;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number | undefined;
}

/**
 * The verdict for one delivery. The signature is compared before the
 * timestamp, as Stripe's own libraries do, and every comparison is constant
 * time over equal-length digests.
 */
export function verifySignature(input: VerifyInput): SignatureVerdict {
  if (input.header === null) return 'malformed';
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) return 'malformed';
  const expected = Buffer.from(signPayload(input.secret, parsed.timestamp, input.payload), 'hex');
  let matched = false;
  for (const candidate of parsed.signatures) {
    const given = Buffer.from(candidate, 'hex');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return 'mismatch';
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - parsed.timestamp) > tolerance) return 'stale';
  return 'ok';
}
