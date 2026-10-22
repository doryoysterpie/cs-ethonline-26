import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { isReadError, ReadError } from './errors.js';
import { READER_LIMITS, userAgent, type ReaderLimits } from './limits.js';
import { nodeTransport } from './node-transport.js';
import { cutAtParagraph, readSources, type SourceToRead } from './read.js';
import { parseRobots, patternMatches, robotsAllows } from './robots.js';
import { checkTarget, type Resolver } from './target.js';
import { recordedTransport, type RawRequest, type RecordedPage } from './transport.js';

/**
 * The tests docs/FETCH-POLICY.md section 5 requires, one falsification per
 * rule, over the injected transport and resolver. No test opens a socket.
 */

const UA = userAgent('0.1', 'https://dashboard.example.org');

function resolver(
  table: Record<string, readonly string[] | readonly (readonly string[])[]>,
): Resolver & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  const cursors = new Map<string, number>();
  return {
    calls,
    async resolve(host) {
      calls.push(host);
      const entry = table[host];
      if (entry === undefined) throw new Error('unknown host');
      if (entry.length > 0 && Array.isArray(entry[0])) {
        const sequence = entry as readonly (readonly string[])[];
        const cursor = cursors.get(host) ?? 0;
        cursors.set(host, cursor + 1);
        return sequence[Math.min(cursor, sequence.length - 1)] ?? [];
      }
      return entry as readonly string[];
    },
  };
}

const PUBLIC = '93.184.216.34';
const HTML = (body: string, title = 'A story'): string =>
  `<!doctype html><html><head><title>${title}</title><script>alert(1)</script></head><body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;

function limits(overrides: Partial<ReaderLimits>): ReaderLimits {
  return { ...READER_LIMITS, ...overrides };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return isReadError(error) ? error.code : 'other';
  }
}

describe('rules R1 to R6: the target is checked before any connection', () => {
  it('refuses every literal loopback, private, link-local, multicast and reserved address in every encoding (test 1)', async () => {
    const r = resolver({});
    const cases: [string, string][] = [
      ['http://127.1/', 'loopback_address'],
      ['http://0x7f000001/', 'loopback_address'],
      ['http://2130706433/', 'loopback_address'],
      ['http://[::ffff:127.0.0.1]/', 'loopback_address'],
      ['http://[64:ff9b::7f00:1]/', 'loopback_address'],
      ['http://[::1]/', 'loopback_address'],
      ['http://10.0.0.1/', 'private_address'],
      ['http://172.16.5.5/', 'private_address'],
      ['http://192.168.1.1/', 'private_address'],
      ['http://100.64.0.1/', 'private_address'],
      ['http://169.254.169.254/latest/meta-data/', 'link_local_address'],
      ['http://[fe80::1]/', 'link_local_address'],
      ['http://224.0.0.1/', 'multicast_address'],
      ['http://0.0.0.0/', 'reserved_address'],
      ['http://[fc00::1]/', 'private_address'],
      ['file:///etc/passwd', 'scheme_not_permitted'],
      ['http://user:pw@example.org/', 'credentials_present'],
      ['http://localhost/', 'local_name'],
      ['http://db.internal/', 'local_name'],
      ['http://example.test/', 'reserved_name'],
      ['http://example.org:8080/', 'port_not_permitted'],
      ['https://example.org:80/', 'port_not_permitted'],
      ['not a url', 'malformed'],
    ];
    for (const [url, code] of cases) {
      expect(await codeOf(checkTarget(url, r)), url).toBe(code);
    }
    expect(r.calls).toEqual([]);
  });

  it('refuses a name that resolves to a private address, and attempts no connection (test 2)', async () => {
    const r = resolver({
      'evil.example.org': ['10.1.2.3'],
      'mixed.example.org': [PUBLIC, '127.0.0.1'],
    });
    const transport = recordedTransport({});
    const reading = await readSources(
      [
        { sourceRowId: 'a', url: 'https://evil.example.org/story' },
        { sourceRowId: 'b', url: 'https://mixed.example.org/story' },
      ],
      { transport, resolver: r, userAgent: UA },
    );
    expect(reading.outcomes.map((o) => [o.sourceRowId, o.status, o.code])).toEqual([
      ['a', 'not_read', 'resolved_address_refused'],
      ['b', 'not_read', 'resolved_address_refused'],
    ]);
    expect(transport.calls).toEqual([]);
  });

  it('connects only to the address it checked, so a rebinding name cannot move the socket (test 3)', async () => {
    const r = resolver({ 'news.example.org': [[PUBLIC], ['127.0.0.1']] });
    const transport = recordedTransport({
      'https://news.example.org/robots.txt': { status: 404 },
      'https://news.example.org/story': { body: HTML('The company said systems were restored.') },
    });
    const reading = await readSources(
      [{ sourceRowId: 'a', url: 'https://news.example.org/story' }],
      {
        transport,
        resolver: r,
        userAgent: UA,
      },
    );
    expect(reading.outcomes[0]?.status).toBe('read');
    expect(transport.calls.every((call) => call.endsWith(`@ ${PUBLIC}`))).toBe(true);
    expect(r.calls).toEqual(['news.example.org']);
  });

  it('never fetches a URL it was not given: no link, image or script on a page is requested', async () => {
    const r = resolver({ 'news.example.org': [PUBLIC] });
    const transport = recordedTransport({
      'https://news.example.org/robots.txt': { status: 404 },
      'https://news.example.org/story': {
        body: HTML(
          'See <a href="https://other.example.org/x">more</a> <img src="https://news.example.org/i.png">',
        ),
      },
    });
    await readSources([{ sourceRowId: 'a', url: 'https://news.example.org/story' }], {
      transport,
      resolver: r,
      userAgent: UA,
    });
    expect(transport.calls.map((c) => c.split(' ')[1])).toEqual([
      'https://news.example.org/robots.txt',
      'https://news.example.org/story',
    ]);
  });
});

describe('rule R7: redirects are re-checked, bounded and never downgraded (test 4)', () => {
  const r = () => resolver({ 'news.example.org': [PUBLIC], 'cdn.example.org': [PUBLIC] });
  const robots = {
    'https://news.example.org/robots.txt': { status: 404 },
    'https://cdn.example.org/robots.txt': { status: 404 },
  };

  it('refuses a redirect to a private address before connecting to it', async () => {
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/story': {
        status: 302,
        headers: { location: 'http://10.0.0.1/admin' },
      },
    });
    const reading = await readSources(
      [{ sourceRowId: 'a', url: 'https://news.example.org/story' }],
      {
        transport,
        resolver: r(),
        userAgent: UA,
      },
    );
    expect(reading.outcomes[0]?.code).toBe('private_address');
    expect(transport.calls.some((c) => c.includes('10.0.0.1'))).toBe(false);
  });

  it('refuses a chain of four and an https to http downgrade, and follows three', async () => {
    const chain: Record<string, RecordedPage> = { ...robots };
    for (let i = 0; i < 4; i += 1) {
      chain[`https://news.example.org/r${i}`] = {
        status: 301,
        headers: { location: `/r${i + 1}` },
      };
    }
    chain['https://news.example.org/r4'] = { body: HTML('end') };
    chain['https://news.example.org/down'] = {
      status: 302,
      headers: { location: 'http://news.example.org/plain' },
    };
    chain['https://news.example.org/three'] = {
      status: 307,
      headers: { location: 'https://cdn.example.org/one' },
    };
    chain['https://cdn.example.org/one'] = { status: 308, headers: { location: '/two' } };
    chain['https://cdn.example.org/two'] = {
      status: 303,
      headers: { location: 'https://news.example.org/final' },
    };
    chain['https://news.example.org/final'] = { body: HTML('Arrived after three hops.') };
    chain['https://news.example.org/nowhere'] = { status: 302 };
    const transport = recordedTransport(chain);
    const reading = await readSources(
      [
        { sourceRowId: 'four', url: 'https://news.example.org/r0' },
        { sourceRowId: 'down', url: 'https://news.example.org/down' },
        { sourceRowId: 'three', url: 'https://news.example.org/three' },
        { sourceRowId: 'nowhere', url: 'https://news.example.org/nowhere' },
      ],
      { transport, resolver: r(), userAgent: UA },
    );
    expect(reading.outcomes.map((o) => [o.sourceRowId, o.status, o.code])).toEqual([
      ['four', 'not_read', 'redirect_limit'],
      ['down', 'not_read', 'redirect_downgrade'],
      ['three', 'read', null],
      ['nowhere', 'not_read', 'redirect_refused'],
    ]);
    expect(transport.calls.some((c) => c.includes('http://news.example.org/plain'))).toBe(false);
  });
});

describe('rules R9 to R11: the body is bounded in type, size and time', () => {
  const r = () => resolver({ 'news.example.org': [PUBLIC] });
  const robots = { 'https://news.example.org/robots.txt': { status: 404 } };

  it('stops at the bound for a lying length, a body one byte over, and a compressed bomb (test 5)', async () => {
    const small = limits({ bodyBytes: 200, textCharsPerSource: 10_000 });
    const over = 'x'.repeat(201);
    const bomb = gzipSync(Buffer.from('<p>' + 'y'.repeat(100_000) + '</p>'));
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/lying': {
        headers: { 'content-type': 'text/plain', 'content-length': '10' },
        body: 'z'.repeat(5000),
      },
      'https://news.example.org/over': { headers: { 'content-type': 'text/plain' }, body: over },
      'https://news.example.org/exact': {
        headers: { 'content-type': 'text/plain' },
        body: 'w'.repeat(199),
      },
      'https://news.example.org/bomb': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: new Uint8Array(bomb),
      },
      'https://news.example.org/odd': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'zstd' },
        body: 'q',
      },
    });
    const reading = await readSources(
      ['lying', 'over', 'exact', 'bomb', 'odd'].map((p) => ({
        sourceRowId: p,
        url: `https://news.example.org/${p}`,
      })),
      { transport, resolver: r(), userAgent: UA, limits: small },
    );
    const byId = new Map(reading.outcomes.map((o) => [o.sourceRowId, o]));
    expect(byId.get('lying')).toMatchObject({
      status: 'partly_read',
      code: 'body_limit',
      bytes: 200,
    });
    expect(byId.get('over')).toMatchObject({
      status: 'partly_read',
      code: 'body_limit',
      bytes: 200,
    });
    expect(byId.get('exact')).toMatchObject({ status: 'read', code: null, bytes: 199 });
    expect(byId.get('bomb')).toMatchObject({
      status: 'partly_read',
      code: 'body_limit',
      bytes: 200,
    });
    expect(byId.get('odd')).toMatchObject({
      status: 'not_read',
      code: 'content_encoding_not_permitted',
    });
    expect(reading.totals.bytes).toBe(200 + 200 + 199 + 200);
  });

  it('reports a body that never completes as a timeout and closes it (test 6)', async () => {
    let closed = false;
    // A socket that only ends when the request's signal aborts it.
    async function* hanging(signal: AbortSignal): AsyncIterable<Uint8Array> {
      try {
        yield new TextEncoder().encode('<p>partial');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('socket closed')), {
            once: true,
          });
        });
      } finally {
        closed = true;
      }
    }
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/slow': (request) => ({ body: hanging(request.signal) }),
    });
    const reading = await readSources(
      [{ sourceRowId: 'slow', url: 'https://news.example.org/slow' }],
      {
        transport,
        resolver: r(),
        userAgent: UA,
        limits: limits({ fetchTimeoutMs: 60 }),
      },
    );
    expect(reading.outcomes[0]).toMatchObject({ status: 'not_read', code: 'fetch_timeout' });
    expect(closed).toBe(true);
  });

  it('refuses an image and a JSON document, and reports a non-page status (test 7)', async () => {
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/i.png': { headers: { 'content-type': 'image/png' }, body: 'PNG' },
      'https://news.example.org/api': {
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      'https://news.example.org/gone': {
        status: 404,
        headers: { 'content-type': 'text/html' },
        body: HTML('gone'),
      },
      'https://news.example.org/plain': {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Line one.\n\n  Line   two.  \n',
      },
      'https://news.example.org/xhtml': {
        headers: { 'content-type': 'application/xhtml+xml' },
        body: HTML('xhtml body'),
      },
    });
    const reading = await readSources(
      ['i.png', 'api', 'gone', 'plain', 'xhtml'].map((p) => ({
        sourceRowId: p,
        url: `https://news.example.org/${p}`,
      })),
      { transport, resolver: r(), userAgent: UA },
    );
    expect(reading.outcomes.map((o) => [o.sourceRowId, o.status, o.code])).toEqual([
      ['i.png', 'not_read', 'content_type_not_permitted'],
      ['api', 'not_read', 'content_type_not_permitted'],
      ['gone', 'not_read', 'status_not_ok'],
      ['plain', 'read', null],
      ['xhtml', 'read', null],
    ]);
    const plain = reading.outcomes[3];
    expect(plain?.status === 'read' && plain.text).toBe('Line one.\nLine two.');
  });

  it('times out the whole stage and lists the rest as not read (R11)', async () => {
    let clock = 0;
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/a': { body: HTML('a') },
      'https://news.example.org/b': { body: HTML('b') },
    });
    const reading = await readSources(
      [
        { sourceRowId: 'a', url: 'https://news.example.org/a' },
        { sourceRowId: 'b', url: 'https://news.example.org/b' },
      ],
      {
        transport,
        resolver: r(),
        userAgent: UA,
        limits: limits({ stageTimeoutMs: 20, concurrency: 1 }),
        now: () => {
          clock += 6;
          return clock;
        },
      },
    );
    expect(reading.outcomes.map((o) => o.code)).toEqual([null, 'stage_timeout']);
  });
});

describe('rules R12 to R14: once per URL, extraction, and the text bounds', () => {
  const r = () => resolver({ 'news.example.org': [PUBLIC] });
  const robots = { 'https://news.example.org/robots.txt': { status: 404 } };

  it('fetches each canonical URL once and gives every row its own outcome', async () => {
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/story': { body: HTML('shared') },
    });
    const reading = await readSources(
      [
        { sourceRowId: 'a', url: 'https://news.example.org/story' },
        { sourceRowId: 'b', url: 'https://news.example.org/story' },
      ],
      { transport, resolver: r(), userAgent: UA },
    );
    expect(reading.outcomes.map((o) => o.sourceRowId)).toEqual(['a', 'b']);
    expect(transport.calls.filter((c) => c.includes('/story'))).toHaveLength(1);
  });

  it('extracts text, drops scripts, decodes the declared charset, and digests what it kept', async () => {
    const latin = new Uint8Array([
      0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e,
    ]); // <p>café</p>
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/story': {
        body: HTML('The <b>company</b> said &amp; confirmed.', 'Headline'),
      },
      'https://news.example.org/latin': {
        headers: { 'content-type': 'text/html; charset=iso-8859-1' },
        body: latin,
      },
    });
    const reading = await readSources(
      [
        { sourceRowId: 'a', url: 'https://news.example.org/story' },
        { sourceRowId: 'b', url: 'https://news.example.org/latin' },
      ],
      { transport, resolver: r(), userAgent: UA },
    );
    const [a, b] = reading.outcomes;
    expect(a?.status === 'read' && a.text).toBe('Headline\nThe company said & confirmed.');
    expect(a?.status === 'read' && a.text.includes('alert')).toBe(false);
    expect(a?.status === 'read' && a.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(b?.status === 'read' && b.text).toBe('café');
  });

  it('cuts a long source at a paragraph boundary and lists a source past the reading bound as not read', async () => {
    // Lines of exactly 99 characters after the 7-character title line: the
    // cut at 500 lands on the boundary at 407.
    const paragraphs = Array.from({ length: 30 }, () => `<p>${'a'.repeat(99)}</p>`).join('');
    const transport = recordedTransport({
      ...robots,
      'https://news.example.org/long': { body: HTML(paragraphs) },
      'https://news.example.org/short': { body: HTML('short') },
      'https://news.example.org/last': { body: HTML('b'.repeat(100)) },
    });
    const reading = await readSources(
      ['long', 'short', 'last'].map((p) => ({
        sourceRowId: p,
        url: `https://news.example.org/${p}`,
      })),
      {
        transport,
        resolver: r(),
        userAgent: UA,
        limits: limits({ textCharsPerSource: 500, textCharsPerReading: 520 }),
      },
    );
    const [long, short, last] = reading.outcomes;
    expect(long).toMatchObject({ status: 'partly_read', code: 'text_limit' });
    expect(long?.status === 'partly_read' && long.text.length).toBe(407);
    expect(short).toMatchObject({ status: 'read' });
    expect(last).toMatchObject({ status: 'not_read', code: 'text_limit' });
    expect(cutAtParagraph('abc\ndef\nghi', 5)).toBe('abc');
    expect(cutAtParagraph('abcdefghi', 5)).toBe('abcde');
  });
});

describe('robots.txt, obeyed (O-2)', () => {
  it('parses groups and decides by the longest match, allow winning a tie', () => {
    const rules = parseRobots(
      [
        'User-agent: *',
        'Disallow: /private',
        'Allow: /private/ok',
        '',
        'User-agent: LatestInCyber',
        'User-agent: Other',
        'Disallow: /news/*.pdf$',
        'Disallow:',
        '# comment',
      ].join('\n'),
    );
    expect(rules.groups).toHaveLength(2);
    expect(robotsAllows(rules, 'latestincyber', '/news/story.html')).toBe(true);
    expect(robotsAllows(rules, 'LatestInCyber', '/news/file.pdf')).toBe(false);
    expect(robotsAllows(rules, 'LatestInCyber', '/news/file.pdf?x')).toBe(true);
    expect(robotsAllows(rules, 'Elsebot', '/private/x')).toBe(false);
    expect(robotsAllows(rules, 'Elsebot', '/private/ok/x')).toBe(true);
    expect(robotsAllows(parseRobots(''), 'LatestInCyber', '/anything')).toBe(true);
    const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a');
    expect(robotsAllows(tie, 'x', '/a/b')).toBe(true);
    expect(patternMatches('/a*b$', '/axxb')).toBe(true);
    expect(patternMatches('/a*b$', '/axxbc')).toBe(false);
    expect(patternMatches('', '/x')).toBe(false);
  });

  it('reads the file once per host, lists a disallowed path and an unreadable file as not read, and treats 404 as no rule', async () => {
    const r = resolver({
      'a.example.org': [PUBLIC],
      'b.example.org': [PUBLIC],
      'c.example.org': [PUBLIC],
    });
    const transport = recordedTransport({
      'https://a.example.org/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: LatestInCyber\nDisallow: /paywall/',
      },
      'https://a.example.org/paywall/story': { body: HTML('paid') },
      'https://a.example.org/free/story': { body: HTML('free') },
      'https://b.example.org/robots.txt': { status: 503 },
      'https://b.example.org/story': { body: HTML('b') },
      'https://c.example.org/robots.txt': { status: 404 },
      'https://c.example.org/story': { body: HTML('c') },
    });
    const reading = await readSources(
      [
        { sourceRowId: 'a1', url: 'https://a.example.org/paywall/story' },
        { sourceRowId: 'a2', url: 'https://a.example.org/free/story' },
        { sourceRowId: 'b', url: 'https://b.example.org/story' },
        { sourceRowId: 'c', url: 'https://c.example.org/story' },
      ],
      { transport, resolver: r, userAgent: UA },
    );
    expect(reading.outcomes.map((o) => [o.sourceRowId, o.status, o.code])).toEqual([
      ['a1', 'not_read', 'robots_disallowed'],
      ['a2', 'read', null],
      ['b', 'not_read', 'robots_unavailable'],
      ['c', 'read', null],
    ]);
    expect(transport.calls.filter((c) => c.includes('a.example.org/robots.txt'))).toHaveLength(1);
    expect(transport.calls.some((c) => c.includes('b.example.org/story'))).toBe(false);
  });
});

describe('the one Node transport', () => {
  it('pins the connection to the checked address, names the host for TLS, sends only the fixed headers, and follows nothing', async () => {
    const r = resolver({ 'news.example.org': [PUBLIC] });
    const target = await checkTarget('https://news.example.org/story?x=1', r);
    const captured: Record<string, unknown>[] = [];
    const fakeRequester = ((options: Record<string, unknown>, callback: (res: unknown) => void) => {
      captured.push(options);
      const res = {
        statusCode: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': ['a=b', 'c=d'] },
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('<p>hi</p>');
        },
      };
      const req = { on: () => req, end: () => callback(res) };
      return req;
    }) as unknown as typeof import('node:https').request;
    const transport = nodeTransport({ http: fakeRequester, https: fakeRequester });
    const response = await transport.request({
      target,
      headers: { accept: 'text/html', 'user-agent': UA },
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBe('a=b, c=d');
    const options = captured[0] as {
      hostname: string;
      port: number;
      path: string;
      method: string;
      agent: unknown;
      servername: string;
      headers: Record<string, string>;
      lookup: (
        h: string,
        o: { all?: boolean },
        cb: (e: null, a: unknown, f?: number) => void,
      ) => void;
    };
    expect(options).toMatchObject({
      hostname: 'news.example.org',
      port: 443,
      path: '/story?x=1',
      method: 'GET',
      agent: false,
      servername: 'news.example.org',
    });
    expect(Object.keys(options.headers).sort()).toEqual(['accept', 'user-agent']);
    await new Promise<void>((resolve) => {
      options.lookup('news.example.org', {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe(PUBLIC);
        expect(family).toBe(4);
        options.lookup('news.example.org', { all: true }, (_e, all) => {
          expect(all).toEqual([{ address: PUBLIC, family: 4 }]);
          resolve();
        });
      });
    });
  });
});

describe('the policy layer opens no socket (test 11)', () => {
  it('names no network module outside the one transport, and the fixed user agent has the decided shape', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = (await readdir(here)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const forbidden =
      /from '(?:node:)?(?:net|http|https|tls|dgram|http2|dns)'|undici|\bfetch\s*\(/u;
    for (const name of sources) {
      const text = await readFile(new URL(name, import.meta.url), 'utf8');
      if (name === 'node-transport.ts') {
        expect(/node:https?\b/u.test(text)).toBe(true);
        continue;
      }
      expect(forbidden.test(text), name).toBe(false);
    }
    expect(UA).toBe('LatestInCyber/0.1 (+https://dashboard.example.org)');
    expect(() => userAgent('0.1', 'http://insecure.example.org')).toThrow(RangeError);
    expect(new ReadError('fetch_timeout', 'x').code).toBe('fetch_timeout');
  });
});

export type { SourceToRead, RawRequest };
