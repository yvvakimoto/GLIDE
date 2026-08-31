/**
 * Everything derived from the keystroke log: the live speed series with its
 * moving average, plus the aggregates the summary screen shows.
 *
 * Two different things are counted here, and keeping them apart is the whole
 * point of this module: **speed counts the characters of text produced, while
 * accuracy counts presses.** A press carries its own character worth (see
 * `Keystroke.chars`), so a romaji kana and a thumb-shift kana are the same
 * amount of speed for a different number of keystrokes, and the two Japanese
 * methods can be compared at all. Latin is the degenerate case where one press
 * is one character, so nothing about latin numbers changes.
 */

import type { Finger } from './keyboard-geometry';

export type Keystroke = {
  /** ms since the run started */
  t: number;
  expected: string;
  typed: string;
  correct: boolean;
  code: string;
  finger: Finger;
  shift: boolean;
  /**
   * What this press is worth in characters of text — the numerator of every
   * speed figure.
   *
   * On a correct press it is the characters the press *finished*: a unit's whole
   * span on its last press, and 0 half-way through one, so romaji credits きゃ
   * once, on the a, rather than three times. On a wrong press it is the share of
   * the unit the miss wasted, so mashing costs raw speed in proportion to the
   * keystrokes the unit actually needs. Latin is always 1.
   */
  chars: number;
};

export type SamplePoint = {
  /** seconds since start */
  t: number;
  /** instantaneous net WPM */
  wpm: number;
  /** instantaneous raw WPM, errors included */
  raw: number;
  /** moving average of wpm */
  ma: number;
  /** errors that landed inside this sample window */
  errors: number;
};

export type KeyStat = { code: string; label: string; count: number; errors: number; meanMs: number };
export type FingerStat = { finger: Finger; count: number; errors: number; meanMs: number };
export type GramStat = { gram: string; meanMs: number; count: number };

export type Summary = {
  wpm: number;
  rawWpm: number;
  accuracy: number;
  consistency: number;
  durationMs: number;
  /** characters of text produced: kana for Japanese, characters for English */
  producedChars: number;
  correctKeys: number;
  errorKeys: number;
  keystrokes: number;
  corrections: number;
  bestStreak: number;
  series: SamplePoint[];
  perKey: KeyStat[];
  perFinger: FingerStat[];
  slowGrams: GramStat[];
};

const SAMPLE_MS = 250;
/** sliding window behind each instantaneous reading */
const INSTANT_WINDOW_MS = 1500;
const MIN_WINDOW_MS = 400;
/** gaps longer than this are pauses, not typing, so latency stats skip them */
const PAUSE_MS = 1000;

/** Five characters is one word, for kana as much as for letters. */
export const wpmOf = (chars: number, ms: number): number => (ms <= 0 ? 0 : chars / 5 / (ms / 60_000));

export class Stats {
  readonly series: SamplePoint[] = [];
  private strokes: Keystroke[] = [];
  private nextSampleAt = SAMPLE_MS;
  private correct = 0;
  private errors = 0;
  private produced = 0;
  private rawChars = 0;
  private corrections = 0;
  private streak = 0;
  private best = 0;
  private maWindowSec: number;

  constructor(maWindowSec: number) {
    this.maWindowSec = maWindowSec;
  }

  push(stroke: Keystroke): void {
    this.strokes.push(stroke);
    this.rawChars += stroke.chars;
    if (stroke.correct) {
      this.correct++;
      this.produced += stroke.chars;
      this.streak++;
      if (this.streak > this.best) this.best = this.streak;
    } else {
      this.errors++;
      this.streak = 0;
    }
  }

  /** Bookkeeping for a backspace. The keystroke log itself is append-only. */
  correction(): void {
    this.corrections++;
    this.streak = 0;
  }

  /** Characters of text produced — kana for Japanese, characters for English. */
  get producedChars(): number {
    return this.produced;
  }

  get correctKeys(): number {
    return this.correct;
  }

  get errorKeys(): number {
    return this.errors;
  }

  get currentStreak(): number {
    return this.streak;
  }

  get bestStreak(): number {
    return this.best;
  }

  accuracy(): number {
    const total = this.correct + this.errors;
    return total ? (this.correct / total) * 100 : 100;
  }

  netWpm(elapsedMs: number): number {
    return wpmOf(this.produced, elapsedMs);
  }

  rawWpm(elapsedMs: number): number {
    return wpmOf(this.rawChars, elapsedMs);
  }

  setMaWindow(seconds: number): void {
    this.maWindowSec = seconds;
  }

  /** Appends series points up to elapsedMs. Call once per frame. */
  sample(elapsedMs: number): void {
    while (this.nextSampleAt <= elapsedMs) {
      const at = this.nextSampleAt;
      const window = Math.max(MIN_WINDOW_MS, Math.min(INSTANT_WINDOW_MS, at));
      const from = at - window;
      const since = this.series.length ? this.series[this.series.length - 1]!.t * 1000 : 0;

      let correct = 0;
      let total = 0;
      let errorsHere = 0;
      for (let i = this.strokes.length - 1; i >= 0; i--) {
        const s = this.strokes[i]!;
        if (s.t <= from && s.t <= since) break;
        if (s.t > at) continue;
        if (s.t > from) {
          total += s.chars;
          if (s.correct) correct += s.chars;
        }
        if (s.t > since && !s.correct) errorsHere++;
      }

      const wpm = wpmOf(correct, window);
      const maCount = Math.max(1, Math.round((this.maWindowSec * 1000) / SAMPLE_MS));
      let sum = wpm;
      let n = 1;
      for (let i = this.series.length - 1; i >= 0 && n < maCount; i--, n++) sum += this.series[i]!.wpm;

      this.series.push({
        t: at / 1000,
        wpm,
        raw: wpmOf(total, window),
        ma: sum / n,
        errors: errorsHere,
      });
      this.nextSampleAt += SAMPLE_MS;
    }
  }

  summary(elapsedMs: number, labelOf: (code: string) => string): Summary {
    type Bucket = { count: number; errors: number; total: number; samples: number };
    const perKey = new Map<string, Bucket>();
    const perFinger = new Map<Finger, Bucket>();
    const grams = new Map<string, { total: number; count: number }>();
    const bucket = (): Bucket => ({ count: 0, errors: 0, total: 0, samples: 0 });

    for (let i = 0; i < this.strokes.length; i++) {
      const s = this.strokes[i]!;
      const prev = i > 0 ? this.strokes[i - 1] : undefined;
      const gap = prev ? s.t - prev.t : Number.POSITIVE_INFINITY;
      const timed = gap <= PAUSE_MS && s.correct;

      for (const [map, key] of [
        [perKey, s.code],
        [perFinger, s.finger],
      ] as Array<[Map<string, Bucket>, string]>) {
        const b = map.get(key) ?? bucket();
        b.count++;
        if (!s.correct) b.errors++;
        if (timed) {
          b.total += gap;
          b.samples++;
        }
        map.set(key, b);
      }

      if (prev && timed && prev.correct) {
        const gram = prev.expected + s.expected;
        if (!gram.includes(' ')) {
          const g = grams.get(gram) ?? { total: 0, count: 0 };
          g.total += gap;
          g.count++;
          grams.set(gram, g);
        }
      }
    }

    // Consistency, as the coefficient of variation of the per-second speed.
    const perSecond = new Map<number, number>();
    for (const s of this.strokes) {
      const sec = Math.floor(s.t / 1000);
      perSecond.set(sec, (perSecond.get(sec) ?? 0) + s.chars);
    }
    const speeds = [...perSecond.values()].map((n) => wpmOf(n, 1000));
    const mean = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
    const variance = speeds.length
      ? speeds.reduce((acc, v) => acc + (v - mean) ** 2, 0) / speeds.length
      : 0;
    const consistency = mean > 0 ? Math.max(0, Math.min(100, 100 * (1 - Math.sqrt(variance) / mean))) : 0;

    const meanOf = (b: Bucket) => (b.samples ? b.total / b.samples : 0);

    return {
      wpm: this.netWpm(elapsedMs),
      rawWpm: this.rawWpm(elapsedMs),
      accuracy: this.accuracy(),
      consistency,
      durationMs: elapsedMs,
      producedChars: this.produced,
      correctKeys: this.correct,
      errorKeys: this.errors,
      keystrokes: this.correct + this.errors,
      corrections: this.corrections,
      bestStreak: this.best,
      series: this.series,
      perKey: [...perKey.entries()]
        .map(([code, b]): KeyStat => ({
          code,
          label: labelOf(code),
          count: b.count,
          errors: b.errors,
          meanMs: meanOf(b),
        }))
        .sort((a, b) => b.count - a.count),
      perFinger: [...perFinger.entries()].map(([finger, b]): FingerStat => ({
        finger: finger as Finger,
        count: b.count,
        errors: b.errors,
        meanMs: meanOf(b),
      })),
      slowGrams: [...grams.entries()]
        .filter(([, v]) => v.count >= 3)
        .map(([gram, v]): GramStat => ({ gram, meanMs: v.total / v.count, count: v.count }))
        .sort((a, b) => b.meanMs - a.meanMs)
        .slice(0, 10),
    };
  }
}
