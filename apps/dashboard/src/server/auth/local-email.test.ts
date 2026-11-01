import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { localEmailProvider } from './local-email.ts';

describe('the local email file (memory store only)', () => {
  const directory = mkdtemp(path.join(tmpdir(), 'cas-local-email-'));
  afterAll(async () => rm(await directory, { recursive: true, force: true }));
  const message = { to: 'one@example.org', subject: 'First', text: 'code 123456' };

  it('appends one JSON line per message to a mode-600 file, and drops everything when no file is named', async () => {
    const file = path.join(await directory, 'email.jsonl');
    const provider = localEmailProvider(file);
    await provider.send(message);
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

  it('narrows a file that already exists with wider permissions to mode 600, keeping what it held (combined audit F3)', async () => {
    const file = path.join(await directory, 'existing.jsonl');
    // One handle seeds the file and reads it back after the provider has written, so the test
    // opens the path once and nothing it checked by path is used again (code scanning, alert 17).
    // `chmod` sets the mode exactly, whatever the umask.
    const handle = await open(file, 'w+', 0o644);
    try {
      await handle.write('earlier line\n');
      await handle.chmod(0o644);
      await localEmailProvider(file).send(message);
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').trimEnd().split('\n');
      expect(lines[0]).toBe('earlier line');
      expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ text: 'code 123456' });
    } finally {
      await handle.close();
    }
  });

  it('refuses a symbolic link and anything that is not a regular file, and writes nothing through them (combined audit F3)', async () => {
    const target = path.join(await directory, 'elsewhere.txt');
    await writeFile(target, 'untouched\n', { mode: 0o644 });
    await chmod(target, 0o644);
    const link = path.join(await directory, 'link.jsonl');
    await symlink(target, link);
    await expect(localEmailProvider(link).send(message)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('untouched\n');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    const folder = path.join(await directory, 'a-folder');
    await mkdir(folder);
    await expect(localEmailProvider(folder).send(message)).rejects.toThrow();
  });
});
