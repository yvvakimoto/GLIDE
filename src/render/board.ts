/**
 * Owns the keyboard canvas: DPR-aware sizing, press flashes, the ribbon's slide
 * animation, and the hand schematics that flank the board.
 *
 * The sixty-one keycaps are baked into an offscreen layer and blitted, because
 * nothing about them moves between keystrokes; only the ribbon, the hands and a
 * live press bloom are redrawn per frame. `capKey` is what decides when that
 * layer is stale — see `capSignature`.
 */

import { physKey } from '../core/keyboard-geometry';
import { thumbKeyOf, type Chord, type KeyLabel, type MethodSpec } from '../core/method';
import { easeOutCubic } from '../core/spline';
import { computeGuide, drawGuide, upcomingWeights, type GuideTarget } from './guide';
import { drawHands, type HandCue } from './hands';
import {
  boardMetrics,
  boardUnit,
  drawKeyboard,
  drawKeyFlash,
  flashAlive,
  type BoardMetrics,
  type Flash,
  type KeyboardOptions,
} from './keyboard';
import { renderScale } from './quality';

export type BoardState = {
  labels: Map<string, KeyLabel>;
  spec: MethodSpec;
  fingerColors: boolean;
  showHands: boolean;
  /** the upcoming presses, the one due now first */
  chords: readonly Chord[];
  now: number;
  /** ribbon opacity, so it can fade in and out with the run */
  guideOpacity: number;
  /** drop every blur and render at a lower resolution */
  lite: boolean;
  heat?: Map<string, number>;
  fade?: number;
};

/** how long the ribbon takes to slide one key forward */
const SLIDE_MS = 115;
const FLASH_KEEP_MS = 400;
/** below this keycap size the hands are dropped and the board takes the width */
const MIN_UNIT_WITH_HANDS = 26;
/** how many upcoming presses the hands light up */
const HAND_CUES = 3;

export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private metrics: BoardMetrics = { unit: 0, originX: 0, originY: 0 };
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 0;
  private sideWidth = 0;
  private handsShown = false;
  private handsWanted: boolean | undefined;
  private flashes = new Map<string, Flash>();
  private prevCode: string | undefined;
  private slideStart = -1;
  /** bumped by the ResizeObserver; the canvas is only measured when it moves */
  private sizeEpoch = 0;
  private laidOut = -1;
  private caps: HTMLCanvasElement | undefined;
  private capCtx: CanvasRenderingContext2D | undefined;
  private capKey = '';
  private capLabels: Map<string, KeyLabel> | undefined;
  private capHeat: Map<string, number> | undefined;

  /** Called when the canvas has been resized, so the owner can redraw. */
  onInvalidate: (() => void) | undefined;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    const invalidate = (): void => {
      this.sizeEpoch++;
      this.onInvalidate?.();
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(invalidate).observe(canvas);
    else window.addEventListener('resize', invalidate);
  }

  /** The finger has landed on `code`; the ribbon slides forward from there. */
  noteKeystroke(code: string, correct: boolean, now: number): void {
    this.flash(code, correct, now);
    this.prevCode = code;
    this.slideStart = now;
  }

  /** Feedback for a key that changed nothing (a press while a mistype stands). */
  flash(code: string, correct: boolean, now: number): void {
    this.flashes.set(code, { at: now, correct });
  }

  reset(): void {
    this.flashes.clear();
    this.prevCode = undefined;
    this.slideStart = -1;
  }

  /**
   * Whether the board still has something moving of its own. The frame loop uses
   * it to keep drawing for the tail of the last press after a run has ended,
   * instead of freezing a bloom half-way through.
   */
  busy(now: number): boolean {
    for (const [code, flash] of this.flashes) {
      if (now - flash.at > FLASH_KEEP_MS) this.flashes.delete(code);
    }
    return this.flashes.size > 0 || (this.slideStart >= 0 && now - this.slideStart < SLIDE_MS);
  }

  private syncSize(showHands: boolean): void {
    const dpr = renderScale();
    if (this.sizeEpoch !== this.laidOut || showHands !== this.handsWanted || dpr !== this.dpr) {
      this.laidOut = this.sizeEpoch;
      this.handsWanted = showHands;
      this.dpr = dpr;

      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      this.cssWidth = w;
      this.cssHeight = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);

      // Reserve a column on each side for a hand, unless that would shrink the
      // keycaps too far — then the board gets everything.
      let side = showHands ? Math.min(280, Math.max(120, w * 0.2)) : 0;
      if (side > 0 && boardUnit(w - side * 2, h) < MIN_UNIT_WITH_HANDS) side = 0;
      this.sideWidth = side;
      this.handsShown = showHands && side > 0;
      this.metrics = boardMetrics(w - side * 2, h, side);
      this.capKey = '';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get boardMetrics(): BoardMetrics {
    return this.metrics;
  }

  /**
   * Everything the baked keycap layer depends on. `upcoming` and `holds` are
   * rebuilt every frame so they have to be compared by value, but their weights
   * come from the target's index in the ribbon, which only moves on a keystroke.
   */
  private capSignature(opts: KeyboardOptions): string {
    const m = this.metrics;
    let key = `${m.unit}|${m.originX}|${m.originY}|${this.dpr}|${opts.fingerColors}`;
    key += `|${opts.fade ?? 0}|${opts.lite}|${opts.nextCode ?? ''}`;
    if (opts.upcoming) for (const [code, w] of opts.upcoming) key += `|${code}:${w.toFixed(3)}`;
    if (opts.holds) for (const [code, w] of opts.holds) key += `|h${code}:${w.toFixed(3)}`;
    return key;
  }

  /** Blits the keycap layer, rebaking it first if anything static has moved. */
  private paintCaps(opts: KeyboardOptions): void {
    if (!this.caps) {
      this.caps = document.createElement('canvas');
      this.capCtx = this.caps.getContext('2d') ?? undefined;
    }
    const cap = this.capCtx;
    if (!cap) {
      // no offscreen context: draw straight to the board, as it used to
      this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      drawKeyboard(this.ctx, this.metrics, opts);
      return;
    }

    const key = this.capSignature(opts);
    if (key !== this.capKey || opts.labels !== this.capLabels || opts.heat !== this.capHeat) {
      this.capKey = key;
      this.capLabels = opts.labels;
      this.capHeat = opts.heat;
      if (this.caps.width !== this.canvas.width || this.caps.height !== this.canvas.height) {
        this.caps.width = this.canvas.width;
        this.caps.height = this.canvas.height;
      }
      cap.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      cap.clearRect(0, 0, this.cssWidth, this.cssHeight);
      drawKeyboard(cap, this.metrics, opts);
    }
    // 'copy' does the clear and the blit in one pass, with no blending
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.caps, 0, 0, this.cssWidth, this.cssHeight);
    ctx.globalCompositeOperation = 'source-over';
  }

  draw(state: BoardState): void {
    this.syncSize(state.showHands);
    const ctx = this.ctx;

    for (const [code, flash] of this.flashes) {
      if (state.now - flash.at > FLASH_KEEP_MS) this.flashes.delete(code);
    }

    const guide = computeGuide(this.metrics, state.chords, this.prevCode, state.spec);
    const weights = upcomingWeights(guide);
    const live = state.guideOpacity > 0.05;

    const capOpts: KeyboardOptions = {
      labels: state.labels,
      fingerColors: state.fingerColors,
      now: state.now,
      nextCode: live ? guide.targets[0]?.key.code : undefined,
      upcoming: weights.keys,
      holds: weights.holds,
      lite: state.lite,
      ...(state.heat ? { heat: state.heat } : {}),
      ...(state.fade === undefined ? {} : { fade: state.fade }),
    };
    this.paintCaps(capOpts);

    for (const [code, flash] of this.flashes) {
      const key = physKey(code);
      if (key && flashAlive(flash, state.now)) {
        drawKeyFlash(ctx, this.metrics, key, flash, state.now, capOpts);
      }
    }

    if (this.handsShown) {
      const top = this.metrics.originY - this.metrics.unit * 0.32;
      const height = this.metrics.unit * 5.5;
      drawHands(
        ctx,
        { x: 0, y: top, w: this.sideWidth, h: height },
        { x: this.cssWidth - this.sideWidth, y: top, w: this.sideWidth, h: height },
        {
          cues: live ? handCues(guide.targets.slice(0, HAND_CUES), state.spec) : [],
          fingerColors: state.fingerColors,
          now: state.now,
          opacity: state.fade ? 0.35 : 1,
          lite: state.lite,
        },
      );
    }

    if (state.guideOpacity > 0.01) {
      const phase = this.slideStart < 0 ? 1 : easeOutCubic((state.now - this.slideStart) / SLIDE_MS);
      drawGuide(ctx, this.metrics, {
        guide,
        phase,
        now: state.now,
        fingerColors: state.fingerColors,
        opacity: state.guideOpacity,
        lite: state.lite,
      });
    }
  }
}

/**
 * Only the next few presses reach the hands: with six cues almost every finger
 * lights up and the "which one now" signal is lost. The ribbon covers the longer
 * view. A thumb-shifted press lights its own hand's thumb as well.
 */
function handCues(targets: readonly GuideTarget[], spec: MethodSpec): HandCue[] {
  const cues: HandCue[] = [];
  targets.forEach((t, at) => {
    cues.push({ finger: t.finger, row: t.key.row, char: t.chord.label, at });
    if (t.chord.thumb !== 'none') {
      cues.push({
        finger: 'thumb',
        row: physKey(thumbKeyOf(spec, t.chord.thumb))?.row ?? 4,
        char: '⇧',
        at,
        side: t.chord.thumb,
      });
    }
  });
  return cues;
}
