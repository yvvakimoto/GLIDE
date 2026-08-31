/**
 * Speed chart: instantaneous WPM as a filled area, the moving average as the
 * bright line on top, and error ticks along the floor. Used both for the live
 * strip during a run and for the larger summary chart.
 */

import type { SamplePoint } from '../core/stats';
import { rgba, speedRgb, type RGB } from './color';

export type ChartOptions = {
  series: readonly SamplePoint[];
  width: number;
  height: number;
  /** right edge of the x axis, in seconds */
  xMax: number;
  /** left edge, in seconds (for the rolling live view) */
  xMin?: number;
  maWindow: number;
  axes?: boolean;
  /** draw the current value at the right edge */
  readout?: boolean;
  /** low-cost mode: no glow under the moving-average line */
  lite?: boolean;
  padding?: { top: number; right: number; bottom: number; left: number };
};

const GRID: RGB = [126, 142, 176];
const RAW: RGB = [110, 130, 170];
const ERROR: RGB = [255, 61, 110];
const MONO = `'JetBrains Mono', ui-monospace, monospace`;

function niceMax(value: number): number {
  const min = 40;
  const step = 20;
  return Math.max(min, Math.ceil((value * 1.12) / step) * step);
}

export function drawChart(ctx: CanvasRenderingContext2D, opts: ChartOptions): void {
  const pad = opts.padding ?? (opts.axes
    ? { top: 14, right: 46, bottom: 22, left: 38 }
    : { top: 6, right: 8, bottom: 8, left: 8 });
  const x0 = pad.left;
  const x1 = opts.width - pad.right;
  const y0 = pad.top;
  const y1 = opts.height - pad.bottom;
  if (x1 <= x0 || y1 <= y0) return;

  const xMin = opts.xMin ?? 0;
  const xMax = Math.max(xMin + 1, opts.xMax);
  const visible = opts.series.filter((p) => p.t >= xMin - 1 && p.t <= xMax + 1);
  const peak = visible.reduce((max, p) => Math.max(max, p.raw, p.wpm), 0);
  const yMax = niceMax(peak);

  const sx = (t: number) => x0 + ((t - xMin) / (xMax - xMin)) * (x1 - x0);
  const sy = (v: number) => y1 - (Math.min(v, yMax) / yMax) * (y1 - y0);

  ctx.save();

  // grid
  ctx.lineWidth = 1;
  ctx.font = `500 10px ${MONO}`;
  ctx.textBaseline = 'middle';
  const steps = yMax / 20;
  for (let i = 0; i <= steps; i++) {
    const v = (yMax / steps) * i;
    const y = Math.round(sy(v)) + 0.5;
    ctx.strokeStyle = rgba(GRID, i === 0 ? 0.22 : 0.09);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    if (opts.axes && i > 0) {
      ctx.fillStyle = rgba(GRID, 0.5);
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(v)), x0 - 6, y);
    }
  }

  if (opts.axes) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tickCount = Math.min(8, Math.max(2, Math.round((xMax - xMin) / 10)));
    for (let i = 0; i <= tickCount; i++) {
      const t = xMin + ((xMax - xMin) / tickCount) * i;
      ctx.strokeStyle = rgba(GRID, 0.09);
      ctx.beginPath();
      ctx.moveTo(Math.round(sx(t)) + 0.5, y0);
      ctx.lineTo(Math.round(sx(t)) + 0.5, y1);
      ctx.stroke();
      ctx.fillStyle = rgba(GRID, 0.5);
      ctx.fillText(`${Math.round(t)}s`, sx(t), y1 + 6);
    }
  }

  if (visible.length >= 2) {
    // raw area
    ctx.beginPath();
    ctx.moveTo(sx(visible[0]!.t), y1);
    for (const p of visible) ctx.lineTo(sx(p.t), sy(p.raw));
    ctx.lineTo(sx(visible[visible.length - 1]!.t), y1);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, y0, 0, y1);
    fill.addColorStop(0, rgba(RAW, 0.3));
    fill.addColorStop(1, rgba(RAW, 0.02));
    ctx.fillStyle = fill;
    ctx.fill();

    // instantaneous net line
    ctx.beginPath();
    visible.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.wpm)) : ctx.moveTo(sx(p.t), sy(p.wpm))));
    ctx.strokeStyle = rgba([180, 200, 235], 0.4);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // moving average
    const last = visible[visible.length - 1]!;
    const accent = speedRgb(last.ma);
    ctx.beginPath();
    visible.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.ma)) : ctx.moveTo(sx(p.t), sy(p.ma))));
    ctx.strokeStyle = rgba(accent, 0.98);
    ctx.lineWidth = opts.axes ? 2.6 : 2;
    ctx.lineJoin = 'round';
    if (!opts.lite) {
      ctx.shadowColor = rgba(accent, 0.55);
      ctx.shadowBlur = 10;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // error ticks
    for (const p of visible) {
      if (!p.errors) continue;
      const x = Math.round(sx(p.t)) + 0.5;
      const h = Math.min(y1 - y0, 5 + p.errors * 3);
      ctx.strokeStyle = rgba(ERROR, 0.75);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y1 - h);
      ctx.stroke();
    }

    if (opts.readout) {
      ctx.beginPath();
      ctx.arc(sx(last.t), sy(last.ma), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(accent, 1);
      ctx.fill();
      ctx.font = `700 11px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(accent, 0.95);
      // sits just ahead of the leading point, not pinned to the far edge
      const labelX = Math.min(sx(last.t) + 9, opts.width - 26);
      const labelY = Math.min(y1 - 7, Math.max(y0 + 7, sy(last.ma)));
      ctx.fillText(String(Math.round(last.ma)), labelX, labelY);
    }
  }

  if (opts.axes) {
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rgba(GRID, 0.55);
    ctx.fillText(`wpm  /  ${opts.maWindow}s moving average`, x0, 0);
  }

  ctx.restore();
}
