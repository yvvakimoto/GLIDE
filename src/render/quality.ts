/**
 * How much resolution the canvases ask for.
 *
 * Every canvas in the app used to cap the device pixel ratio at 2.5, which on a
 * 4K panel at 200% is a 6.25x fill rate for a difference no one can see. Two is
 * the point past which a keycap edge stops getting any crisper.
 *
 * This does not vary with the `graphics` setting, and that was measured rather
 * than assumed: `lite` at 2x holds sixty frames a second through a whole session
 * at 2560x1440 on a doubled backing store, in a headless shell rasterising on
 * the CPU with no GPU at all. The cost was never the resolution, it was the
 * blurs — so charging `lite` a soft keycap legend for nothing was the wrong
 * trade once it became the default. See scripts/perf.mjs.
 */
export function renderScale(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}
