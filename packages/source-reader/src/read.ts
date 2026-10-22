import { createHash } from 'node:crypto';

import { classifySourceReference } from '@cas/contracts';

import { decodeText, readBounded } from './body.js';
import { isReadError, ReadError, type ReadCode } from './errors.js';
import { htmlToText } from './html-text.js';
import { ACCEPT, READER_LIMITS, USER_AGENT_TOKEN, type ReaderLimits } from './limits.js';
import { parseRobots, robotsAllows, type RobotsRules } from './robots.js';
import { checkTarget, type CheckedTarget, type Resolver } from './target.js';
import type { RawResponse, RawTransport } from './transport.js';

/** One source row of the persisted selection: the only thing ever fetched (R13). */
export interface SourceToRead {
  readonly sourceRowId: string;
  readonly url: string;
}

export interface ReadSource {
  readonly sourceRowId: string;
  readonly status: 'read' | 'partly_read';
  /** Why the page is incomplete, when it is. */
  readonly code: ReadCode | null;
  readonly text: string;
  readonly chars: number;
  readonly bytes: number;
  /** SHA-256 of the extracted text: kept in provenance so a later run can tell a page changed (O-1). */
  readonly digest: string;
  readonly ms: number;
}

export interface UnreadSource {
  readonly sourceRowId: string;
  readonly status: 'not_read';
  readonly code: ReadCode;
  readonly bytes: number;
  readonly ms: number;
}

export type SourceOutcome = ReadSource | UnreadSource;

export interface Reading {
  /** One outcome per source, in the order given. */
  readonly outcomes: readonly SourceOutcome[];
  readonly limits: ReaderLimits;
  readonly totals: { readonly bytes: number; readonly chars: number; readonly ms: number };
}

export interface ReaderDependencies {
  readonly transport: RawTransport;
  readonly resolver: Resolver;
  /** The fixed user agent of O-3 (`userAgent()` in limits.ts). */
  readonly userAgent: string;
  readonly limits?: ReaderLimits;
  readonly now?: () => number;
}

type RobotsVerdict =
  | { readonly kind: 'rules'; readonly rules: RobotsRules }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

const PERMITTED_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function plainText(text: string): string {
  const lines = text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/gu, ' ').trim())
    .filter((line) => line.length > 0);
  return lines.join('\n').normalize('NFC');
}

/** Cuts text at the last paragraph boundary before the limit, or at the limit when there is none. */
export function cutAtParagraph(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const boundary = text.lastIndexOf('\n', limit);
  return text.slice(0, boundary > 0 ? boundary : limit);
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ReadError('fetch_timeout', 'the fetch did not complete in time')),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

class Reader {
  private readonly limits: ReaderLimits;
  private readonly now: () => number;
  private readonly robots = new Map<string, Promise<RobotsVerdict>>();
  readonly deadline: number;

  constructor(private readonly deps: ReaderDependencies) {
    this.limits = deps.limits ?? READER_LIMITS;
    this.now = deps.now ?? Date.now;
    this.deadline = this.now() + this.limits.stageTimeoutMs;
  }

  private headers(): Record<string, string> {
    return {
      accept: ACCEPT,
      'accept-encoding': 'identity',
      'user-agent': this.deps.userAgent,
    };
  }

  /** One request to a checked target, bounded in time; the caller reads the body. */
  private async request(
    target: CheckedTarget,
    timeoutMs: number,
    bound: number,
  ): Promise<{ response: RawResponse; body: () => Promise<{ bytes: Uint8Array; cut: boolean }> }> {
    const { signal, clear } = withTimeout(timeoutMs);
    try {
      const response = await this.deps.transport.request({
        target,
        headers: this.headers(),
        signal,
      });
      return {
        response,
        body: async () => {
          try {
            return await readBounded(response, bound, signal);
          } finally {
            clear();
          }
        },
      };
    } catch (error) {
      clear();
      throw error;
    }
  }

  private robotsFor(target: CheckedTarget): Promise<RobotsVerdict> {
    const key = `${target.tls ? 'https' : 'http'}://${target.host}`;
    let pending = this.robots.get(key);
    if (pending === undefined) {
      pending = this.fetchRobots(target);
      this.robots.set(key, pending);
    }
    return pending;
  }

  private async fetchRobots(target: CheckedTarget): Promise<RobotsVerdict> {
    try {
      const url = new URL(`${target.tls ? 'https' : 'http'}://${target.host}/robots.txt`);
      const robotsTarget: CheckedTarget = { ...target, url };
      const { response, body } = await this.request(
        robotsTarget,
        this.limits.robotsTimeoutMs,
        this.limits.robotsBytes,
      );
      if (response.status >= 400 && response.status < 500) return { kind: 'none' };
      if (response.status < 200 || response.status >= 300) return { kind: 'unavailable' };
      const { bytes } = await body();
      const text = decodeText(bytes, response.headers['content-type'] ?? 'text/plain');
      return { kind: 'rules', rules: parseRobots(text) };
    } catch {
      // A server error, a timeout or a refused redirect: RFC 9309 treats the
      // file as unreadable, which is a complete disallow.
      return { kind: 'unavailable' };
    }
  }

  /** The page for one source, following at most `redirectLimit` re-checked redirects (R7). */
  async readOne(source: SourceToRead): Promise<SourceOutcome> {
    const started = this.now();
    let bytesRead = 0;
    const done = (
      outcome: Omit<ReadSource, 'ms'> | Omit<UnreadSource, 'ms' | 'bytes'>,
    ): SourceOutcome =>
      outcome.status === 'not_read'
        ? { ...outcome, bytes: bytesRead, ms: this.now() - started }
        : { ...outcome, ms: this.now() - started };
    try {
      if (this.now() >= this.deadline) {
        throw new ReadError('stage_timeout', 'the reading stage is over its deadline');
      }
      let current = source.url;
      for (let hop = 0; ; hop += 1) {
        const target = await checkTarget(current, this.deps.resolver);
        const robots = await this.robotsFor(target);
        if (robots.kind === 'unavailable') {
          throw new ReadError('robots_unavailable', 'robots.txt could not be read');
        }
        const path = `${target.url.pathname}${target.url.search}`;
        if (robots.kind === 'rules' && !robotsAllows(robots.rules, USER_AGENT_TOKEN, path)) {
          throw new ReadError('robots_disallowed', 'robots.txt disallows the path');
        }
        const { response, body } = await this.request(
          target,
          this.limits.fetchTimeoutMs,
          this.limits.bodyBytes,
        );
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.location;
          if (location === undefined)
            throw new ReadError('redirect_refused', 'a redirect without a location');
          if (hop >= this.limits.redirectLimit)
            throw new ReadError('redirect_limit', 'too many redirects');
          let next: URL;
          try {
            next = new URL(location, target.url);
          } catch {
            throw new ReadError('redirect_refused', 'a redirect to a malformed location');
          }
          // Re-classified under R1 to R4 first, so a redirect into a private
          // address is named as such; then the downgrade rule; then R5 and R6
          // at the top of the loop.
          const verdict = classifySourceReference(next.href);
          if (verdict.status === 'rejected') {
            throw new ReadError(verdict.reason, 'a redirect to a refused location');
          }
          if (target.tls && next.protocol !== 'https:') {
            throw new ReadError('redirect_downgrade', 'a redirect from https to http');
          }
          current = next.href;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new ReadError('status_not_ok', 'the response is not a page');
        }
        const contentType = response.headers['content-type'];
        const type = mediaType(contentType);
        if (!PERMITTED_TYPES.has(type)) {
          throw new ReadError('content_type_not_permitted', 'the response is not text');
        }
        const { bytes, cut } = await body();
        bytesRead = bytes.length;
        const decoded = decodeText(bytes, contentType ?? '');
        const extracted = type === 'text/plain' ? plainText(decoded) : (htmlToText(decoded) ?? '');
        const kept = cutAtParagraph(extracted, this.limits.textCharsPerSource);
        const textCut = kept.length < extracted.length;
        const code: ReadCode | null = cut ? 'body_limit' : textCut ? 'text_limit' : null;
        return done({
          sourceRowId: source.sourceRowId,
          status: code === null ? 'read' : 'partly_read',
          code,
          text: kept,
          chars: kept.length,
          bytes: bytes.length,
          digest: sha256(kept),
        });
      }
    } catch (error) {
      const code: ReadCode = isReadError(error)
        ? error.code
        : error instanceof Error && error.name === 'AbortError'
          ? 'fetch_timeout'
          : 'connection_failed';
      return done({ sourceRowId: source.sourceRowId, status: 'not_read', code });
    }
  }
}

/**
 * Reads every source of a selection under the policy, at most `concurrency`
 * at a time, each canonical URL once, in the order given; then applies the
 * per-reading text bound in that order, so the owner's first selections are
 * read in full first (docs/CAS-005-REPORT.md, section 1.3).
 */
export async function readSources(
  sources: readonly SourceToRead[],
  deps: ReaderDependencies,
): Promise<Reading> {
  const reader = new Reader(deps);
  const limits = deps.limits ?? READER_LIMITS;
  const started = (deps.now ?? Date.now)();
  const byUrl = new Map<string, Promise<SourceOutcome>>();
  const results: (SourceOutcome | undefined)[] = Array.from({ length: sources.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const source = sources[index];
      if (source === undefined) return;
      let pending = byUrl.get(source.url);
      if (pending === undefined) {
        pending = reader.readOne(source);
        byUrl.set(source.url, pending);
      }
      const outcome = await pending;
      results[index] =
        outcome.sourceRowId === source.sourceRowId
          ? outcome
          : { ...outcome, sourceRowId: source.sourceRowId };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, () => worker()));
  let chars = 0;
  let bytes = 0;
  const outcomes: SourceOutcome[] = [];
  for (const outcome of results) {
    if (outcome === undefined) continue;
    if (outcome.status === 'not_read') {
      bytes += outcome.bytes;
      outcomes.push(outcome);
      continue;
    }
    bytes += outcome.bytes;
    if (chars + outcome.chars > limits.textCharsPerReading) {
      outcomes.push({
        sourceRowId: outcome.sourceRowId,
        status: 'not_read',
        code: 'text_limit',
        bytes: outcome.bytes,
        ms: outcome.ms,
      });
      continue;
    }
    chars += outcome.chars;
    outcomes.push(outcome);
  }
  return { outcomes, limits, totals: { bytes, chars, ms: (deps.now ?? Date.now)() - started } };
}
