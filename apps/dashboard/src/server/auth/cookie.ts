import type { DashboardEnvironment } from '../environment.ts';

/**
 * The session cookie.
 *
 * Host-only: no `Domain` attribute, `Path=/`. `HttpOnly` and `SameSite=Strict`
 * always. `Secure` in every environment except `local`, where the app runs
 * over plain HTTP; when it is `Secure` the name carries the `__Host-` prefix,
 * which a conforming browser accepts only for a secure, host-only, root-path
 * cookie, so the attributes are enforced by the browser as well as set here.
 *
 * Pure: shared by the server tree and unit tests.
 */

export const SESSION_COOKIE_BASE = 'cas_session';

export interface SessionCookieAttributes {
  readonly name: string;
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'strict';
  readonly path: '/';
  readonly maxAge: number;
}

export function sessionCookieName(environment: DashboardEnvironment): string {
  return environment === 'local' ? SESSION_COOKIE_BASE : `__Host-${SESSION_COOKIE_BASE}`;
}

export function sessionCookieAttributes(
  environment: DashboardEnvironment,
  maxAgeSeconds: number,
): SessionCookieAttributes {
  return {
    name: sessionCookieName(environment),
    httpOnly: true,
    secure: environment !== 'local',
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** The `Set-Cookie` header value that clears the session cookie. */
export function clearingCookieHeader(environment: DashboardEnvironment): string {
  const secure = environment !== 'local' ? '; Secure' : '';
  return `${sessionCookieName(environment)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}

/** Reads one cookie's value from a `Cookie` header. Returns null when absent. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
