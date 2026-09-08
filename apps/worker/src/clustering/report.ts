import {
  countClustersByKind,
  getClusteringRun,
  type ClusteringRunRecord,
  type Database,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/** Count-only reporting for one explicit clustering run. */

export interface ClusteringReport {
  readonly run: ClusteringRunRecord;
  readonly kinds: readonly { readonly kind: string; readonly count: number }[];
  readonly reconciled: boolean;
}

export async function reportClusteringRun(db: Database, runId: string): Promise<ClusteringReport> {
  const run = await db.withClient((client) => getClusteringRun(client, runId));
  if (run === null) {
    throw new IngestionError(
      'configuration',
      'clustering_run_not_found',
      'no clustering run with that id',
    );
  }
  const kinds = await db.withClient((client) => countClustersByKind(client, runId));
  const members = kinds.reduce((total, entry) => total + entry.count, 0);
  return {
    run,
    kinds,
    // A completed run was validated by the database on completion; this is the
    // read-side restatement of the same invariant.
    reconciled:
      run.status === 'completed' &&
      run.incidentCount === members &&
      run.incidentCount === run.singletonIncidentCount + run.multiSourceIncidentCount,
  };
}
