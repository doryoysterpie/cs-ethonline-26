import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';

import { createCasMcpServer } from './server.js';
import {
  FakeStore,
  SECRET_API_KEY,
  SECRET_DATABASE_URL,
  testRuntime,
  uuidFrom,
} from './test-support.js';

/**
 * The stdio boundary: the built entry point as a child process for lifecycle
 * and secrecy, and the transport over in-process pipes for framing. No socket
 * is opened anywhere; a pipe is not a network.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const RUN = uuidFrom(4, 1);

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function exitOf(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const outcome = await Promise.race([exited, timer]);
  if (outcome === 'timeout') throw new Error('the server did not exit in time');
  return outcome;
}

describe('the built stdio entry point', () => {
  it('serves the catalogue, answers without a database, and exits when the client disconnects', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    });
    const stderrChunks: Buffer[] = [];
    const client = new Client(
      { name: 'cas-stdio-harness', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'list_incidents',
        'explain_incident',
        'chain_anomalies',
        'draft_section',
      ]);
      const result = await client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN },
      });
      expect(result.isError).toBe(true);
      const first = result.content[0] as { text?: string };
      expect(JSON.parse(first.text ?? '{}')).toMatchObject({
        error: { code: 'database_not_configured' },
      });
      const live = await client.callTool({
        name: 'chain_anomalies',
        arguments: { mode: 'live', chain: 'base' },
      });
      expect(live.isError).toBe(true);
      expect((live.content[0] as { text?: string }).text).toContain('graph_credential_missing');
    } finally {
      await client.close();
    }
    // Closing the client closes stdin; the server must exit on its own.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid as number, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(() => process.kill(pid as number, 0)).toThrow();
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    expect(stderr).toContain(
      'cas-mcp-server ready transport=stdio database=absent graph_credential=absent mode=production database_role=absent',
    );
  });

  it('refuses an unknown mode with a fixed line, exit code 2, and no echo', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: { PATH: process.env['PATH'] ?? '', CAS_MCP_MODE: 'staging-secret-name' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const code = await exitOf(child);
    expect(code).toBe(2);
    const stderr = Buffer.concat(err).toString('utf8');
    expect(stderr).toContain('failed to start');
    expect(stderr).not.toContain('staging');
  });

  it('keeps stdout for protocol messages only and never writes a secret to stderr', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: SECRET_DATABASE_URL,
        GRAPH_API_KEY: SECRET_API_KEY,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // A modern client opens with server/discover; a well-formed request line is enough to prove framing.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.stdin.end();
    const code = await exitOf(child);
    expect(code).toBe(0);
    const stdout = Buffer.concat(out).toString('utf8');
    for (const line of stdout.split('\n').filter((l) => l.length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    }
    const stderr = Buffer.concat(err).toString('utf8');
    expect(stderr).toContain('database=configured graph_credential=configured');
    // The seed URL names no reachable role: the start-up check reports the
    // role unverified with a fixed reason, and every stored call would verify
    // again on its own connection before reading.
    expect(stderr).toContain('database role unverified reason=database_unavailable');
    expect(stderr).toContain('database_role=unverified');
    expect(stderr).not.toContain(SECRET_API_KEY);
    expect(stderr).not.toContain('seedpassword');
    expect(stderr).not.toContain('postgres://');
  });

  it('exits on SIGINT and on SIGTERM with the documented codes', async () => {
    for (const [signal, expected] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const child = spawn(process.execPath, [BIN], {
        env: { PATH: process.env['PATH'] ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const err: Buffer[] = [];
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      // Signal only once the process has announced readiness, so the handlers are installed.
      await waitFor(() => Buffer.concat(err).toString('utf8').includes('cas-mcp-server ready'));
      child.kill(signal);
      const code = await exitOf(child);
      expect(code).toBe(expected);
      expect(Buffer.concat(err).toString('utf8')).toContain(
        `shutdown reason=${signal.toLowerCase()}`,
      );
    }
  });

  it('refuses to start on a rejected configuration without echoing it', async () => {
    const child = spawn(process.execPath, [BIN], {
      env: {
        PATH: process.env['PATH'] ?? '',
        GRAPH_API_KEY: SECRET_API_KEY,
        GRAPH_GATEWAY_URL: 'http://insecure.example/api',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    const code = await exitOf(child);
    expect(code).toBe(2);
    const stderr = Buffer.concat(err).toString('utf8');
    expect(stderr).toContain('failed to start');
    expect(stderr).not.toContain('insecure.example');
    expect(stderr).not.toContain(SECRET_API_KEY);
  });
});

describe('the stdio transport over in-process pipes', () => {
  it('survives a garbage line, answers valid frames, and writes newline-delimited JSON only', async () => {
    const { runtime } = testRuntime({ store: new FakeStore() });
    const server = createCasMcpServer(runtime);
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const transport = new StdioServerTransport(input, output);
    await server.connect(transport);
    input.write('this is not json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
    input.write(
      '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"list_incidents","arguments":{"evidenceRunId":"x"}}}\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const lines = written
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc: string; id?: unknown };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    const ids = lines.map((line) => (JSON.parse(line) as { id?: unknown }).id);
    expect(ids).toContain(7);
    await server.close();
  });
});
