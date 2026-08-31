import { describe, expect, it } from 'vitest';

import { easeOutCubic, resampleUniform, sampleCatmullRom, type Pt } from '../src/core/spline';

const points: Pt[] = [
  { x: 0, y: 0 },
  { x: 40, y: 10 },
  { x: 40, y: 80 },
  { x: 160, y: 90 },
  { x: 90, y: 20 },
];

describe('spline', () => {
  it('passes through every control point', () => {
    const dense = sampleCatmullRom(points, 12);
    for (let i = 0; i < points.length; i++) {
      const hit = dense.find((s) => Math.abs(s.u - i) < 1e-9);
      expect(hit, `control point ${i}`).toBeDefined();
      expect(hit!.x).toBeCloseTo(points[i]!.x, 6);
      expect(hit!.y).toBeCloseTo(points[i]!.y, 6);
    }
  });

  it('keeps u monotonic and spaces resampled points evenly by arc length', () => {
    const { samples, length } = resampleUniform(sampleCatmullRom(points, 16), 120);
    expect(samples.length).toBe(120);
    expect(length).toBeGreaterThan(200);

    const step = length / (samples.length - 1);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      expect(b.u).toBeGreaterThanOrEqual(a.u - 1e-9);
      // each gap is within a few percent of the ideal spacing
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(step, 0);
    }
    expect(samples[0]!.u).toBeCloseTo(0, 6);
    expect(samples[samples.length - 1]!.u).toBeCloseTo(points.length - 1, 3);
  });

  it('survives degenerate inputs', () => {
    expect(sampleCatmullRom([], 8)).toEqual([]);
    expect(sampleCatmullRom([{ x: 3, y: 4 }], 8)).toEqual([{ x: 3, y: 4, u: 0 }]);
    const flat = resampleUniform(sampleCatmullRom([{ x: 1, y: 1 }, { x: 1, y: 1 }], 8), 40);
    expect(flat.length).toBe(0);
    expect(flat.samples.length).toBe(1);
  });

  it('eases from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
