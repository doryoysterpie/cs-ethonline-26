import 'server-only';

/**
 * The narrow interface every email delivery path implements.
 *
 * One message, one recipient, plain text. Nothing here is Resend-specific:
 * a test injects a fake implementing this same interface, and a future
 * provider only has to satisfy it, not reshape the caller.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
