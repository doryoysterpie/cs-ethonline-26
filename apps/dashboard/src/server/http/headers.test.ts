import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, HSTS, NO_STORE, securityHeaders } from './headers.ts';

describe('content security policy', () => {
  it('is nonce-based and strict, with no inline or eval allowance anywhere', () => {
    const policy = contentSecurityPolicy('abc123');
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("img-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('*');
    expect(policy).not.toContain('data:');
  });
});

describe('security headers', () => {
  it('sets the baseline everywhere and HSTS only in production', () => {
    const local = securityHeaders('local', 'n');
    expect(local['X-Content-Type-Options']).toBe('nosniff');
    expect(local['X-Frame-Options']).toBe('DENY');
    expect(local['Referrer-Policy']).toBe('no-referrer');
    expect(local['Permissions-Policy']).toContain('camera=()');
    expect(local['Permissions-Policy']).toContain('geolocation=()');
    expect(local['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(local['Content-Security-Policy']).toContain("'nonce-n'");
    expect(local['Strict-Transport-Security']).toBeUndefined();
    const production = securityHeaders('production', 'n');
    expect(production['Strict-Transport-Security']).toBe(HSTS);
    expect(HSTS).toMatch(/^max-age=\d{8,}; includeSubDomains$/u);
    expect(NO_STORE).toContain('no-store');
    expect(NO_STORE).toContain('private');
  });
});
