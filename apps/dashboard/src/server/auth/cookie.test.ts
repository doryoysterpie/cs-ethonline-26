import { describe, expect, it } from 'vitest';

import {
  clearingCookieHeader,
  readCookie,
  sessionCookieAttributes,
  sessionCookieName,
} from './cookie.ts';

describe('session cookie', () => {
  it('is host-only, HttpOnly and SameSite=Strict everywhere, Secure and __Host- outside local', () => {
    const local = sessionCookieAttributes('local', 3600);
    expect(local).toEqual({
      name: 'cas_session',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/',
      maxAge: 3600,
    });
    const production = sessionCookieAttributes('production', 3600);
    expect(production.name).toBe('__Host-cas_session');
    expect(production.secure).toBe(true);
    expect(production.httpOnly).toBe(true);
    expect(production.sameSite).toBe('strict');
    expect(production.path).toBe('/');
    expect(Object.keys(production)).not.toContain('domain');
    expect(sessionCookieName('production')).toBe('__Host-cas_session');
  });

  it('clears with the same attributes', () => {
    expect(clearingCookieHeader('local')).toBe(
      'cas_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
    );
    expect(clearingCookieHeader('production')).toBe(
      '__Host-cas_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure',
    );
  });

  it('reads one cookie by exact name from a header', () => {
    expect(readCookie('a=1; cas_session=tok; b=2', 'cas_session')).toBe('tok');
    expect(readCookie('xcas_session=tok', 'cas_session')).toBeNull();
    expect(readCookie('cas_session=tok=with=equals', 'cas_session')).toBe('tok=with=equals');
    expect(readCookie(null, 'cas_session')).toBeNull();
    expect(readCookie('', 'cas_session')).toBeNull();
    expect(readCookie('garbage', 'cas_session')).toBeNull();
  });
});
