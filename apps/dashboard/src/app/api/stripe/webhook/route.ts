import { recordWebhook, WEBHOOK_MAX_BYTES } from '../../../../server/dal/support.ts';
import { NO_STORE } from '../../../../server/http/headers.ts';
import { networkKey } from '../../../../server/http/network.ts';
import { getRuntime } from '../../../../server/runtime.ts';

export const dynamic = 'force-dynamic';

/**
 * Stripe's webhook endpoint (CAS-008). No session and no CSRF token: the
 * signature in `Stripe-Signature` is the authentication, checked by the
 * data-access layer against the endpoint's signing secret. The body is read
 * as bytes under a bound and never re-serialized, since the signature covers
 * the raw bytes. The response is a bare status: `200` once the event is
 * recorded or found recorded, `400` for anything that fails verification or
 * parsing, `413` for a body over the bound, `503` while the tier is not
 * configured, `500` for a failure of this service, so Stripe retries.
 * Reachable without a session (`proxy.ts` exempts `/api/*`).
 */

/** The body as text, or null once more than `limit` bytes have arrived (the rest is not read). */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function POST(request: Request): Promise<Response> {
  const headers = { 'Cache-Control': NO_STORE };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > WEBHOOK_MAX_BYTES) {
    return new Response(null, { status: 413, headers });
  }
  try {
    const runtime = await getRuntime();
    const body = await readBounded(request.body, WEBHOOK_MAX_BYTES);
    if (body === null) return new Response(null, { status: 413, headers });
    const outcome = await recordWebhook(runtime, {
      body,
      signatureHeader: request.headers.get('stripe-signature'),
      networkKey: networkKey(request.headers, runtime.config),
    });
    return new Response(null, { status: outcome.status, headers });
  } catch {
    return new Response(null, { status: 500, headers });
  }
}
