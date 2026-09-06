import { describe, expect, it } from 'vitest';

import { GraphProbeError } from './errors.js';
import { DEFAULT_GATEWAY_BASE_URL, parseGatewayBaseUrl } from './gateway-url.js';

function rejection(raw: string | undefined): string {
  try {
    parseGatewayBaseUrl(raw);
  } catch (error) {
    if (error instanceof GraphProbeError && error.kind === 'validation') return error.message;
    return 'wrong error kind';
  }
  return 'accepted';
}

describe('parseGatewayBaseUrl', () => {
  it('rejects a URL carrying a username or password without echoing it', () => {
    const message = rejection('https://user:password@example.com/api');
    expect(message).toMatch(/must not contain credentials/);
    expect(message).not.toContain('password');
    expect(message).not.toContain('example.com');
    expect(rejection('https://user@example.com/api')).toMatch(/credentials/);
  });

  it('rejects a query string', () => {
    const message = rejection('https://example.com/api?token=secret');
    expect(message).toMatch(/query string/);
    expect(message).not.toContain('secret');
  });

  it('rejects a fragment', () => {
    const message = rejection('https://example.com/api#Bearer-secret');
    expect(message).toMatch(/fragment/);
    expect(message).not.toContain('Bearer');
  });

  it('rejects http and other schemes', () => {
    expect(rejection('http://gateway.thegraph.com/api')).toMatch(/https/);
    expect(rejection('ftp://gateway.thegraph.com/api')).toMatch(/https/);
  });

  it('rejects unparseable or empty values', () => {
    expect(rejection('')).toMatch(/empty/);
    expect(rejection('   ')).toMatch(/empty/);
    expect(rejection('not a url')).toMatch(/parseable/);
    expect(rejection('https://')).toMatch(/parseable|hostname/);
  });

  it('normalizes a safe HTTPS gateway URL deterministically', () => {
    expect(parseGatewayBaseUrl('https://gateway.thegraph.com/api/')).toEqual({
      base: 'https://gateway.thegraph.com/api',
      host: 'gateway.thegraph.com',
      provider: 'the-graph-gateway',
    });
    expect(parseGatewayBaseUrl('https://gateway.thegraph.com/api///').base).toBe(
      'https://gateway.thegraph.com/api',
    );
    expect(parseGatewayBaseUrl('  https://gateway.thegraph.com/api  ').base).toBe(
      'https://gateway.thegraph.com/api',
    );
    expect(parseGatewayBaseUrl(undefined).base).toBe(DEFAULT_GATEWAY_BASE_URL);
  });

  it('records any other validated HTTPS endpoint as a Graph-compatible endpoint, not the gateway', () => {
    expect(parseGatewayBaseUrl('https://custom.example:8443/graph//')).toEqual({
      base: 'https://custom.example:8443/graph',
      host: 'custom.example',
      provider: 'graph-compatible-https-endpoint',
    });
  });
});
