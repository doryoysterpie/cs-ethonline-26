import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { createAnthropicTransport, ModelTransportError, type MessagesClient } from './anthropic.ts';

/**
 * The adapter's boundary after a response exists (re-review RR1): a refusal,
 * an output that did not fit and text that is not JSON are each billed by
 * the provider, and each failure carries that usage for the ledger.
 */
function answering(message: Partial<Anthropic.Message>): MessagesClient {
  return {
    messages: {
      create: async () =>
        ({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: '{"ok":true}', citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1_234, output_tokens: 56 },
          ...message,
        }) as Anthropic.Message,
    },
  };
}

const request = {
  model: 'claude-opus-5-5',
  system: 's',
  user: 'u',
  jsonSchema: {},
  maxOutputTokens: 16_000,
};
const config = { apiKey: 'sk-ant-test-not-a-key', timeoutMs: 1_000 };

async function failure(client: MessagesClient): Promise<ModelTransportError> {
  try {
    await createAnthropicTransport(config, client).generate(request);
  } catch (error) {
    if (error instanceof ModelTransportError) return error;
    throw error;
  }
  throw new Error('expected a transport failure');
}

describe('the provider adapter after a response exists', () => {
  it('returns the parsed JSON with the usage on a clean answer', async () => {
    const response = await createAnthropicTransport(config, answering({})).generate(request);
    expect(response).toEqual({
      raw: { ok: true },
      usage: { inputTokens: 1_234, outputTokens: 56 },
      model: 'claude-opus-5-5',
    });
  });

  it('carries the billed usage on a refusal, an overflow and a non-JSON answer', async () => {
    const billed = { model: 'claude-opus-5-5', inputTokens: 1_234, outputTokens: 56 };
    const refused = await failure(answering({ stop_reason: 'refusal' }));
    expect([refused.code, refused.billed]).toEqual(['model_refused', billed]);
    const overflow = await failure(answering({ stop_reason: 'max_tokens' }));
    expect([overflow.code, overflow.billed]).toEqual(['model_failed', billed]);
    const notJson = await failure(
      answering({ content: [{ type: 'text', text: 'not json', citations: null }] }),
    );
    expect([notJson.code, notJson.billed]).toEqual(['response_invalid', billed]);
    for (const error of [refused, overflow, notJson]) expect(error.message).not.toContain('json');
  });

  it('carries no usage when the request itself failed before any answer', async () => {
    const failing: MessagesClient = {
      messages: {
        create: async () => {
          throw new Error('socket hang up');
        },
      },
    };
    const error = await failure(failing);
    expect([error.code, error.billed]).toEqual(['model_failed', null]);
    expect(error.message).not.toContain('socket');
  });
});
