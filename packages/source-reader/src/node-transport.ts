import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import type { RawRequest, RawResponse, RawTransport } from './transport.js';

/**
 * The one transport over the network: Node's HTTP clients, no redirect ever
 * followed, no cookie or credential, the connection pinned to the address the
 * policy checked through a `lookup` that answers that address and nothing
 * else (R5), TLS verified against the host name (`servername`), no agent and
 * no keep-alive, the caller's signal and headers. Everything else the policy
 * layer decides.
 */
export interface NodeRequesters {
  readonly http: typeof httpRequest;
  readonly https: typeof httpsRequest;
}

function flatten(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function nodeTransport(
  requesters: NodeRequesters = { http: httpRequest, https: httpsRequest },
): RawTransport {
  return {
    request({ target, headers, signal }: RawRequest): Promise<RawResponse> {
      const lookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      };
      return new Promise((resolve, reject) => {
        const requester = target.tls ? requesters.https : requesters.http;
        const req = requester(
          {
            hostname: target.host,
            port: target.port,
            path: `${target.url.pathname}${target.url.search}`,
            method: 'GET',
            headers,
            lookup,
            agent: false,
            signal,
            ...(target.tls ? { servername: target.host } : {}),
          },
          (res) => {
            resolve({
              status: res.statusCode ?? 0,
              headers: flatten(res.headers),
              body: res as AsyncIterable<Uint8Array>,
            });
          },
        );
        req.on('error', (error: Error) => reject(error));
        req.end();
      });
    },
  };
}
