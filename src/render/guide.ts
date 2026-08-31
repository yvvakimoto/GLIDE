/**
 * The look-ahead ribbon: a smooth curve through the next N presses whose alpha
 * and width fade toward the far end, coloured by the finger that owns each key.
 *
 * The curve always runs [where the finger came from] -> [key to press now] ->
 * [future keys], and the visible part is clipped at `startU` (the animation
 * phase). That way a keystroke only slides the clip forward by one control
 * point — the geometry itself never jumps.
 */

import { FINGER_RGB, physKey, type Finger, type PhysKey } from '../core/keyboard-geometry';
import { thumbKeyOf, type Chord, type MethodSpec } from '../core/method';
import { resampleUniform, sampleCatmullRom, type Pt, type Sample } from '../core/spline';
import { keyCenterPx, spaceTargetX, type BoardMetrics } from './keyboard';
import { mixRgb, rgba, type RGB } from './color';

export type GuideTarget = {
  chord: Chord;
  key: PhysKey;
  point: Pt;
  finger: Finger;
  /** keys that must be held for this press: a shift, or a thumb-shift */
  holds: string[];
};

export type Guide = {
  /** control points: index 0 is the previous key when `hasTail` is true */
  points: Pt[];
  fingers: Finger[];
  targets: GuideTarget[];
  hasTail: boolean;
};

/** How far a repeated key is nudged off centre so a double tap stays visible. */
const REPEAT_OFFSET = 0.3;

/** Resolves the upcoming presses to points on the board. */
export function computeGuide(
  m: BoardMetrics,
  chords: readonly Chord[],
  prevCode: string | undefined,
  spec: MethodSpec,
): Guide {
  const targets: GuideTarget[] = [];

  let cursor: Pt | undefined;
  const prevKey = prevCode ? physKey(prevCode) : undefined;
  if (prevKey) cursor = keyCenterPx(m, prevKey);

  let runCode: string | undefined;
  let runIndex = 0;

  for (const chord of chords) {
    const key = physKey(chord.code);
    if (!key) continue;
    let point = keyCenterPx(m, key);

    if (key.code === 'Space') {
      point = { x: spaceTargetX(m, key, cursor?.x ?? point.x), y: point.y };
    }

    if (key.code === runCode) {
      runIndex++;
      const dir = cursor ? { x: point.x - cursor.x, y: point.y - cursor.y } : { x: 1, y: 0 };
      const len = Math.hypot(dir.x, dir.y) || 1;
      const perp = { x: -dir.y / len, y: dir.x / len };
      const sign = runIndex % 2 === 1 ? 1 : -1;
      const decay = 1 - Math.min(0.5, 0.18 * Math.floor((runIndex - 1) / 2));
      const r = m.unit * REPEAT_OFFSET * decay * sign;
      point = { x: point.x + perp.x * r, y: point.y + perp.y * r };
    } else {
      runCode = key.code;
      runIndex = 0;
    }

    const holds: string[] = [];
    if (chord.thumb !== 'none') holds.push(thumbKeyOf(spec, chord.thumb));
    if (chord.shift) holds.push(key.finger.startsWith('l') ? 'ShiftRight' : 'ShiftLeft');

    targets.push({ chord, key, point, finger: key.finger, holds });
    cursor = point;
  }

  const hasTail = Boolean(prevKey) && targets.length > 0;
  const points: Pt[] = targets.map((t) => t.point);
  const fingers: Finger[] = targets.map((t) => t.finger);
  if (hasTail && prevKey) {
    points.unshift(keyCenterPx(m, prevKey));
    fingers.unshift(prevKey.finger);
  }

  return { points, fingers, targets, hasTail };
}

/** code -> emphasis weight, for the keycap highlight under the ribbon. */
export function upcomingWeights(guide: Guide): { keys: Map<string, number>; holds: Map<string, number> } {
  const keys = new Map<string, number>();
  const holds = new Map<string, number>();
  const n = Math.max(1, guide.targets.length);
  guide.targets.forEach((t, i) => {
    const w = (1 - i / n) ** 1.5;
    keys.set(t.key.code, Math.max(keys.get(t.key.code) ?? 0, w));
    for (const code of t.holds) holds.set(code, Math.max(holds.get(code) ?? 0, w));
  });
  return { keys, holds };
}

export type GuideDrawOptions = {
  guide: Guide;
  /** 0..1 slide progress away from the tail point */
  phase: number;
  now: number;
  fingerColors: boolean;
  /** global multiplier, used to fade the ribbon in and out */
  opacity: number;
  /** low-cost mode: fewer bands along the ribbon */
  lite?: boolean;
};

/** Curve samples per control point, and the ceiling a long ribbon stops at. */
const SAMPLES_PER_SPAN = 24;
const SAMPLES_MAX = 168;
const HEAD_ALPHA = 0.98;
const FALLOFF = 1.35;

/**
 * How many constant-colour bands the ribbon is stroked in.
 *
 * The alpha, the width and the finger colour all vary continuously along the
 * curve, and the honest way to draw that is one `stroke()` per sample segment —
 * which came to about three hundred and forty draw calls a frame, each with its
 * own freshly built `rgba()` string. Quantising into bands and stroking each
 * band as a single path costs an order of magnitude less and is invisible,
 * because round caps make the seam between two bands a continuous edge.
 */
const BANDS = 14;
const BANDS_LITE = 6;
/** the wide translucent underpass, then the bright core */
const PASSES = [1, 0] as const;

/**
 * The alpha one continuous stroke needs to match a chain of overlapping ones.
 *
 * Stroking segment by segment with a round cap does not lay the colour down
 * once: a cap of width `w` on a segment of length `l` is painted over by its
 * neighbours about `w / l` times, and the ribbon's look came from that build-up
 * as much as from the alpha ramp — the tail was roughly twice as solid as its
 * nominal alpha. Drawing a band as a single path lays it down exactly once, so
 * the alpha has to be pre-composited to land in the same place: n coats of `a`
 * come to `1 - (1 - a)^n`. Capped, because the glow underpass is wide enough
 * that its `w / l` runs away.
 */
const MAX_COATS = 6;
function overlaid(alpha: number, width: number, segment: number): number {
  const coats = Math.min(MAX_COATS, Math.max(1, width / Math.max(0.01, segment)));
  return 1 - (1 - Math.min(1, alpha)) ** coats;
}

function clipSamples(samples: Sample[], startU: number): Sample[] {
  if (startU <= 0) return samples;
  const out: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.u < startU) continue;
    if (out.length === 0 && i > 0) {
      const prev = samples[i - 1]!;
      const span = s.u - prev.u;
      const t = span > 1e-6 ? (startU - prev.u) / span : 0;
      out.push({
        x: prev.x + (s.x - prev.x) * t,
        y: prev.y + (s.y - prev.y) * t,
        u: startU,
      });
    }
    out.push(s);
  }
  return out;
}

export function drawGuide(ctx: CanvasRenderingContext2D, m: BoardMetrics, opts: GuideDrawOptions): void {
  const { guide, now, opacity } = opts;
  if (opacity <= 0.01 || guide.targets.length === 0) return;

  const neutral: RGB = [150, 168, 200];
  const colorAt = (u: number): RGB => {
    if (!opts.fingerColors) return neutral;
    const i = Math.max(0, Math.min(guide.fingers.length - 1, Math.floor(u)));
    const j = Math.min(guide.fingers.length - 1, i + 1);
    return mixRgb(FINGER_RGB[guide.fingers[i]!], FINGER_RGB[guide.fingers[j]!], u - i);
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (guide.points.length >= 2) {
    // A three-key ribbon does not need a six-key ribbon's worth of samples.
    const count = Math.min(SAMPLES_MAX, SAMPLES_PER_SPAN * (guide.points.length - 1));
    const dense = sampleCatmullRom(guide.points, 18);
    const { samples } = resampleUniform(dense, count);
    const startU = guide.hasTail ? Math.min(1, Math.max(0, opts.phase)) : 0;
    const path = clipSamples(samples, startU);

    if (path.length >= 2) {
      // arc length from the head, for the alpha/width ramp
      const dist: number[] = [0];
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!;
        const b = path[i]!;
        dist.push(dist[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const total = dist[dist.length - 1]! || 1;
      const flow = now / 620;
      const bands = opts.lite ? BANDS_LITE : BANDS;

      for (const pass of PASSES) {
        for (let band = 0; band < bands; band++) {
          // the band's mid-point drives its colour, alpha and width
          const s = (band + 0.5) / bands;
          const ramp = (1 - s) ** FALLOFF;
          const shimmer = 0.88 + 0.12 * Math.sin((s * 3.1 - flow) * Math.PI * 2);
          const width = m.unit * (0.15 - 0.1 * s);
          const lo = (band / bands) * total;
          const hi = ((band + 1) / bands) * total;

          let started = false;
          let uSum = 0;
          let uCount = 0;
          ctx.beginPath();
          for (let i = 1; i < path.length; i++) {
            const mid = (dist[i - 1]! + dist[i]!) / 2;
            // one segment of overlap on each side, so bands butt rather than gap
            if (mid < lo || mid >= hi) continue;
            const a = path[i - 1]!;
            const b = path[i]!;
            if (!started) {
              ctx.moveTo(a.x, a.y);
              started = true;
            }
            ctx.lineTo(b.x, b.y);
            uSum += (a.u + b.u) / 2;
            uCount++;
          }
          if (!started) continue;

          const c = colorAt(uSum / uCount);
          const lineWidth = pass === 1 ? width * 3.2 : width;
          const alpha = pass === 1 ? ramp * 0.13 * opacity : ramp * HEAD_ALPHA * shimmer * opacity;
          ctx.lineWidth = lineWidth;
          ctx.strokeStyle = rgba(c, overlaid(alpha, lineWidth, (hi - lo) / uCount));
          ctx.stroke();
        }
      }
    }
  }

  // dots on every upcoming key
  const n = Math.max(1, guide.targets.length);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = guide.targets.length - 1; i >= 0; i--) {
    const t = guide.targets[i]!;
    const k = i / n;
    const ramp = (1 - k) ** 1.15;
    const c = opts.fingerColors ? FINGER_RGB[t.finger] : neutral;
    const radius = m.unit * (0.1 - 0.055 * k);

    ctx.beginPath();
    ctx.arc(t.point.x, t.point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = rgba(c, 0.28 * ramp * opacity);
    ctx.fill();
    ctx.lineWidth = Math.max(1, m.unit * 0.022);
    ctx.strokeStyle = rgba(c, 0.9 * ramp * opacity);
    ctx.stroke();

    if (i === 0) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 240);
      ctx.beginPath();
      ctx.arc(t.point.x, t.point.y, radius * (1.5 + pulse * 0.85), 0, Math.PI * 2);
      ctx.strokeStyle = rgba(c, (0.5 - pulse * 0.32) * opacity);
      ctx.lineWidth = Math.max(1, m.unit * 0.03);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(t.point.x, t.point.y, radius * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = rgba([255, 255, 255], 0.92 * opacity);
      ctx.fill();
    } else if (i < 3) {
      ctx.font = `600 ${m.unit * 0.17}px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.fillStyle = rgba(c, 0.55 * ramp * opacity);
      ctx.fillText(String(i + 1), t.point.x + m.unit * 0.2, t.point.y - m.unit * 0.2);
    }
  }

  ctx.restore();
}
