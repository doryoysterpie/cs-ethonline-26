import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { localEmailProvider } from './local-email.ts';

describe('the local email file (memory store only)', () => {
  const directory = mkdtemp(path.join(tmpdir(), 'cas-local-email-'));
  afterAll(async () => rm(await directory, { recursive: true, force: true }));

  it('appends one JSON line per message to a mode-600 file, and drops everything when no file is named', async () => {
    const file = path.join(await directory, 'email.jsonl');
    const provider = localEmailProvider(file);
    await provider.send({ to: 'one@example.org', subject: 'First', text: 'code 123456' });
    await provider.send({ to: 'two@example.org', subject: 'Second', text: 'code 654321' });
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as { to: string; text: string })).toEqual([
      { at: expect.any(String), to: 'one@example.org', subject: 'First', text: 'code 123456' },
      { at: expect.any(String), to: 'two@example.org', subject: 'Second', text: 'code 654321' },
    ]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(
      localEmailProvider(null).send({ to: 'x@example.org', subject: 's', text: 't' }),
    ).resolves.toBeUndefined();
  });
});
