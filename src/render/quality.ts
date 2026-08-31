/**
 * How much resolution the canvases ask for.
 *
 * Every canvas in the app used to cap the device pixel ratio at 2.5, which on a
 * 4K panel at 200% is a 6.25x fill rate for a difference no one can see. Two is
 * the point past which a keycap edge stops getting any crisper; `lite` goes
 * below one device pixel per CSS pixel on purpose, because a machine that picked
 * `lite` is one whose GPU is the bottleneck.
 */
export function renderScale(lite: boolean): number {
  return Math.min(lite ? 1.25 : 2, window.devicePixelRatio || 1);
}
