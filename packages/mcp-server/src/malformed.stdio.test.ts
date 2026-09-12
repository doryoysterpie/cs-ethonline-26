import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SECRET_API_KEY, SECRET_DATABASE_URL } from './test-support.js';

/**
 * Every request gets exactly one answer (Track D re-audit finding L4).
 *
 * The pinned SDK validates a line against the base message shape and discards
 * it before any handler runs, so a request whose `params` is not an object
 * used to receive nothing at all and a conforming client waited for its own
 * timeout. The entry point now filters stdin ahead of the SDK and answers
 * those itself. This drives the built binary over real pipes and counts the
 * responses, because the defect is invisible to an in-process harness.
 *
 * No socket is opened: a pipe is not a network, and the configured database
 * address is never reachable. Hostile strings are built from code points so
 * this file holds no control byte.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const char = (code: number): string => String.fromCodePoint(code);

interface Wire {
  readonly responses: readonly Record<string, unknown>[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Writes every line to the built entry point and collects what comes back. */
async function exchange(lines: readonly string[]): Promise<Wire> {
  const child: ChildProcess = spawn(process.execPath, [BIN], {
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: SECRET_DATABASE_URL,
      GRAPH_API_KEY: SECRET_API_KEY,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  for (const line of lines) child.stdin?.write(`${line}\n`);
  // The last line is a valid request; its answer proves the exchange is done.
  const deadline = Date.now() + 20_000;
  const answered = (): boolean => Buffer.concat(out).toString('utf8').includes('"id":99');
  while (!answered() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.stdin?.end();
  const exitCode = await Promise.race([
    once(child, 'exit').then(([code]) => code as number | null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  const stdout = Buffer.concat(out).toString('utf8');
  const responses = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { responses, stdout, stderr: Buffer.concat(err).toString('utf8'), exitCode };
}

const HEALTH = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' });

function errorCodeOf(wire: Wire, id: number): number | 'result' | 'none' | 'duplicate' {
  const matching = wire.responses.filter((message) => message['id'] === id);
  if (matching.length === 0) return 'none';
  if (matching.length > 1) return 'duplicate';
  const first = matching[0] as { error?: { code?: number }; result?: unknown };
  if (first.error !== undefined) return first.error.code ?? 'none';
  return 'result';
}

describe('a malformed request is answered, never dropped', () => {
  it('answers every invalid params shape with one fixed -32602 and stays healthy', async () => {
    const cases: readonly [string, unknown][] = [
      ['string', 'not-an-object'],
      ['array', []],
      ['number', 42],
      ['null', null],
      ['boolean', true],
      ['oversized string', 'x'.repeat(512 * 1024)],
    ];
    const lines = cases.map(([, params], index) =>
      JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params }),
    );
    const wire = await exchange([...lines, HEALTH]);
    cases.forEach(([label], index) => {
      expect(errorCodeOf(wire, index + 1), label).toBe(-32602);
    });
    expect(errorCodeOf(wire, 99)).toBe('result');
    expect(wire.exitCode).toBe(0);
  }, 60_000);

  it('keeps the existing answers for shapes the SDK already handled', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', arguments: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { arguments: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'no/such/method', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
      HEALTH,
    ];
    const wire = await exchange(lines);
    expect(errorCodeOf(wire, 1), 'params omitted').toBe(-32602);
    expect(errorCodeOf(wire, 2), 'stray top-level member').toBe(-32600);
    expect(errorCodeOf(wire, 3), 'object without name').toBe(-32602);
    expect(errorCodeOf(wire, 4), 'unknown method').toBe(-32601);
    expect(errorCodeOf(wire, 5), 'valid call').toBe('result');
    expect(errorCodeOf(wire, 99)).toBe('result');
  }, 60_000);

  it('answers a malformed request shape with -32600', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 42, params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: '', params: {} }),
      HEALTH,
    ];
    const wire = await exchange(lines);
    expect(errorCodeOf(wire, 1), 'wrong jsonrpc version').toBe(-32600);
    expect(errorCodeOf(wire, 2), 'method not a string').toBe(-32600);
    expect(errorCodeOf(wire, 3), 'empty method').toBe(-32600);
    expect(errorCodeOf(wire, 99)).toBe('result');
  }, 60_000);

  it('never answers a notification, whatever its params', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: 'not-an-object' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: [] }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'tools/call', params: 'x' }),
      HEALTH,
    ];
    const wire = await exchange(lines);
    const idless = wire.responses.filter(
      (message) => message['id'] === undefined || message['id'] === null,
    );
    expect(idless).toEqual([]);
    expect(errorCodeOf(wire, 99)).toBe('result');
  }, 60_000);

  it('reflects no caller value, leaks no secret and stays within the response bound', async () => {
    const hostile = `${'x'.repeat(4096)}${char(0x1b)}[31m${char(0x202e)}`;
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: hostile }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: [hostile] }),
      HEALTH,
    ];
    const wire = await exchange(lines);
    expect(errorCodeOf(wire, 1)).toBe(-32602);
    expect(errorCodeOf(wire, 2)).toBe(-32602);
    expect(wire.stdout).not.toContain('x'.repeat(1000));
    expect(wire.stdout).not.toContain(char(0x1b));
    expect(wire.stdout).not.toContain(char(0x202e));
    expect(wire.stdout).not.toContain(SECRET_API_KEY);
    expect(wire.stdout).not.toContain('seedpassword');
    expect(wire.stdout).not.toContain('postgres://');
    expect(wire.stderr).not.toContain(SECRET_API_KEY);
    expect(wire.stderr).not.toContain('seedpassword');
    for (const message of wire.responses) {
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThan(256 * 1024);
    }
    // Fixed messages only: no caller text is echoed into one.
    const messages = wire.responses
      .filter((message) => message['error'] !== undefined)
      .map((message) => (message['error'] as { message?: string }).message);
    expect(new Set(messages)).toEqual(new Set(['invalid params']));
  }, 60_000);
});
