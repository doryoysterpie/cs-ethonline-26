import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import type { GenerationRequest, GenerationResponse, RoundupTransport } from '@cas/roundup';

import type { ModelConfig } from './config.ts';

/** A coded failure the round-up package maps to its own error by code. */
class ModelTransportError extends Error {
  constructor(
    readonly code: 'model_failed' | 'model_refused' | 'response_invalid',
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ModelTransportError';
  }
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
export function createAnthropicTransport(config: ModelConfig): RoundupTransport {
  const client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 2 });
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
      if (message.stop_reason === 'refusal') {
        throw new ModelTransportError('model_refused', 'the model declined the request');
      }
      if (message.stop_reason === 'max_tokens') {
        throw new ModelTransportError(
          'model_failed',
          'the response did not fit the output allowance',
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
        throw new ModelTransportError('response_invalid', 'the response was not JSON');
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
