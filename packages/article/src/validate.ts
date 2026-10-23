import { ArticleError } from './errors.js';
import { readableRows, unreadRows, type ArticleInput, type ArticleRow } from './input.js';
import { ArticleSlotsSchema, CONTRACT, SECTIONS, type ArticleSlots } from './schema.js';
import { countWords, normalizeForMatch, quotedSpans } from './text.js';

/**
 * A model response is accepted only when it rests on the selection as read:
 * every citation a read source of the selection, no citation of a source not
 * read, the not-read list echoed, every quotation found verbatim in a cited
 * source's text, the section order and the required sections, the bounds on
 * the headline, the standfirst and the length, and the naming basis under
 * D4 mechanically checked. One violation rejects the whole response; nothing
 * partial is kept. Messages carry codes and counts, never the response's text.
 */
export function validateArticle(raw: unknown, input: ArticleInput): ArticleSlots {
  const parsed = ArticleSlotsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArticleError('response_invalid', 'the response does not match the article schema', {
      issues: parsed.error.issues.length,
    });
  }
  const slots = parsed.data;
  const readable = new Map<string, ArticleRow>(
    readableRows(input).map((row) => [row.sourceRowId, row]),
  );
  const unread = new Set(unreadRows(input).map((row) => row.sourceRowId));
  const expectedNotRead = [...unread].sort();
  const givenNotRead = [...new Set(slots.notRead)].sort();
  if (
    expectedNotRead.length !== givenNotRead.length ||
    expectedNotRead.some((id, i) => id !== givenNotRead[i])
  ) {
    throw new ArticleError('response_not_read_differs', 'the not-read list was not echoed exactly');
  }
  const citationsOf = (citations: readonly string[], where: string): ArticleRow[] =>
    citations.map((id) => {
      if (unread.has(id)) {
        throw new ArticleError('response_citation_unread', 'a citation names a source not read', {
          where,
        });
      }
      const row = readable.get(id);
      if (row === undefined) {
        throw new ArticleError(
          'response_citation_outside_selection',
          'a citation names a row outside the selection',
          { where },
        );
      }
      return row;
    });

  // The headline.
  const headlineWords = countWords(slots.headline);
  if (
    headlineWords === 0 ||
    headlineWords > CONTRACT.headlineWordsMax ||
    slots.headline.includes('?') ||
    (slots.headline.match(/:/gu)?.length ?? 0) > 1
  ) {
    throw new ArticleError('response_headline', 'the headline breaks the contract', {
      words: headlineWords,
    });
  }
  // The standfirst and the length.
  const standfirstWords = countWords(slots.standfirst);
  if (
    standfirstWords < CONTRACT.standfirstWords.min ||
    standfirstWords > CONTRACT.standfirstWords.max
  ) {
    throw new ArticleError('response_length', 'the standfirst is outside its bounds', {
      standfirstWords,
    });
  }
  const bodyWords = slots.paragraphs.reduce((sum, p) => sum + countWords(p.text), 0);
  const wordCount = standfirstWords + bodyWords;
  if (wordCount < CONTRACT.words.min || wordCount > CONTRACT.words.max) {
    throw new ArticleError('response_length', 'the article is outside its length bounds', {
      wordCount,
    });
  }
  // Sections: the fixed order, the required ones, one prior-context paragraph at most.
  let last = -1;
  let priorContext = 0;
  const present = new Set<string>();
  for (const [index, paragraph] of slots.paragraphs.entries()) {
    const position = SECTIONS.indexOf(paragraph.section);
    if (position < last) {
      throw new ArticleError('response_section_order', 'a paragraph is out of section order', {
        paragraph: index,
      });
    }
    last = position;
    present.add(paragraph.section);
    if (paragraph.section === 'prior_context') priorContext += 1;
  }
  if (!present.has('what_happened') || !present.has('next_step') || priorContext > 1) {
    throw new ArticleError(
      'response_section_missing',
      'a required section is missing or prior context repeats',
    );
  }
  // Citations and quotations, paragraph by paragraph.
  for (const [index, paragraph] of slots.paragraphs.entries()) {
    const cited = citationsOf(paragraph.citations, `paragraph ${index}`);
    const texts = cited.map((row) => normalizeForMatch(row.reading.text ?? ''));
    for (const span of quotedSpans(paragraph.text)) {
      if (countWords(span) < CONTRACT.quotationWordsMin) continue;
      const needle = normalizeForMatch(span);
      if (!texts.some((text) => text.includes(needle))) {
        throw new ArticleError(
          'response_quotation_not_found',
          'a quotation is not found in any source the paragraph cites',
          { paragraph: index },
        );
      }
    }
  }
  // The naming basis (D4): checked where it can be checked.
  const naming = slots.victimNaming;
  if (naming.named) {
    if (naming.basis === 'none' || naming.organization === null || naming.citations.length === 0) {
      throw new ArticleError(
        'response_naming_basis',
        'a named victim needs a basis and its sources',
      );
    }
    const basisRows = citationsOf(naming.citations, 'victimNaming');
    if (naming.basis === 'two_independent') {
      const publishers = new Set(basisRows.map((row) => row.publisher.toLowerCase()));
      if (basisRows.length < 2 || publishers.size < 2) {
        throw new ArticleError(
          'response_naming_basis',
          'two independent reports need two read sources from distinct publishers',
        );
      }
    }
  } else if (
    naming.basis !== 'none' ||
    naming.organization !== null ||
    naming.citations.length !== 0
  ) {
    throw new ArticleError('response_naming_basis', 'an unnamed victim carries no basis');
  }
  return slots;
}

/** The word count the provenance records: the standfirst and the paragraphs. */
export function wordCountOf(slots: ArticleSlots): number {
  return (
    countWords(slots.standfirst) + slots.paragraphs.reduce((sum, p) => sum + countWords(p.text), 0)
  );
}
