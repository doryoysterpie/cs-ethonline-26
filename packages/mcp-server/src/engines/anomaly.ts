import type { AnomalyLabel, ChainId, DataOrigin } from '@cas/contracts';
import { chainAnomalies, EVIDENCE_CONTRACT } from '@cas/evidence';

/**
 * The anomaly labeller, behind an interface.
 *
 * The labels a stored signal run receives here are the labels the worker's
 * `evidence anomaly` command gives the same run, because both call the same
 * pure function in `@cas/evidence`. That package is Sprint 5 work and is
 * under correction; this adapter is the only file that imports it for
 * labelling, so final integration re-points one file at the Codex-accepted
 * Sprint 5 revision and nothing else moves.
 */

export interface ChainSeries {
  readonly targetId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly dataOrigin: DataOrigin;
  readonly provenanceId: string;
  readonly observations: readonly { readonly observedAt: number; readonly deltaPercent: string }[];
}

export interface ChainAnomalyEntry {
  readonly label: AnomalyLabel;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly observationWindow: { readonly startsAt: number; readonly endsAt: number };
  readonly baselineWindow: { readonly startsAt: number; readonly endsAt: number } | null;
  readonly value: string;
  readonly threshold: string;
  readonly dataOrigin: DataOrigin;
  readonly provenanceId: string;
  readonly reasonCodes: readonly string[];
  readonly evidenceLimitation: string;
}

export interface AnomalyLabeller {
  /** Observations read per target before labelling. */
  readonly maximumObservationsPerTarget: number;
  /** Most entries one evaluation may return. */
  readonly maximumEntries: number;
  label(series: readonly ChainSeries[], asOfSeconds: number): ChainAnomalyEntry[];
}

/** The shipped labeller: the Sprint 5 contract, unchanged. */
export const evidenceContractLabeller: AnomalyLabeller = Object.freeze({
  maximumObservationsPerTarget: EVIDENCE_CONTRACT.anomaly.maximumObservationsPerTarget,
  maximumEntries: EVIDENCE_CONTRACT.anomaly.maximumFeedEntries,
  label(series: readonly ChainSeries[], asOfSeconds: number): ChainAnomalyEntry[] {
    return chainAnomalies(
      series.map((target) => ({
        targetId: target.targetId,
        chain: target.chain,
        protocolSlug: target.protocolSlug,
        dataOrigin: target.dataOrigin,
        provenanceId: target.provenanceId,
        observations: target.observations.map((o) => ({
          observedAt: o.observedAt,
          deltaPercent: o.deltaPercent,
        })),
      })),
      asOfSeconds,
    ).map((entry) => ({
      label: entry.label,
      chain: entry.chain ?? 'ethereum',
      protocolSlug: entry.protocolSlug ?? '',
      observationWindow: entry.observationWindow,
      baselineWindow: entry.baselineWindow,
      value: entry.value,
      threshold: entry.threshold,
      dataOrigin: entry.dataOrigin,
      provenanceId: entry.provenanceId,
      reasonCodes: entry.reasonCodes,
      evidenceLimitation: entry.evidenceLimitation,
    }));
  },
});
