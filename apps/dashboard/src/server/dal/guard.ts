import 'server-only';

import { can, type Capability } from '../auth/roles.ts';
import type { Principal } from '../auth/session.ts';
import { forbidden, unauthenticated } from '../errors.ts';

/**
 * The one authorization gate every data-access function calls first.
 *
 * It runs before any store or database access, so a refused caller costs no
 * query and learns nothing about whether the object exists. A page, a server
 * action, a route handler and the provisioning command all reach the store
 * through functions that begin here; the request proxy redirects early for
 * convenience and is never relied on.
 */
export function requireCapability(principal: Principal | null, capability: Capability): Principal {
  if (principal === null) throw unauthenticated('session_required');
  if (!can(principal.role, capability)) throw forbidden(capability);
  return principal;
}

/** True when the principal holds the capability; never throws. */
export function holds(principal: Principal | null, capability: Capability): boolean {
  return principal !== null && can(principal.role, capability);
}
