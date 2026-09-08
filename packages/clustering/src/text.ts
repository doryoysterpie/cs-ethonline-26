import { createHash } from 'node:crypto';

import { CLUSTERING_CONTRACT, type ClusteringContract } from './contract.js';
import type { ClusteringInput } from './input.js';

/**
 * Text assembly, normalization, tokenization and fingerprinting, driven
 * entirely by the behaviour contract. Field order, the Unicode form, the case
 * rule, the character limit, the token pattern, the minimum token length, the
 * token cap, the stop terms and every fingerprint parameter are read from the
 * contract, so changing any of them changes both what the engine does and the
 * contract hash. Whitespace collapsing and the joiner are fixed engine
 * behaviour rather than contract fields, because tokenization ignores every
 * character that is not part of a token, so neither can change a decision.
 *
 * Source text is hostile evidence. It is normalized, split and hashed. It is
 * never interpreted, never executed and never concatenated into a query.
 */

const WHITESPACE = /\s+/gu;

export function normalizeForMatching(
  value: string,
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string {
  const assembly = contract.textAssembly;
  let text = value.normalize(assembly.unicodeNormalizationForm);
  if (assembly.caseNormalization === 'lowercase') text = text.toLowerCase();
  // Always collapsed: whitespace is never part of a token, so this bounds the
  // text without being able to change any decision.
  return text.replace(WHITESPACE, ' ').trim();
}

export function assembleText(
  input: ClusteringInput,
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string {
  const assembly = contract.textAssembly;
  const record = input as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of assembly.fieldOrder) {
    const raw = record[field];
    // An absent or empty field contributes no tokens, so it is skipped rather
    // than represented; no treatment of it could change a decision.
    if (raw === null || raw === undefined) continue;
    const normalized = normalizeForMatching(String(raw), contract);
    if (normalized.length === 0) continue;
    parts.push(normalized);
  }
  // A single space, which is never part of a token, so the join itself can
  // never create, destroy or alter one.
  const joined = parts.join(' ');
  if (assembly.maxInputCharacters === null) return joined;
  return joined.slice(0, assembly.maxInputCharacters);
}

/** Tokens in document order, bounded by the contract's token cap. */
export function tokenize(
  text: string,
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string[] {
  const rules = contract.tokenization;
  const tokens: string[] = [];
  for (const match of text.matchAll(new RegExp(rules.tokenPattern, 'gu'))) {
    const token = match[0];
    if (token.length < rules.minimumTokenLength) continue;
    tokens.push(token);
    if (tokens.length >= rules.maximumTokens) break;
  }
  return tokens;
}

/**
 * Distinctive tokens: sorted, de-duplicated, stop terms removed and short
 * tokens dropped. These are the only tokens that may support an incident
 * grouping, which is what stops two reports merging because both say "attack".
 */
export function distinctiveTokens(
  tokens: readonly string[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string[] {
  const stop = new Set(contract.tokenization.stopTerms);
  const minimum = contract.incident.minimumDistinctiveTokenLength;
  const kept = new Set<string>();
  for (const token of tokens) {
    if (token.length < minimum) continue;
    if (stop.has(token)) continue;
    kept.add(token);
  }
  return [...kept].sort();
}

/**
 * Overlapping token shingles, as sorted unique strings. Shingles capture word
 * order, which is what separates the same wording carried by two publishers
 * from two different reports that share vocabulary.
 */
export function shingles(
  tokens: readonly string[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string[] {
  const rules = contract.fingerprint;
  const size = Math.max(1, rules.shingleSize);
  const out = new Set<string>();
  // A text shorter than one shingle produces none. Two short identical
  // fragments would otherwise match perfectly on a single degenerate shingle,
  // which is far too little evidence to call two rows the same reporting.
  if (tokens.length < size) return [];
  const separator = rules.componentSeparator;
  for (let index = 0; index + size <= tokens.length; index += 1) {
    out.add(tokens.slice(index, index + size).join(separator));
    if (out.size >= rules.maximumShingles) break;
  }
  return [...out].sort();
}

/** Contract-parameterized digest over already-sorted components. */
export function fingerprintOf(
  components: readonly string[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): string {
  const rules = contract.fingerprint;
  const separator = rules.componentSeparator;
  return createHash(rules.algorithm)
    .update(components.join(separator), 'utf8')
    .digest('hex')
    .slice(0, rules.digestLength);
}

/** Jaccard or containment over two sorted unique string arrays, per the contract. */
export function similarityOf(
  left: readonly string[],
  right: readonly string[],
  contract: ClusteringContract = CLUSTERING_CONTRACT,
): number {
  if (left.length === 0 || right.length === 0) return 0;
  const smaller = left.length <= right.length ? left : right;
  const larger = left.length <= right.length ? right : left;
  const lookup = new Set(larger);
  let shared = 0;
  for (const value of smaller) if (lookup.has(value)) shared += 1;
  if (contract.similarity.function === 'containment') return shared / smaller.length;
  const union = left.length + right.length - shared;
  return union === 0 ? 0 : shared / union;
}

/** How many values two sorted unique arrays share. */
export function sharedCount(left: readonly string[], right: readonly string[]): number {
  const smaller = left.length <= right.length ? left : right;
  const lookup = new Set(left.length <= right.length ? right : left);
  let shared = 0;
  for (const value of smaller) if (lookup.has(value)) shared += 1;
  return shared;
}
