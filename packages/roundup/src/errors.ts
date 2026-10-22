export type RoundupErrorCode =
  | 'template_invalid'
  | 'template_hash_mismatch'
  | 'input_invalid'
  | 'input_empty'
  | 'response_invalid'
  | 'response_entry_count'
  | 'response_order'
  | 'response_citation_outside_selection'
  | 'response_sources_differ'
  | 'response_flagged_differs'
  | 'response_extras_differs'
  | 'model_key_missing'
  | 'spend_cap_exceeded'
  | 'model_refused'
  | 'model_failed';

/** A fixed code and a message that never carries model output or source text. */
export class RoundupError extends Error {
  constructor(
    readonly code: RoundupErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'RoundupError';
  }
}

export function isRoundupError(error: unknown): error is RoundupError {
  return error instanceof RoundupError;
}
