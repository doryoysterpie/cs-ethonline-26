/**
 * Cost at D9's published rates for `claude-opus-5-5`: USD 4.00 per million
 * input tokens, USD 20.00 per million output tokens; thinking bills as
 * output. Amounts are integer microdollars so a ledger sums exactly.
 */
export const MODEL_ID = 'claude-opus-5-5';
export const INPUT_MICRODOLLARS_PER_TOKEN = 4; // USD 4.00 / 1,000,000 tokens
export const OUTPUT_MICRODOLLARS_PER_TOKEN = 20; // USD 20.00 / 1,000,000 tokens
export const MONTHLY_CAP_MICRODOLLARS = 25_000_000; // USD 25 (D9 resolution)
export const MAX_OUTPUT_TOKENS = 16_000;

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

/**
 * The worst case a request can cost before it is made: the prompt's size
 * (four characters per token is the conservative rule used here) and the
 * full output allowance. The cap check uses this, so a run can never be the
 * one that crosses the month.
 */
export function worstCaseMicrodollars(promptCharacters: number): number {
  const inputTokens = Math.ceil(promptCharacters / 4) + 1_000;
  return costMicrodollars({ inputTokens, outputTokens: MAX_OUTPUT_TOKENS });
}

export function wouldExceedCap(spentThisMonth: number, worstCase: number): boolean {
  return spentThisMonth + worstCase > MONTHLY_CAP_MICRODOLLARS;
}

/** The UTC month key the ledger sums over. */
export function monthKey(instant: Date): string {
  return `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, '0')}`;
}
