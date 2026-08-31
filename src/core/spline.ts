/**
 * Centripetal Catmull-Rom sampling with uniform arc-length resampling.
 *
 * The ribbon fades along its own length, so samples must be evenly spaced in
 * *distance* — otherwise the alpha ramp bunches up wherever two keys sit close
 * together. Each sample also carries `u`, its fractional position in the original
 * control-point array, which is how a sample recovers the finger colour of the
 * keys it lies between.
 */

export type Pt = { x: number; y: number };
export type Sample = { x: number; y: number; u: number };

const EPS = 1e-6;

function interp(a: Pt, b: Pt, ta: number, tb: number, t: number): Pt {
  const span = tb - ta;
  if (Math.abs(span) < EPS) return { x: b.x, y: b.y };
  const w = (t - ta) / span;
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
}

/** Barry–Goldman evaluation of one centripetal Catmull-Rom segment p1->p2. */
function segmentPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, s: number, alpha: number): Pt {
  const knot = (a: Pt, b: Pt) => Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** alpha, EPS);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + s * (t2 - t1);

  const a1 = interp(p0, p1, t0, t1, t);
  const a2 = interp(p1, p2, t1, t2, t);
  const a3 = interp(p2, p3, t2, t3, t);
  const b1 = interp(a1, a2, t0, t2, t);
  const b2 = interp(a2, a3, t1, t3, t);
  return interp(b1, b2, t1, t2, t);
}

/** Dense polyline through `points`; end tangents are mirrored so the curve starts/ends straight. */
export function sampleCatmullRom(points: readonly Pt[], perSegment = 16, alpha = 0.5): Sample[] {
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0]!;
    return [{ x: p.x, y: p.y, u: 0 }];
  }
  const out: Sample[] = [];
  const at = (i: number): Pt => {
    if (i < 0) {
      const a = points[0]!;
      const b = points[1]!;
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (i > points.length - 1) {
      const a = points[points.length - 1]!;
      const b = points[points.length - 2]!;
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    return points[i]!;
  };

  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < perSegment; j++) {
      const s = j / perSegment;
      const p = segmentPoint(at(i - 1), at(i), at(i + 1), at(i + 2), s, alpha);
      out.push({ x: p.x, y: p.y, u: i + s });
    }
  }
  const last = points[points.length - 1]!;
  out.push({ x: last.x, y: last.y, u: points.length - 1 });
  return out;
}

/** Resamples a polyline to `count` points spaced evenly by arc length. */
export function resampleUniform(poly: readonly Sample[], count: number): { samples: Sample[]; length: number } {
  if (poly.length === 0) return { samples: [], length: 0 };
  if (poly.length === 1 || count < 2) return { samples: [{ ...poly[0]! }], length: 0 };

  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[cum.length - 1]!;
  if (total < EPS) return { samples: [{ ...poly[0]! }], length: 0 };

  const samples: Sample[] = [];
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (seg < cum.length - 1 && cum[seg]! < target) seg++;
    const d0 = cum[seg - 1]!;
    const d1 = cum[seg]!;
    const w = d1 - d0 < EPS ? 0 : (target - d0) / (d1 - d0);
    const a = poly[seg - 1]!;
    const b = poly[seg]!;
    samples.push({
      x: a.x + (b.x - a.x) * w,
      y: a.y + (b.y - a.y) * w,
      u: a.u + (b.u - a.u) * w,
    });
  }
  return { samples, length: total };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}
