import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixture } from '../test-support.js';
import { readCsv } from './csv-stream.js';
import { isIngestionError } from './errors.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function collect(filePath: string): Promise<{
  header: readonly string[] | null;
  records: (readonly string[])[];
  stats: Awaited<ReturnType<typeof readCsv>>;
}> {
  let header: readonly string[] | null = null;
  const records: (readonly string[])[] = [];
  const stats = await readCsv(filePath, {
    onHeader: (cells) => {
      header = cells;
    },
    onRecord: (_rowNumber, cells) => {
      records.push(cells);
    },
  });
  return { header, records, stats };
}

async function expectStructural(filePath: string): Promise<{ code: string; message: string }> {
  let caught: unknown;
  try {
    await collect(filePath);
  } catch (error) {
    caught = error;
  }
  if (!isIngestionError(caught)) throw new Error('expected an IngestionError');
  expect(caught.kind).toBe('structural');
  return { code: caught.code, message: caught.message };
}

describe('readCsv', () => {
  it('streams the master fixture: BOM consumed, quoting, escaped quotes, embedded newline, long field', async () => {
    const file = fixture('master-synthetic.csv');
    const { header, records, stats } = await collect(file);
    expect(header).toHaveLength(10);
    expect(header?.[0]).toBe('ch');
    expect(records).toHaveLength(12);
    expect(records[0]?.[3]).toBe('Synthetic story one, with a comma');
    expect(records[1]?.[3]).toBe('Title with "escaped" quotes');
    expect(records[1]?.[5]).toBe('Line one of description\nLine two of description');
    expect(records[4]?.[6]).toHaveLength(48_400);
    expect(stats.bom).toBe(true);
    const bytes = await readFile(file);
    expect(stats.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stats.byteLength).toBe((await stat(file)).size);
  });

  it('streams the weekly fixture with CRLF line endings and trailing blank cells', async () => {
    const { header, records, stats } = await collect(fixture('weekly-synthetic.csv'));
    expect(header).toEqual([
      'ch',
      'Date Posted',
      'Date Updated',
      'Title',
      'Summary',
      'URL',
      'Category',
      '',
      '',
    ]);
    expect(records).toHaveLength(8);
    expect(records[7]?.[3]).toBe('Weekly story eight, quoted');
    expect(records[7]?.slice(7)).toEqual(['', '']);
    expect(stats.bom).toBe(false);
  });

  it('rejects an unclosed quote as structural and never repeats the offending content', async () => {
    const failure = await expectStructural(fixture('structural-unclosed-quote.csv'));
    expect(failure.code).toMatch(/^csv_/);
    expect(failure.message).not.toContain('MARKER');
  });

  it('rejects inconsistent column counts as structural without echoing the row', async () => {
    const failure = await expectStructural(fixture('structural-inconsistent-columns.csv'));
    expect(failure.code).toBe('csv_inconsistent_columns');
    expect(failure.message).not.toContain('MARKER');
  });

  it('rejects an empty file for lacking a header', async () => {
    expect((await expectStructural(fixture('structural-empty.csv'))).code).toBe('header_missing');
  });

  it('rejects invalid UTF-8 and NUL characters generated in a temporary directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-csv-'));
    temps.push(dir);
    const bad = path.join(dir, 'invalid-utf8.csv');
    await writeFile(
      bad,
      Buffer.concat([Buffer.from('ch,Title\nTRUE,'), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]),
    );
    expect((await expectStructural(bad)).code).toBe('decode_invalid_utf8');
    const nul = path.join(dir, 'nul.csv');
    await writeFile(nul, Buffer.from(`ch,Title\nTRUE,a${String.fromCharCode(0)}b\n`));
    expect((await expectStructural(nul)).code).toBe('unsafe_null_character');
  });

  it('reports a missing file as a configuration error', async () => {
    let caught: unknown;
    try {
      await collect(path.join(os.tmpdir(), 'cas-does-not-exist-marker.csv'));
    } catch (error) {
      caught = error;
    }
    expect(
      isIngestionError(caught) &&
        caught.kind === 'configuration' &&
        caught.code === 'file_unreadable',
    ).toBe(true);
    expect((caught as Error).message).not.toContain('marker');
  });

  it('propagates a handler error unchanged and stops reading', async () => {
    const own = new Error('handler stopped the read');
    let seen = 0;
    await expect(
      readCsv(fixture('master-synthetic.csv'), {
        onHeader: () => undefined,
        onRecord: () => {
          seen += 1;
          if (seen === 2) throw own;
        },
      }),
    ).rejects.toBe(own);
    expect(seen).toBe(2);
  });

  it('stops at an aborted signal with an aborted error', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCsv(
        fixture('master-synthetic.csv'),
        { onHeader: () => undefined, onRecord: () => undefined },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });
});
