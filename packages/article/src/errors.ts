export type ArticleErrorCode =
  | 'input_invalid'
  | 'input_empty'
  | 'input_too_large'
  | 'response_invalid'
  | 'response_citation_outside_selection'
  | 'response_citation_unread'
  | 'response_not_read_differs'
  | 'response_quotation_not_found'
  | 'response_section_order'
  | 'response_section_missing'
  | 'response_length'
  | 'response_headline'
  | 'response_naming_basis'
  | 'response_too_long'
  | 'model_key_missing'
  | 'spend_cap_exceeded'
  | 'model_refused'
  | 'model_failed';

/** What a request that reached the model cost, carried on a failure after the response (the round-up's review F3). */
export interface BilledUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A fixed code and a message that never carries model output or page text. */
export class ArticleError extends Error {
  /** Non-null when a model request was made and billed before the failure; the ledger records it. */
  readonly billed: BilledUsage | null;

  constructor(
    readonly code: ArticleErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    billed: BilledUsage | null = null,
  ) {
    super(message);
    this.name = 'ArticleError';
    this.billed = billed;
  }
}

export function isArticleError(error: unknown): error is ArticleError {
  return error instanceof ArticleError;
}
