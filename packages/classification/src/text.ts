import { BEHAVIOR_CONTRACT, type BehaviorContract } from './contract.js';
import type { ClassificationInput } from './input.js';

/**
 * Text assembly and normalization, driven entirely by the behaviour contract.
 *
 * Field order, the separator, null and empty handling, the Unicode form, the
 * case rule, the whitespace rule and the absence of truncation are read from
 * `contract.textAssembly`, so changing any of them changes the ruleset hash.
 */

const WHITESPACE = /\s+/gu;

/**
 * Applies the contract's normalization: Unicode form, then locale-independent
 * lower casing, then whitespace collapse and trim.
 */
export function normalizeForMatching(
  value: string,
  contract: BehaviorContract = BEHAVIOR_CONTRACT,
): string {
  const assembly = contract.textAssembly;
  let text = value.normalize(assembly.unicodeNormalizationForm);
  if (assembly.caseNormalization === 'locale-independent-lowercase') text = text.toLowerCase();
  if (assembly.whitespaceNormalization === 'collapse-runs-to-single-space-and-trim') {
    text = text.replace(WHITESPACE, ' ').trim();
  }
  return text;
}

/**
 * Joins the contract's fields in the contract's order with the contract's
 * separator. Absent and empty fields are skipped as the contract declares.
 * Nothing is truncated: `maxInputCharacters` is null.
 */
export function assembleText(
  input: ClassificationInput,
  contract: BehaviorContract = BEHAVIOR_CONTRACT,
): string {
  const assembly = contract.textAssembly;
  const parts: string[] = [];
  for (const field of assembly.fieldOrder) {
    const raw = input[field];
    if (raw === null) {
      if (assembly.nullHandling === 'skip') continue;
    } else {
      const normalized = normalizeForMatching(raw, contract);
      if (normalized.length === 0) {
        if (assembly.emptyHandling === 'skip') continue;
      }
      parts.push(normalized);
      continue;
    }
  }
  const joined = parts.join(assembly.fieldSeparator);
  if (assembly.maxInputCharacters === null) return joined;
  return joined.slice(0, assembly.maxInputCharacters);
}
