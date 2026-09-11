import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/server';

import { ERROR_TEXT_MAX_BYTES } from '../bounds.js';
import type { Redactor } from '../safety/redact.js';
import { toSingleLineWithoutDirection } from '../safety/text.js';

/**
 * The outbound error policy at the transport boundary (Track D finding F4).
 *
 * The SDK builds some responses itself: a protocol error for an unknown
 * method, a malformed request or a handler that threw, and it copies the
 * thrown message into the wire error. This wrapper sits between the SDK and
 * the real transport so that every outbound message passes one fixed policy
 * before it is written:
 *
 *   - a JSON-RPC error keeps its code and receives the fixed message for that
 *     code; its `data` is dropped except the list of supported protocol
 *     versions a client needs to negotiate, which is server-owned;
 *   - an `isError` tool result has each text block redacted, rendered as one
 *     line with control, separator and directional characters escaped, and
 *     bounded in UTF-8 bytes with a visible marker.
 *
 * Nothing inbound is altered: the wrapper forwards every message to the SDK
 * unchanged, because the tools/call handler this server installs already
 * refuses hostile names and arguments without reflecting them.
 */

const FIXED_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  [-32700]: 'parse error',
  [-32600]: 'invalid request',
  [-32601]: 'method not found',
  [-32602]: 'invalid params',
  [-32603]: 'internal error',
};

export function fixedErrorMessage(code: number): string {
  return FIXED_ERROR_MESSAGES[code] ?? 'request refused';
}

/** Redacts, escapes and bounds one text field of an error result. */
export function sanitizeErrorText(text: string, redact: Redactor): string {
  const escaped = toSingleLineWithoutDirection(redact(text));
  if (Buffer.byteLength(escaped, 'utf8') <= ERROR_TEXT_MAX_BYTES) return escaped;
  let cut = escaped;
  while (Buffer.byteLength(cut, 'utf8') > ERROR_TEXT_MAX_BYTES - 32) cut = cut.slice(0, -1);
  return `${cut}…[+${escaped.length - cut.length} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Applies the outbound policy to one message. Pure; the input is never mutated. */
export function applyOutboundPolicy(message: JSONRPCMessage, redact: Redactor): JSONRPCMessage {
  const raw = message as unknown as Record<string, unknown>;
  if (isRecord(raw['error'])) {
    const error = raw['error'];
    const code = typeof error['code'] === 'number' ? error['code'] : -32603;
    const data = isRecord(error['data']) ? error['data'] : undefined;
    const supported =
      data !== undefined && Array.isArray(data['supported']) ? data['supported'] : undefined;
    return {
      ...raw,
      error: {
        code,
        message: fixedErrorMessage(code),
        ...(supported === undefined ? {} : { data: { supported } }),
      },
    } as unknown as JSONRPCMessage;
  }
  if (isRecord(raw['result'])) {
    const result = raw['result'];
    if (result['isError'] === true && Array.isArray(result['content'])) {
      const content = result['content'].map((block: unknown) =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
          ? { ...block, text: sanitizeErrorText(block['text'], redact) }
          : block,
      );
      return { ...raw, result: { ...result, content } } as unknown as JSONRPCMessage;
    }
  }
  return message;
}

export interface PolicyTransportOptions {
  readonly redact: Redactor;
}

/** A transport decorator that applies the outbound policy to every message it writes. */
export class PolicyTransport implements Transport {
  readonly #inner: Transport;
  readonly #redact: Redactor;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];

  constructor(inner: Transport, options: PolicyTransportOptions) {
    this.#inner = inner;
    this.#redact = options.redact;
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId;
  }

  async start(): Promise<void> {
    this.#inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    this.#inner.onclose = () => this.onclose?.();
    this.#inner.onerror = (error) => this.onerror?.(error);
    await this.#inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.#inner.send(applyOutboundPolicy(message, this.#redact), options);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}
