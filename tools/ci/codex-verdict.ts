import { isMain } from '../checks/lib/report.ts';

/**
 * The Codex verdict, enforced (D52). A pull request may merge into `main` only
 * when a Codex PASS is recorded against its exact head commit: the `main`
 * ruleset requires the commit status `Codex verdict`, which this recorder sets
 * on the head of the pull request it is run for, from the pull request's
 * comments. A verdict is one line of a comment, exactly
 * `Codex verdict: PASS at <40-hex commit>` or
 * `Codex verdict: CHANGES REQUIRED at <40-hex commit>`, written by an account
 * with write access (author association OWNER, MEMBER or COLLABORATOR). The
 * last such line naming the head decides; a new push makes a new head, which
 * no verdict names, so the status turns to failure until Codex passes it.
 *
 * What it cannot do, in a repository with one GitHub identity: tell Codex's
 * comment from anyone else's with that identity's access. It enforces against
 * a merge of a head Codex never passed, the realistic failure; a person who
 * can push can also edit the ruleset, and the ruleset's history records that.
 */
export const STATUS_CONTEXT = 'Codex verdict';

const VERDICT = /^Codex verdict: (PASS|CHANGES REQUIRED) at ([0-9a-f]{40})$/u;
const WRITERS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface ConversationEntry {
  readonly author_association: string;
  readonly body: string | null;
}

export interface Verdict {
  readonly state: 'success' | 'failure' | 'pending';
  readonly description: string;
}

/** The verdict lines of one comment, in order: `[verdict, commit]` for each line that is exactly one. */
export function verdictLines(body: string): Array<readonly ['PASS' | 'CHANGES REQUIRED', string]> {
  const lines: Array<readonly ['PASS' | 'CHANGES REQUIRED', string]> = [];
  for (const line of body.split(/\r?\n/u)) {
    const match = VERDICT.exec(line.trim());
    if (match !== null) lines.push([match[1] as 'PASS' | 'CHANGES REQUIRED', match[2] ?? '']);
  }
  return lines;
}

/**
 * The status for `head` from the conversation, in the order it was written:
 * success only when the last verdict line from a writer that names `head` is
 * a PASS. A verdict on any other commit says nothing about this one.
 */
export function decide(head: string, entries: readonly ConversationEntry[]): Verdict {
  const short = head.slice(0, 7);
  let last: 'PASS' | 'CHANGES REQUIRED' | null = null;
  for (const entry of entries) {
    if (!WRITERS.has(entry.author_association) || entry.body === null) continue;
    for (const [verdict, commit] of verdictLines(entry.body)) {
      if (commit === head) last = verdict;
    }
  }
  if (last === 'PASS') return { state: 'success', description: `Codex PASS recorded at ${short}` };
  if (last === 'CHANGES REQUIRED') {
    return { state: 'failure', description: `Codex CHANGES REQUIRED at ${short}` };
  }
  return { state: 'failure', description: `No Codex verdict recorded at ${short}` };
}

interface Environment {
  readonly api: string;
  readonly repository: string;
  readonly token: string;
  readonly pull: string;
}

function environment(env: NodeJS.ProcessEnv): Environment {
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = env.GITHUB_REPOSITORY ?? '';
  const token = env.GITHUB_TOKEN ?? '';
  const pull = env.PULL_NUMBER ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('GITHUB_REPOSITORY is not owner/name');
  }
  if (!/^[1-9][0-9]{0,9}$/u.test(pull)) throw new Error('PULL_NUMBER is not a pull request number');
  if (token.length === 0) throw new Error('GITHUB_TOKEN is not set');
  if (env.STATUS_CONTEXT !== STATUS_CONTEXT) throw new Error('STATUS_CONTEXT does not match');
  return { api, repository, token, pull };
}

async function github(env: Environment, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${env.api}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  // A fixed line: never the response body, which may echo a request.
  if (!response.ok)
    throw new Error(`GitHub API ${init.method ?? 'GET'} ${path}: ${response.status}`);
  return response;
}

function isEntry(value: unknown): value is ConversationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.author_association === 'string' &&
    (typeof entry.body === 'string' || entry.body === null)
  );
}

/** The pull request's comments, oldest first. A review is not read: a verdict is a comment. */
async function conversation(env: Environment): Promise<ConversationEntry[]> {
  const entries: ConversationEntry[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await github(
      env,
      `/repos/${env.repository}/issues/${env.pull}/comments?per_page=100&page=${page}`,
    );
    const batch: unknown = await response.json();
    if (!Array.isArray(batch) || !batch.every(isEntry)) {
      throw new Error('a page of comments is not a list of comments');
    }
    entries.push(...batch);
    if (batch.length < 100) return entries;
  }
  throw new Error('the pull request has more than 5,000 comments');
}

async function setStatus(env: Environment, head: string, verdict: Verdict): Promise<void> {
  await github(env, `/repos/${env.repository}/statuses/${head}`, {
    method: 'POST',
    body: JSON.stringify({
      state: verdict.state,
      context: STATUS_CONTEXT,
      description: verdict.description,
    }),
  });
}

/**
 * Records the verdict on the pull request's head. Once the head is known, the
 * status is set to pending before anything is read, so a status an earlier run
 * set never outlives this one (the review of pull request 65 at aa6f519, H1):
 * if a read, a page or the decision fails, the head is left pending, or
 * failure where that can still be written, and a merge stays blocked. Success
 * is written only after every comment has been read and decided.
 */
export async function record(env: NodeJS.ProcessEnv = process.env): Promise<Verdict> {
  const settings = environment(env);
  const pull = (await (
    await github(settings, `/repos/${settings.repository}/pulls/${settings.pull}`)
  ).json()) as { head?: { sha?: unknown } };
  const head = typeof pull.head?.sha === 'string' ? pull.head.sha : '';
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error('the pull request has no head commit');
  const short = head.slice(0, 7);
  await setStatus(settings, head, {
    state: 'pending',
    description: `Reading the Codex verdict at ${short}`,
  });
  let verdict: Verdict;
  try {
    verdict = decide(head, await conversation(settings));
  } catch (error) {
    await setStatus(settings, head, {
      state: 'failure',
      description: `The Codex verdict could not be read at ${short}`,
    }).catch(() => undefined);
    throw error;
  }
  await setStatus(settings, head, verdict);
  console.log(`codex-verdict: ${verdict.state} at ${head} (${verdict.description})`);
  return verdict;
}

if (isMain(import.meta.url)) {
  record().catch((error: unknown) => {
    console.error(`codex-verdict: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  });
}
