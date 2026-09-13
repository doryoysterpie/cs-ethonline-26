/**
 * Roles and capabilities. Deny by default.
 *
 * A capability is granted only where it is listed below. `can` returns false
 * for anything it does not recognise: an unknown role, an unknown capability,
 * a misspelling. There is no wildcard and no inheritance rule in code; the
 * editor and admin sets are written out in full so a reviewer can read what
 * each role can do without following a chain.
 *
 * Pure: no environment, no database, no clock.
 */

export const ROLES = ['judge', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  // Sanitized read-only views.
  'view:command_center',
  'view:incidents',
  'view:anomaly',
  'view:evidence',
  'view:draft',
  // Editorial views and text.
  'view:queue',
  'view:source_text',
  'view:notes',
  // Editorial mutations.
  'review:queue',
  'review:incidents',
  'review:evidence',
  'edit:draft',
  // Administration.
  'admin:accounts',
  'admin:sessions',
  'view:audit',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * A judge holds no `view:draft`: the production-candidate owner decision of
 * 2026-09-12 withdraws draft-preview access from the judge role entirely. A
 * judge must not receive a source headline, a source link, source text, an
 * editor note or any other unsanitized draft content — only the sanitized,
 * aggregate views below.
 */
const JUDGE: readonly Capability[] = [
  'view:command_center',
  'view:incidents',
  'view:anomaly',
  'view:evidence',
];

const EDITOR: readonly Capability[] = [
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
];

const ADMIN: readonly Capability[] = [
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
];

const PERMISSIONS: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  judge: new Set(JUDGE),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True only when the role is known and the capability is listed for it. */
export function can(role: unknown, capability: unknown): boolean {
  if (!isRole(role)) return false;
  if (typeof capability !== 'string') return false;
  if (!(CAPABILITIES as readonly string[]).includes(capability)) return false;
  return PERMISSIONS[role].has(capability as Capability);
}

/** The capabilities of a role, for display. */
export function capabilitiesOf(role: Role): readonly Capability[] {
  return [...PERMISSIONS[role]];
}

/** Every mutation a judge must be refused: used by tests to enumerate. */
export const MUTATION_CAPABILITIES: readonly Capability[] = [
  'review:queue',
  'review:incidents',
  'review:evidence',
  'edit:draft',
  'admin:accounts',
  'admin:sessions',
];

/** Everything an editor must be refused: used by tests to enumerate. */
export const ADMIN_CAPABILITIES: readonly Capability[] = [
  'admin:accounts',
  'admin:sessions',
  'view:audit',
];
