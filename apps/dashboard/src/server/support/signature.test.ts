import { describe, expect, it } from 'vitest';

import { parseSignatureHeader, signPayload, verifySignature } from './signature.ts';

const SECRET = 'whsec_' + 'k'.repeat(32);
const BODY = '{"id":"evt_test_0000000001","object":"event","type":"invoice.paid"}';
const NOW = 1_800_000_000;

describe('Stripe signature verification', () => {
  it('accepts a signature built as Stripe documents it, with a v0 element ignored', () => {
    const v1 = signPayload(SECRET, NOW - 10, BODY);
    const header = `t=${NOW - 10},v1=${v1},v0=${'0'.repeat(64)}`;
    expect(verifySignature({ payload: BODY, header, secret: SECRET, nowSeconds: NOW })).toBe('ok');
    expect(parseSignatureHeader(header)).toEqual({ timestamp: NOW - 10, signatures: [v1] });
  });

  it('accepts any one of several v1 signatures, as during a secret roll', () => {
    const old = 'whsec_' + 'o'.repeat(32);
    const header = `t=${NOW},v1=${signPayload(old, NOW, BODY)},v1=${signPayload(SECRET, NOW, BODY)}`;
    expect(verifySignature({ payload: BODY, header, secret: SECRET, nowSeconds: NOW })).toBe('ok');
    expect(verifySignature({ payload: BODY, header, secret: old, nowSeconds: NOW })).toBe('ok');
  });

  it('refuses a wrong secret, a tampered body, a tampered timestamp and a v0-only header', () => {
    const v1 = signPayload(SECRET, NOW, BODY);
    const wrongSecret = verifySignature({
      payload: BODY,
      header: `t=${NOW},v1=${v1}`,
      secret: 'whsec_' + 'x'.repeat(32),
      nowSeconds: NOW,
    });
    const tamperedBody = verifySignature({
      payload: BODY.replace('invoice.paid', 'invoice.void'),
      header: `t=${NOW},v1=${v1}`,
      secret: SECRET,
      nowSeconds: NOW,
    });
    const tamperedTime = verifySignature({
      payload: BODY,
      header: `t=${NOW + 1},v1=${v1}`,
      secret: SECRET,
      nowSeconds: NOW,
    });
    const v0Only = verifySignature({
      payload: BODY,
      header: `t=${NOW},v0=${v1}`,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect([wrongSecret, tamperedBody, tamperedTime, v0Only]).toEqual([
      'mismatch',
      'mismatch',
      'mismatch',
      'malformed',
    ]);
  });

  it('refuses a stale timestamp beyond five minutes, in either direction, and accepts one inside', () => {
    const at = (timestamp: number) =>
      verifySignature({
        payload: BODY,
        header: `t=${timestamp},v1=${signPayload(SECRET, timestamp, BODY)}`,
        secret: SECRET,
        nowSeconds: NOW,
      });
    expect([at(NOW - 301), at(NOW + 301), at(NOW - 300), at(NOW + 300)]).toEqual([
      'stale',
      'stale',
      'ok',
      'ok',
    ]);
  });

  it('treats a missing, empty, oversized or misshapen header as malformed, never as a match', () => {
    const cases = [
      null,
      '',
      't=abc,v1=' + 'a'.repeat(64),
      `t=${NOW},v1=short`,
      `t=${NOW}`,
      'v1=' + 'a'.repeat(64),
      `t=${NOW},t=${NOW},v1=${'a'.repeat(64)}`,
      `t=${NOW},v1=${'a'.repeat(64)},garbage`,
      'x'.repeat(5_000),
    ];
    for (const header of cases) {
      expect(verifySignature({ payload: BODY, header, secret: SECRET, nowSeconds: NOW })).toBe(
        'malformed',
      );
    }
  });
});
