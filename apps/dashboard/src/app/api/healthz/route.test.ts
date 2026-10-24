import { describe, expect, it } from 'vitest';

import { NO_STORE } from '../../../server/http/headers.ts';
import { GET } from './route.ts';

describe('/api/healthz', () => {
  it('remains an immediate, content-free process-liveness response', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(NO_STORE);
    expect(await response.text()).toBe('');
  });
});
