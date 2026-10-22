import 'server-only';

import { randomBytes } from 'node:crypto';

import type { Reading } from '@cas/source-reader';

/**
 * The reading record (report, section 1.2, R17): what the reading stage left
 * of a selection's sources, held in this process's memory for ten minutes
 * under a random identifier, so the owner can see what was read and what was
 * not before the model is called, and confirm it by that identifier. It is
 * the only place fetched text exists (O-1); a restart or expiry means reading
 * again, never a stored page.
 */
export interface ReadingEntry {
  readonly id: string;
  readonly weekRunId: string;
  readonly category: string;
  readonly accountId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly reading: Reading;
}

export const READING_TTL_MS = 10 * 60 * 1000;

export class ReadingCache {
  private readonly entries = new Map<string, ReadingEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  put(entry: Omit<ReadingEntry, 'id' | 'createdAt' | 'expiresAt'>): ReadingEntry {
    this.sweep();
    const createdAt = this.now();
    const record: ReadingEntry = {
      ...entry,
      id: randomBytes(16).toString('hex'),
      createdAt,
      expiresAt: createdAt + READING_TTL_MS,
    };
    // One pending reading per week, category and account: a new reading
    // replaces the previous one.
    for (const [id, existing] of this.entries) {
      if (
        existing.weekRunId === entry.weekRunId &&
        existing.category === entry.category &&
        existing.accountId === entry.accountId
      ) {
        this.entries.delete(id);
      }
    }
    this.entries.set(record.id, record);
    return record;
  }

  get(id: string): ReadingEntry | null {
    this.sweep();
    return this.entries.get(id) ?? null;
  }

  find(weekRunId: string, category: string, accountId: string): ReadingEntry | null {
    this.sweep();
    for (const entry of this.entries.values()) {
      if (
        entry.weekRunId === weekRunId &&
        entry.category === category &&
        entry.accountId === accountId
      ) {
        return entry;
      }
    }
    return null;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
