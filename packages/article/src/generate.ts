import {
  costMicrodollars,
  estimatedInputTokens,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  worstCaseMicrodollars,
  wouldExceedCap,
} from './cost.js';
import { ArticleError, type BilledUsage } from './errors.js';
import { assertArticleInput, inputDigest, type ArticleInput } from './input.js';
import { PROMPT_VERSION, promptHash, systemPrompt, userPrompt } from './prompt.js';
import { MAX_MARKDOWN_CHARACTERS, renderMarkdown } from './render.js';
import { slotsJsonSchema, type ArticleSlots, type NamingBasis } from './schema.js';
import type { ArticleTransport } from './transport.js';
import { validateArticle, wordCountOf } from './validate.js';

export interface ArticleSourceProvenance {
  readonly sourceRowId: string;
  readonly status: 'read' | 'partly_read' | 'not_read';
  readonly code: string | null;
  readonly bytes: number;
  readonly digest: string | null;
}

export interface ArticleProvenance {
  readonly model: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly inputDigest: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
  readonly wordCount: number;
  readonly namingBasis: NamingBasis;
  readonly sources: readonly ArticleSourceProvenance[];
}

export interface ArticleGeneration {
  readonly slots: ArticleSlots;
  readonly markdown: string;
  readonly provenance: ArticleProvenance;
}

export interface GenerateOptions {
  /** The month's spend so far on articles, in microdollars, for the cap check. */
  readonly spentThisMonth: number;
}

/** The billed usage a foreign error carries, when it has the shape; null otherwise. */
function billedOf(value: unknown): BilledUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const model = record['model'];
  const inputTokens = record['inputTokens'];
  const outputTokens = record['outputTokens'];
  if (
    typeof model !== 'string' ||
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return null;
  }
  return { model, inputTokens, outputTokens };
}

/** The prompt and its worst case, for the caller's cap check before any request. */
export function prepareArticle(input: ArticleInput): {
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
  readonly worstCaseMicrodollars: number;
  readonly inputDigest: string;
} {
  assertArticleInput(input);
  const system = systemPrompt();
  const user = userPrompt(input);
  const characters = system.length + user.length;
  const estimated = estimatedInputTokens(characters);
  if (estimated > MAX_INPUT_TOKENS) {
    throw new ArticleError('input_too_large', 'the prompt exceeds the input bound', {
      estimatedInputTokens: estimated,
    });
  }
  return {
    system,
    user,
    estimatedInputTokens: estimated,
    worstCaseMicrodollars: worstCaseMicrodollars(characters),
    inputDigest: inputDigest(input),
  };
}

/** The reading record the revision keeps, per source, never the text. */
export function sourceProvenance(input: ArticleInput): ArticleSourceProvenance[] {
  return input.incidents.flatMap((incident) =>
    incident.rows.map((row) => ({
      sourceRowId: row.sourceRowId,
      status: row.reading.status,
      code: row.reading.code,
      bytes: row.reading.bytes,
      digest: row.reading.digest,
    })),
  );
}

/**
 * One generation: refuse what can be refused before the request (input,
 * size, credential, cap), make exactly one request through the transport,
 * validate the response against the selection and the texts read, and
 * return the revision with its provenance. Throws ArticleError with a fixed
 * code; a transport failure is reported by its code, never its body.
 */
export async function generateArticle(
  input: ArticleInput,
  transport: ArticleTransport | null,
  options: GenerateOptions,
): Promise<ArticleGeneration> {
  const prepared = prepareArticle(input);
  if (transport === null) {
    throw new ArticleError(
      'model_key_missing',
      'no model credential is configured; nothing was requested',
    );
  }
  if (wouldExceedCap(options.spentThisMonth, prepared.worstCaseMicrodollars)) {
    throw new ArticleError(
      'spend_cap_exceeded',
      'this generation could take the month over the article spending cap',
      { spentThisMonth: options.spentThisMonth, worstCase: prepared.worstCaseMicrodollars },
    );
  }
  let response;
  try {
    response = await transport.generate({
      model: MODEL_ID,
      system: prepared.system,
      user: prepared.user,
      jsonSchema: slotsJsonSchema(),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    if (error instanceof ArticleError) throw error;
    // A transport may be loaded as another module instance; its coded failure
    // is honoured by code, never by class identity, and never by its text.
    const code = (error as { code?: unknown } | null)?.code;
    // A transport that answered before failing carries what the answer cost;
    // read by shape, never by class, and kept on the error for the ledger.
    const billed = billedOf((error as { billed?: unknown } | null)?.billed);
    if (code === 'model_refused' || code === 'response_invalid') {
      throw new ArticleError(
        code,
        code === 'model_refused' ? 'the model declined the request' : 'the response was not JSON',
        {},
        billed,
      );
    }
    throw new ArticleError('model_failed', 'the model request failed', {}, billed);
  }
  // The request was made and billed whatever happens next: a failure from
  // here carries the usage, so the ledger records the real cost.
  const billed: BilledUsage = {
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  };
  let slots: ArticleSlots;
  try {
    slots = validateArticle(response.raw, input);
  } catch (error) {
    if (error instanceof ArticleError) {
      throw new ArticleError(error.code, error.message, error.details, billed);
    }
    throw error;
  }
  const markdown = renderMarkdown(slots, input);
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new ArticleError(
      'response_too_long',
      'the generated article renders past the stored bound',
      { characters: markdown.length, bound: MAX_MARKDOWN_CHARACTERS },
      billed,
    );
  }
  return {
    slots,
    markdown,
    provenance: {
      model: response.model,
      promptVersion: PROMPT_VERSION,
      promptHash: promptHash(),
      inputDigest: prepared.inputDigest,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costMicrodollars: costMicrodollars(response.usage),
      wordCount: wordCountOf(slots),
      namingBasis: slots.victimNaming.basis,
      sources: sourceProvenance(input),
    },
  };
}
