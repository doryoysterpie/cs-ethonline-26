import 'server-only';

import { DashboardError } from '../errors.ts';
import type { EmailMessage, EmailProvider } from './email-provider.ts';

/**
 * Resend, through a bounded server-side fetch. No SDK: the whole surface
 * this needs is one POST to one origin, and a dependency brings a much
 * larger one for it.
 *
 * Reaches exactly `RESEND_ENDPOINT` and no other origin, follows no
 * redirect, and times the request out. A response is trusted only if its
 * status is 2xx and its body parses as a JSON object; a 2xx with a body that
 * does not is treated as a failure, not a success, the same way a token
 * exchange that returns 200 with an unparsable body is refused rather than
 * believed in `packages/sheets-intake`. No error thrown here ever carries a
 * transport message, a header, a status body or the API key: every one of
 * those can name a host, a proxy or a credential, so only a fixed code
 * leaves this module.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResendProviderOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetchImpl?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

function unavailable(code: string): DashboardError {
  return new DashboardError('unavailable', code, 'The request could not be completed.');
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function createResendProvider(options: ResendProviderOptions): EmailProvider {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async send(message: EmailMessage): Promise<void> {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          // Declined, never chased: a redirect could move the request, and
          // the bearer key with it, to any other origin.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw unavailable('email_transport_failed');
      }

      if (response.status >= 300 && response.status < 400) {
        await drain(response);
        throw unavailable('email_redirect_refused');
      }
      if (response.status < 200 || response.status >= 300) {
        await drain(response);
        throw unavailable('email_send_failed');
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw unavailable('email_response_unreadable');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw unavailable('email_response_invalid');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw unavailable('email_response_invalid');
      }
    },
  };
}
