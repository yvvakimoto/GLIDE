import { beforeEach, describe, expect, it } from 'vitest';

import {
  CAP,
  loadHistory,
  recordRun,
  rowOf,
  sameSetup,
  worthKeeping,
  type HistoryRow,
} from '../src/core/history';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import type { Summary } from '../src/core/stats';

/** The key history.ts writes. Spelled out here so a rename has to be deliberate. */
const KEY = 'dvorak-trainer/history/v1';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
});

const summaryOf = (over: Partial<Summary> = {}): Summary => ({
  wpm: 62.349,
  rawWpm: 65.11,
  accuracy: 96.55,
  consistency: 88.2,
  durationMs: 60_000,
  producedChars: 312,
  correctKeys: 312,
  errorKeys: 11,
  keystrokes: 323,
  corrections: 2,
  bestStreak: 90,
  series: [],
  perKey: [],
  perFinger: [],
  slowGrams: [],
  ...over,
});

const settings: Settings = { ...DEFAULT_SETTINGS };

/** Rows are stamped with a real clock time; anything pre-2020 is treated as junk. */
const BASE = Date.UTC(2024, 0, 1);

const rowAt = (offset: number, over: Partial<Summary> = {}): HistoryRow =>
  rowOf(summaryOf(over), settings, 'latin', 'time', BASE + offset);

describe('rowOf', () => {
  it('copies the run and rounds the rates to one decimal', () => {
    const row = rowAt(0);
    expect(row.wpm).toBe(62.3);
    expect(row.raw).toBe(65.1);
    expect(row.acc).toBe(96.6);
    expect(row.chars).toBe(312);
    expect(row.keys).toBe(323);
    expect(row.errs).toBe(11);
    expect(row.layout).toBe(settings.layout);
    expect(row.limit).toBe(settings.duration);
    expect(row.end).toBe('time');
  });
});

describe('worthKeeping', () => {
  it('rejects runs too short to mean anything', () => {
    // a two-second blur-abort can score hundreds of wpm and would own the
    // personal best for ever
    expect(worthKeeping(rowAt(1, { durationMs: 2000, producedChars: 40 }))).toBe(false);
    expect(worthKeeping(rowAt(1, { durationMs: 30_000, producedChars: 8 }))).toBe(false);
  });

  it('accepts the shortest offered duration', () => {
    expect(worthKeeping(rowAt(1, { durationMs: 15_000, producedChars: 60 }))).toBe(true);
  });
});

describe('recordRun', () => {
  it('appends and returns the new log without a second read', () => {
    const first = recordRun(rowAt(1_000));
    expect(first).toHaveLength(1);
    const second = recordRun(rowAt(2_000));
    expect(second).toHaveLength(2);
    expect(loadHistory()).toHaveLength(2);
  });

  it('does not record a run too short to keep, but still returns the log', () => {
    recordRun(rowAt(1_000));
    const rows = recordRun(rowAt(2_000, { durationMs: 1_500, producedChars: 5 }));
    expect(rows).toHaveLength(1);
    expect(loadHistory()).toHaveLength(1);
  });

  it('caps the log and drops the oldest', () => {
    for (let i = 0; i < CAP + 20; i++) recordRun(rowAt(1_000 + i));
    const rows = loadHistory();
    expect(rows).toHaveLength(CAP);
    expect(rows[0]!.at).toBe(BASE + 1_020);
    expect(rows[rows.length - 1]!.at).toBe(BASE + 1_000 + CAP + 19);
  });
});

describe('loadHistory', () => {
  it('survives anything else on the origin writing to the key', () => {
    for (const junk of ['{', 'null', '[]', '{"rows":5}', '{"rows":[null,3,"x",[]]}', '']) {
      store.setItem(KEY, junk);
      expect(loadHistory()).toEqual([]);
    }
  });

  it('drops a malformed row rather than repairing it', () => {
    const good = rowAt(1_000);
    const rows: unknown[] = [
      good,
      { ...good, at: BASE + 2_000, wpm: -3 },
      { ...good, at: BASE + 3_000, wpm: 'seven' },
      { ...good, at: BASE + 4_000, acc: 140 },
      { ...good, at: BASE + 5_000, layout: 'not-a-layout' },
      { ...good, at: BASE + 6_000, script: 'klingon' },
      { ...good, at: BASE + 7_000, end: 'exploded' },
      { ...good, at: BASE + 8_000, method: 'shorthand' },
      // a row claiming to predate the app is junk from whatever shares the origin
      { ...good, at: 1_000_000 },
      { ...good, at: Date.now() + 30 * 86_400_000 },
    ];
    store.setItem(KEY, JSON.stringify({ rows }));
    const kept = loadHistory();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.at).toBe(BASE + 1_000);
  });

  it('keeps a run whose source this build no longer ships', () => {
    const row = { ...rowAt(1_000), source: 'pg-something-retired' };
    store.setItem(KEY, JSON.stringify({ rows: [row] }));
    expect(loadHistory()).toHaveLength(1);
  });

  it('returns rows oldest first even if they were stored out of order', () => {
    store.setItem(KEY, JSON.stringify({ rows: [rowAt(3_000), rowAt(1_000), rowAt(2_000)] }));
    expect(loadHistory().map((r) => r.at)).toEqual([BASE + 1_000, BASE + 2_000, BASE + 3_000]);
  });

  it('is empty when storage throws outright', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem() {
          throw new Error('denied');
        },
      },
      configurable: true,
      writable: true,
    });
    expect(loadHistory()).toEqual([]);
  });
});

describe('sameSetup', () => {
  const of = (over: Partial<HistoryRow>): HistoryRow => ({ ...rowAt(0), ...over });

  it('separates latin layouts', () => {
    expect(sameSetup(of({ layout: 'dvorak' }), of({ layout: 'dvorak' }))).toBe(true);
    expect(sameSetup(of({ layout: 'dvorak' }), of({ layout: 'qwerty' }))).toBe(false);
  });

  it('separates the scripts', () => {
    expect(sameSetup(of({ script: 'latin' }), of({ script: 'ja' }))).toBe(false);
  });

  it('separates the Japanese methods', () => {
    const nicola = of({ script: 'ja', method: 'nicola' });
    expect(sameSetup(nicola, of({ script: 'ja', method: 'asuka' }))).toBe(false);
    expect(sameSetup(nicola, of({ script: 'ja', method: 'nicola' }))).toBe(true);
  });

  it('ignores the latin layout for a thumb-shift layout, but not for romaji', () => {
    // NICOLA does not touch the latin layout, so a Dvorak user and a QWERTY user
    // typing NICOLA are doing the same thing
    const nicola = (layout: HistoryRow['layout']) => of({ script: 'ja', method: 'nicola', layout });
    expect(sameSetup(nicola('dvorak'), nicola('qwerty'))).toBe(true);

    // romaji is typed on the latin layout, so the layout is part of the motion
    const romaji = (layout: HistoryRow['layout']) => of({ script: 'ja', method: 'romaji', layout });
    expect(sameSetup(romaji('dvorak'), romaji('qwerty'))).toBe(false);
    expect(sameSetup(romaji('dvorak'), romaji('dvorak'))).toBe(true);
  });
});
