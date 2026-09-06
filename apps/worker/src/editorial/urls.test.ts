import { describe, expect, it } from 'vitest';

import { canonicalizeUrl } from './urls.js';

function canonical(raw: string): string {
  const result = canonicalizeUrl(raw);
  if (!result.ok) throw new Error(`expected canonical form, got ${result.code}`);
  return result.canonical;
}

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host, drops default ports, fragments and userinfo', () => {
    expect(canonical('HTTPS://News.Example:443/Story-Twelve/?b=2&a=1#fragment')).toBe(
      'https://news.example/Story-Twelve/?a=1&b=2',
    );
    expect(canonical('http://user:pw@news.example:80/x')).toBe('http://news.example/x');
    expect(canonical('https://news.example:8443/x')).toBe('https://news.example:8443/x');
  });

  it('removes known tracking parameters and sorts the rest deterministically', () => {
    expect(
      canonical(
        'https://news.example/story-two?utm_source=newsletter&utm_medium=email&fbclid=abc123',
      ),
    ).toBe('https://news.example/story-two');
    expect(canonical('https://news.example/story-two?gclid=zzz&mc_cid=1&mc_eid=2')).toBe(
      'https://news.example/story-two',
    );
    expect(canonical('https://news.example/a?z=1&UTM_CAMPAIGN=x&y=2&y=1&mkt_tok=t')).toBe(
      'https://news.example/a?y=1&y=2&z=1',
    );
  });

  it('preserves path case, meaningful path content and trailing-slash distinctions', () => {
    expect(canonical('https://news.example/A/b')).not.toBe(canonical('https://news.example/a/b'));
    expect(canonical('https://news.example/a')).not.toBe(canonical('https://news.example/a/'));
    expect(canonical('https://news.example/a/b/../c')).toBe('https://news.example/a/c');
  });

  it('classifies empty, unparseable and disallowed-scheme URLs', () => {
    expect(canonicalizeUrl('')).toEqual({ ok: false, code: 'url_missing' });
    expect(canonicalizeUrl('   ')).toEqual({ ok: false, code: 'url_missing' });
    expect(canonicalizeUrl('not a url at all')).toEqual({ ok: false, code: 'url_invalid' });
    expect(canonicalizeUrl('weekly.example/five-without-scheme')).toEqual({
      ok: false,
      code: 'url_invalid',
    });
    expect(canonicalizeUrl('ftp://files.example/report.txt')).toEqual({
      ok: false,
      code: 'url_scheme_not_allowed',
    });
    expect(canonicalizeUrl('javascript:alert(1)')).toEqual({
      ok: false,
      code: 'url_scheme_not_allowed',
    });
    expect(canonicalizeUrl('mailto:someone@example.test')).toEqual({
      ok: false,
      code: 'url_scheme_not_allowed',
    });
  });

  it('is a pure function that leaves its input untouched', () => {
    const raw = 'https://news.example/story-one?utm_source=x';
    const before = raw;
    canonicalizeUrl(raw);
    expect(raw).toBe(before);
  });
});
