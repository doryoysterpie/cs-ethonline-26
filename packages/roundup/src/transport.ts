import type { RoundupSlots } from './schema.js';
import type { TokenUsage } from './cost.js';

/**
 * The one boundary to a model. Implemented in the dashboard with the official
 * client; in every test with a recorded response. The package never opens a
 * socket.
 */
export interface GenerationRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export interface GenerationResponse {
  /** The parsed JSON the model returned; validated by the caller, never trusted here. */
  readonly raw: unknown;
  readonly usage: TokenUsage;
  readonly model: string;
}

export interface RoundupTransport {
  generate(request: GenerationRequest): Promise<GenerationResponse>;
}

/** A transport that answers with a fixed response: the test seam. */
export function recordedTransport(
  response: { readonly raw: unknown; readonly usage: TokenUsage; readonly model?: string },
  onRequest?: (request: GenerationRequest) => void,
): RoundupTransport {
  return {
    async generate(request) {
      onRequest?.(request);
      return { raw: response.raw, usage: response.usage, model: response.model ?? request.model };
    },
  };
}

export type { RoundupSlots };
