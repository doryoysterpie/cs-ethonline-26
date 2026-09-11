import type { ChainId } from '@cas/contracts';
import {
  BASE_LENDING_TARGETS,
  ETHEREUM_LENDING_TARGETS,
  GraphGatewayClient,
  evaluateFailedTarget,
  evaluateTarget,
  validateRegistry,
  type DeploymentTarget,
  type FetchLike,
  type TargetEvaluation,
} from '@cas/graph-evidence';

import { LIVE_REQUEST_TIMEOUT_MS } from '../bounds.js';
import type { Redactor } from '../safety/redact.js';
import { createPolicyFetch } from './gateway-policy.js';

/**
 * The live signal source, behind an interface.
 *
 * Live mode is the existing Sprint 1 client and nothing else: the same
 * gateway URL validation, the same bearer-only credential handling, the same
 * redactor, the same registry of configured targets, the same identity gate
 * and the same freshness rule. No target outside the registry can be queried,
 * because the interface takes a chain, not a subgraph identifier or a URL.
 *
 * Every request the client makes passes through this server's own transport
 * policy (`gateway-policy.ts`, Track D findings F1 and F2): the request may
 * address only the configured gateway, no redirect is ever followed, and the
 * call's abort signal aborts the socket. The client is built per call so that
 * the policy is bound to that call's signal and nothing is shared between
 * concurrent calls.
 *
 * There is no fallback. A provider failure is returned as a failure for that
 * target; nothing reads a stored, replay or fixture row in this file, and a
 * unit test enforces that structurally.
 */

export interface LiveObservation {
  readonly provider: 'the-graph-gateway' | 'graph-compatible-https-endpoint';
  readonly providerBase: string;
  readonly queriedAtUtc: string;
  readonly evaluations: readonly TargetEvaluation[];
  readonly redact: Redactor;
}

export interface LiveSignalSource {
  observe(chain: ChainId, signal?: AbortSignal): Promise<LiveObservation>;
}

export interface GraphLiveSignalSourceOptions {
  readonly apiKey: string | undefined;
  readonly gatewayBaseUrl?: string | undefined;
  /** The base fetch the policy wraps. Defaults to the global fetch. */
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  /** Receives one fixed line per refused request. Never a URL. */
  readonly log?: ((line: string) => void) | undefined;
}

function targetsFor(chain: ChainId): readonly DeploymentTarget[] {
  return chain === 'ethereum' ? ETHEREUM_LENDING_TARGETS : BASE_LENDING_TARGETS;
}

export class GraphLiveSignalSource implements LiveSignalSource {
  readonly #options: GraphLiveSignalSourceOptions;
  readonly #gatewayBase: string;
  readonly #now: () => Date;
  readonly #baseFetch: FetchLike;

  /** Throws the client's own credential or validation error; nothing is deferred. */
  constructor(options: GraphLiveSignalSourceOptions) {
    validateRegistry([...ETHEREUM_LENDING_TARGETS, ...BASE_LENDING_TARGETS]);
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#baseFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    // Built once here so a missing key or a rejected gateway URL fails at
    // start-up, exactly as before. Per-call clients repeat the same checks.
    this.#gatewayBase = this.#client(undefined).gateway.base;
  }

  #client(signal: AbortSignal | undefined): GraphGatewayClient {
    // The policy needs the validated base before it can check a request
    // against it; the first client is built without a policy to obtain that
    // base, and every request-making client is built with the policy.
    const gatewayBase = this.#gatewayBase as string | undefined;
    return new GraphGatewayClient({
      apiKey: this.#options.apiKey,
      gatewayBaseUrl: this.#options.gatewayBaseUrl,
      timeoutMs: this.#options.timeoutMs ?? LIVE_REQUEST_TIMEOUT_MS,
      fetchImpl:
        gatewayBase === undefined
          ? this.#baseFetch
          : createPolicyFetch(this.#baseFetch, { gatewayBase, signal, log: this.#options.log }),
      now: this.#now,
    });
  }

  async observe(chain: ChainId, signal?: AbortSignal): Promise<LiveObservation> {
    const client = this.#client(signal);
    const queriedAtUtc = this.#now().toISOString();
    const evaluations = await Promise.all(
      targetsFor(chain).map(async (target): Promise<TargetEvaluation> => {
        try {
          const reading = await client.queryStandardizedTvl({
            subgraphId: target.subgraphId,
            targetChain: target.chain,
            targetSlug: target.slug,
          });
          const queriedAtSeconds = Math.floor(Date.parse(reading.provenance.queriedAtUtc) / 1000);
          return evaluateTarget(target, reading, queriedAtSeconds, client.redact);
        } catch (error) {
          return evaluateFailedTarget(target, error, client.redact);
        }
      }),
    );
    return {
      provider: client.gateway.provider,
      providerBase: client.gateway.base,
      queriedAtUtc,
      evaluations,
      redact: client.redact,
    };
  }
}
