export type RoundupErrorCode =
  | 'template_invalid'
  | 'template_hash_mismatch'
  | 'input_invalid'
  | 'input_empty'
  | 'input_too_long'
  | 'response_invalid'
  | 'response_entry_count'
  | 'response_order'
  | 'response_citation_outside_selection'
  | 'response_sources_differ'
  | 'response_text_unsafe'
  | 'response_too_long'
  | 'response_url_outside_selection'
  | 'response_flagged_differs'
  | 'response_extras_differs'
  | 'model_key_missing'
  | 'spend_cap_exceeded'
  | 'model_refused'
  | 'model_failed';

/** What a request that reached the model cost, carried on a failure after the response (review F3). */
export interface BilledUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A fixed code and a message that never carries model output or source text. */
export class RoundupError extends Error {
  /** Non-null when a model request was made and billed before the failure; the ledger records it. */
  readonly billed: BilledUsage | null;

  constructor(
    readonly code: RoundupErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    billed: BilledUsage | null = null,
  ) {
    super(message);
    this.name = 'RoundupError';
    this.billed = billed;
  }
}

export function isRoundupError(error: unknown): error is RoundupError {
  return error instanceof RoundupError;
}
