import { ETHEREUM_LENDING_TARGETS, type FetchLike } from '@cas/graph-evidence';
import { describe, expect, it } from 'vitest';

import { GraphLiveSignalSource } from './engines/live-graph.js';
import { CallLimiter, invokeTool } from './runtime.js';
import { CallScope, abortCause, throwIfAborted } from './safety/cancellation.js';
import {
  connectInMemory,
  FakeStore,
  ForbiddenStore,
  SECRET_API_KEY,
  testRuntime,
  textOf,
  uuidFrom,
} from './test-support.js';

/**
 * One cancellation state per call (Track D finding F1), in process. The
 * fake store hangs and observes the call's signal the way the PostgreSQL
 * store observes it; a live base fetch does the same for the socket.
 */

const RUN = uuidFrom(4, 1);

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('the call scope', () => {
  it('aborts once, for the first cause, and disposes its timer and links', async () => {
    const client = new AbortController();
    const shutdown = new AbortController();
    const scope = new CallScope({
      client: client.signal,
      shutdown: shutdown.signal,
      deadlineMs: 60_000,
    });
    expect(scope.aborted).toBe(false);
    client.abort();
    expect(scope.cause).toBe('client_cancelled');
    shutdown.abort('shutdown');
    expect(scope.cause).toBe('client_cancelled');
    scope.dispose();
    expect(() => throwIfAborted(scope.signal)).toThrow(/cancelled/);
    const deadline = new CallScope({ deadlineMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deadline.cause).toBe('deadline');
    expect(() => throwIfAborted(deadline.signal)).toThrow(/time budget/);
    deadline.dispose();
    expect(abortCause(undefined)).toBeNull();
    const already = new AbortController();
    already.abort('shutdown');
    const pre = new CallScope({ shutdown: already.signal, deadlineMs: 60_000 });
    expect(pre.cause).toBe('shutdown');
    pre.dispose();
  });
});

describe('deadlines', () => {
  it('cancels the store, issues no further read, and releases the permit only after the work unwound', async () => {
    const store = new FakeStore();
    store.hang = true;
    const limiter = new CallLimiter();
    const { runtime, logs } = testRuntime({
      store,
      limiter,
      deadlines: { stored: 100, live: 100 },
    });
    const started = Date.now();
    const outcome = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.aborts).toEqual(['getEvidenceRun']);
    expect(store.calls).toEqual(['getEvidenceRun']);
    await tick();
    expect(limiter.inFlight).toBe(0);
    expect(runtime.active.size).toBe(0);
    expect(logs.at(-1)).toMatch(/outcome=tool_timeout .* unwound=true/);
  });

  it('holds the permit while work that ignores the abort is still unwinding, then releases it', async () => {
    const store = new FakeStore();
    store.hang = true;
    store.ignoreAbort = true;
    const limiter = new CallLimiter();
    const { runtime, logs } = testRuntime({
      store,
      limiter,
      deadlines: { stored: 50, live: 50 },
      unwindGraceMs: 100,
    });
    const started = Date.now();
    const outcome = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    // Reported after the grace period, not after the work.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(store.aborts).toEqual(['getEvidenceRun']);
    expect(limiter.inFlight).toBe(1);
    expect(runtime.active.size).toBe(1);
    expect(logs.at(-1)).toMatch(/unwound=false/);
    store.release();
    await tick();
    expect(limiter.inFlight).toBe(0);
    expect(runtime.active.size).toBe(0);
    expect(store.calls).toEqual(['getEvidenceRun']);
  });

  it('aborts the live socket through the gateway policy', async () => {
    const seen: AbortSignal[] = [];
    const baseFetch: FetchLike = (_url, init) =>
      new Promise<Response>((_, reject) => {
        const signal = init.signal as AbortSignal;
        seen.push(signal);
        const fail = (): void => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    const live = new GraphLiveSignalSource({ apiKey: SECRET_API_KEY, fetchImpl: baseFetch });
    const limiter = new CallLimiter();
    const { runtime } = testRuntime({
      store: new ForbiddenStore(),
      live,
      limiter,
      deadlines: { stored: 100, live: 100 },
    });
    const outcome = await invokeTool(runtime, 'chain_anomalies', {
      mode: 'live',
      chain: 'ethereum',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    expect(seen).toHaveLength(ETHEREUM_LENDING_TARGETS.length);
    for (const signal of seen) expect(signal.aborted).toBe(true);
    await tick();
    expect(limiter.inFlight).toBe(0);
  });
});

describe('client cancellation over the protocol', () => {
  it('aborts the store when the client cancels, and issues no later read', async () => {
    const store = new FakeStore();
    store.hang = true;
    const harness = await connectInMemory({ store });
    try {
      const controller = new AbortController();
      const call = harness.client.callTool(
        { name: 'list_incidents', arguments: { evidenceRunId: RUN } },
        { signal: controller.signal },
      );
      const until = Date.now() + 2_000;
      while (store.calls.length === 0 && Date.now() < until) await tick();
      expect(store.calls).toEqual(['getEvidenceRun']);
      controller.abort();
      await expect(call).rejects.toThrow();
      const settle = Date.now() + 2_000;
      while (store.aborts.length === 0 && Date.now() < settle) await tick();
      expect(store.aborts).toEqual(['getEvidenceRun']);
      await tick();
      expect(store.calls).toEqual(['getEvidenceRun']);
      expect(harness.runtime.limiter.inFlight).toBe(0);
      expect(harness.runtime.active.size).toBe(0);
      expect(harness.logs.some((line) => line.includes('outcome=call_cancelled'))).toBe(true);
      // Capacity is intact: four concurrent calls are admitted, a fifth is not.
      store.hang = true;
      const four = Array.from({ length: 4 }, () =>
        harness.client.callTool({ name: 'list_incidents', arguments: { evidenceRunId: RUN } }),
      );
      const wait = Date.now() + 2_000;
      while (harness.runtime.limiter.inFlight < 4 && Date.now() < wait) await tick();
      expect(harness.runtime.limiter.inFlight).toBe(4);
      const fifth = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: RUN },
      });
      expect(fifth.isError).toBe(true);
      expect(textOf(fifth)).toContain('too_many_concurrent_calls');
      store.hang = false;
      store.release();
      const results = await Promise.all(four);
      for (const result of results) expect(result.isError).not.toBe(true);
      expect(harness.runtime.limiter.inFlight).toBe(0);
    } finally {
      store.release();
      await harness.close();
    }
  });
});

describe('shutdown', () => {
  it('aborts active calls and waits for them to unwind before closing the store', async () => {
    const store = new FakeStore();
    store.hang = true;
    const { runtime } = testRuntime({ store, deadlines: { stored: 60_000, live: 60_000 } });
    const call = invokeTool(runtime, 'explain_incident', {
      evidenceRunId: RUN,
      incidentId: uuidFrom(10, 2),
    });
    const until = Date.now() + 2_000;
    while (store.calls.length === 0 && Date.now() < until) await tick();
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    const outcome = await call;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('call_cancelled');
    expect(store.aborts).toEqual(['getEvidenceRun']);
    expect(store.calls).toEqual(['getEvidenceRun']);
    expect(store.closed).toBe(true);
    expect(runtime.active.size).toBe(0);
    // A call started after shutdown is refused before it does anything.
    const late = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('call_cancelled');
    expect(store.calls).toEqual(['getEvidenceRun']);
  });

  it('is bounded when work never unwinds', async () => {
    const store = new FakeStore();
    store.hang = true;
    store.ignoreAbort = true;
    const { runtime, logs } = testRuntime({
      store,
      deadlines: { stored: 60_000, live: 60_000 },
      unwindGraceMs: 50,
      shutdownDeadlineMs: 100,
    });
    void invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    const until = Date.now() + 2_000;
    while (store.calls.length === 0 && Date.now() < until) await tick();
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs.some((line) => /shutdown active_calls=1 unwound=false/.test(line))).toBe(true);
    store.release();
    await tick();
    expect(runtime.active.size).toBe(0);
  });
});
