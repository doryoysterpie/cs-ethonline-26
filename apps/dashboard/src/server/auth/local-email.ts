import 'server-only';

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { EmailMessage, EmailProvider } from './email-provider.ts';

/**
 * The memory store's email path (CAS-010, for the browser tests and for a
 * developer signing in locally): the message is appended, one JSON object
 * per line, to a file the developer names, or dropped when no file is named.
 * The memory store is refused outside `local` by the configuration, so this
 * provider never runs in production; the file holds one-time codes and is
 * never committed (`test-results/` is ignored).
 *
 * The file is mode 600 whether it is new or already there (the combined audit
 * of `main` at 8105678, F3): it is opened without following a symbolic link
 * and without blocking on a pipe, refused unless it is a regular file, and
 * narrowed to mode 600 through the same handle before the line is written.
 */
export const LOCAL_EMAIL_FILE_VARIABLE = 'DASHBOARD_LOCAL_EMAIL_FILE';

const OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export function localEmailProvider(file: string | null): EmailProvider {
  if (file === null) return { send: async () => undefined };
  return {
    async send(message: EmailMessage): Promise<void> {
      const line = JSON.stringify({ at: new Date().toISOString(), ...message });
      const handle = await open(file, OPEN_FLAGS, 0o600);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('the local email file is not a regular file');
        if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
        await handle.write(`${line}\n`, null, 'utf8');
      } finally {
        await handle.close();
      }
    },
  };
}
