import 'server-only';

import { DashboardError, isDashboardError } from '../errors.ts';
import type { WorkspacePackages } from '../packages.ts';

/**
 * Maps a failure from a lower layer to a dashboard failure with a fixed
 * message. A worker `IngestionError` carries a fixed message by construction,
 * so its message is safe to show; a database error is reduced to one
 * sentence with no SQLSTATE and no driver text; anything unrecognised is a
 * generic failure.
 */
const CONFLICTS = new Set([
  'stale_revision',
  'review_action_conflict',
  'evidence_action_conflict',
  'draft_exists',
]);

const MISSING = new Set([
  'clustering_run_not_found',
  'clustering_run_not_completed',
  'evidence_run_not_completed',
  'evidence_run_not_found',
  'signal_run_not_completed',
  'association_not_found',
  'incident_not_effective',
  'claim_not_found',
]);

export function mapFailure(error: unknown, packages: WorkspacePackages): DashboardError {
  if (isDashboardError(error)) return error;
  if (packages.worker.isIngestionError(error)) {
    if (CONFLICTS.has(error.code)) return new DashboardError('conflict', error.code, error.message);
    if (MISSING.has(error.code)) return new DashboardError('not_found', error.code, error.message);
    if (error.kind === 'configuration' || error.kind === 'structural') {
      return new DashboardError('validation', error.code, error.message);
    }
    return new DashboardError(
      'unavailable',
      error.code,
      'the store could not complete the request',
    );
  }
  if (packages.database.isDatabaseError(error)) {
    return new DashboardError(
      'unavailable',
      `database_${error.kind}`,
      'the store could not complete the request',
    );
  }
  return new DashboardError('unavailable', 'unexpected', 'the request could not be completed');
}
