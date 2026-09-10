import { describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { assertFileIngestInput, assertSnapshot, ingestSnapshotFile } from './signals.js';

/**
 * The snapshot validator as a closed input boundary (audit finding F4), and
 * the file-ingestion input boundary (audit finding F1), offline.
 *
 * The validator has to refuse an object that would satisfy a naive shape
 * check while carrying something the shape does not admit: an inherited
 * field, a symbol key, a non-enumerable extra, an accessor, a proxy, a widened
 * nested object or array. And it has to refuse an accessor without invoking
 * it, which is the difference between a validator and a trigger.
 */

const HEX = 'a'.repeat(64);

function observation(): Record<string, unknown> {
  return {
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    subgraphDeploymentId: null,
    blockNumber: 1,
    blockHash: null,
    observedAt: '2026-09-04T03:17:41Z',
    baselineObservedAt: '2026-09-03T03:17:41Z',
    currentTvlUsd: '1',
    baselineTvlUsd: '1',
    deltaUsd: '0',
    deltaPercent: '0',
  };
}

function snapshot(): Record<string, unknown> {
  return {
    gatewayHost: 'gateway.fixture.example',
    querySha256: HEX,
    observations: [observation()],
  };
}

const refused = (value: unknown): boolean => {
  try {
    assertSnapshot(value);
    return false;
  } catch (error) {
    return isIngestionError(error) && error.code === 'snapshot_invalid';
  }
};

describe('assertSnapshot as a closed boundary', () => {
  it('accepts exactly the documented shape', () => {
    expect(assertSnapshot(snapshot()).observations).toHaveLength(1);
  });

  it('refuses a field that is inherited rather than own', () => {
    const inherited = Object.create({ observations: [observation()] }) as Record<string, unknown>;
    inherited['gatewayHost'] = 'gateway.fixture.example';
    inherited['querySha256'] = HEX;
    expect(refused(inherited)).toBe(true);
    // The same at the nested level.
    const nested = Object.create(observation()) as Record<string, unknown>;
    expect(refused({ ...snapshot(), observations: [nested] })).toBe(true);
  });

  it('refuses an object whose prototype is not the plain one', () => {
    class Shaped {
      gatewayHost = 'gateway.fixture.example';
      querySha256 = HEX;
      observations = [observation()];
    }
    expect(refused(new Shaped())).toBe(true);
    // A null prototype is plain and is accepted.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, snapshot());
    expect(assertSnapshot(bare).gatewayHost).toBe('gateway.fixture.example');
  });

  it('refuses a symbol key at either level', () => {
    const top = Object.assign(snapshot(), { [Symbol('extra')]: 1 });
    expect(refused(top)).toBe(true);
    const nested = Object.assign(observation(), { [Symbol('extra')]: 1 });
    expect(refused({ ...snapshot(), observations: [nested] })).toBe(true);
  });

  it('refuses a non-enumerable unexpected property', () => {
    const top = snapshot();
    Object.defineProperty(top, 'extra', { value: 1, enumerable: false });
    expect(refused(top)).toBe(true);
    const nested = observation();
    Object.defineProperty(nested, 'extra', { value: 1, enumerable: false });
    expect(refused({ ...snapshot(), observations: [nested] })).toBe(true);
  });

  it('refuses a non-enumerable expected property too', () => {
    const top = snapshot();
    Object.defineProperty(top, 'gatewayHost', {
      value: 'gateway.fixture.example',
      enumerable: false,
    });
    expect(refused(top)).toBe(true);
  });

  it('refuses an accessor without ever invoking it', () => {
    let invoked = 0;
    const top = snapshot();
    Object.defineProperty(top, 'gatewayHost', {
      get() {
        invoked += 1;
        return 'gateway.fixture.example';
      },
      enumerable: true,
    });
    expect(refused(top)).toBe(true);
    expect(invoked).toBe(0);

    const nested = observation();
    Object.defineProperty(nested, 'deltaPercent', {
      get(): never {
        invoked += 1;
        throw new Error('a getter ran');
      },
      enumerable: true,
    });
    expect(refused({ ...snapshot(), observations: [nested] })).toBe(true);
    expect(invoked).toBe(0);

    const element = snapshot();
    const list = [observation()];
    Object.defineProperty(list, '0', {
      get(): never {
        invoked += 1;
        throw new Error('an element getter ran');
      },
      enumerable: true,
    });
    element['observations'] = list;
    expect(refused(element)).toBe(true);
    expect(invoked).toBe(0);
  });

  it('refuses a proxy at either level', () => {
    let trapped = 0;
    const top = new Proxy(snapshot(), {
      get(target, key) {
        trapped += 1;
        return Reflect.get(target, key);
      },
    });
    expect(refused(top)).toBe(true);
    const nestedProxy = new Proxy(observation(), {});
    expect(refused({ ...snapshot(), observations: [nestedProxy] })).toBe(true);
    const listProxy = new Proxy([observation()], {});
    expect(refused({ ...snapshot(), observations: listProxy })).toBe(true);
    expect(trapped).toBe(0);
  });

  it('refuses a widened nested object or array', () => {
    expect(refused({ ...snapshot(), observations: [{ ...observation(), extra: 1 }] })).toBe(true);
    const widened = [observation()] as unknown[] & { extra?: number };
    widened.extra = 1;
    expect(refused({ ...snapshot(), observations: widened })).toBe(true);
    class Listish extends Array<unknown> {}
    const subclass = Listish.from([observation()]);
    expect(refused({ ...snapshot(), observations: subclass })).toBe(true);
    // A missing expected field is a widening in the other direction.
    const narrowed = observation();
    delete narrowed['deltaPercent'];
    expect(refused({ ...snapshot(), observations: [narrowed] })).toBe(true);
  });

  it('keeps the value, length and range checks', () => {
    expect(refused({ ...snapshot(), gatewayHost: 'https://gateway.fixture.example' })).toBe(true);
    expect(refused({ ...snapshot(), querySha256: 'nope' })).toBe(true);
    expect(refused({ ...snapshot(), observations: [] })).toBe(true);
    expect(
      refused({
        ...snapshot(),
        observations: Array.from({ length: 501 }, (_, index) => ({
          ...observation(),
          protocolSlug: `p${index}`,
        })),
      }),
    ).toBe(true);
    expect(
      refused({ ...snapshot(), observations: [{ ...observation(), deltaPercent: '1e9' }] }),
    ).toBe(true);
    expect(refused({ ...snapshot(), observations: [{ ...observation(), blockNumber: -1 }] })).toBe(
      true,
    );
    expect(refused({ ...snapshot(), observations: [{ ...observation(), chain: 'solana' }] })).toBe(
      true,
    );
  });
});

describe('file ingestion input boundary', () => {
  it('refuses live before anything else happens', () => {
    let caught: unknown;
    try {
      assertFileIngestInput({ kind: 'file', snapshotPath: '/nowhere/x.json', dataOrigin: 'live' });
    } catch (error) {
      caught = error;
    }
    expect(isIngestionError(caught) ? caught.code : '').toBe('origin_not_file_backed');
    expect(isIngestionError(caught) ? caught.kind : '').toBe('configuration');
  });

  it('accepts only fixture and replay, explicitly', () => {
    expect(
      assertFileIngestInput({ kind: 'file', snapshotPath: 'x.json', dataOrigin: 'replay' })
        .dataOrigin,
    ).toBe('replay');
    expect(
      assertFileIngestInput({ kind: 'file', snapshotPath: 'x.json', dataOrigin: 'fixture' })
        .dataOrigin,
    ).toBe('fixture');
    for (const origin of [undefined, '', 'LIVE', 'Replay', 'production']) {
      let caught: unknown;
      try {
        assertFileIngestInput({ kind: 'file', snapshotPath: 'x.json', dataOrigin: origin });
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught) ? caught.code : '', String(origin)).toBe('origin_required');
    }
  });

  it('refuses an input that is not exactly a file input', () => {
    for (const input of [
      { kind: 'graph-client', snapshotPath: 'x.json', dataOrigin: 'replay' },
      { kind: 'file', snapshotPath: 'x.json', dataOrigin: 'replay', evaluations: [] },
      { kind: 'file', dataOrigin: 'replay' },
      Object.assign(Object.create({ dataOrigin: 'replay' }), { kind: 'file', snapshotPath: 'x' }),
      new Proxy({ kind: 'file', snapshotPath: 'x.json', dataOrigin: 'replay' }, {}),
    ]) {
      expect(() => assertFileIngestInput(input)).toThrowError();
    }
  });

  it('never opens the file or the database for a live request', async () => {
    let used = 0;
    const db = {
      withClient: () => {
        used += 1;
        throw new Error('used');
      },
      withTransaction: () => {
        used += 1;
        throw new Error('used');
      },
    };
    let caught: unknown;
    try {
      await ingestSnapshotFile(db as never, {
        kind: 'file',
        snapshotPath: '/nowhere/does-not-exist.json',
        dataOrigin: 'live' as unknown as 'replay',
      });
    } catch (error) {
      caught = error;
    }
    // A missing file would have produced `snapshot_unreadable`; the origin
    // refusal came first.
    expect(isIngestionError(caught) ? caught.code : '').toBe('origin_not_file_backed');
    expect(used).toBe(0);
  });
});
