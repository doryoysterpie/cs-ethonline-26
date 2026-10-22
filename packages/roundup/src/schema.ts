import { z } from 'zod';

/**
 * The slot schema the model's response must match (report, section 1.2).
 * Bounds are deliberate: a slot is an entry, never an article.
 */
export const SLOT_LIMITS = {
  headlineCharacters: 300,
  summaryCharacters: 1_200,
  reasonCharacters: 600,
  sourcesPerEntry: 50,
  citationsPerEntry: 50,
  entries: 200,
} as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const RundownEntrySchema = z
  .object({
    headline: z.string().min(1).max(SLOT_LIMITS.headlineCharacters),
    summary: z.string().min(1).max(SLOT_LIMITS.summaryCharacters),
    sources: z.array(z.string().min(1).max(2_048)).min(1).max(SLOT_LIMITS.sourcesPerEntry),
    citations: z.array(uuid).min(1).max(SLOT_LIMITS.citationsPerEntry),
  })
  .strict();

export const FlaggedEntrySchema = z
  .object({
    headline: z.string().min(1).max(SLOT_LIMITS.headlineCharacters),
    reason: z.string().min(1).max(SLOT_LIMITS.reasonCharacters),
    disposition: z.enum(['omit', 'carry']),
  })
  .strict();

export const RoundupSlotsSchema = z
  .object({
    rundown: z.array(RundownEntrySchema).min(1).max(SLOT_LIMITS.entries),
    flagged: z.array(FlaggedEntrySchema).max(SLOT_LIMITS.entries),
    extras: z.string().min(1).max(600),
  })
  .strict();

export type RundownEntry = z.infer<typeof RundownEntrySchema>;
export type RoundupFlagged = z.infer<typeof FlaggedEntrySchema>;
export type RoundupSlots = z.infer<typeof RoundupSlotsSchema>;

/** The JSON Schema the model is constrained to (structured output). */
export function slotsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(RoundupSlotsSchema) as Record<string, unknown>;
}
