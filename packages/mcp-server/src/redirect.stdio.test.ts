import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BASE_LENDING_TARGETS, type DeploymentTarget } from '@cas/graph-evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { structured, syntheticPayload, T_NOW, textOf } from './test-support.js';

/**
 * Real synthetic redirects through the built entry point (Track D finding
 * F2), and a real abort-aware gateway for cancellation (finding F1). A
 * disposable HTTPS gateway on loopback answers each case; separate loopback
 * HTTP and HTTPS destinations count every request they receive, and are
 * required to receive none. The certificate is generated for the test and
 * trusted only by the child process.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const KEY = 'redirect-test-key-0123456789';

interface Servers {
  readonly gateway: https.Server;
  readonly httpDestination: http.Server;
  readonly httpsDestination: https.Server;
  readonly gatewayPort: number;
  readonly httpPort: number;
  readonly httpsPort: number;
  readonly certificate: string;
  gatewayHits: number;
  httpHits: number;
  httpsHits: number;
  /** What the gateway does with the next requests. */
  mode:
    | { kind: 'redirect'; location: string; status: number }
    | { kind: 'payload' }
    | { kind: 'stall' };
  stalled: { closed: boolean }[];
}

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function certificate(directory: string): { key: string; cert: string } {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      path.join(directory, 'key.pem'),
      '-out',
      path.join(directory, 'cert.pem'),
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  return {
    key: readFileSync(path.join(directory, 'key.pem'), 'utf8'),
    cert: readFileSync(path.join(directory, 'cert.pem'), 'utf8'),
  };
}

/**
 * The synthetic payload, with every timestamp shifted to the real clock the
 * child process reads, so the freshness rule sees a current observation.
 */
function freshPayload(target: DeploymentTarget): Record<string, unknown> {
  const shift = Math.floor(Date.now() / 1000) - T_NOW;
  const payload = syntheticPayload(target);
  const meta = payload['_meta'] as { block: { timestamp: number } };
  const snapshots = payload['financialsDailySnapshots'] as { timestamp: string }[];
  return {
    ...payload,
    _meta: { ...meta, block: { ...meta.block, timestamp: meta.block.timestamp + shift } },
    financialsDailySnapshots: snapshots.map((snapshot) => ({
      ...snapshot,
      timestamp: String(Number(snapshot.timestamp) + shift),
    })),
  };
}

function failureKinds(live: Record<string, unknown>): string {
  return (live['targets'] as Record<string, unknown>[])
    .map((target) => {
      const failure = target['failure'] as Record<string, unknown> | null;
      return `${String((target['target'] as Record<string, unknown>)['configuredSlug'])}=${
        failure === null ? 'valid' : String(failure['kind'])
      }`;
    })
    .join(',');
}

describe('the built entry point against real synthetic redirects', () => {
  let directory: string;
  let servers: Servers;
  let client: Client;
  let transport: StdioClientTransport;
  const stderr: Buffer[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'cas-mcp-redirect-'));
    const { key, cert } = certificate(directory);
    const state = {
      gatewayHits: 0,
      httpHits: 0,
      httpsHits: 0,
      mode: { kind: 'payload' } as Servers['mode'],
      stalled: [] as { closed: boolean }[],
    };
    const gateway = https.createServer({ key, cert }, (request, response) => {
      state.gatewayHits += 1;
      if (state.mode.kind === 'redirect') {
        response.writeHead(state.mode.status, { location: state.mode.location });
        response.end();
        return;
      }
      if (state.mode.kind === 'stall') {
        const entry = { closed: false };
        state.stalled.push(entry);
        request.on('close', () => {
          entry.closed = true;
        });
        return;
      }
      const target = BASE_LENDING_TARGETS.find((t) =>
        request.url?.endsWith(`/subgraphs/id/${t.subgraphId}`),
      );
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: target === undefined ? {} : freshPayload(target) }));
    });
    const httpDestination = http.createServer((_request, response) => {
      state.httpHits += 1;
      response.writeHead(200);
      response.end('{}');
    });
    const httpsDestination = https.createServer({ key, cert }, (_request, response) => {
      state.httpsHits += 1;
      response.writeHead(307, { location: `http://127.0.0.1:${servers.httpPort}/chained` });
      response.end();
    });
    const [gatewayPort, httpPort, httpsPort] = await Promise.all([
      listen(gateway),
      listen(httpDestination),
      listen(httpsDestination),
    ]);
    servers = Object.assign(state, {
      gateway,
      httpDestination,
      httpsDestination,
      gatewayPort,
      httpPort,
      httpsPort,
      certificate: path.join(directory, 'cert.pem'),
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: {
        PATH: process.env['PATH'] ?? '',
        GRAPH_API_KEY: KEY,
        GRAPH_GATEWAY_URL: `https://localhost:${gatewayPort}/api`,
        NODE_EXTRA_CA_CERTS: servers.certificate,
      },
      stderr: 'pipe',
    });
    client = new Client(
      { name: 'redirect-harness', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  });

  afterAll(async () => {
    await client?.close();
    for (const server of [servers?.gateway, servers?.httpDestination, servers?.httpsDestination]) {
      if (server === undefined) continue;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function liveBase(): Promise<Awaited<ReturnType<Client['callTool']>>> {
    return client.callTool(
      { name: 'chain_anomalies', arguments: { mode: 'live', chain: 'base' } },
      { timeout: 60_000 },
    );
  }

  it('records the contacted endpoint as provenance when the gateway answers directly', async () => {
    servers.mode = { kind: 'payload' };
    servers.gatewayHits = 0;
    const result = await liveBase();
    expect(result.isError).not.toBe(true);
    const live = structured(result)['live'] as Record<string, unknown>;
    expect(live['provider']).toBe('graph-compatible-https-endpoint');
    expect(live['providerBase']).toBe(`https://localhost:${servers.gatewayPort}/api`);
    expect(live['targetsValid'], failureKinds(live)).toBe(BASE_LENDING_TARGETS.length);
    for (const target of live['targets'] as Record<string, unknown>[]) {
      expect((target['provenance'] as Record<string, unknown>)['providerBase']).toBe(
        live['providerBase'],
      );
    }
    expect(servers.gatewayHits).toBe(BASE_LENDING_TARGETS.length);
  });

  it('refuses every redirect with zero destination requests', async () => {
    const cases: [string, number][] = [
      [`http://127.0.0.1:${servers.httpPort}/downgrade`, 307],
      [`http://localhost:${servers.httpPort}/downgrade`, 302],
      [`https://127.0.0.1:${servers.httpsPort}/loopback`, 307],
      [`https://[::1]:${servers.httpsPort}/ipv6`, 307],
      [`https://0x7f000001:${servers.httpsPort}/encoded`, 308],
      [`https://2130706433:${servers.httpsPort}/integer`, 301],
      [`https://10.0.0.1:${servers.httpsPort}/private`, 307],
      [`https://user:pw@127.0.0.1:${servers.httpsPort}/userinfo`, 307],
      [`https://localhost:${servers.httpsPort}/chain`, 307],
      ['/relative/on/gateway', 303],
    ];
    for (const [location, status] of cases) {
      servers.mode = { kind: 'redirect', location, status };
      servers.gatewayHits = 0;
      servers.httpHits = 0;
      servers.httpsHits = 0;
      const result = await liveBase();
      expect(result.isError, location).not.toBe(true);
      const live = structured(result)['live'] as Record<string, unknown>;
      expect(live['targetsValid'], location).toBe(0);
      for (const target of live['targets'] as Record<string, unknown>[]) {
        expect(target['outcome']).toBe('failed');
        expect((target['failure'] as Record<string, unknown>)['kind']).toBe('network');
      }
      expect(servers.gatewayHits, location).toBe(BASE_LENDING_TARGETS.length);
      expect(servers.httpHits, location).toBe(0);
      expect(servers.httpsHits, location).toBe(0);
      expect(textOf(result)).not.toContain(location);
    }
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toContain(
      'gateway_redirect_refused status=307 destination=loopback downgrade=true',
    );
    expect(log).toContain('destination=private');
    expect(log).toContain('credentials=true');
    expect(log).not.toContain('user:pw');
    expect(log).not.toContain(`:${servers.httpPort}/`);
  });

  it('aborts a stalled gateway request when the client cancels', async () => {
    servers.mode = { kind: 'stall' };
    servers.stalled = [];
    const controller = new AbortController();
    const call = client.callTool(
      { name: 'chain_anomalies', arguments: { mode: 'live', chain: 'base' } },
      { signal: controller.signal, timeout: 60_000 },
    );
    const until = Date.now() + 5_000;
    while (servers.stalled.length < BASE_LENDING_TARGETS.length && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(servers.stalled).toHaveLength(BASE_LENDING_TARGETS.length);
    controller.abort();
    await expect(call).rejects.toThrow();
    const settle = Date.now() + 5_000;
    while (!servers.stalled.every((s) => s.closed) && Date.now() < settle) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(servers.stalled.every((s) => s.closed)).toBe(true);
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toContain('outcome=call_cancelled');
    // Capacity is intact: four concurrent calls are admitted and answered.
    servers.mode = { kind: 'payload' };
    const after = await Promise.all(Array.from({ length: 4 }, () => liveBase()));
    for (const result of after) {
      expect(result.isError).not.toBe(true);
      const live = structured(result)['live'] as Record<string, unknown>;
      expect(live['targetsValid'], failureKinds(live)).toBe(BASE_LENDING_TARGETS.length);
    }
  });

  it('writes no destination and no credential to stderr', () => {
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain('user:pw');
    expect(log).not.toContain('10.0.0.1');
    expect(log).not.toContain('0x7f000001');
  });
});
