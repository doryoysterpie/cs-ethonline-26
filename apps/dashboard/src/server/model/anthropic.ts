import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import type { GenerationRequest, GenerationResponse, RoundupTransport } from '@cas/roundup';

import type { ModelConfig } from './config.ts';

/** What a request that reached the model cost, carried on a failure after a response (re-review RR1). */
export interface BilledUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A coded failure the round-up package maps to its own error by code. When
 * the provider answered before the failure (a refusal, an output that did not
 * fit, text that was not JSON), `billed` carries the usage that answer cost,
 * so the ledger records it; the package reads it by shape, never by class.
 */
export class ModelTransportError extends Error {
  constructor(
    readonly code: 'model_failed' | 'model_refused' | 'response_invalid',
    message: string,
    readonly status: number | null = null,
    readonly billed: BilledUsage | null = null,
  ) {
    super(message);
    this.name = 'ModelTransportError';
  }
}

/** The one call this transport makes, as an interface so a test can answer it. */
export interface MessagesClient {
  readonly messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * The one implementation of the round-up transport (report, section 1.6):
 * the official client, the model and settings D9 resolved, structured output
 * against the slot schema, an explicit timeout, the client's own bounded
 * retries. A refusal is a fixed code; a provider error is a fixed code and
 * never its body; the key travels in the client and nowhere else. No
 * fallback to another model: D9 names one, and a refusal is surfaced to the
 * owner rather than rerouted.
 */
export function createAnthropicTransport(
  config: ModelConfig,
  client: MessagesClient = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: 2,
  }),
): RoundupTransport {
  return {
    async generate(request: GenerationRequest): Promise<GenerationResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          thinking: { type: 'adaptive' },
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: request.jsonSchema },
          },
        });
      } catch (error) {
        throw new ModelTransportError(
          'model_failed',
          'the model request failed',
          error instanceof Anthropic.APIError ? (error.status ?? null) : null,
        );
      }
      // From here the provider has answered and billed the answer, whatever
      // is done with it: every failure below carries that usage.
      const billed: BilledUsage = {
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      };
      if (message.stop_reason === 'refusal') {
        throw new ModelTransportError(
          'model_refused',
          'the model declined the request',
          null,
          billed,
        );
      }
      if (message.stop_reason === 'max_tokens') {
        throw new ModelTransportError(
          'model_failed',
          'the response did not fit the output allowance',
          null,
          billed,
        );
      }
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ModelTransportError(
          'response_invalid',
          'the response was not JSON',
          null,
          billed,
        );
      }
      return {
        raw,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
        model: message.model,
      };
    },
  };
}
