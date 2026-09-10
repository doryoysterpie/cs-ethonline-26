/**
 * The one environment knob, in a module that imports nothing, so the request
 * proxy can read it without pulling the database layer into its bundle.
 * `loadDashboardConfig` re-validates it with the rest of the configuration.
 */
export const ENVIRONMENTS = ['local', 'production'] as const;
export type DashboardEnvironment = (typeof ENVIRONMENTS)[number];

export const ENVIRONMENT_VARIABLE = 'DASHBOARD_ENVIRONMENT';

/** The environment named by the variable, or null when unset or unknown. */
export function readEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): DashboardEnvironment | null {
  const value = env[ENVIRONMENT_VARIABLE]?.trim();
  return value === 'local' || value === 'production' ? value : null;
}
