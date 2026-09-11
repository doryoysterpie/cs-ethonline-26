import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import { ERROR_TEXT_MAX_BYTES } from './bounds.js';
import { createRedactor } from './safety/redact.js';
import {
  connectInMemory,
  FakeStore,
  hasRawControl,
  HOSTILE,
  SECRET_API_KEY,
  SECRET_DATABASE_URL,
  SECRET_PASSWORD,
  textOf,
  uuidFrom,
} from './test-support.js';
import { applyOutboundPolicy, fixedErrorMessage, sanitizeErrorText } from './transport/policy.js';

/**
 * The outbound error boundary (Track D finding F4), in process: the pure
 * policy, and the SDK's own protocol errors passing through it over the
 * in-memory transport. The compiled stdio cases are in
 * `boundary.stdio.test.ts`.
 */

const RUN = uuidFrom(4, 1);
const char = (code: number): string => String.fromCodePoint(code);
const BIDI = `${char(0x202e)}reversed${char(0x2066)}iso${char(0x2069)}`;

describe('the pure policy', () => {
  const redact = createRedactor([SECRET_API_KEY]);

  it('replaces every error message with the fixed one for its code and drops data', () => {
    const message = {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32601,
        message: `Tool ${SECRET_API_KEY} not found`,
        data: { echo: SECRET_API_KEY },
      },
    } as unknown as JSONRPCMessage;
    const out = applyOutboundPolicy(message, redact) as unknown as {
      error: { code: number; message: string; data?: unknown };
    };
    expect(out.error).toEqual({ code: -32601, message: 'method not found' });
    for (const code of [-32700, -32600, -32602, -32603, -32001, -1]) {
      expect(typeof fixedErrorMessage(code)).toBe('string');
      expect(fixedErrorMessage(code)).not.toContain(String(code));
    }
  });

  it('keeps the supported protocol versions a client needs, and nothing else', () => {
    const message = {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32003,
        message: 'Unsupported protocol version: hostile',
        data: { supported: ['2026-07-28'], requested: 'hostile' },
      },
    } as unknown as JSONRPCMessage;
    const out = applyOutboundPolicy(message, redact) as unknown as {
      error: Record<string, unknown>;
    };
    expect(out.error).toEqual({
      code: -32003,
      message: 'request refused',
      data: { supported: ['2026-07-28'] },
    });
  });

  it('sanitizes and bounds the text of an error result and leaves a success alone', () => {
    const text = `${SECRET_API_KEY} ${HOSTILE.ansi} ${HOSTILE.newline} ${BIDI} ${'x'.repeat(10_000)}`;
    const out = sanitizeErrorText(text, redact);
    expect(out).not.toContain(SECRET_API_KEY);
    expect(hasRawControl(out)).toBe(false);
    expect(out).not.toContain(char(0x202e));
    expect(out).toContain('\\u202e');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(ERROR_TEXT_MAX_BYTES);
    expect(out).toMatch(/…\[\+\d+ chars\]$/);
    const errorResult = {
      jsonrpc: '2.0',
      id: 2,
      result: { isError: true, content: [{ type: 'text', text }] },
    } as unknown as JSONRPCMessage;
    const sanitized = applyOutboundPolicy(errorResult, redact) as unknown as {
      result: { content: { text: string }[] };
    };
    expect(sanitized.result.content[0]?.text).toBe(out);
    const success = {
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text }], structuredContent: { text } },
    } as unknown as JSONRPCMessage;
    expect(applyOutboundPolicy(success, redact)).toBe(success);
  });
});

describe('the SDK boundary over the in-memory transport', () => {
  it('answers hostile names and keys with fixed, redacted, bounded errors and stays healthy', async () => {
    const harness = await connectInMemory({
      store: new FakeStore(),
      env: { DATABASE_URL: SECRET_DATABASE_URL, GRAPH_API_KEY: SECRET_API_KEY },
    });
    try {
      const probes: [string, Record<string, unknown>][] = [
        [SECRET_API_KEY, {}],
        [`list_incidents${HOSTILE.ansi}`, {}],
        [`${HOSTILE.newline}${BIDI}`, {}],
        ['x'.repeat(512 * 1024), {}],
        ['list_incidents', { evidenceRunId: RUN, [SECRET_API_KEY]: 1 }],
        ['list_incidents', { evidenceRunId: RUN, [`${HOSTILE.ansi}${BIDI}`]: SECRET_PASSWORD }],
        ['list_incidents', { evidenceRunId: RUN, ['k'.repeat(100_000)]: 1 }],
        ['list_incidents', Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]))],
      ];
      for (const [name, args] of probes) {
        const result = await harness.client.callTool({ name, arguments: args });
        expect(result.isError, name.slice(0, 20)).toBe(true);
        const text = textOf(result);
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(ERROR_TEXT_MAX_BYTES);
        expect(text).not.toContain(SECRET_API_KEY);
        expect(text).not.toContain(SECRET_PASSWORD);
        expect(hasRawControl(text)).toBe(false);
        expect(text).not.toContain(char(0x202e));
        expect(text).not.toContain('xxxxxxxx');
        expect(text).not.toContain('kkkkkkkk');
        expect(text).toMatch(/"code":"(unknown_tool|invalid_arguments)"/);
      }
      for (const line of harness.logs) {
        expect(line).not.toContain(SECRET_API_KEY);
        expect(line).not.toContain(SECRET_PASSWORD);
        expect(line).not.toContain('xxxxxxxx');
        expect(hasRawControl(line)).toBe(false);
      }
      // Valid calls remain healthy after the malformed ones, in parallel.
      const healthy = await Promise.all(
        Array.from({ length: 4 }, () =>
          harness.client.callTool({ name: 'list_incidents', arguments: { evidenceRunId: RUN } }),
        ),
      );
      for (const result of healthy) expect(result.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('gives SDK-generated protocol errors the fixed vocabulary', async () => {
    const harness = await connectInMemory({
      store: new FakeStore(),
      env: { GRAPH_API_KEY: SECRET_API_KEY },
    });
    try {
      const received: JSONRPCMessage[] = [];
      const original = harness.clientTransport.onmessage;
      harness.clientTransport.onmessage = (message, extra) => {
        received.push(message);
        original?.(message, extra);
      };
      const probes: JSONRPCMessage[] = [
        { jsonrpc: '2.0', id: 9001, method: `tools/${SECRET_API_KEY}`, params: {} },
        {
          jsonrpc: '2.0',
          id: 9002,
          method: 'tools/call',
          params: { name: 'list_incidents', arguments: `${SECRET_API_KEY}${HOSTILE.ansi}` },
        },
        { jsonrpc: '2.0', id: 9003, method: 'tools/call', params: { name: 42 } },
        {
          jsonrpc: '2.0',
          id: 9004,
          method: 'resources/read',
          params: { uri: `file:///${SECRET_API_KEY}` },
        },
      ] as unknown as JSONRPCMessage[];
      for (const probe of probes) await harness.clientTransport.send(probe);
      const until = Date.now() + 3_000;
      while (received.filter((m) => 'error' in m).length < probes.length && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const errors = received.filter((m) => 'error' in m) as unknown as {
        id: number;
        error: { code: number; message: string; data?: unknown };
      }[];
      expect(errors.map((e) => e.id).sort()).toEqual([9001, 9002, 9003, 9004]);
      for (const error of errors) {
        expect([
          'method not found',
          'invalid params',
          'internal error',
          'request refused',
        ]).toContain(error.error.message);
        expect(error.error.data).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(SECRET_API_KEY);
        expect(hasRawControl(JSON.stringify(error))).toBe(false);
      }
      const healthy = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN },
      });
      expect(healthy.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  });
});
