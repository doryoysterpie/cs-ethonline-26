import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { assertSheetsImportMapping } from './import.js';
import { loadTabMapPolicy, mappingForTab, TAB_MAP_PATH } from './tab-map.js';

let temporary = '';

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'cas-tab-map-'));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function policyFile(content: string): Promise<string> {
  const file = path.join(temporary, 'tab-map.json');
  await writeFile(file, content, 'utf8');
  return file;
}

async function codeOf(run: () => Promise<unknown> | unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return isIngestionError(error) ? error.code : 'not-an-ingestion-error';
  }
}

const VALID = {
  tabs: [
    {
      title: 'Synthetic feed',
      stage: 'rss_source_corpus',
      sourceKind: 'master',
      firstDataRow: 2,
      columns: 9,
      timestampColumns: [2, 3],
    },
  ],
};

describe('the committed tab map', () => {
  it('declares the living feed tab as the source corpus, and nothing else', async () => {
    const policy = await loadTabMapPolicy(TAB_MAP_PATH);
    expect(policy.tabs).toHaveLength(1);
    const feed = mappingForTab(policy, 'Cyberattack Sundays');
    expect(feed.stage).toBe('rss_source_corpus');
    expect(feed.sourceKind).toBe('master');
    expect(feed.firstDataRow).toBe(2);
    expect(feed.columns).toBe(9);
    expect(feed.timestampColumns).toEqual([2, 3]);
    expect(() => assertSheetsImportMapping(feed)).not.toThrow();
  });
});

describe('loading a tab map', () => {
  it('loads a valid declaration', async () => {
    const policy = await loadTabMapPolicy(await policyFile(JSON.stringify(VALID)));
    expect(policy.tabs[0]?.title).toBe('Synthetic feed');
  });

  it('refuses a file that is not JSON, and a missing file', async () => {
    expect(await codeOf(async () => loadTabMapPolicy(await policyFile('{')))).toBe(
      'tab_map_unreadable',
    );
    expect(await codeOf(() => loadTabMapPolicy(path.join(temporary, 'absent.json')))).toBe(
      'tab_map_unreadable',
    );
  });

  it('refuses a declaration with the wrong shape', async () => {
    for (const content of [
      '[]',
      '{"tabs": {}}',
      JSON.stringify({ tabs: [{}] }),
      JSON.stringify({ tabs: [{ ...VALID.tabs[0], title: '' }] }),
      JSON.stringify({ tabs: [{ ...VALID.tabs[0], title: 'bad\u0007title' }] }),
      JSON.stringify({ tabs: [{ ...VALID.tabs[0], sourceKind: 'other' }] }),
      JSON.stringify({ tabs: [{ ...VALID.tabs[0], firstDataRow: 0 }] }),
      JSON.stringify({ tabs: [{ ...VALID.tabs[0], timestampColumns: 'B' }] }),
      JSON.stringify({ tabs: [VALID.tabs[0], VALID.tabs[0]] }),
    ]) {
      expect(await codeOf(async () => loadTabMapPolicy(await policyFile(content))), content).toBe(
        'tab_map_invalid',
      );
    }
  });

  it('refuses a tab the declaration does not name', async () => {
    const policy = await loadTabMapPolicy(await policyFile(JSON.stringify(VALID)));
    expect(await codeOf(() => mappingForTab(policy, 'CS90'))).toBe('tab_not_declared');
  });
});
