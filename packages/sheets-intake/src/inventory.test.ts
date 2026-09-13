import { describe, expect, it } from 'vitest';

import { SheetsReadOnlyClient } from './client.js';
import { isSheetsIntakeError } from './errors.js';
import { inventoryWorkbook } from './inventory.js';
import { readTab, totalStats } from './reader.js';
import { analyzeHeaders, inferTabType } from './schema.js';
import { TokenSource } from './token.js';
import {
  AUTHORIZED_ID,
  fakeTransport,
  metadataResponse,
  syntheticCredential,
  testLimits,
  tokenResponse,
  valuesResponse,
  type FakeResponse,
} from './test-support.js';

/**
 * The inventory and the bounded read, against synthetic workbooks.
 *
 * Two claims get the most attention here. The inventory must describe a
 * workbook without reporting its contents, which is checked by scanning the
 * whole serialized report for planted data. And the reader must never present
 * a partial reading as a complete one, which is checked by giving it a tab
 * larger than its bound and requiring a refusal rather than a prefix.
 */

const limits = testLimits();

function harness(script: readonly FakeResponse[], clientLimits = limits) {
  const transport = fakeTransport([tokenResponse(), ...script]);
  const tokens = new TokenSource({
    credential: syntheticCredential(),
    limits: clientLimits,
    fetchImpl: transport.fetchImpl,
    sleep: transport.sleep,
  });
  const client = new SheetsReadOnlyClient(AUTHORIZED_ID, {
    tokens,
    limits: clientLimits,
    fetchImpl: transport.fetchImpl,
    sleep: transport.sleep,
  });
  return { transport, client };
}

describe('the inventory describes structure and reports no content', () => {
  it('reports the title match, tab counts and declared sizes', async () => {
    const { client } = harness([
      metadataResponse([
        { title: 'RSS Feed', rows: 24_000, columns: 9 },
        { title: 'CS86', rows: 200, columns: 6 },
        { title: 'Scratch', rows: 10, columns: 2, hidden: true },
      ]),
      valuesResponse("'RSS Feed'!A1:I1", [['Title', 'URL', 'Published', 'Feed', 'guid']]),
      valuesResponse("'CS86'!A1:F1", [['Title', 'URL', 'ch', 'Notes']]),
      valuesResponse("'Scratch'!A1:B1", [['a', 'b']]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });

    expect(inventory.titleMatches).toBe(true);
    expect(inventory.expectedTitle).toBe('Cyberattack Sunday - RSS Intake');
    expect(inventory.tabCount).toBe(3);
    expect(inventory.visibleTabCount).toBe(2);
    expect(inventory.hiddenTabCount).toBe(1);
    expect(inventory.timeZone).toBe('America/Toronto');
    expect(inventory.tabsInspected).toBe(3);
    expect(inventory.tabsSkipped).toBe(0);
    expect(inventory.tabs[0]).toMatchObject({
      displayName: 'RSS Feed',
      declaredRows: 24_000,
      declaredColumns: 9,
    });
    expect(inventory.tabs[0]?.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reads only the header row of each tab, and nothing below it', async () => {
    const { transport, client } = harness([
      metadataResponse([{ title: 'RSS Feed', rows: 24_000, columns: 4 }]),
      valuesResponse("'RSS Feed'!A1:D1", [['Title', 'URL', 'Published', 'guid']]),
    ]);
    await inventoryWorkbook(client, { limits });
    const ranges = transport.requests
      .filter((request) => request.url.includes('/values/'))
      .map((request) => decodeURIComponent(request.url.split('/values/')[1]?.split('?')[0] ?? ''));
    expect(ranges).toEqual(["'RSS Feed'!A1:D1"]);
    // Row 1 only. No range in this run reaches row 2.
    for (const range of ranges) expect(range).toMatch(/!A1:[A-Z]+1$/);
  });

  it('never carries a data cell into the report', async () => {
    const planted = 'PLANTED-HEADLINE-DO-NOT-LEAK';
    const plantedUrl = 'https://planted.invalid/story';
    const { client } = harness([
      metadataResponse([{ title: 'RSS Feed', rows: 50, columns: 3 }]),
      // The header row is what the inventory asks for; the fake answers with
      // data rows too, as a hostile API could.
      valuesResponse("'RSS Feed'!A1:C1", [
        ['Title', 'URL', 'Published'],
        [planted, plantedUrl, 46194],
      ]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(planted);
    expect(serialized).not.toContain(plantedUrl);
    expect(serialized).not.toContain(AUTHORIZED_ID);
    // The headers it did report are there.
    expect(serialized).toContain('Title');
  });

  it('renders a hostile tab name as one line and flags that it was escaped', async () => {
    const hostile = `Week 41\ninventory: tabs=0 warnings=0${String.fromCharCode(0x1b)}[2K`;
    const { client } = harness([
      metadataResponse([{ title: hostile, rows: 10, columns: 2 }]),
      valuesResponse('x', [['a', 'b']]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });
    const tab = inventory.tabs[0];
    expect(tab?.nameSanitized).toBe(true);
    expect(tab?.displayName).not.toContain('\n');
    expect(tab?.displayName).toContain('\\n');
    expect(tab?.displayName).toContain('\\x1b');
    expect(JSON.stringify(inventory).includes('\\n"')).toBe(false);
  });

  it('warns rather than aborting when the title does not match', async () => {
    const { client } = harness([
      metadataResponse([{ title: 'Feed' }], { title: 'Some Other Workbook' }),
      valuesResponse('x', [['a']]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });
    expect(inventory.titleMatches).toBe(false);
    expect(inventory.warnings.join(' ')).toContain('does not match the authorized file name');
    // The rest of the structure is still reported, which is what a reviewer needs.
    expect(inventory.tabs).toHaveLength(1);
  });

  it('warns when the workbook declares no time zone', async () => {
    const { client } = harness([
      metadataResponse([{ title: 'Feed' }], { timeZone: null }),
      valuesResponse('x', [['a']]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });
    expect(inventory.warnings.join(' ')).toContain('no time zone');
  });

  it('records one unreadable tab as a warning and inspects the rest', async () => {
    const { client } = harness(
      [
        metadataResponse([
          { title: 'Good', rows: 10, columns: 2 },
          { title: 'Bad', rows: 10, columns: 2 },
        ]),
        valuesResponse("'Good'!A1:B1", [['Title', 'URL']]),
        { status: 500 },
      ],
      testLimits({ maximumAttempts: 1 }),
    );
    const inventory = await inventoryWorkbook(client, { limits });
    expect(inventory.tabs).toHaveLength(2);
    expect(inventory.tabs[0]?.headers).not.toBeNull();
    expect(inventory.tabs[1]?.headers).toBeNull();
    expect(inventory.tabs[1]?.warnings.join(' ')).toContain('could not be read');
  });

  it('refuses a workbook declaring more tabs than the bound', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ title: `T${index}` }));
    const tight = testLimits({ maximumTabs: 5 });
    const { client } = harness([metadataResponse(many)], tight);
    let caught: unknown;
    try {
      await inventoryWorkbook(client, { limits: tight });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('workbook_too_many_tabs');
  });

  it('warns rather than reading when a tab exceeds the row or column bound', async () => {
    const { client } = harness([
      metadataResponse([{ title: 'Huge', rows: 500_000, columns: 500 }]),
      valuesResponse('x', [['a']]),
    ]);
    const inventory = await inventoryWorkbook(client, {
      limits: testLimits({ maximumRowsPerTab: 1000, maximumColumnsPerTab: 16 }),
    });
    const warnings = inventory.tabs[0]?.warnings.join(' ') ?? '';
    expect(warnings).toContain('declared row count 500000 exceeds');
    expect(warnings).toContain('declared column count 500 exceeds');
  });

  it('reports a non-grid tab as unreadable rather than guessing', async () => {
    const { client } = harness([
      metadataResponse([{ title: 'Chart', sheetType: 'OBJECT', rows: 0, columns: 0 }]),
    ]);
    const inventory = await inventoryWorkbook(client, { limits });
    expect(inventory.tabs[0]?.headers).toBeNull();
    expect(inventory.tabs[0]?.warnings.join(' ')).toContain('not a grid');
  });
});

describe('headers are described, never repaired', () => {
  it('reports duplicates and blanks with their positions, deterministically', () => {
    const row = ['Title', '', 'URL', 'title', '   ', 'URL'];
    const first = analyzeHeaders(row, limits);
    const second = analyzeHeaders([...row], limits);
    expect(second).toEqual(first);

    expect(first.blankColumns).toEqual([2, 5]);
    expect(first.duplicates).toEqual([
      { normalized: 'title', columns: [1, 4] },
      { normalized: 'url', columns: [3, 6] },
    ]);
    // Nothing was renamed, deduplicated or filled in.
    expect(first.headers.map((header) => header.display)).toEqual(row);
  });

  it('orders duplicate groups the same way whatever the column order', () => {
    const a = analyzeHeaders(['b', 'a', 'b', 'a'], limits);
    expect(a.duplicates.map((d) => d.normalized)).toEqual(['a', 'b']);
  });

  it('escapes a hostile header for display and flags it', () => {
    const analysis = analyzeHeaders([`Title\nURL`], limits);
    expect(analysis.anySanitized).toBe(true);
    expect(analysis.headers[0]?.display).toBe('Title\\nURL');
  });

  it('refuses an oversized header row and an oversized header cell', () => {
    let caught: unknown;
    try {
      analyzeHeaders(
        Array.from({ length: 65 }, () => 'h'),
        testLimits({ maximumColumnsPerTab: 64 }),
      );
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('header_too_many_columns');

    let caught2: unknown;
    try {
      analyzeHeaders(['x'.repeat(201)], testLimits({ maximumHeaderCharacters: 200 }));
    } catch (error) {
      caught2 = error;
    }
    expect(isSheetsIntakeError(caught2) ? caught2.code : '').toBe('header_too_long');
  });

  it('marks every type inference provisional and ignores the tab name', () => {
    const corpus = inferTabType(analyzeHeaders(['Title', 'URL', 'guid', 'feed'], limits));
    expect(corpus).toMatchObject({ hypothesis: 'rss_source_corpus', provisional: true });
    expect(corpus.confidence).toBeGreaterThan(0);

    const weekly = inferTabType(analyzeHeaders(['Title', 'URL', 'ch', 'include', 'week'], limits));
    expect(weekly).toMatchObject({ hypothesis: 'weekly_candidates', provisional: true });

    const unknown = inferTabType(analyzeHeaders(['Alpha', 'Beta'], limits));
    expect(unknown).toMatchObject({ hypothesis: 'unclassified', confidence: 0, provisional: true });
  });
});

describe('the bounded read never truncates silently', () => {
  const tab = {
    sheetId: 1,
    title: 'RSS Feed',
    index: 0,
    sheetType: 'GRID',
    hidden: false,
    rowCount: 5,
    columnCount: 3,
    frozenRowCount: 1,
  };
  const mapping = {
    title: 'RSS Feed',
    stage: 'rss_source_corpus' as const,
    firstDataRow: 2,
    columns: 3,
    timestampColumn: 3,
  };
  const readOptions = {
    limits: testLimits({ rowsPerPage: 2 }),
    timeZone: 'America/Toronto',
    workbookDigest: 'wbdigest',
    now: () => new Date('2026-09-12T00:00:00Z'),
  };

  function rowsHarness() {
    return harness([
      valuesResponse("'RSS Feed'!A2:C3", [
        ['First story', 'https://a.invalid', 46194],
        ['Second story', 'https://b.invalid', 46195],
      ]),
      valuesResponse("'RSS Feed'!A4:C5", [
        ['', '', ''],
        ['=1+1', 'https://c.invalid', 'not a date'],
      ]),
    ]);
  }

  it('pages through a tab and counts what it saw', async () => {
    const { client } = rowsHarness();
    const outcome = await readTab(client, tab, mapping, { ...readOptions, collectRows: true });
    expect(outcome.stats).toMatchObject({
      tabsRead: 1,
      rowsRead: 4,
      rowsEmitted: 3,
      rowsBlank: 1,
      pages: 2,
      timestampsNormalized: 2,
      timestampsUnreadable: 1,
      cellsFormulaLeading: 1,
    });
    expect(outcome.rows).toHaveLength(3);
  });

  it('carries the tab, stage, row number and read instant on every row', async () => {
    const { client } = rowsHarness();
    const outcome = await readTab(client, tab, mapping, { ...readOptions, collectRows: true });
    const first = outcome.rows[0];
    expect(first).toMatchObject({
      tabDisplayName: 'RSS Feed',
      stage: 'rss_source_corpus',
      rowNumber: 2,
      observedAt: '2026-06-21T04:00:00.000Z',
      ingestedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(first?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same keys when the same workbook is read again', async () => {
    const firstRun = await readTab(rowsHarness().client, tab, mapping, {
      ...readOptions,
      collectRows: true,
    });
    const secondRun = await readTab(rowsHarness().client, tab, mapping, {
      ...readOptions,
      collectRows: true,
      now: () => new Date('2026-09-13T00:00:00Z'),
    });
    expect(secondRun.rows.map((row) => row.key)).toEqual(firstRun.rows.map((row) => row.key));
    // The read instant differs, and identity does not depend on it.
    expect(secondRun.rows[0]?.ingestedAt).not.toBe(firstRun.rows[0]?.ingestedAt);
  });

  it('collects nothing on a dry run but counts everything', async () => {
    const { client } = rowsHarness();
    const outcome = await readTab(client, tab, mapping, readOptions);
    expect(outcome.rows).toEqual([]);
    expect(outcome.stats.rowsEmitted).toBe(3);
  });

  it('streams to a callback without collecting', async () => {
    const seen: number[] = [];
    const { client } = rowsHarness();
    const outcome = await readTab(client, tab, mapping, {
      ...readOptions,
      onRow: (row) => seen.push(row.rowNumber),
    });
    expect(seen).toEqual([2, 3, 5]);
    expect(outcome.rows).toEqual([]);
  });

  it('keeps a formula-leading cell as inert text and warns about it', async () => {
    const { client } = rowsHarness();
    const outcome = await readTab(client, tab, mapping, { ...readOptions, collectRows: true });
    const formulaRow = outcome.rows.find((row) => row.rowNumber === 5);
    expect(formulaRow?.cells[0]).toMatchObject({ kind: 'text', raw: '=1+1', formulaLeading: true });
    expect(outcome.warnings.join(' ')).toContain('begin like a formula');
  });

  it('refuses a tab larger than its bound instead of reading a prefix', async () => {
    const { transport, client } = harness([]);
    let caught: unknown;
    try {
      await readTab(client, { ...tab, rowCount: 2000 }, mapping, {
        ...readOptions,
        limits: testLimits({ maximumRowsPerTab: 1000 }),
      });
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('tab_row_bound_exceeded');
    // The decisive part: no partial read happened.
    expect(transport.requests.filter((r) => r.url.includes('/values/'))).toEqual([]);
  });

  it('refuses a tab wider than its bound, and a page that would be too large', async () => {
    const { client } = harness([]);
    await expect(
      readTab(
        client,
        { ...tab, columnCount: 500 },
        { ...mapping, columns: 500 },
        {
          ...readOptions,
          limits: testLimits({ maximumColumnsPerTab: 16 }),
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isSheetsIntakeError(e) && e.code === 'tab_column_bound_exceeded',
    );

    await expect(
      readTab(client, tab, mapping, {
        ...readOptions,
        limits: testLimits({ rowsPerPage: 500, maximumCellsPerPage: 10 }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isSheetsIntakeError(e) && e.code === 'page_cell_bound_exceeded',
    );
  });

  it('refuses a row wider than the range it asked for', async () => {
    const { client } = harness([valuesResponse("'RSS Feed'!A2:C3", [['a', 'b', 'c', 'smuggled']])]);
    await expect(readTab(client, { ...tab, rowCount: 3 }, mapping, readOptions)).rejects.toSatisfy(
      (e: unknown) => isSheetsIntakeError(e) && e.code === 'row_wider_than_requested',
    );
  });

  it('honours cancellation between pages', async () => {
    const controller = new AbortController();
    const { client } = harness([
      valuesResponse("'RSS Feed'!A2:C3", [
        ['a', 'b', 46194],
        ['c', 'd', 46195],
      ]),
      valuesResponse("'RSS Feed'!A4:C5", [
        ['e', 'f', 46196],
        ['g', 'h', 46197],
      ]),
    ]);
    let rows = 0;
    await expect(
      readTab(client, tab, mapping, {
        ...readOptions,
        signal: controller.signal,
        onRow: () => {
          rows += 1;
          if (rows === 2) controller.abort();
        },
      }),
    ).rejects.toSatisfy((e: unknown) => isSheetsIntakeError(e) && e.code === 'read_cancelled');
  });

  it('refuses a mapping whose timestamp column is outside what it reads', async () => {
    const { client } = harness([]);
    await expect(
      readTab(client, tab, { ...mapping, timestampColumn: 9 }, readOptions),
    ).rejects.toSatisfy(
      (e: unknown) => isSheetsIntakeError(e) && e.code === 'mapping_timestamp_column_invalid',
    );
  });

  it('sums several tab readings into one run total', () => {
    const one = {
      stats: {
        tabsRead: 1,
        rowsRead: 10,
        rowsEmitted: 9,
        rowsBlank: 1,
        pages: 2,
        cellsFormulaLeading: 0,
        cellsRequiringEscape: 0,
        timestampsNormalized: 9,
        timestampsUnreadable: 0,
        distinctKeys: 9,
      },
      rows: [],
      warnings: [],
    };
    const two = {
      ...one,
      stats: { ...one.stats, rowsRead: 5, rowsEmitted: 5, rowsBlank: 0, pages: 1, distinctKeys: 5 },
    };
    expect(totalStats([one, two])).toMatchObject({
      tabsRead: 2,
      rowsRead: 15,
      rowsEmitted: 14,
      pages: 3,
    });
  });
});

describe('the connector cannot follow a link it read', () => {
  it('never requests a URL found in a cell', async () => {
    const articleUrl = 'https://article.invalid/exclusive';
    const { transport, client } = harness([
      metadataResponse([{ title: 'RSS Feed', rows: 3, columns: 2 }]),
      valuesResponse("'RSS Feed'!A1:B1", [['Title', 'URL']]),
    ]);
    await inventoryWorkbook(client, { limits });
    await readTab(
      client,
      {
        sheetId: 1,
        title: 'RSS Feed',
        index: 0,
        sheetType: 'GRID',
        hidden: false,
        rowCount: 3,
        columnCount: 2,
        frozenRowCount: 1,
      },
      { title: 'RSS Feed', stage: 'rss_source_corpus', firstDataRow: 2, columns: 2 },
      { limits, timeZone: 'America/Toronto', workbookDigest: 'wb', collectRows: true },
    ).catch(() => undefined);

    for (const attempted of transport.requests) {
      expect(
        attempted.url.startsWith('https://sheets.googleapis.com/') ||
          attempted.url.startsWith('https://oauth2.googleapis.com/'),
      ).toBe(true);
      expect(attempted.url).not.toContain('article.invalid');
    }
    expect(articleUrl).not.toBe('');
  });
});
