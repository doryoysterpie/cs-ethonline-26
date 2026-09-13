import { createSign } from 'node:crypto';

import type { ServiceAccountCredential } from './credentials.js';
import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';
import { request, type FetchLike } from './transport.js';

/**
 * Authorization: a signed assertion exchanged for a read-only access token.
 *
 * This is the service-account JWT-bearer flow, implemented directly against
 * Node's crypto and the transport boundary rather than through a Google SDK.
 * That is a deliberate security choice, not an exercise: the whole surface
 * this connector can reach is the two origins the transport allowlists and the
 * one scope named below. A general-purpose client library would bring the
 * Drive API, the write scopes and a discovery mechanism into the dependency
 * graph, and "no Drive call exists" would become a claim about how we use a
 * large library instead of a fact about what the code can do.
 *
 * There is no user OAuth flow here and no refresh token. Nothing asks the
 * owner to authorize anything in a browser, and nothing acts as the owner: the
 * connector acts as a service account that the owner shared exactly one file
 * with, and revocation is removing that share.
 */

/**
 * The only scope this connector ever requests.
 *
 * Read-only, and scoped to Sheets. No Drive scope exists anywhere in this
 * package, and a test asserts that this constant is the sole scope string and
 * that no write or Drive scope appears in the built output.
 */
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Assertion lifetime. Google permits up to an hour; a short window is enough. */
const ASSERTION_LIFETIME_SECONDS = 300;
/** A token is renewed this long before it expires, so no request races expiry. */
const RENEW_BEFORE_SECONDS = 60;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Builds and signs the assertion. Exported so a test can verify the claim set
 * and the scope without performing an exchange.
 */
export function buildAssertion(
  credential: ServiceAccountCredential,
  issuedAtSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: credential.clientEmail,
      scope: SHEETS_READONLY_SCOPE,
      aud: credential.tokenUri,
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + ASSERTION_LIFETIME_SECONDS,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  let signature: string;
  try {
    signature = signer.sign(credential.privateKey, 'base64url');
  } catch {
    // The underlying message can quote key material; it is not carried through.
    throw fail.credential(
      'assertion_signing_failed',
      'the service-account private key could not sign the authorization assertion',
    );
  }
  return `${signingInput}.${signature}`;
}

export interface AccessToken {
  readonly value: string;
  /** Unix seconds at which the token stops being used. */
  readonly expiresAtSeconds: number;
}

export interface TokenSourceOptions {
  readonly credential: ServiceAccountCredential;
  readonly limits: SheetsLimits;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => Date) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Supplies access tokens, caching one until shortly before it expires.
 *
 * The cached token is held in a private field and is never returned as part of
 * any report, error or provenance record. A concurrent caller awaits the
 * in-flight exchange rather than starting a second one.
 */
export class TokenSource {
  readonly #credential: ServiceAccountCredential;
  readonly #limits: SheetsLimits;
  readonly #fetchImpl: FetchLike | undefined;
  readonly #now: () => Date;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  #cached: AccessToken | null = null;
  #inFlight: Promise<AccessToken> | null = null;

  constructor(options: TokenSourceOptions) {
    this.#credential = options.credential;
    this.#limits = options.limits;
    this.#fetchImpl = options.fetchImpl;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep;
  }

  /** The service account's address. Safe to print; it is not a secret. */
  get clientEmail(): string {
    return this.#credential.clientEmail;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    const nowSeconds = Math.floor(this.#now().getTime() / 1000);
    const cached = this.#cached;
    if (cached !== null && cached.expiresAtSeconds - RENEW_BEFORE_SECONDS > nowSeconds) {
      return cached.value;
    }
    this.#inFlight ??= this.#exchange(nowSeconds, signal).finally(() => {
      this.#inFlight = null;
    });
    const token = await this.#inFlight;
    return token.value;
  }

  async #exchange(nowSeconds: number, signal?: AbortSignal): Promise<AccessToken> {
    const assertion = buildAssertion(this.#credential, nowSeconds);
    const body = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion,
    }).toString();

    const response = await request(
      {
        url: this.#credential.tokenUri,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        // A token exchange is safe to repeat: it mints a new token and
        // changes nothing the owner can observe.
        idempotent: true,
      },
      {
        limits: this.#limits,
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
        ...(signal === undefined ? {} : { signal }),
        ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
      },
    );

    if (response.status !== 200) {
      // The body of a failed token exchange can echo the assertion. The
      // status alone is reported.
      throw fail.authorization(
        'token_exchange_failed',
        'the authorization exchange was refused. Confirm the service account exists, that its key is current, and that the Sheets API is enabled for its project.',
        { status: response.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text) as unknown;
    } catch {
      throw fail.schema(
        'token_response_not_json',
        'the authorization response could not be parsed as JSON',
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw fail.schema(
        'token_response_invalid',
        'the authorization response is not a JSON object',
      );
    }
    const record = parsed as Record<string, unknown>;
    const value = record['access_token'];
    const expiresIn = record['expires_in'];
    if (typeof value !== 'string' || value.length === 0) {
      throw fail.schema('token_response_invalid', 'the authorization response carries no token');
    }
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw fail.schema(
        'token_response_invalid',
        'the authorization response carries no usable expiry',
      );
    }
    const token: AccessToken = {
      value,
      expiresAtSeconds: nowSeconds + Math.floor(expiresIn),
    };
    this.#cached = token;
    return token;
  }
}
