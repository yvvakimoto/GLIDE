import { FINGER_RGB, type Finger } from '../core/keyboard-geometry';

export type RGB = [number, number, number];

export const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;

export const fingerRgba = (finger: Finger, a: number): string => rgba(FINGER_RGB[finger], a);

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Cool -> hot ramp for the summary heatmap. */
const HEAT_STOPS: RGB[] = [
  [40, 52, 74],
  [61, 214, 255],
  [182, 242, 74],
  [255, 138, 61],
  [255, 61, 110],
];

export function heatRgb(t: number): RGB {
  const k = Math.min(1, Math.max(0, t)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(k));
  return mixRgb(HEAT_STOPS[i]!, HEAT_STOPS[i + 1]!, k - i);
}

/** Speed -> colour, so the big WPM readout shifts hue as you get faster. */
export function speedRgb(wpm: number): RGB {
  const stops: Array<[number, RGB]> = [
    [0, [125, 135, 152]],
    [20, [61, 214, 255]],
    [45, [182, 242, 74]],
    [70, [247, 210, 74]],
    [100, [255, 138, 61]],
    [140, [255, 61, 110]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [lo, cLo] = stops[i]!;
    const [hi, cHi] = stops[i + 1]!;
    if (wpm <= hi) return mixRgb(cLo, cHi, (wpm - lo) / (hi - lo));
  }
  return stops[stops.length - 1]![1];
}
