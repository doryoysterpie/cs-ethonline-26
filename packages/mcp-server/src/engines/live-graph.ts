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

/**
 * The live signal source, behind an interface.
 *
 * Live mode is the existing Sprint 1 client and nothing else: the same
 * gateway URL validation, the same bearer-only credential handling, the same
 * redactor, the same registry of configured targets, the same identity gate
 * and the same freshness rule. No target outside the registry can be queried,
 * because the interface takes a chain, not a subgraph identifier or a URL.
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
  observe(chain: ChainId): Promise<LiveObservation>;
}

export interface GraphLiveSignalSourceOptions {
  readonly apiKey: string | undefined;
  readonly gatewayBaseUrl?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
}

function targetsFor(chain: ChainId): readonly DeploymentTarget[] {
  return chain === 'ethereum' ? ETHEREUM_LENDING_TARGETS : BASE_LENDING_TARGETS;
}

export class GraphLiveSignalSource implements LiveSignalSource {
  readonly #client: GraphGatewayClient;
  readonly #now: () => Date;

  /** Throws the client's own credential or validation error; nothing is deferred. */
  constructor(options: GraphLiveSignalSourceOptions) {
    validateRegistry([...ETHEREUM_LENDING_TARGETS, ...BASE_LENDING_TARGETS]);
    this.#now = options.now ?? (() => new Date());
    this.#client = new GraphGatewayClient({
      apiKey: options.apiKey,
      gatewayBaseUrl: options.gatewayBaseUrl,
      timeoutMs: options.timeoutMs ?? LIVE_REQUEST_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
      now: this.#now,
    });
  }

  async observe(chain: ChainId): Promise<LiveObservation> {
    const queriedAtUtc = this.#now().toISOString();
    const evaluations = await Promise.all(
      targetsFor(chain).map(async (target): Promise<TargetEvaluation> => {
        try {
          const reading = await this.#client.queryStandardizedTvl({
            subgraphId: target.subgraphId,
            targetChain: target.chain,
            targetSlug: target.slug,
          });
          const queriedAtSeconds = Math.floor(Date.parse(reading.provenance.queriedAtUtc) / 1000);
          return evaluateTarget(target, reading, queriedAtSeconds, this.#client.redact);
        } catch (error) {
          return evaluateFailedTarget(target, error, this.#client.redact);
        }
      }),
    );
    return {
      provider: this.#client.gateway.provider,
      providerBase: this.#client.gateway.base,
      queriedAtUtc,
      evaluations,
      redact: this.#client.redact,
    };
  }
}
