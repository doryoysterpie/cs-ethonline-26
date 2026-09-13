import { createHash } from 'node:crypto';

/**
 * The one common GraphQL document used against every selected deployment.
 * Only the Subgraph ID varies between deployments; the document never does.
 *
 * It reads the standardized `Protocol` interface (Messari schema: name, slug,
 * network, type, the three version fields and the head TVL), the daily
 * financial snapshots ordered by the provider so that a ~24 h baseline is
 * available, and `_meta` for block and deployment provenance.
 */
export const STANDARDIZED_TVL_QUERY = `query CasStandardizedTvl($snapshots: Int!) {
  _meta { block { number hash timestamp } deployment hasIndexingErrors }
  protocols(first: 1) { id name slug network type schemaVersion subgraphVersion methodologyVersion totalValueLockedUSD }
  financialsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) { id timestamp blockNumber totalValueLockedUSD }
}`;

/** Number of daily snapshots requested; four covers a 24 h baseline with margin. */
export const DEFAULT_SNAPSHOT_COUNT = 4;

export function queryDocumentSha256(document: string = STANDARDIZED_TVL_QUERY): string {
  return createHash('sha256').update(document).digest('hex');
}
