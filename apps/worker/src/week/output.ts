import type { Redactor } from '@cas/database';

import { toSingleLine } from '../editorial/display.js';
import type { WeekRunOutcome } from './run.js';

/** Count-only, identifier-only lines; no title, URL or cell ever appears here. */
export function formatWeekRunOutcome(outcome: WeekRunOutcome, redact: Redactor): string[] {
  const week = outcome.week;
  const head =
    outcome.outcome === 'ran'
      ? `week:run: ran week=${week.id}`
      : `week:run: already ran as week=${week.id}; nothing new written`;
  const lines = [
    `${head} status=${week.status} origin=${week.dataOrigin} batch=${week.batchId}`,
    `window: ${week.windowStart}..${week.windowEnd} zone=${week.timeZone} freeze=${week.freezeAt} publicationCutoff=${week.publicationCutoffAt}`,
    `categories: ${week.categories.join(',')}`,
    ...outcome.children.map(
      (child) =>
        `child position=${child.position} kind=${child.kind}${child.category === null ? '' : ` category=${child.category}`} outcome=${child.outcome}${
          child.batchId === null ? '' : ` batch=${child.batchId}`
        }${child.classificationRunId === null ? '' : ` run=${child.classificationRunId}`}${
          child.clusteringRunId === null ? '' : ` run=${child.clusteringRunId}`
        }${child.errorCode === null ? '' : ` error=${child.errorCode}`}`,
    ),
    `timing: started=${week.startedAt} completed=${week.completedAt} durationMs=${outcome.durationMs}`,
  ];
  return lines.map((line) => toSingleLine(redact(line)));
}
