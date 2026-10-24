import 'server-only';

import type { Principal } from '../auth/session.ts';
import { workspace } from '../packages.ts';
import type { Runtime } from '../runtime.ts';
import type { WeekRunDto } from './dto.ts';
import { mapFailure } from './failures.ts';
import { requireCapability } from './guard.ts';
import { weekRunDto } from './read.ts';

/**
 * What the shell's status block states (CAS-010, decisions 1 and 3): the
 * build, the latest week run, and the data instant, which is the completion
 * of the last successful import. Nothing here is measured by the dashboard
 * itself (no uptime, no load), so nothing here can be invented. Read on every
 * protected render for any signed-in principal; it carries no source text,
 * no title and no address, and it does not count against a reader's read
 * limit, since every page that renders it is itself limited.
 */
export interface ShellStatusDto {
  /** The deployed commit's first seven characters, or "local". */
  readonly build: string;
  readonly latestWeek: WeekRunDto | null;
  /** The instant the last successful import completed, or null before the first. */
  readonly asOf: string | null;
}

export async function shellStatus(
  runtime: Runtime,
  who: Principal | null,
): Promise<ShellStatusDto> {
  requireCapability(who, 'view:command_center');
  const packages = await workspace();
  const { latestCompletedImportBatch, listWeekRuns } = packages.database;
  try {
    return await runtime.database.withClient(async (client) => {
      const [week] = await listWeekRuns(client, 1);
      const batch = await latestCompletedImportBatch(client);
      return {
        build: runtime.config.buildCommit ?? 'local',
        latestWeek: week === undefined ? null : weekRunDto(week),
        asOf: batch?.completedAt ?? null,
      };
    });
  } catch (error) {
    throw mapFailure(error, packages);
  }
}
