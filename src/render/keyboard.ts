/**
 * Canvas keyboard: glass keycaps, finger colouring, press bloom, and a heatmap
 * mode reused by the summary screen.
 */

import {
  BOARD_UNITS_X,
  BOARD_UNITS_Y,
  FINGER_RGB,
  PHYS_KEYS,
  type PhysKey,
} from '../core/keyboard-geometry';
import type { KeyLabel } from '../core/method';
import { heatRgb, rgba, type RGB } from './color';

export type BoardMetrics = {
  unit: number;
  originX: number;
  originY: number;
};

export type Flash = { at: number; correct: boolean };

export type KeyboardOptions = {
  /** code -> what to paint on the cap; a missing entry means a blank cap */
  labels: Map<string, KeyLabel>;
  fingerColors: boolean;
  now: number;
  /** the key that must be pressed right now */
  nextCode?: string | undefined;
  /** code -> emphasis weight (0..1) for keys further ahead in the ribbon */
  upcoming?: Map<string, number>;
  /** modifier keys the ribbon wants held (shift, thumb-shift), code -> weight */
  holds?: Map<string, number>;
  flashes?: Map<string, Flash>;
  /** code -> 0..1, drawn instead of finger tint (summary heatmap) */
  heat?: Map<string, number>;
  /** 0 = normal, 1 = fully faded (used on the idle screen) */
  fade?: number;
};

const PAD_UNITS = 0.5;
const FLASH_MS = 260;
const NEUTRAL: RGB = [150, 162, 186];

/** Unit size for a region, before the board is centred in it. */
export function boardUnit(width: number, height: number): number {
  return Math.min(width / (BOARD_UNITS_X + PAD_UNITS), height / (BOARD_UNITS_Y + PAD_UNITS));
}

/** Centres the board in a `width` x `height` region placed at (offsetX, offsetY). */
export function boardMetrics(width: number, height: number, offsetX = 0, offsetY = 0): BoardMetrics {
  const unit = boardUnit(width, height);
  return {
    unit,
    originX: offsetX + (width - BOARD_UNITS_X * unit) / 2,
    originY: offsetY + (height - BOARD_UNITS_Y * unit) / 2,
  };
}

export function keyRect(m: BoardMetrics, key: PhysKey): { x: number; y: number; w: number; h: number } {
  const gap = m.unit * 0.085;
  return {
    x: m.originX + key.x * m.unit + gap / 2,
    y: m.originY + key.row * m.unit + gap / 2,
    w: key.w * m.unit - gap,
    h: m.unit - gap,
  };
}

export function keyCenterPx(m: BoardMetrics, key: PhysKey): { x: number; y: number } {
  const r = keyRect(m, key);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Clamps an x position onto the space bar, so the ribbon drops straight down to it. */
export function spaceTargetX(m: BoardMetrics, key: PhysKey, preferredX: number): number {
  const r = keyRect(m, key);
  const inset = r.w * 0.18;
  return Math.min(r.x + r.w - inset, Math.max(r.x + inset, preferredX));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawKeyboard(ctx: CanvasRenderingContext2D, m: BoardMetrics, opts: KeyboardOptions): void {
  const { unit } = m;
  const fade = opts.fade ?? 0;
  const alpha = 1 - fade * 0.6;
  // Canvas does not read --mono, so this stack has to be kept in step with the
  // one in app.css by hand. 'Noto Sans JP' is the bundled kana subset
  // (style/fonts-ja.css) and last, so a machine with a Japanese system font
  // keeps using it; without this entry the kana legends are tofu on a machine
  // that has none, which is most of the audience of a public URL.
  const mono = `'JetBrains Mono', 'Yu Gothic UI', 'Hiragino Sans', 'Noto Sans JP', ui-monospace, monospace`;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const key of PHYS_KEYS) {
    const r = keyRect(m, key);
    const radius = unit * 0.17;
    // character keys are exactly those the geometry does not give a fixed legend
    const isChar = key.label === undefined;
    const base: RGB = opts.fingerColors && isChar ? FINGER_RGB[key.finger] : NEUTRAL;

    const heat = opts.heat?.get(key.code);
    const tint: RGB = heat === undefined ? base : heatRgb(heat);
    const heatWeight = heat === undefined ? 0 : 0.35 + heat * 0.5;

    const isNext = opts.nextCode === key.code;
    const ahead = opts.upcoming?.get(key.code) ?? 0;
    const hold = opts.holds?.get(key.code) ?? 0;
    const flash = opts.flashes?.get(key.code);
    const flashAge = flash ? (opts.now - flash.at) / FLASH_MS : 1;
    const flashK = flash && flashAge < 1 ? 1 - flashAge : 0;

    // body
    const grad = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
    const bodyTop = heat !== undefined ? heatWeight * 0.9 : 0.14 + ahead * 0.16 + (isNext ? 0.3 : 0);
    const bodyBottom = heat !== undefined ? heatWeight * 0.45 : 0.05 + ahead * 0.08 + (isNext ? 0.14 : 0);
    grad.addColorStop(0, rgba(tint, bodyTop));
    grad.addColorStop(1, rgba(tint, bodyBottom));
    roundRect(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.fillStyle = '#10131b';
    ctx.fill();
    ctx.fillStyle = grad;
    ctx.fill();

    // press bloom
    if (flashK > 0) {
      const c: RGB = flash!.correct ? tint : [255, 70, 96];
      ctx.save();
      ctx.shadowColor = rgba(c, 0.9 * flashK);
      ctx.shadowBlur = unit * 0.7 * flashK;
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.fillStyle = rgba(c, 0.35 + 0.4 * flashK);
      ctx.fill();
      ctx.restore();

      // expanding ring
      const spread = unit * (0.1 + 0.5 * (1 - flashK));
      roundRect(ctx, r.x - spread, r.y - spread, r.w + spread * 2, r.h + spread * 2, radius + spread);
      ctx.strokeStyle = rgba(c, 0.35 * flashK);
      ctx.lineWidth = Math.max(1, unit * 0.03);
      ctx.stroke();
    }

    // next-key halo
    if (isNext) {
      ctx.save();
      ctx.shadowColor = rgba(tint, 0.85);
      ctx.shadowBlur = unit * 0.55;
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.strokeStyle = rgba(tint, 0.95);
      ctx.lineWidth = Math.max(1.2, unit * 0.045);
      ctx.stroke();
      ctx.restore();
    } else if (hold > 0) {
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.strokeStyle = rgba([220, 230, 255], 0.25 + hold * 0.5);
      ctx.lineWidth = Math.max(1, unit * 0.03);
      ctx.stroke();
    } else {
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.strokeStyle = rgba(tint, 0.18 + ahead * 0.35 + (key.home ? 0.16 : 0));
      ctx.lineWidth = Math.max(1, unit * 0.022);
      ctx.stroke();
    }

    // glass highlight along the top edge
    const gloss = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h * 0.55);
    gloss.addColorStop(0, 'rgba(255,255,255,0.07)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    roundRect(ctx, r.x + r.w * 0.04, r.y + r.h * 0.05, r.w * 0.92, r.h * 0.5, radius * 0.8);
    ctx.fillStyle = gloss;
    ctx.fill();

    // home-row nub
    if (key.home) {
      ctx.beginPath();
      ctx.arc(r.x + r.w / 2, r.y + r.h * 0.84, unit * 0.035, 0, Math.PI * 2);
      ctx.fillStyle = rgba(tint, 0.75);
      ctx.fill();
    }

    // label
    const label = opts.labels.get(key.code) ?? (key.label === undefined ? undefined : { main: key.label });
    if (label?.main || label?.tl || label?.tr) {
      const strong = isNext || flashK > 0.2;
      const ink = (a: number) =>
        heat !== undefined ? rgba([255, 255, 255], Math.min(1, a + 0.2)) : rgba(tint, a);

      if (label.tl || label.tr) {
        // three faces: alone in the middle, thumb-shifted below left and right
        ctx.font = `600 ${unit * 0.3}px ${mono}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = ink(strong ? 1 : 0.72 + ahead * 0.25);
        if (label.main) ctx.fillText(label.main, r.x + r.w / 2, r.y + r.h * 0.34);

        ctx.font = `500 ${unit * 0.2}px ${mono}`;
        ctx.textAlign = 'left';
        if (label.tl) ctx.fillText(label.tl, r.x + r.w * 0.1, r.y + r.h * 0.75);
        ctx.textAlign = 'right';
        if (label.tr) ctx.fillText(label.tr, r.x + r.w * 0.9, r.y + r.h * 0.75);
        ctx.textAlign = 'center';
      } else {
        ctx.font = `${isChar ? 600 : 500} ${unit * (isChar ? 0.34 : 0.2)}px ${mono}`;
        ctx.fillStyle = ink(strong ? 1 : 0.62 + ahead * 0.3);
        ctx.fillText(label.main, r.x + r.w / 2, r.y + r.h * (label.sub ? 0.62 : 0.54));
        if (label.sub) {
          ctx.font = `500 ${unit * 0.2}px ${mono}`;
          ctx.fillStyle = ink(0.42);
          ctx.fillText(label.sub, r.x + r.w / 2, r.y + r.h * 0.26);
        }
      }
    }
  }

  ctx.restore();
}
