import { describe, expect, it } from 'vitest';

import {
  ADMIN_CAPABILITIES,
  CAPABILITIES,
  MUTATION_CAPABILITIES,
  ROLES,
  can,
  capabilitiesOf,
  isRole,
} from './roles.ts';

/**
 * The authorization matrix, written out in full so a change to any role's
 * rights shows up as a failing test rather than a surprise in production.
 */
const MATRIX: Readonly<Record<(typeof ROLES)[number], readonly string[]>> = {
  judge: ['view:command_center', 'view:incidents', 'view:anomaly', 'view:evidence'],
  editor: [
    'view:command_center',
    'view:incidents',
    'view:anomaly',
    'view:evidence',
    'view:draft',
    'view:queue',
    'view:source_text',
    'view:notes',
    'review:queue',
    'review:incidents',
    'review:evidence',
    'edit:draft',
  ],
  admin: [
    'view:command_center',
    'view:incidents',
    'view:anomaly',
    'view:evidence',
    'view:draft',
    'view:queue',
    'view:source_text',
    'view:notes',
    'review:queue',
    'review:incidents',
    'review:evidence',
    'edit:draft',
    'admin:accounts',
    'admin:sessions',
    'view:audit',
  ],
};

describe('roles and capabilities', () => {
  it('grants exactly the listed capabilities to each role', () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(can(role, capability), `${role} ${capability}`).toBe(
          MATRIX[role].includes(capability),
        );
      }
      expect([...capabilitiesOf(role)].sort()).toEqual([...MATRIX[role]].sort());
    }
  });

  it('denies by default: unknown roles, unknown capabilities and non-strings', () => {
    expect(can('root', 'view:command_center')).toBe(false);
    expect(can('admin', 'admin:everything')).toBe(false);
    expect(can('ADMIN', 'admin:accounts')).toBe(false);
    expect(can(undefined, 'view:incidents')).toBe(false);
    expect(can('editor', undefined)).toBe(false);
    expect(can({ toString: () => 'admin' }, 'admin:accounts')).toBe(false);
    expect(isRole('judge ')).toBe(false);
  });

  it('refuses every mutation to a judge and every administrative capability to an editor', () => {
    for (const capability of MUTATION_CAPABILITIES) expect(can('judge', capability)).toBe(false);
    for (const capability of ADMIN_CAPABILITIES) expect(can('editor', capability)).toBe(false);
    expect(can('judge', 'view:source_text')).toBe(false);
    expect(can('judge', 'view:notes')).toBe(false);
    expect(can('judge', 'view:queue')).toBe(false);
  });

  it('withdraws draft preview from the judge role entirely', () => {
    expect(can('judge', 'view:draft')).toBe(false);
    expect(can('editor', 'view:draft')).toBe(true);
    expect(can('admin', 'view:draft')).toBe(true);
  });
});
