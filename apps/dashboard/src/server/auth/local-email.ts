import 'server-only';

import { appendFile } from 'node:fs/promises';

import type { EmailMessage, EmailProvider } from './email-provider.ts';

/**
 * The memory store's email path (CAS-010, for the browser tests and for a
 * developer signing in locally): the message is appended, one JSON object
 * per line, to a file the developer names, created mode 600, or dropped when
 * no file is named. The memory store is refused outside `local` by the
 * configuration, so this provider never runs in production; the file holds
 * one-time codes and is never committed (`test-results/` is ignored).
 */
export const LOCAL_EMAIL_FILE_VARIABLE = 'DASHBOARD_LOCAL_EMAIL_FILE';

export function localEmailProvider(file: string | null): EmailProvider {
  if (file === null) return { send: async () => undefined };
  return {
    async send(message: EmailMessage): Promise<void> {
      const line = JSON.stringify({ at: new Date().toISOString(), ...message });
      await appendFile(file, `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    },
  };
}
