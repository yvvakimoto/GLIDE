/**
 * Owns the keyboard canvas: DPR-aware sizing, press flashes, the ribbon's slide
 * animation, and the hand schematics that flank the board.
 */

import { physKey } from '../core/keyboard-geometry';
import { thumbKeyOf, type Chord, type KeyLabel, type MethodSpec } from '../core/method';
import { easeOutCubic } from '../core/spline';
import { computeGuide, drawGuide, upcomingWeights, type GuideTarget } from './guide';
import { drawHands, type HandCue } from './hands';
import { boardMetrics, boardUnit, drawKeyboard, type BoardMetrics, type Flash } from './keyboard';

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
  private sideWidth = 0;
  private handsShown = false;
  private flashes = new Map<string, Flash>();
  private prevCode: string | undefined;
  private slideStart = -1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
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

  private syncSize(showHands: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const resized = w !== this.cssWidth || h !== this.cssHeight || this.canvas.width !== Math.round(w * dpr);

    if (resized || showHands !== this.handsShown) {
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
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get boardMetrics(): BoardMetrics {
    return this.metrics;
  }

  draw(state: BoardState): void {
    this.syncSize(state.showHands);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    for (const [code, flash] of this.flashes) {
      if (state.now - flash.at > FLASH_KEEP_MS) this.flashes.delete(code);
    }

    const guide = computeGuide(this.metrics, state.chords, this.prevCode, state.spec);
    const weights = upcomingWeights(guide);
    const live = state.guideOpacity > 0.05;

    drawKeyboard(ctx, this.metrics, {
      labels: state.labels,
      fingerColors: state.fingerColors,
      now: state.now,
      nextCode: live ? guide.targets[0]?.key.code : undefined,
      upcoming: weights.keys,
      holds: weights.holds,
      flashes: this.flashes,
      ...(state.heat ? { heat: state.heat } : {}),
      ...(state.fade === undefined ? {} : { fade: state.fade }),
    });

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
