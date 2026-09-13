import { describe, expect, it } from 'vitest';

import type { Database } from '@cas/database';

import { insertSynthetic, syntheticAccount } from '../../test/synthetic-accounts.ts';
import { openMemoryStores } from '../auth/memory-store.ts';
import { ROLES, type Role } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { isDashboardError } from '../errors.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import {
  assignRole,
  decideEvidence,
  disableAccount,
  mergeIncidentsAction,
  provisionAccount,
  revokeAccountSessions,
  reviewQueueEntry,
  saveDraftRevision,
  setAccountExpiry,
  splitIncidentAction,
} from './mutate.ts';
import {
  administration,
  anomalyView,
  commandCenter,
  draftView,
  evidenceView,
  incidentDetail,
  incidentExplorer,
  reviewQueue,
} from './read.ts';

/**
 * Authorization at the data-access layer, proven without a database.
 *
 * The runtime's database handle throws on any use, so a call that reaches it
 * fails the test. Every unauthenticated call, every judge attempt at a
 * mutation and every editor attempt at administration must therefore be
 * refused before the store is consulted, and every refusal must be a fixed
 * authentication or authorization failure.
 */

const ID = '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab';
const OTHER = '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ac';

const untouchable: Database = new Proxy({} as Database, {
  get(_target, property) {
    if (property === 'schema') return 'public';
    return () => {
      throw new Error(`database must not be reached (${String(property)})`);
    };
  },
});

async function runtimeFor(): Promise<{ runtime: Runtime; principals: Record<Role, Principal> }> {
  const stores = await openMemoryStores(null);
  const runtime = createRuntime(
    {
      environment: 'local',
      accountStore: 'memory',
      memorySeedPath: null,
      databaseSchema: 'public',
      trustForwardedFor: false,
    },
    stores,
    untouchable,
  );
  const principals = {} as Record<Role, Principal>;
  for (const role of ROLES) {
    const account = await syntheticAccount(role);
    await insertSynthetic(stores, account);
    principals[role] = {
      accountId: account.record.id,
      username: account.record.username,
      role,
      sessionId: `session-${role}`,
      sessionToken: 'a'.repeat(43),
    };
  }
  return { runtime, principals };
}

type Call = (runtime: Runtime, who: Principal | null) => Promise<unknown>;

const READS: Readonly<Record<string, Call>> = {
  commandCenter: (r, p) => commandCenter(r, p),
  incidentExplorer: (r, p) => incidentExplorer(r, p, ID, null),
  incidentDetail: (r, p) => incidentDetail(r, p, ID, OTHER),
  reviewQueue: (r, p) => reviewQueue(r, p, ID, 0),
  evidenceView: (r, p) => evidenceView(r, p, ID),
  anomalyView: (r, p) =>
    anomalyView(r, p, { signalRunId: ID, asOf: null, clusteringRunId: null, windows: [] }),
  draftView: (r, p) => draftView(r, p, ID, '2026-08-09T00:00:00Z', '2026-08-16T00:00:00Z'),
  administration: (r, p) => administration(r, p),
};

const MUTATIONS: Readonly<Record<string, Call>> = {
  reviewQueueEntry: (r, p) =>
    reviewQueueEntry(r, p, {
      classificationRunId: ID,
      sourceRowId: OTHER,
      reviewState: 'selected',
      reasonCode: 'editorial_judgement',
      note: null,
    }),
  mergeIncidentsAction: (r, p) =>
    mergeIncidentsAction(r, p, {
      clusteringRunId: ID,
      incidentIds: [ID, OTHER],
      reasonCode: 'same_incident',
      note: null,
      expectedRevision: 0,
    }),
  splitIncidentAction: (r, p) =>
    splitIncidentAction(r, p, {
      clusteringRunId: ID,
      incidentId: ID,
      membershipIds: [OTHER],
      reasonCode: 'distinct_incident',
      note: null,
      expectedRevision: 0,
    }),
  decideEvidence: (r, p) =>
    decideEvidence(r, p, {
      evidenceRunId: ID,
      associationId: OTHER,
      operation: 'accept',
      relation: 'context',
      claimId: null,
      reasonCode: 'editorial_review',
      rationale: null,
    }),
  saveDraftRevision: (r, p) =>
    saveDraftRevision(r, p, {
      evidenceRunId: ID,
      periodStart: '2026-08-09T00:00:00Z',
      periodEnd: '2026-08-16T00:00:00Z',
      expectedRevision: 0,
      markdown: '# draft',
    }),
  provisionAccount: (r, p) =>
    provisionAccount(r, p, {
      username: 'syn_new',
      role: 'editor',
      expiresAt: null,
      password: 'synthetic-provision-passphrase',
      rotate: false,
    }),
  disableAccount: (r, p) => disableAccount(r, p, ID),
  assignRole: (r, p) => assignRole(r, p, { accountId: ID, role: 'editor', expiresAt: null }),
  setAccountExpiry: (r, p) => setAccountExpiry(r, p, ID, null),
  revokeAccountSessions: (r, p) => revokeAccountSessions(r, p, ID),
};

const ADMIN_ONLY = new Set([
  'administration',
  'provisionAccount',
  'disableAccount',
  'assignRole',
  'setAccountExpiry',
  'revokeAccountSessions',
]);
const EDITOR_ONLY_READS = new Set(['reviewQueue', 'draftView']);

async function kindOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (isDashboardError(error)) return error.kind;
    return `unexpected:${(error as Error).message}`;
  }
  return 'succeeded';
}

describe('data-access layer authorization without a database', () => {
  it('refuses every read and every mutation without a session', async () => {
    const { runtime } = await runtimeFor();
    for (const [name, call] of Object.entries({ ...READS, ...MUTATIONS })) {
      expect(await kindOf(call(runtime, null)), name).toBe('authentication');
    }
  });

  it('refuses every mutation and every editorial or administrative read to a judge', async () => {
    const { runtime, principals } = await runtimeFor();
    for (const [name, call] of Object.entries(MUTATIONS)) {
      expect(await kindOf(call(runtime, principals.judge)), name).toBe('authorization');
    }
    for (const name of [...ADMIN_ONLY, ...EDITOR_ONLY_READS]) {
      const call = READS[name];
      if (call === undefined) continue;
      expect(await kindOf(call(runtime, principals.judge)), name).toBe('authorization');
    }
  });

  it('refuses every administrative function to an editor', async () => {
    const { runtime, principals } = await runtimeFor();
    for (const name of ADMIN_ONLY) {
      const call = READS[name] ?? MUTATIONS[name];
      if (call === undefined) throw new Error(`unknown call ${name}`);
      expect(await kindOf(call(runtime, principals.editor)), name).toBe('authorization');
    }
  });

  it('lets an authorized principal past the gate, where the untouchable database then stops it', async () => {
    const { runtime, principals } = await runtimeFor();
    // A read that needs the database reaches it and fails there, proving the
    // gate opened; the failure is mapped to a generic unavailable, never a
    // stack or a driver message.
    const kind = await kindOf(commandCenter(runtime, principals.judge));
    expect(kind).toBe('unavailable');
    try {
      await commandCenter(runtime, principals.judge);
    } catch (error) {
      expect((error as Error).message).not.toContain('must not be reached');
    }
  });

  it('validates identifiers before touching anything, with fixed codes', async () => {
    const { runtime, principals } = await runtimeFor();
    expect(await kindOf(incidentDetail(runtime, principals.editor, 'not-a-uuid', ID))).toBe(
      'validation',
    );
    expect(
      await kindOf(
        mergeIncidentsAction(runtime, principals.editor, {
          clusteringRunId: ID,
          incidentIds: [ID, ID],
          reasonCode: 'same_incident',
          note: null,
          expectedRevision: 0,
        }),
      ),
    ).toBe('validation');
    expect(
      await kindOf(
        saveDraftRevision(runtime, principals.editor, {
          evidenceRunId: ID,
          periodStart: '2026-08-09T00:00:00Z',
          periodEnd: '2026-08-16T00:00:00Z',
          expectedRevision: 0,
          markdown: `body ${String.fromCodePoint(0x202e)}`,
        }),
      ),
    ).toBe('validation');
    expect(
      await kindOf(
        decideEvidence(runtime, principals.editor, {
          evidenceRunId: ID,
          associationId: OTHER,
          operation: 'accept',
          relation: 'supports',
          claimId: null,
          reasonCode: 'Editorial',
          rationale: null,
        }),
      ),
    ).toBe('validation');
  });

  it('applies the account rules: judge expiry, self-disable, self-role change, rotation scope', async () => {
    const { runtime, principals } = await runtimeFor();
    const admin = principals.admin;
    expect(
      await kindOf(
        provisionAccount(runtime, admin, {
          username: 'syn_judge_new',
          role: 'judge',
          expiresAt: null,
          password: 'synthetic-provision-passphrase',
          rotate: false,
        }),
      ),
    ).toBe('validation');
    expect(
      await kindOf(
        provisionAccount(runtime, admin, {
          username: 'syn_judge_new',
          role: 'judge',
          expiresAt: '2020-01-01T00:00:00Z',
          password: 'synthetic-provision-passphrase',
          rotate: false,
        }),
      ),
    ).toBe('validation');
    expect(
      await kindOf(
        provisionAccount(runtime, admin, {
          username: 'syn_judge_new',
          role: 'judge',
          expiresAt: '2030-01-01T00:00:00Z',
          password: 'short',
          rotate: false,
        }),
      ),
    ).toBe('validation');
    const created = await provisionAccount(runtime, admin, {
      username: 'syn_judge_new',
      role: 'judge',
      expiresAt: '2030-01-01T00:00:00Z',
      password: 'synthetic-provision-passphrase',
      rotate: false,
    });
    expect(created.outcome).toBe('created');
    expect(
      await kindOf(
        provisionAccount(runtime, admin, {
          username: 'syn_judge_new',
          role: 'judge',
          expiresAt: '2030-01-01T00:00:00Z',
          password: 'another-synthetic-passphrase',
          rotate: false,
        }),
      ),
    ).toBe('conflict');
    const rotated = await provisionAccount(runtime, admin, {
      username: 'syn_judge_new',
      role: 'judge',
      expiresAt: '2030-01-01T00:00:00Z',
      password: 'another-synthetic-passphrase',
      rotate: true,
    });
    expect(rotated.outcome).toBe('rotated');
    expect(await kindOf(disableAccount(runtime, admin, admin.accountId))).toBe('validation');
    expect(
      await kindOf(
        assignRole(runtime, admin, {
          accountId: admin.accountId,
          role: 'judge',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
      ),
    ).toBe('validation');
    expect(
      await kindOf(
        assignRole(runtime, admin, {
          accountId: created.accountId,
          role: 'judge',
          expiresAt: null,
        }),
      ),
    ).toBe('validation');
    await assignRole(runtime, admin, {
      accountId: created.accountId,
      role: 'editor',
      expiresAt: null,
    });
    const stored = await runtime.stores.accounts.getById(created.accountId);
    expect(stored?.role).toBe('editor');
    expect(stored?.expiresAt).toBeNull();
    const audit = await runtime.stores.audit.list(20);
    expect(audit.map((event) => event.kind)).toContain('account_role_assigned');
    expect(audit.map((event) => event.kind)).toContain('account_password_rotated');
    expect(JSON.stringify(audit)).not.toContain('synthetic-provision-passphrase');
  });
});
