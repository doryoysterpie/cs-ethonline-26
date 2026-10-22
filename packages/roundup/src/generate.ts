import {
  costMicrodollars,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  worstCaseMicrodollars,
  wouldExceedCap,
} from './cost.js';
import { RoundupError, type BilledUsage } from './errors.js';
import { assertRoundupInput, inputDigest, type RoundupInput } from './input.js';
import { PROMPT_VERSION, promptHash, systemPrompt, userPrompt } from './prompt.js';
import { deterministicSlots, MAX_MARKDOWN_CHARACTERS, renderMarkdown } from './render.js';
import { slotsJsonSchema, type RoundupSlots } from './schema.js';
import { sectionOf, type LoadedTemplate } from './template.js';
import { urlsIn } from './text.js';
import type { RoundupTransport } from './transport.js';
import { validateResponse } from './validate.js';

/**
 * The export may carry exactly the selection's URLs, each once, on the
 * sources lines (review F2): whatever a slot text held, escaped or not, the
 * rendered Markdown is checked against the selection before it is kept.
 */
function assertOnlySelectedUrls(
  markdown: string,
  input: RoundupInput,
  billed: BilledUsage | null,
): void {
  const expected = input.incidents
    .flatMap((incident) => incident.rows.map((row) => row.url))
    .sort();
  const found = urlsIn(markdown).sort();
  if (found.length !== expected.length || found.some((url, i) => url !== expected[i])) {
    throw new RoundupError(
      'response_url_outside_selection',
      'the rendered round-up carries a URL outside the selection',
      { expected: expected.length, found: found.length },
      billed,
    );
  }
}

export interface GenerationProvenance {
  readonly model: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly inputDigest: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
}

export interface RoundupGeneration {
  readonly deterministic: { readonly slots: RoundupSlots; readonly markdown: string };
  readonly generated: { readonly slots: RoundupSlots; readonly markdown: string };
  readonly provenance: GenerationProvenance;
}

export interface GenerateOptions {
  /** The template hash the caller believes is current; a mismatch refuses. */
  readonly expectedTemplateHash?: string | undefined;
  /** The month's spend so far, in microdollars, for the cap check. */
  readonly spentThisMonth: number;
}

/** The worst-case cost of this input, for the caller's cap check before any request. */
export function prepareGeneration(
  input: RoundupInput,
  loaded: LoadedTemplate,
): {
  readonly system: string;
  readonly user: string;
  readonly worstCaseMicrodollars: number;
  readonly inputDigest: string;
} {
  assertRoundupInput(input);
  // The deterministic rendering is the smallest a round-up of this selection
  // can be; past the stored bound, no revision could be kept, so nothing is
  // requested.
  const deterministic = renderMarkdown(deterministicSlots(input, loaded.template), loaded.template);
  if (deterministic.length > MAX_MARKDOWN_CHARACTERS) {
    throw new RoundupError('input_too_long', 'the selection renders past the stored bound', {
      characters: deterministic.length,
      bound: MAX_MARKDOWN_CHARACTERS,
    });
  }
  const system = systemPrompt(loaded.template);
  const user = userPrompt(input, sectionOf(loaded.template, 'extras').marker ?? '');
  return {
    system,
    user,
    worstCaseMicrodollars: worstCaseMicrodollars(system.length + user.length),
    inputDigest: inputDigest(input),
  };
}

/**
 * One generation: refuse what can be refused before the request (input,
 * template hash, cap), make exactly one request through the transport,
 * validate the response against the selection, and return both revisions
 * with the provenance the record keeps. Throws RoundupError with a fixed code;
 * a transport failure is reported as `model_failed` without the provider's
 * body.
 */
export async function generateRoundup(
  input: RoundupInput,
  loaded: LoadedTemplate,
  transport: RoundupTransport | null,
  options: GenerateOptions,
): Promise<RoundupGeneration> {
  const prepared = prepareGeneration(input, loaded);
  if (options.expectedTemplateHash !== undefined && options.expectedTemplateHash !== loaded.hash) {
    throw new RoundupError(
      'template_hash_mismatch',
      'the template changed since the request was made',
    );
  }
  if (transport === null) {
    throw new RoundupError(
      'model_key_missing',
      'no model credential is configured; nothing was requested',
    );
  }
  if (wouldExceedCap(options.spentThisMonth, prepared.worstCaseMicrodollars)) {
    throw new RoundupError(
      'spend_cap_exceeded',
      'this generation could take the month over the spending cap',
      {
        spentThisMonth: options.spentThisMonth,
        worstCase: prepared.worstCaseMicrodollars,
      },
    );
  }
  const deterministic = deterministicSlots(input, loaded.template);
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
    if (error instanceof RoundupError) throw error;
    // A transport may be loaded as another module instance; its coded failure
    // is honoured by code, never by class identity, and never by its text.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'model_refused' || code === 'response_invalid') {
      throw new RoundupError(
        code,
        code === 'model_refused' ? 'the model declined the request' : 'the response was not JSON',
      );
    }
    throw new RoundupError('model_failed', 'the model request failed');
  }
  // The request was made and billed whatever happens next: a failure from
  // here carries the usage, so the ledger records the real cost (review F3).
  const billed: BilledUsage = {
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  };
  let slots: RoundupSlots;
  try {
    slots = validateResponse(response.raw, input, loaded.template);
  } catch (error) {
    if (error instanceof RoundupError) {
      throw new RoundupError(error.code, error.message, error.details, billed);
    }
    throw error;
  }
  const deterministicMarkdown = renderMarkdown(deterministic, loaded.template);
  const generatedMarkdown = renderMarkdown(slots, loaded.template);
  if (generatedMarkdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new RoundupError(
      'response_too_long',
      'the generated round-up renders past the stored bound',
      { characters: generatedMarkdown.length, bound: MAX_MARKDOWN_CHARACTERS },
      billed,
    );
  }
  assertOnlySelectedUrls(deterministicMarkdown, input, billed);
  assertOnlySelectedUrls(generatedMarkdown, input, billed);
  return {
    deterministic: {
      slots: deterministic,
      markdown: deterministicMarkdown,
    },
    generated: { slots, markdown: generatedMarkdown },
    provenance: {
      model: response.model,
      promptVersion: PROMPT_VERSION,
      promptHash: promptHash(loaded.template),
      templateVersion: loaded.template.version,
      templateHash: loaded.hash,
      inputDigest: prepared.inputDigest,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costMicrodollars: costMicrodollars(response.usage),
    },
  };
}
