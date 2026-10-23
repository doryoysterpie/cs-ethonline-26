import type { TokenUsage } from './cost.js';

/**
 * The one boundary to a model, the same shape the round-up uses so the
 * dashboard's one transport serves both. Implemented in the dashboard with
 * the official client; in every test with a recorded response. The package
 * never opens a socket.
 */
export interface GenerationRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export interface GenerationResponse {
  readonly raw: unknown;
  readonly usage: TokenUsage;
  readonly model: string;
}

export interface ArticleTransport {
  generate(request: GenerationRequest): Promise<GenerationResponse>;
}

/** A transport that answers with a fixed response: the test seam. */
export function recordedTransport(
  response: { readonly raw: unknown; readonly usage: TokenUsage; readonly model?: string },
  onRequest?: (request: GenerationRequest) => void,
): ArticleTransport {
  return {
    async generate(request) {
      onRequest?.(request);
      return { raw: response.raw, usage: response.usage, model: response.model ?? request.model };
    },
  };
}
