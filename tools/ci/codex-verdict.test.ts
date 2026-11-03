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
    const NO_WAIT = { pause: async () => undefined };
    const PASSED = [{ author_association: 'OWNER', body: `Codex verdict: PASS at ${HEAD}` }];
    const CHANGES = [
      ...PASSED,
      { author_association: 'OWNER', body: `Codex verdict: CHANGES REQUIRED at ${HEAD}` },
    ];

    it('sets pending first, reads every page of comments, then posts the verdict on the head', async () => {
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
        if (url.includes('/issues/64/comments') && url.endsWith('page=1')) {
          return Response.json(page(100));
        }
        if (url.includes('/issues/64/comments') && url.endsWith('page=2')) {
          return Response.json([...page(3), ...PASSED]);
        }
        if (url.endsWith(`/statuses/${HEAD}`)) return new Response(null, { status: 201 });
        return new Response('unexpected', { status: 404 });
      });
      expect(await record(ENV, NO_WAIT)).toEqual({
        state: 'success',
        description: 'Codex PASS recorded at aaaaaaa',
      });
      expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example', '')}`)).toEqual([
        'GET /repos/owner/repo/pulls/64',
        `POST /repos/owner/repo/statuses/${HEAD}`,
        'GET /repos/owner/repo/issues/64/comments?per_page=100&page=1',
        'GET /repos/owner/repo/issues/64/comments?per_page=100&page=2',
        `POST /repos/owner/repo/statuses/${HEAD}`,
      ]);
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        {
          state: 'pending',
          context: 'Codex verdict',
          description: 'Reading the Codex verdict at aaaaaaa',
        },
        {
          state: 'success',
          context: 'Codex verdict',
          description: 'Codex PASS recorded at aaaaaaa',
        },
      ]);
      expect(calls.every((c) => c.auth === 'Bearer ephemeral')).toBe(true);
    });

    it('posts nothing, and fails with a fixed line, when the head cannot be read after its retries', async () => {
      const posted: string[] = [];
      let reads = 0;
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'POST') posted.push(url);
        else reads += 1;
        return new Response('secret-looking body', { status: 502 });
      });
      await expect(record(ENV, NO_WAIT)).rejects.toThrow(
        /^GitHub API GET \/repos\/owner\/repo\/pulls\/64: 502$/u,
      );
      expect([posted, reads]).toEqual([[], 3]);
    });

    /**
     * A head whose status an earlier run left green. `comments` answers each page; `refuse` says
     * whether the status endpoint refuses the nth status write (from 1) carrying that state.
     * Returns the head's status as GitHub would hold it after the run, and the run's error.
     */
    async function afterPriorSuccess(
      comments: (page: number) => Response,
      refuse: (state: string, nth: number) => boolean = () => false,
    ): Promise<{ readonly state: string; readonly error: unknown }> {
      let state = 'success';
      const seen = new Map<string, number>();
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        if (url.endsWith('/pulls/64')) return Response.json({ head: { sha: HEAD } });
        const match = /page=(\d+)$/u.exec(url);
        if (url.includes('/issues/64/comments') && match !== null) {
          return comments(Number(match[1]));
        }
        if (url.endsWith(`/statuses/${HEAD}`)) {
          const posted = (JSON.parse(String(init.body)) as { state: string }).state;
          const nth = (seen.get(posted) ?? 0) + 1;
          seen.set(posted, nth);
          if (refuse(posted, nth)) return new Response('no', { status: 503 });
          state = posted;
          return new Response(null, { status: 201 });
        }
        return new Response('unexpected', { status: 404 });
      });
      let error: unknown = null;
      try {
        await record(ENV, NO_WAIT);
      } catch (caught) {
        error = caught;
      }
      return { state, error };
    }

    it('never leaves an earlier success standing when the comments cannot be read (H1)', async () => {
      const full = Array.from({ length: 100 }, () => ({ author_association: 'OWNER', body: 'x' }));
      for (const [label, comments] of [
        ['the first page fails', () => new Response('down', { status: 502 })],
        [
          'a later page fails',
          (n: number) => (n === 1 ? Response.json(full) : new Response('down', { status: 502 })),
        ],
        ['a page is not JSON', () => new Response('<html>', { status: 200 })],
        ['a page is not a list', () => Response.json({ message: 'rate limited' })],
        ['a comment is malformed', () => Response.json([{ author_association: 'OWNER', body: 7 }])],
      ] as const) {
        const { state, error } = await afterPriorSuccess(comments);
        expect([label, state, error instanceof Error]).toEqual([label, 'failure', true]);
      }
    });

    it('goes on past a refused pending write and writes the verdict it decides (review of 26dad9d, H1)', async () => {
      // The pending write refused on every attempt; the verdict is now CHANGES REQUIRED.
      expect(
        await afterPriorSuccess(
          () => Response.json(CHANGES),
          (state) => state === 'pending',
        ),
      ).toEqual({ state: 'failure', error: null });
      // Refused once, then accepted on its retry.
      expect(
        await afterPriorSuccess(
          () => Response.json(CHANGES),
          (state, nth) => state === 'pending' && nth === 1,
        ),
      ).toEqual({ state: 'failure', error: null });
      // Refused, and the comments cannot be read either: failure is still written.
      const unread = await afterPriorSuccess(
        () => new Response('down', { status: 502 }),
        (state) => state === 'pending',
      );
      expect([unread.state, unread.error instanceof Error]).toEqual(['failure', true]);
      // Refused, and the verdict is still a PASS: success is the true verdict.
      expect(
        await afterPriorSuccess(
          () => Response.json(PASSED),
          (state) => state === 'pending',
        ),
      ).toEqual({ state: 'success', error: null });
    });

    it('leaves the head pending, never green, when the verdict or the failure cannot be written', async () => {
      const passed = () => Response.json(PASSED);
      expect(await afterPriorSuccess(passed, (state) => state === 'success')).toMatchObject({
        state: 'pending',
      });
      const down = () => new Response('down', { status: 502 });
      expect(await afterPriorSuccess(down, (state) => state === 'failure')).toMatchObject({
        state: 'pending',
      });
      // Only when every status write is refused does the earlier one stand, and the run fails.
      const blocked = await afterPriorSuccess(down, () => true);
      expect([blocked.state, blocked.error instanceof Error]).toEqual(['success', true]);
    });
  });
});
