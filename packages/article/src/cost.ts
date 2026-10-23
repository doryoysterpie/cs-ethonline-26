/**
 * Cost at D9's published rates for `claude-opus-5-5`, resolved for the
 * article on 22 October 2026: USD 4.00 per million input tokens, USD 20.00
 * per million output tokens, thinking billed as output; source text bounded
 * at 200,000 tokens per generation, output at 32,000; a separate USD 25
 * monthly cap (option b). Integer microdollars, so the ledger sums exactly.
 */
export const MODEL_ID = 'claude-opus-5-5';
export const INPUT_MICRODOLLARS_PER_TOKEN = 4;
export const OUTPUT_MICRODOLLARS_PER_TOKEN = 20;
export const MONTHLY_CAP_MICRODOLLARS = 25_000_000;
export const MAX_OUTPUT_TOKENS = 32_000;
export const MAX_INPUT_TOKENS = 200_000;
/** The conservative estimate the cap check uses: four characters per token. */
export const CHARACTERS_PER_TOKEN = 4;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function costMicrodollars(usage: TokenUsage): number {
  return (
    usage.inputTokens * INPUT_MICRODOLLARS_PER_TOKEN +
    usage.outputTokens * OUTPUT_MICRODOLLARS_PER_TOKEN
  );
}

export function estimatedInputTokens(promptCharacters: number): number {
  return Math.ceil(promptCharacters / CHARACTERS_PER_TOKEN) + 1_000;
}

/** The worst case a request can cost before it is made: the prompt's estimate and the full output allowance. */
export function worstCaseMicrodollars(promptCharacters: number): number {
  return costMicrodollars({
    inputTokens: estimatedInputTokens(promptCharacters),
    outputTokens: MAX_OUTPUT_TOKENS,
  });
}

export function wouldExceedCap(spentThisMonth: number, worstCase: number): boolean {
  return spentThisMonth + worstCase > MONTHLY_CAP_MICRODOLLARS;
}
