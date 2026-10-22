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
  | 'model_key_missing'
  | 'spend_cap_exceeded'
  | 'model_refused'
  | 'model_failed';

/** A fixed code and a message that never carries model output or page text. */
export class ArticleError extends Error {
  constructor(
    readonly code: ArticleErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = 'ArticleError';
  }
}

export function isArticleError(error: unknown): error is ArticleError {
  return error instanceof ArticleError;
}
