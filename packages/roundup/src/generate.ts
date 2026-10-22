import {
  costMicrodollars,
  MAX_OUTPUT_TOKENS,
  MODEL_ID,
  worstCaseMicrodollars,
  wouldExceedCap,
} from './cost.js';
import { RoundupError } from './errors.js';
import { assertRoundupInput, inputDigest, type RoundupInput } from './input.js';
import { PROMPT_VERSION, promptHash, systemPrompt, userPrompt } from './prompt.js';
import { deterministicSlots, renderMarkdown } from './render.js';
import { slotsJsonSchema, type RoundupSlots } from './schema.js';
import { sectionOf, type LoadedTemplate } from './template.js';
import type { RoundupTransport } from './transport.js';
import { validateResponse } from './validate.js';

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
  const slots = validateResponse(response.raw, input, loaded.template);
  return {
    deterministic: {
      slots: deterministic,
      markdown: renderMarkdown(deterministic, loaded.template),
    },
    generated: { slots, markdown: renderMarkdown(slots, loaded.template) },
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
