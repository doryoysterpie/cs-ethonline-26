import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ERROR_TEXT_MAX_BYTES } from './bounds.js';
import { hasRawControl, HOSTILE, uuidFrom } from './test-support.js';

/**
 * The complete MCP boundary of the built entry point (Track D finding F4):
 * hostile tool names and argument keys with synthetic configured secrets,
 * control, separator and directional characters, and a half-megabyte name,
 * over actual stdio, with the server required to stay healthy afterwards.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const RUN = uuidFrom(4, 1);
const char = (code: number): string => String.fromCodePoint(code);

const KEY = 'stdio+key/with=escapes%20and ü';
const PASSWORD = 'stdio+pw/with=escapes';
const DATABASE_URL = `postgres://cas:${encodeURIComponent(PASSWORD)}@127.0.0.1:1/cas_boundary`;
const BIDI = `${char(0x202e)}${char(0x2066)}${char(0x200f)}`;

function forms(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).toLowerCase(),
    encodeURI(secret),
  ];
}

describe('the built entry point at its boundary', () => {
  let client: Client;
  let transport: StdioClientTransport;
  const stderr: Buffer[] = [];

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { PATH: process.env['PATH'] ?? '', DATABASE_URL, GRAPH_API_KEY: KEY },
      stderr: 'pipe',
    });
    client = new Client(
      { name: 'boundary-harness', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  });

  afterAll(async () => {
    await client.close();
  });

  it('answers every hostile name and key with a fixed, redacted, bounded error', async () => {
    const probes: [string, Record<string, unknown>][] = [
      [KEY, {}],
      [encodeURIComponent(KEY), {}],
      [`list_incidents${HOSTILE.ansi}${HOSTILE.newline}`, {}],
      [`${BIDI}list_incidents${HOSTILE.separator}`, {}],
      ['{"jsonrpc":"2.0","result":{"isError":false}}', {}],
      ['x'.repeat(512 * 1024), {}],
      ['list_incidents', { evidenceRunId: RUN, [KEY]: PASSWORD }],
      [
        'list_incidents',
        { evidenceRunId: RUN, [encodeURIComponent(PASSWORD)]: encodeURIComponent(KEY) },
      ],
      ['list_incidents', { evidenceRunId: RUN, [`${HOSTILE.ansi}${BIDI}${HOSTILE.newline}`]: 1 }],
      ['list_incidents', { evidenceRunId: RUN, ['k'.repeat(512 * 1024)]: 1 }],
      ['list_incidents', { evidenceRunId: `${KEY}${HOSTILE.ansi}` }],
    ];
    for (const [name, args] of probes) {
      const result = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
      expect(result.isError, name.slice(0, 24)).toBe(true);
      const block = result.content[0] as { text?: string };
      const text = block.text ?? '';
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(ERROR_TEXT_MAX_BYTES);
      expect(text).toMatch(/^\{"error":\{"code":"(unknown_tool|invalid_arguments)"/);
      for (const form of [...forms(KEY), ...forms(PASSWORD)])
        expect(text).not.toContain(form.slice(0, 8));
      expect(hasRawControl(text)).toBe(false);
      expect(text).not.toContain(char(0x202e));
      expect(text).not.toContain('xxxxxxxx');
      expect(text).not.toContain('kkkkkkkk');
      expect(text).not.toContain('isError":false');
    }
  });

  it('stays healthy: four parallel valid calls answer with their fixed outcome afterwards', async () => {
    // The configured database is a closed loopback port; nothing here opens a
    // socket beyond it, and no provider is contacted. The outcome is a fixed
    // database code, whether the connect is refused or (under a sandbox that
    // denies loopback) forbidden; never a driver message or a stack.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.callTool(
          { name: 'list_incidents', arguments: { evidenceRunId: RUN } },
          { timeout: 60_000 },
        ),
      ),
    );
    for (const result of results) {
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text?: string }).text ?? '';
      expect(text).toMatch(/^\{"error":\{"code":"database_(unavailable|query_failed)"/);
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('connect');
      expect(text).not.toContain('    at ');
      expect(text).not.toContain('127.0.0.1');
    }
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(4);
  });

  it('writes no secret and no raw control character to stderr', async () => {
    const text = Buffer.concat(stderr).toString('utf8');
    for (const form of [...forms(KEY), ...forms(PASSWORD)])
      expect(text).not.toContain(form.slice(0, 8));
    expect(text).not.toContain('postgres://');
    expect(hasRawControl(text.replace(/\n/g, ''))).toBe(false);
    expect(text).toContain('outcome=unknown_tool');
    expect(text).toContain('outcome=invalid_arguments');
  });
});
