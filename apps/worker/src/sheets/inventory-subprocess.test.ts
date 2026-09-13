import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The real bug this file guards against never showed up in an in-process
 * test: `packages/sheets-intake/src/transport.ts` used to `.unref()` its
 * retry-delay timer, so a retried request abandoned its promise the instant
 * nothing else held the event loop open. Every existing sheets-intake test
 * injects a fake `sleep` (see `packages/sheets-intake/src/test-support.ts`),
 * which never touches that timer at all, and vitest's own worker process
 * always has other handles open regardless of what this one timer does. Only
 * a genuine, separate subprocess whose sole job is the one awaited command
 * can show whether the process itself stays alive long enough to answer.
 *
 * `HARNESS` drives the compiled `apps/worker/dist/cli.js` for real, through
 * a faked Google (see the harness file), so this exercises the actual retry
 * path rather than a stand-in for it.
 */

const HARNESS = fileURLToPath(new URL('./inventory-subprocess-harness.mjs', import.meta.url));

async function exitOf(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  const outcome = await Promise.race([exited, timer]);
  if (outcome === 'timeout') throw new Error('the harness did not exit in time');
  return outcome;
}

async function runHarness(
  mode: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [HARNESS], {
    env: { PATH: process.env['PATH'] ?? '', HARNESS_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const code = await exitOf(child);
  return {
    code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

// The service account's address is deliberately printed (`readAs=...`) —
// see token.ts's own comment: it identifies who is reading, and is not a
// secret. Everything below this line is a secret or raw-response fragment
// that must never appear, in either the success or the failure path.
const SECRET_MARKERS = [
  'BEGIN PRIVATE KEY',
  'SyntheticSubprocessHarness',
  'harness-synthetic-access-token',
  '.json',
  '"values"',
  '503',
];

describe('the compiled sheets inventory command, run as a real subprocess', () => {
  it('stays alive across a real retry delay, prints the structural inventory, and exits 0', async () => {
    const { code, stdout, stderr } = await runHarness('success-after-retry');
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('sheets:inventory: workbook=');
    expect(stdout).toContain('titleMatch=yes');
    expect(stdout).toMatch(/tab: index=0 digest=[0-9a-f]+ name=Feed/);
    // The bug's exact fingerprint: a hang here means Node's "unsettled top-level
    // await" diagnostic on stderr and no structural line ever printed.
    expect(stdout).not.toBe('');
  }, 10_000);

  it('reports a rejected token exchange as one fixed, redacted error line and a nonzero exit', async () => {
    const { code, stdout, stderr } = await runHarness('rejected-token');
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    const lines = stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error\[sheets:authorization\/token_exchange_failed\]: /);
    expect(lines[0]).toContain('status=401');
  }, 10_000);

  it('never prints a credential, key, identifier, token or raw response body, in success or failure', async () => {
    for (const mode of ['success-after-retry', 'rejected-token']) {
      const { stdout, stderr } = await runHarness(mode);
      const combined = `${stdout}\n${stderr}`;
      for (const marker of SECRET_MARKERS) {
        expect(combined, `mode=${mode} marker=${marker}`).not.toContain(marker);
      }
    }
  }, 15_000);
});
