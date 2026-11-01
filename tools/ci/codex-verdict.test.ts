import { afterEach, describe, expect, it, vi } from 'vitest';

import { decide, record, verdictLines, type ConversationEntry } from './codex-verdict.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const by = (body: string, author_association = 'OWNER'): ConversationEntry => ({
  author_association,
  body,
});

describe('the Codex verdict recorder (D52)', () => {
  it('reads only lines that are exactly a verdict on a full commit', () => {
    expect(
      verdictLines(
        [
          'Review notes.',
          `Codex verdict: PASS at ${HEAD}`,
          `  Codex verdict: CHANGES REQUIRED at ${OLD}  `,
          `Codex verdict: PASS at ${HEAD.slice(0, 7)}`,
          `codex verdict: PASS at ${HEAD}`,
          `Codex verdict: PASS at ${HEAD.toUpperCase()}`,
          `Codex verdict: PASS at ${HEAD} and more`,
          `> Codex verdict: PASS at ${HEAD}`,
        ].join('\r\n'),
      ),
    ).toEqual([
      ['PASS', HEAD],
      ['CHANGES REQUIRED', OLD],
    ]);
  });

  it('passes only when the last verdict from a writer that names the head is a PASS', () => {
    expect(decide(HEAD, [])).toEqual({
      state: 'failure',
      description: 'No Codex verdict recorded at aaaaaaa',
    });
    expect(decide(HEAD, [by(`Codex verdict: PASS at ${HEAD}`)])).toEqual({
      state: 'success',
      description: 'Codex PASS recorded at aaaaaaa',
    });
    // A verdict on another commit, such as the head before a new push, says nothing about this one.
    expect(decide(HEAD, [by(`Codex verdict: PASS at ${OLD}`)]).state).toBe('failure');
    // The last verdict on the head decides, in the order the conversation was written.
    expect(
      decide(HEAD, [
        by(`Codex verdict: PASS at ${HEAD}`),
        by(`Codex verdict: CHANGES REQUIRED at ${HEAD}`),
      ]),
    ).toEqual({ state: 'failure', description: 'Codex CHANGES REQUIRED at aaaaaaa' });
    expect(
      decide(HEAD, [
        by(`Codex verdict: CHANGES REQUIRED at ${HEAD}`),
        by(`Codex verdict: PASS at ${HEAD}`, 'COLLABORATOR'),
      ]).state,
    ).toBe('success');
  });

  it('ignores a verdict from anyone without write access, and a comment with no body', () => {
    for (const association of [
      'CONTRIBUTOR',
      'FIRST_TIMER',
      'FIRST_TIME_CONTRIBUTOR',
      'NONE',
      'MANNEQUIN',
    ]) {
      expect(decide(HEAD, [by(`Codex verdict: PASS at ${HEAD}`, association)]).state).toBe(
        'failure',
      );
    }
    expect(decide(HEAD, [{ author_association: 'OWNER', body: null }]).state).toBe('failure');
    expect(
      decide(HEAD, [
        by(`Codex verdict: PASS at ${HEAD}`),
        by(`Codex verdict: CHANGES REQUIRED at ${HEAD}`, 'NONE'),
      ]).state,
    ).toBe('success');
  });

  describe('against the GitHub API (fetch stubbed; no socket)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const ENV = {
      GITHUB_API_URL: 'https://api.example',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_TOKEN: 'ephemeral',
      PULL_NUMBER: '64',
      STATUS_CONTEXT: 'Codex verdict',
    };

    it('reads the head and every page of comments, and posts one status on the head', async () => {
      const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
      const page = (n: number) =>
        Array.from({ length: n }, () => ({ author_association: 'OWNER', body: 'note' }));
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: init.body === undefined ? null : JSON.parse(String(init.body)),
          auth: headers.get('authorization'),
        });
        if (url.endsWith('/pulls/64')) return Response.json({ head: { sha: HEAD } });
        if (url.includes('/issues/64/comments') && url.endsWith('page=1'))
          return Response.json(page(100));
        if (url.includes('/issues/64/comments') && url.endsWith('page=2')) {
          return Response.json([
            ...page(3),
            { author_association: 'OWNER', body: `Codex verdict: PASS at ${HEAD}` },
          ]);
        }
        if (url.endsWith(`/statuses/${HEAD}`)) return new Response(null, { status: 201 });
        return new Response('unexpected', { status: 404 });
      });
      expect(await record(ENV)).toEqual({
        state: 'success',
        description: 'Codex PASS recorded at aaaaaaa',
      });
      expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example', '')}`)).toEqual([
        'GET /repos/owner/repo/pulls/64',
        'GET /repos/owner/repo/issues/64/comments?per_page=100&page=1',
        'GET /repos/owner/repo/issues/64/comments?per_page=100&page=2',
        `POST /repos/owner/repo/statuses/${HEAD}`,
      ]);
      expect(calls.at(-1)?.body).toEqual({
        state: 'success',
        context: 'Codex verdict',
        description: 'Codex PASS recorded at aaaaaaa',
      });
      expect(calls.every((c) => c.auth === 'Bearer ephemeral')).toBe(true);
    });

    it('fails with a fixed line, never the response body, and posts nothing when a read fails', async () => {
      const posted: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'POST') posted.push(url);
        return new Response('secret-looking body', { status: 502 });
      });
      await expect(record(ENV)).rejects.toThrow(
        /^GitHub API GET \/repos\/owner\/repo\/pulls\/64: 502$/u,
      );
      expect(posted).toEqual([]);
    });
  });
});
