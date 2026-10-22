import { generateKeyPairSync } from 'node:crypto';

import {
  DEFAULT_LIMITS,
  SheetsReadOnlyClient,
  TokenSource,
  type TokenSourceOptions,
} from '@cas/sheets-intake';
import { describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { prepareSheetsBatch, readFeedTab, type SheetsImportMapping } from './import.js';

/**
 * The read half of the Sheets importer, against a scripted transport that
 * opens no socket: the token exchange, the workbook structure, the header
 * row and one page of data rows are all invented here. Nothing is copied
 * from the authorized workbook.
 */

type Fetch = NonNullable<TokenSourceOptions['fetchImpl']>;

const MAPPING: SheetsImportMapping = {
  title: 'Synthetic feed',
  stage: 'rss_source_corpus',
  sourceKind: 'master',
  firstDataRow: 2,
  columns: 9,
  timestampColumns: [2, 3],
};

const HEADERS = [
  'ch',
  'Date Posted',
  'Date Updated',
  'Title',
  'Author',
  'Description',
  'Summary',
  'URL',
  'Category',
];
const ROWS: unknown[][] = [
  [
    true,
    46277.5,
    46037.395833333336,
    'Synthetic title one',
    '',
    '',
    '',
    'https://example.com/one',
    'synthetic',
  ],
  [false, 46277.5, 46277.5, '', '', '', '', 'https://example.com/two', 'synthetic'],
  [
    true,
    'yesterday',
    46277.5,
    'Synthetic title three',
    '',
    '',
    '',
    'https://example.com/three',
    '',
  ],
];

function json(body: unknown): string {
  return JSON.stringify(body);
}

function metadata(title: string, rowCount: number): string {
  return json({
    properties: { title: 'Synthetic workbook', locale: 'en_GB', timeZone: 'America/New_York' },
    sheets: [
      {
        properties: {
          sheetId: 0,
          title,
          index: 0,
          sheetType: 'GRID',
          hidden: false,
          gridProperties: { rowCount, columnCount: 9, frozenRowCount: 0 },
        },
      },
    ],
  });
}

interface Scripted {
  readonly client: SheetsReadOnlyClient;
  readonly requests: string[];
}

/** A client whose every request is answered from the script, in order. */
function scripted(bodies: readonly string[]): Scripted {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const requests: string[] = [];
  let index = 0;
  const fetchImpl: Fetch = async (url, init) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    const body = bodies[Math.min(index, bodies.length - 1)] ?? '{}';
    index += 1;
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sleep = async (): Promise<void> => undefined;
  const tokens = new TokenSource({
    credential: {
      clientEmail: 'synthetic-intake@synthetic-project.iam.gserviceaccount.com',
      privateKey,
      tokenUri: 'https://oauth2.googleapis.com/token',
    },
    limits: DEFAULT_LIMITS,
    fetchImpl,
    sleep,
  });
  const client = new SheetsReadOnlyClient('SyntheticAuthorized_0000000000000000000001', {
    tokens,
    limits: DEFAULT_LIMITS,
    fetchImpl,
    sleep,
  });
  return { client, requests };
}

const TOKEN = json({ access_token: 'synthetic-access-token-value', expires_in: 3600 });
const OPTIONS = { limits: DEFAULT_LIMITS, workbookDigest: 'a'.repeat(12) };

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return isIngestionError(error) ? error.code : `not-an-ingestion-error`;
  }
}

describe('readFeedTab', () => {
  it('reads the structure, the header and every data row once, then prepares the batch', async () => {
    const { client, requests } = scripted([
      TOKEN,
      metadata('Synthetic feed', 5),
      json({ range: "'Synthetic feed'!A1:I1", values: [HEADERS] }),
      json({ range: "'Synthetic feed'!A2:I5", values: ROWS }),
    ]);
    const read = await readFeedTab(client, MAPPING, OPTIONS);
    expect(read.headerCells).toEqual(HEADERS);
    expect(read.rows).toHaveLength(3);
    expect(read.stats.rowsRead).toBe(3);
    expect(read.stats.pages).toBe(1);
    expect(read.timeZone).toBe('America/New_York');
    expect(read.tabTitle).toBe('Synthetic feed');
    expect(read.tabDigest).toMatch(/^[0-9a-f]{12,64}$/);
    expect(read.readCompletedAt >= read.readStartedAt).toBe(true);
    // One token exchange, one structure read, one header read, one page.
    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatch(/^POST https:\/\/oauth2\.googleapis\.com\/token$/);
    expect(
      requests.slice(1).every((entry) => entry.startsWith('GET https://sheets.googleapis.com/')),
    ).toBe(true);

    const prepared = prepareSheetsBatch({
      workbookDigest: read.workbookDigest,
      tabDigest: read.tabDigest,
      timeZone: read.timeZone,
      headerCells: read.headerCells,
      rows: read.rows,
      mapping: MAPPING,
    });
    expect(prepared.counts).toEqual({
      rows: 3,
      accepted: 1,
      quarantined: 2,
      serialsConverted: 5,
      serialsUnconvertible: 0,
    });
    expect(prepared.rows[0]?.evaluation.postedAt).toBe('2026-09-12T16:00:00.000Z');
  });

  it('refuses a tab the workbook does not hold', async () => {
    const { client } = scripted([TOKEN, metadata('Another tab', 5)]);
    expect(await codeOf(() => readFeedTab(client, MAPPING, OPTIONS))).toBe('tab_not_found');
  });

  it('refuses a tab with no data row rather than importing nothing', async () => {
    const { client } = scripted([
      TOKEN,
      metadata('Synthetic feed', 5),
      json({ range: "'Synthetic feed'!A1:I1", values: [HEADERS] }),
      json({ range: "'Synthetic feed'!A2:I5" }),
    ]);
    expect(await codeOf(() => readFeedTab(client, MAPPING, OPTIONS))).toBe('feed_empty');
  });

  it('lets a renamed required header reject the batch before any write', async () => {
    const renamed = HEADERS.map((header) => (header === 'Title' ? 'Headline' : header));
    const { client } = scripted([
      TOKEN,
      metadata('Synthetic feed', 5),
      json({ range: "'Synthetic feed'!A1:I1", values: [renamed] }),
      json({ range: "'Synthetic feed'!A2:I5", values: ROWS }),
    ]);
    const read = await readFeedTab(client, MAPPING, OPTIONS);
    expect(
      await codeOf(async () =>
        prepareSheetsBatch({
          workbookDigest: read.workbookDigest,
          tabDigest: read.tabDigest,
          timeZone: read.timeZone,
          headerCells: read.headerCells,
          rows: read.rows,
          mapping: MAPPING,
        }),
      ),
    ).toBe('header_required_missing');
  });
});
