import { describe, expect, it } from 'vitest';
import { equalPower, loopAction } from '../src/ui/music';

// The two pure halves of the loop. Everything else in music.ts is an
// AudioContext and a media pipeline, neither of which jsdom has — mocking one
// would only test the mock. These two are worth pinning because the real seam
// is 379 seconds into a session, so nothing else ever exercises them.

describe('equalPower', () => {
  it('runs the whole way, in the right direction', () => {
    const up = equalPower(true);
    const down = equalPower(false);
    expect(up[0]).toBeCloseTo(0, 6);
    expect(up[up.length - 1]).toBeCloseTo(1, 6);
    expect(down[0]).toBeCloseTo(1, 6);
    expect(down[down.length - 1]).toBeCloseTo(0, 6);
    for (let i = 1; i < up.length; i++) {
      expect(up[i]!).toBeGreaterThan(up[i - 1]!);
      expect(down[i]!).toBeLessThan(down[i - 1]!);
    }
  });

  it('holds the level flat across the seam', () => {
    // The whole point, and the reason this is not a linear pair. The tail and
    // the head are uncorrelated, so they sum in power: it is the *squares* that
    // have to add to one. A linear crossfade digs a 3 dB hole in every loop.
    const up = equalPower(true);
    const down = equalPower(false);
    for (let i = 0; i < up.length; i++) {
      expect(up[i]! ** 2 + down[i]! ** 2).toBeCloseTo(1, 6);
    }
  });

  it('is the same length in both directions, at any resolution', () => {
    expect(equalPower(true, 8)).toHaveLength(8);
    expect(equalPower(false, 8)).toHaveLength(8);
  });
});

describe('loopAction', () => {
  const D = 384;

  it('waits through the body of the track', () => {
    expect(loopAction(0, D)).toBe('wait');
    expect(loopAction(200, D)).toBe('wait');
  });

  it('warms the other deck well before it is needed', () => {
    // the window is FADE + GUARD + PRELOAD = 35.5 s, so 40 s out is still 'wait'
    expect(loopAction(D - 40, D)).toBe('wait');
    expect(loopAction(D - 30, D)).toBe('warm');
    expect(loopAction(D - 6, D)).toBe('warm');
  });

  it('swaps before the outgoing deck can run out', () => {
    expect(loopAction(D - 5.5, D)).toBe('swap');
    expect(loopAction(D - 0.1, D)).toBe('swap');
  });

  it('leaves room for a late timeupdate', () => {
    // `timeupdate` is only guaranteed every 250 ms. Find the earliest position
    // that still says 'wait': the tail it leaves must exceed the fade by more
    // than one of those intervals, or the fade ends on silence.
    let latestWait = 0;
    for (let at = 0; at < D; at += 0.01) {
      if (loopAction(at, D) !== 'swap') latestWait = at;
    }
    const firstSwap = latestWait + 0.01;
    const fade = D - firstSwap;
    expect(fade).toBeGreaterThan(5 + 0.25);
  });

  it('waits until the duration is known', () => {
    // NaN until metadata lands, and Infinity on a stream with no Xing header.
    expect(loopAction(0, Number.NaN)).toBe('wait');
    expect(loopAction(0, Number.POSITIVE_INFINITY)).toBe('wait');
    expect(loopAction(Number.NaN, D)).toBe('wait');
    // and a clip shorter than one crossfade has no seam to schedule
    expect(loopAction(1, 3)).toBe('wait');
  });
});
