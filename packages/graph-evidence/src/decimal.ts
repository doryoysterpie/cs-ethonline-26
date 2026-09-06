import { GraphProbeError } from './errors.js';

/**
 * Exact decimal arithmetic on the raw strings the subgraph returns, using
 * BigInt scaled integers. No floating point, no external decimal package.
 */

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export interface ScaledDecimal {
  /** Integer value scaled by 10^scale. */
  readonly value: bigint;
  readonly scale: number;
}

/** Parse a non-negative decimal string exactly. Rejects anything else. */
export function parseDecimal(raw: unknown, field: string): ScaledDecimal {
  if (typeof raw !== 'string') {
    throw new GraphProbeError('validation', `${field} is missing or not a string`, { field });
  }
  const match = DECIMAL_PATTERN.exec(raw.trim());
  if (!match) {
    throw new GraphProbeError('validation', `${field} is not a plain decimal number`, {
      field,
      raw,
    });
  }
  const integerPart = match[1] ?? '0';
  const fractionPart = match[2] ?? '';
  return { value: BigInt(integerPart + fractionPart), scale: fractionPart.length };
}

/** Parse and additionally reject zero. Negative values never match the pattern. */
export function parsePositiveDecimal(raw: unknown, field: string): ScaledDecimal {
  const parsed = parseDecimal(raw, field);
  if (parsed.value === 0n) {
    throw new GraphProbeError('validation', `${field} is zero`, { field, raw });
  }
  return parsed;
}

export function rescale(d: ScaledDecimal, scale: number): bigint {
  if (scale < d.scale) {
    throw new GraphProbeError('validation', 'cannot rescale to a smaller scale', {
      from: d.scale,
      to: scale,
    });
  }
  return d.value * 10n ** BigInt(scale - d.scale);
}

/** Render a scaled integer as a decimal string with exactly `scale` fraction digits. */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  const body = scale === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
}
