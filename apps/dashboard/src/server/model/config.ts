import 'server-only';

/**
 * The model credential (D9 resolution). Read from the environment by name,
 * never placed anywhere else. Absent means no transport: a generation then
 * fails closed with a fixed code before any request, rather than at
 * start-up, because the dashboard serves everything else without a model.
 */
export const ANTHROPIC_API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';
export const MODEL_TIMEOUT_MS = 120_000;

export interface ModelConfig {
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export function loadModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelConfig | null {
  const value = env[ANTHROPIC_API_KEY_VARIABLE];
  if (value === undefined) return null;
  const apiKey = value.trim();
  if (apiKey.length === 0) return null;
  return { apiKey, timeoutMs: MODEL_TIMEOUT_MS };
}
