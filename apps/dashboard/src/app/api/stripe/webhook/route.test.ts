import { describe, expect, it } from 'vitest';

import { readBounded } from './route.ts';

function stream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index];
      index += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
  });
}

describe('the webhook body reader', () => {
  it('reassembles a chunked body under the bound, byte for byte', async () => {
    expect(await readBounded(stream(['{"a":', '"é"', '}']), 64)).toBe('{"a":"é"}');
    expect(await readBounded(null, 64)).toBe('');
  });

  it('stops reading once the bound is crossed, whatever the declared length', async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    expect(await readBounded(endless, 4_096)).toBeNull();
    expect(pulls).toBeLessThanOrEqual(6);
  });
});
