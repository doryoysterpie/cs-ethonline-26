import type { FetchLike } from '@cas/graph-evidence';
import { describe, expect, it } from 'vitest';

import {
  GATEWAY_HOST_MAX_CHARACTERS,
  GATEWAY_PATH_MAX_CHARACTERS,
  GATEWAY_URL_MAX_CHARACTERS,
} from './bounds.js';
import {
  assertGatewayTarget,
  classifyDestination,
  classifyRedirect,
  createPolicyFetch,
  isGatewayPolicyError,
} from './engines/gateway-policy.js';
import { jsonResponse } from './test-support.js';

/**
 * The gateway transport policy (Track D finding F2), against a fake base
 * fetch. The real-socket cases live in `redirect.stdio.test.ts`.
 */

const GATEWAY = 'https://gateway.thegraph.com/api';
const TARGET = `${GATEWAY}/subgraphs/id/JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`;

describe('destination classification', () => {
  it('names every private, loopback, link-local, multicast, reserved and local form', () => {
    const cases: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['127.1.2.3', 'loopback'],
      ['0x7f000001', 'loopback'],
      ['2130706433', 'loopback'],
      ['0177.0.0.1', 'loopback'],
      ['127.1', 'loopback'],
      ['[::1]', 'loopback'],
      ['::1', 'loopback'],
      ['[::ffff:127.0.0.1]', 'loopback'],
      ['[::ffff:7f00:1]', 'loopback'],
      ['0.0.0.0', 'unspecified'],
      ['[::]', 'unspecified'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.254', 'private'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'private'],
      ['[::ffff:10.0.0.1]', 'private'],
      ['169.254.169.254', 'link_local'],
      ['224.0.0.1', 'multicast'],
      ['[ff02::1]', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
      ['198.18.0.1', 'reserved'],
      ['[2001:db8::1]', 'reserved'],
      ['[fe80::1]', 'ipv6_local'],
      ['[fe80::1%25eth0]', 'ipv6_local'],
      ['[fc00::1]', 'ipv6_local'],
      ['[fd12:3456::1]', 'ipv6_local'],
      ['localhost', 'local_name'],
      ['LOCALHOST.', 'local_name'],
      ['api.localhost', 'local_name'],
      ['printer.local', 'local_name'],
      ['db.internal', 'local_name'],
      ['host.home.arpa', 'local_name'],
      ['gateway.thegraph.com', 'public_name'],
      ['8.8.8.8', 'public_address'],
      ['[2606:4700::1111]', 'public_address'],
      ['', 'unparseable'],
      ['[zz::1]', 'unparseable'],
      ['300.1.1.1', 'public_name'],
    ];
    for (const [host, expected] of cases) {
      expect(classifyDestination(host), host).toBe(expected);
    }
  });

  it('classifies a refused redirect by its resolved location', () => {
    const from = new URL(TARGET);
    expect(classifyRedirect('http://127.0.0.1:8080/x', from)).toEqual({
      destinationClass: 'loopback',
      downgrade: true,
      credentials: false,
    });
    expect(classifyRedirect('https://user:pw@10.0.0.9/x', from)).toEqual({
      destinationClass: 'private',
      downgrade: false,
      credentials: true,
    });
    expect(classifyRedirect('/relative', from).destinationClass).toBe('public_name');
    expect(classifyRedirect(null, from).destinationClass).toBe('unparseable');
    expect(classifyRedirect('http://[::1]/', from)).toMatchObject({
      destinationClass: 'loopback',
      downgrade: true,
    });
  });
});

describe('the request target', () => {
  it('admits only a well-formed request under the configured gateway', () => {
    expect(assertGatewayTarget(TARGET, GATEWAY).href).toBe(TARGET);
    const refused = (url: string): string => {
      try {
        assertGatewayTarget(url, GATEWAY);
      } catch (error) {
        return isGatewayPolicyError(error) ? error.refusal : 'other';
      }
      return 'admitted';
    };
    expect(refused('http://gateway.thegraph.com/api/subgraphs/id/x')).toBe('url_refused');
    expect(refused('https://u:p@gateway.thegraph.com/api/subgraphs/id/x')).toBe('url_refused');
    expect(refused(`${TARGET}?k=v`)).toBe('url_refused');
    expect(refused(`${TARGET}#f`)).toBe('url_refused');
    expect(refused('https://evil.example/api/subgraphs/id/x')).toBe('url_refused');
    expect(refused('https://gateway.thegraph.com/other/subgraphs/id/x')).toBe('url_refused');
    expect(refused('https://gateway.thegraph.com/apix/subgraphs/id/x')).toBe('url_refused');
    expect(refused(`https://${'a'.repeat(GATEWAY_HOST_MAX_CHARACTERS + 1)}/api/x`)).toBe(
      'url_refused',
    );
    expect(refused(`${GATEWAY}/${'p'.repeat(GATEWAY_PATH_MAX_CHARACTERS)}`)).toBe('url_refused');
    expect(refused(`${GATEWAY}/${'p'.repeat(GATEWAY_URL_MAX_CHARACTERS)}`)).toBe('url_refused');
    expect(refused('not a url')).toBe('url_refused');
    expect(refused('file:///etc/passwd')).toBe('url_refused');
  });
});

describe('the policy fetch', () => {
  function recording(responder: (url: string, init: RequestInit) => Promise<Response>): {
    fetchImpl: FetchLike;
    calls: { url: string; init: RequestInit }[];
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
      },
    };
  }

  it('sends with redirects disabled and refuses every 3xx before any second request', async () => {
    const logs: string[] = [];
    for (const [status, location, klass, downgrade] of [
      [301, 'http://127.0.0.1:9/x', 'loopback', true],
      [302, 'https://10.0.0.1/x', 'private', false],
      [303, 'https://[::1]/x', 'loopback', false],
      [307, 'https://0x7f000001/x', 'loopback', false],
      [308, 'https://2130706433/x', 'loopback', false],
      [307, 'https://u:p@gateway.thegraph.com/api/x', 'public_name', false],
      [302, '/relative/path', 'public_name', false],
      [307, 'https://gateway.thegraph.com/api/subgraphs/id/x', 'public_name', false],
    ] as const) {
      const base = recording(async () => new Response(null, { status, headers: { location } }));
      const fetchImpl = createPolicyFetch(base.fetchImpl, {
        gatewayBase: GATEWAY,
        log: (line) => logs.push(line),
      });
      let refusal = 'none';
      let destination = 'none';
      try {
        await fetchImpl(TARGET, { method: 'POST' });
      } catch (error) {
        if (isGatewayPolicyError(error)) {
          refusal = error.refusal;
          destination = error.destinationClass ?? 'none';
          expect(error.downgrade).toBe(downgrade);
          expect(error.message).not.toContain(location);
        }
      }
      expect(refusal, `${status} ${location}`).toBe('redirect_refused');
      expect(destination).toBe(klass);
      expect(base.calls).toHaveLength(1);
      expect(base.calls[0]?.url).toBe(TARGET);
      expect(base.calls[0]?.init.redirect).toBe('manual');
    }
    expect(logs.every((line) => line.startsWith('cas-mcp-server gateway_redirect_refused'))).toBe(
      true,
    );
    expect(logs.join('\n')).not.toContain('127.0.0.1');
    expect(logs.join('\n')).not.toContain('u:p@');
  });

  it('refuses a target off the gateway without calling the base fetch', async () => {
    const base = recording(async () => jsonResponse({}));
    const fetchImpl = createPolicyFetch(base.fetchImpl, { gatewayBase: GATEWAY });
    await expect(fetchImpl('https://evil.example/api/subgraphs/id/x', {})).rejects.toSatisfy(
      (error: unknown) => isGatewayPolicyError(error) && error.refusal === 'url_refused',
    );
    await expect(fetchImpl('http://gateway.thegraph.com/api/subgraphs/id/x', {})).rejects.toSatisfy(
      (error: unknown) => isGatewayPolicyError(error) && error.downgrade,
    );
    expect(base.calls).toHaveLength(0);
  });

  it('passes a non-redirect response through and combines the call signal with the request signal', async () => {
    const base = recording(async () => jsonResponse({ data: {} }));
    const controller = new AbortController();
    const fetchImpl = createPolicyFetch(base.fetchImpl, {
      gatewayBase: GATEWAY,
      signal: controller.signal,
    });
    const requestSignal = AbortSignal.timeout(60_000);
    const response = await fetchImpl(TARGET, { method: 'POST', signal: requestSignal });
    expect(response.status).toBe(200);
    const sent = base.calls[0]?.init.signal as AbortSignal;
    expect(sent.aborted).toBe(false);
    controller.abort();
    expect(sent.aborted).toBe(true);
    expect(requestSignal.aborted).toBe(false);
  });
});
