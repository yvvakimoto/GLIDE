import { describe, expect, it } from 'vitest';

import { Stats, wpmOf, type Keystroke } from '../src/core/stats';

const stroke = (t: number, expected: string, typed = expected, code = 'KeyA'): Keystroke => ({
  t,
  expected,
  typed,
  correct: expected === typed,
  code,
  finger: 'l5',
  shift: false,
});

describe('wpm', () => {
  it('counts five characters as one word', () => {
    expect(wpmOf(0, 60_000)).toBe(0);
    expect(wpmOf(5, 60_000)).toBe(1);
    expect(wpmOf(300, 60_000)).toBe(60);
    expect(wpmOf(150, 30_000)).toBe(60);
    expect(wpmOf(10, 0)).toBe(0);
  });
});

describe('Stats', () => {
  it('tracks accuracy, streaks and corrections', () => {
    const stats = new Stats(5);
    stats.push(stroke(100, 'a'));
    stats.push(stroke(200, 'b'));
    stats.push(stroke(300, 'c', 'x'));
    stats.push(stroke(400, 'd'));

    expect(stats.correctChars).toBe(3);
    expect(stats.errorChars).toBe(1);
    expect(stats.accuracy()).toBeCloseTo(75, 6);
    expect(stats.bestStreak).toBe(2);
    expect(stats.currentStreak).toBe(1);

    stats.correction();
    expect(stats.currentStreak).toBe(0);
  });

  it('samples the series every 250ms and averages over the configured window', () => {
    const stats = new Stats(1); // 1s window = 4 samples
    for (let i = 1; i <= 40; i++) stats.push(stroke(i * 100, 'a'));
    stats.sample(4000);

    expect(stats.series.length).toBe(16);
    const points = stats.series.map((p) => p.t);
    expect(points[0]).toBeCloseTo(0.25, 6);
    expect(points[points.length - 1]).toBeCloseTo(4, 6);

    // 10 chars/s sustained = 120 wpm
    const last = stats.series[stats.series.length - 1]!;
    expect(last.wpm).toBeCloseTo(120, 0);
    expect(last.ma).toBeCloseTo(120, 0);
    expect(last.raw).toBeCloseTo(120, 0);
  });

  it('attributes each error to exactly one sample window', () => {
    const stats = new Stats(5);
    stats.push(stroke(300, 'a', 'z'));
    stats.push(stroke(1200, 'b', 'z'));
    stats.sample(2000);
    expect(stats.series.reduce((n, p) => n + p.errors, 0)).toBe(2);
  });

  it('summarises per key, per finger and the slowest pairs', () => {
    const stats = new Stats(5);
    // "th" typed quickly three times, "qu" slowly three times
    let t = 0;
    for (let i = 0; i < 3; i++) {
      stats.push(stroke((t += 100), 't', 't', 'KeyK'));
      stats.push(stroke((t += 80), 'h', 'h', 'KeyJ'));
      stats.push(stroke((t += 100), 'q', 'q', 'KeyX'));
      stats.push(stroke((t += 400), 'u', 'u', 'KeyF'));
    }
    stats.push(stroke((t += 120), 'x', 'y', 'KeyB'));

    const summary = stats.summary(t, (code) => code);
    expect(summary.keystrokes).toBe(13);
    expect(summary.errorChars).toBe(1);

    const slowest = summary.slowGrams[0]!;
    expect(slowest.gram).toBe('qu');
    expect(slowest.meanMs).toBeCloseTo(400, 0);
    expect(summary.slowGrams.some((g) => g.gram === 'th')).toBe(true);

    const keyK = summary.perKey.find((k) => k.code === 'KeyK')!;
    expect(keyK.count).toBe(3);
    expect(keyK.errors).toBe(0);

    expect(summary.perFinger.reduce((n, f) => n + f.count, 0)).toBe(13);
    expect(summary.consistency).toBeGreaterThan(0);
    expect(summary.consistency).toBeLessThanOrEqual(100);
  });
});
