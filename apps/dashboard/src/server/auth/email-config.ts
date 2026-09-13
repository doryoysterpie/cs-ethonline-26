import 'server-only';

import { DashboardError } from '../errors.ts';
import type { EmailProvider } from './email-provider.ts';
import { createResendProvider } from './resend-provider.ts';

/**
 * Configuration for the passwordless email path, read from the environment
 * once and validated as a closed set, the same discipline `config.ts`
 * applies to the rest of the dashboard's configuration. Every one of the
 * three variables is required: there is no fallback provider and no
 * unpeppered mode, in every environment this is loaded in, so a
 * misconfiguration is refused at start-up rather than discovered the first
 * time someone tries to sign in.
 */

export const RESEND_API_KEY_VARIABLE = 'RESEND_API_KEY';
export const AUTH_EMAIL_FROM_VARIABLE = 'AUTH_EMAIL_FROM';
export const AUTH_OTP_PEPPER_VARIABLE = 'AUTH_OTP_PEPPER';
/** Short enough to type by accident, long enough that it is plainly not one. */
export const MINIMUM_PEPPER_LENGTH = 32;

export interface OtpEmailConfig {
  readonly provider: EmailProvider;
  readonly pepper: string;
}

function configuration(code: string, message: string): DashboardError {
  return new DashboardError('configuration', code, message);
}

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function loadOtpEmailConfig(
  env: Readonly<Record<string, string | undefined>>,
): OtpEmailConfig {
  const apiKey = read(env, RESEND_API_KEY_VARIABLE);
  if (apiKey === null) {
    throw configuration('resend_api_key_missing', `${RESEND_API_KEY_VARIABLE} is not set`);
  }
  const from = read(env, AUTH_EMAIL_FROM_VARIABLE);
  if (from === null) {
    throw configuration('auth_email_from_missing', `${AUTH_EMAIL_FROM_VARIABLE} is not set`);
  }
  const pepper = read(env, AUTH_OTP_PEPPER_VARIABLE);
  if (pepper === null) {
    throw configuration('auth_otp_pepper_missing', `${AUTH_OTP_PEPPER_VARIABLE} is not set`);
  }
  if (pepper.length < MINIMUM_PEPPER_LENGTH) {
    throw configuration(
      'auth_otp_pepper_too_short',
      `${AUTH_OTP_PEPPER_VARIABLE} must be at least ${MINIMUM_PEPPER_LENGTH} characters`,
    );
  }
  return { provider: createResendProvider({ apiKey, from }), pepper };
}
