/**
 * The run log: one row per completed run, so the summary can show where today
 * sits against every run before it.
 *
 * This is the app's second localStorage key, and the warning in settings.ts
 * applies to it word for word: localStorage is keyed by *origin*, not by path,
 * so once the app is served from a user's github.io every other page that user
 * hosts there shares this namespace, as does an older build of GLIDE.
 *
 * One deliberate difference from loadSettings, though. Settings *repair* a bad
 * value to its default; history *drops* the row. There is no correct fallback
 * for a wrong number — a repaired 0 wpm is as much a lie as the garbage it
 * replaced, and unlike a setting, which the next write overwrites, a bad row
 * stays in the log poisoning the mean and the personal best for ever.
 */

import type { LayoutId } from './layouts';
import type { JaMethod, Script } from './method';
import { JA_METHODS, LAYOUT_IDS, type Settings } from './settings';
import type { Summary } from './stats';

/** Why the run ended. 'end' is an ordered work running out; see engine.ts. */
export type RunEnd = 'time' | 'quit' | 'end';

export type HistoryRow = {
  /** Date.now() when the run finished */
  at: number;
  /** summary.durationMs */
  ms: number;
  wpm: number;
  raw: number;
  /** accuracy, 0..100 */
  acc: number;
  /** consistency, 0..100 */
  con: number;
  /** characters of text produced: kana for Japanese, characters for English */
  chars: number;
  keys: number;
  errs: number;
  script: Script;
  layout: LayoutId;
  /** meaningful only when script === 'ja' */
  method: JaMethod;
  source: string;
  /** settings.duration at the time; 0 = untimed */
  limit: number;
  end: RunEnd;
};

const STORAGE_KEY = 'dvorak-trainer/history/v1';

/** Rows kept. One row is ~190 bytes, so the cap is ~95 KB — hours of typing. */
export const CAP = 500;

/**
 * A run has to be substantial to be worth a point on the chart, and the floor is
 * about substance rather than about how the run ended.
 *
 * INSTANT_WINDOW_MS is 1500 and wpmOf divides by elapsed, so a two-second
 * blur-abort can score 300 wpm — which would wreck the y scale and take the
 * personal best with it, permanently. Ten seconds is below the shortest offered
 * duration, so this never rejects a run that was actually completed.
 *
 * This is the *only* floor. A second, higher bar for the personal best was tried
 * and removed: a 15 s run whose clock stops at 14.98 s would then be recorded,
 * charted, and counted in the mean while silently not counting as a best, which
 * reads on screen as the best being broken. Ten seconds is already long enough
 * for a speed to mean something.
 */
export const MIN_RUN_MS = 10_000;
export const MIN_RUN_CHARS = 25;

/** Rows claiming to predate the app are junk from whatever else shares the origin. */
const EPOCH_FLOOR = Date.UTC(2020, 0, 1);

const SCRIPTS: ReadonlySet<string> = new Set<Script>(['latin', 'ja']);
const ENDS: ReadonlySet<string> = new Set<RunEnd>(['time', 'quit', 'end']);

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function rowOf(
  summary: Summary,
  settings: Settings,
  script: Script,
  end: RunEnd,
  at: number = Date.now(),
): HistoryRow {
  return {
    at,
    ms: Math.round(summary.durationMs),
    wpm: round1(summary.wpm),
    raw: round1(summary.rawWpm),
    acc: round1(summary.accuracy),
    con: round1(summary.consistency),
    chars: summary.producedChars,
    keys: summary.keystrokes,
    errs: summary.errorKeys,
    script,
    layout: settings.layout,
    method: settings.jaMethod,
    source: settings.source,
    limit: settings.duration,
    end,
  };
}

/**
 * Whether two runs asked the same thing of the fingers.
 *
 * Speed counts characters produced so the three Japanese methods are comparable
 * *as methods*, but a Dvorak drill and a NICOLA passage are still different
 * tasks and averaging them says nothing.
 *
 * Romaji is the case worth spelling out: it is typed on the latin layout, so the
 * layout is part of the motion and belongs in the key. The thumb-shift layouts
 * do not touch it, so for those the latin layout is irrelevant.
 */
export function sameSetup(a: HistoryRow, b: HistoryRow): boolean {
  if (a.script !== b.script) return false;
  if (a.script === 'latin') return a.layout === b.layout;
  if (a.method !== b.method) return false;
  return a.method !== 'romaji' || a.layout === b.layout;
}

/** Long enough, and with enough typing in it, to mean something. */
export const worthKeeping = (row: HistoryRow): boolean =>
  row.ms >= MIN_RUN_MS && row.chars >= MIN_RUN_CHARS;

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/** Returns undefined for anything that is not a row this build wrote. */
function validRow(raw: unknown): HistoryRow | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;

  const at = num(r.at, EPOCH_FLOOR, Date.now() + 86_400_000);
  const ms = num(r.ms, 0, 86_400_000);
  const wpm = num(r.wpm, 0, 1000);
  const rawWpm = num(r.raw, 0, 1000);
  const acc = num(r.acc, 0, 100);
  const con = num(r.con, 0, 100);
  const chars = num(r.chars, 0, 1e7);
  const keys = num(r.keys, 0, 1e7);
  const errs = num(r.errs, 0, 1e7);
  const limit = num(r.limit, 0, 86_400);
  if (
    at === undefined || ms === undefined || wpm === undefined || rawWpm === undefined ||
    acc === undefined || con === undefined || chars === undefined || keys === undefined ||
    errs === undefined || limit === undefined
  ) {
    return undefined;
  }

  const { script, layout, method, source, end } = r;
  if (typeof script !== 'string' || !SCRIPTS.has(script)) return undefined;
  if (typeof layout !== 'string' || !LAYOUT_IDS.has(layout)) return undefined;
  if (typeof method !== 'string' || !JA_METHODS.includes(method as JaMethod)) return undefined;
  // A source this build no longer ships is still a real run that really happened,
  // so keep the row; only reject a value that could not have been a source id.
  if (typeof source !== 'string' || source.length === 0 || source.length > 128) return undefined;
  if (typeof end !== 'string' || !ENDS.has(end)) return undefined;

  return {
    at, ms, wpm, raw: rawWpm, acc, con, chars, keys, errs, limit,
    script: script as Script,
    layout: layout as LayoutId,
    method: method as JaMethod,
    source,
    end: end as RunEnd,
  };
}

/** Oldest first. Malformed rows are dropped, not repaired. */
export function loadHistory(): HistoryRow[] {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : undefined;
  } catch {
    stored = undefined;
  }
  const rows = (stored as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) return [];
  const kept: HistoryRow[] = [];
  for (const entry of rows) {
    const row = validRow(entry);
    if (row) kept.push(row);
  }
  kept.sort((a, b) => a.at - b.at);
  return kept.slice(-CAP);
}

function save(rows: readonly HistoryRow[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows }));
  } catch {
    // Out of quota, most likely because something else on this origin filled it.
    // Halve the log and try once more rather than failing silently for ever.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows: rows.slice(-Math.floor(CAP / 2)) }));
    } catch {
      /* private mode / storage disabled — history just won't persist */
    }
  }
}

/**
 * Appends a run and returns the new log, so the caller does not read back what
 * it just wrote. A run too short to mean anything is not recorded, but the log
 * is still returned so the summary can draw.
 */
export function recordRun(row: HistoryRow): HistoryRow[] {
  const rows = loadHistory();
  if (!worthKeeping(row)) return rows;
  rows.push(row);
  const capped = rows.slice(-CAP);
  save(capped);
  return capped;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
