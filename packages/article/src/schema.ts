import { z } from 'zod';

/**
 * The article's slots (report, section 1.5), in the owner's contract (D41).
 * The schema constrains the shape; the validator constrains the truth.
 */
export const SECTIONS = [
  'what_happened',
  'organization_statement',
  'scale_impact',
  'attribution',
  'not_confirmed',
  'prior_context',
  'next_step',
] as const;
export type Section = (typeof SECTIONS)[number];

export const NAMING_BASES = ['primary_statement', 'two_independent', 'none'] as const;
export type NamingBasis = (typeof NAMING_BASES)[number];

export const SLOT_LIMITS = {
  headlineCharacters: 200,
  standfirstCharacters: 600,
  paragraphCharacters: 2_000,
  paragraphs: 40,
  citationsPerParagraph: 50,
  organizationCharacters: 200,
  notRead: 10_000,
} as const;

/** The owner's bounds (D41), with the validator's tolerance where the prompt asks for a range. */
export const CONTRACT = {
  headlineWordsMax: 12,
  standfirstWords: { min: 20, max: 40, asked: { min: 25, max: 35 } },
  words: { min: 450, max: 750, asked: { min: 500, max: 700 } },
  quotationWordsMin: 4,
} as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const ParagraphSchema = z
  .object({
    section: z.enum(SECTIONS),
    text: z.string().min(1).max(SLOT_LIMITS.paragraphCharacters),
    citations: z.array(uuid).min(1).max(SLOT_LIMITS.citationsPerParagraph),
  })
  .strict();

export const VictimNamingSchema = z
  .object({
    named: z.boolean(),
    basis: z.enum(NAMING_BASES),
    organization: z.string().min(1).max(SLOT_LIMITS.organizationCharacters).nullable(),
    citations: z.array(uuid).max(10),
  })
  .strict();

export const ArticleSlotsSchema = z
  .object({
    headline: z.string().min(1).max(SLOT_LIMITS.headlineCharacters),
    standfirst: z.string().min(1).max(SLOT_LIMITS.standfirstCharacters),
    paragraphs: z.array(ParagraphSchema).min(2).max(SLOT_LIMITS.paragraphs),
    victimNaming: VictimNamingSchema,
    notRead: z.array(uuid).max(SLOT_LIMITS.notRead),
  })
  .strict();

export type ArticleParagraph = z.infer<typeof ParagraphSchema>;
export type VictimNaming = z.infer<typeof VictimNamingSchema>;
export type ArticleSlots = z.infer<typeof ArticleSlotsSchema>;

/** The JSON Schema the model is constrained to (structured output). */
export function slotsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ArticleSlotsSchema) as Record<string, unknown>;
}
