/**
 * Hand schematics that flank the keyboard and light up the finger you should be
 * using. Colour alone is hard to read as "which finger" — a hand shape is not.
 *
 * Each hand is a palm plus five capsules, drawn from a normalised model so the
 * left hand is just the right hand mirrored. The lit fingertip carries the
 * character it is about to type, and the whole digit shifts up or down a little
 * to hint at the row it has to reach for.
 *
 * **The animation is on the hand, not on the finger.** Left-or-right is the
 * decision you make first and fastest, and a pulse on a single fingertip is far
 * too small a thing to answer it in peripheral vision — the two hands sit at
 * opposite edges of the screen and you are looking at the text between them. So
 * the hand that owns the press due now breathes as a whole (aura, palm tint, a
 * couple of percent of scale) and the idle hand recedes; *which* finger is left
 * to the static cues that were already there — the lit digit, the tip glyph and
 * the name below.
 */

import { FINGER_NAME, FINGER_RGB, type Finger } from '../core/keyboard-geometry';
import { rgba, type RGB } from './color';

export type HandCue = {
  finger: Finger;
  /** physical row of the target key, for the reach hint */
  row: number;
  char: string;
  /** position in the upcoming sequence; 0 is the press due now */
  at: number;
  /** for a thumb cue, which hand it belongs to */
  side?: 'left' | 'right';
};

export type Box = { x: number; y: number; w: number; h: number };

export type HandsOptions = {
  /** upcoming keys in order; index 0 is the one to press now */
  cues: readonly HandCue[];
  fingerColors: boolean;
  now: number;
  opacity: number;
};

type Digit = { finger: Finger; x: number; tipY: number; w: number };

/**
 * Right hand, palm down, fingers pointing up, thumb on the left. Proportions are
 * roughly a real hand: the palm is a little over half the length.
 */
const DIGITS: readonly Digit[] = [
  { finger: 'r2', x: 0.330, tipY: 0.155, w: 0.147 },
  { finger: 'r3', x: 0.495, tipY: 0.065, w: 0.147 },
  { finger: 'r4', x: 0.657, tipY: 0.145, w: 0.140 },
  { finger: 'r5', x: 0.802, tipY: 0.295, w: 0.120 },
];

const PALM = { x0: 0.240, y0: 0.400, x1: 0.876, y1: 0.860 };
const FINGER_BASE_Y = 0.50;
const THUMB = { baseX: 0.285, baseY: 0.585, tipX: 0.075, tipY: 0.790, w: 0.150 };
const LABEL_Y = 0.945;

/** How far a digit shifts to suggest reaching for a row. */
const ROW_REACH: Record<number, number> = { 0: -0.075, 1: -0.036, 2: 0, 3: 0.046, 4: 0 };

const LEFT_OF: Record<string, Finger> = { r2: 'l2', r3: 'l3', r4: 'l4', r5: 'l5' };
const NEUTRAL: RGB = [140, 154, 180];

/**
 * The whole-hand pulse. Fast enough to read as a blink rather than as breathing
 * — at 60 wpm a press lasts about 200 ms, so a slower cycle would leave some
 * presses cued at the dim end of the pulse and never resolve.
 */
const PULSE_MS = 680;
/** how far the active hand grows at the top of the pulse */
const PULSE_SCALE = 0.05;
/** the idle hand recedes: half the contrast comes from the other side going quiet */
const IDLE_DIM = 0.45;
const MONO = `'JetBrains Mono', ui-monospace, monospace`;

/**
 * finger -> the earliest cue that wants it, for one hand.
 *
 * The map must hold *only* this hand's cues: the drawing looks each digit up by
 * name and would not care, but "is this the hand that acts now" is read off the
 * whole map, and with the other side's cues left in, both hands answer yes.
 */
function cueIndex(cues: readonly HandCue[], side: 'left' | 'right'): Map<Finger, { at: number; cue: HandCue }> {
  const map = new Map<Finger, { at: number; cue: HandCue }>();
  const initial = side === 'left' ? 'l' : 'r';
  for (const cue of cues) {
    // a thumb cue names its hand; every other finger has its hand in its name
    const mine = cue.finger === 'thumb' ? (cue.side ?? side) === side : cue.finger[0] === initial;
    if (!mine) continue;
    const existing = map.get(cue.finger);
    if (!existing || cue.at < existing.at) map.set(cue.finger, { at: cue.at, cue });
  }
  return map;
}

export function drawHand(
  ctx: CanvasRenderingContext2D,
  box: Box,
  side: 'left' | 'right',
  opts: HandsOptions,
): void {
  if (opts.opacity <= 0.01) return;

  // fit the model into the box, keeping its aspect
  const modelAspect = 0.88;
  const h = Math.min(box.h * 0.94, (box.w * 0.95) / modelAspect);
  const w = h * modelAspect;
  const ox = box.x + (box.w - w) / 2;
  const oy = box.y + (box.h - h) / 2;

  // model space -> canvas, mirroring the whole hand for the left side
  const px = (mx: number) => ox + (side === 'left' ? 1 - mx : mx) * w;
  const py = (my: number) => oy + my * h;

  const cues = cueIndex(opts.cues, side);
  const total = Math.max(1, ...opts.cues.map((c) => c.at + 1));
  const fingerOf = (digit: Digit): Finger =>
    side === 'left' ? (LEFT_OF[digit.finger] ?? digit.finger) : digit.finger;

  const lookup = (finger: Finger) => cues.get(finger);

  // Which hand acts now. A thumb-shifted press cues the character's hand and the
  // holding hand at the same index, and both of them really do have to move, so
  // both pulse.
  const dueNow = [...cues.values()].filter((v) => v.at === 0);
  const active = dueNow.length > 0;
  // colour the hand by the finger that types, not by a thumb that only holds
  const lead = dueNow.find((v) => v.cue.finger !== 'thumb') ?? dueNow[0];
  const accent = opts.fingerColors && lead ? FINGER_RGB[lead.cue.finger] : NEUTRAL;

  // smoothstepped, not a bare sine: it then spends most of the cycle at one end
  // or the other, which reads as a blink instead of as breathing
  const wave = 0.5 + 0.5 * Math.sin((opts.now / PULSE_MS) * Math.PI * 2);
  const beat = active ? wave * wave * (3 - 2 * wave) : 0;
  // dim the idle hand only while something is actually cued, so an idle board
  // still shows two hands of equal weight
  const op = opts.opacity * (opts.cues.length > 0 && !active ? IDLE_DIM : 1);

  ctx.save();

  const cx = ox + w / 2;
  const cy = oy + h / 2;

  // the aura: a soft wash over the whole hand, and the largest part of the
  // left-or-right signal. Drawn untransformed so the glow does not breathe with
  // the hand and double the motion.
  if (active) {
    const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.62);
    aura.addColorStop(0, rgba(accent, (0.1 + 0.3 * beat) * op));
    aura.addColorStop(0.55, rgba(accent, (0.04 + 0.15 * beat) * op));
    aura.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }

  // ...and the hand itself grows into the beat
  if (active) {
    const s = 1 + PULSE_SCALE * beat;
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.translate(-cx, -cy);
  }

  // palm
  const palmColor = active ? accent : NEUTRAL;
  // The floor matters as much as the swing: at the bottom of the beat the hand
  // must still be visibly the tinted one, or a press cued on a dim frame would
  // leave "which hand" unanswered for a third of a second.
  const palmGain = active ? 0.4 + 0.6 * beat : 0;
  const palmX = Math.min(px(PALM.x0), px(PALM.x1));
  const palmW = Math.abs(px(PALM.x1) - px(PALM.x0));
  const palmGrad = ctx.createLinearGradient(0, py(PALM.y0), 0, py(PALM.y1));
  palmGrad.addColorStop(0, rgba(palmColor, (0.14 + 0.2 * palmGain) * op));
  palmGrad.addColorStop(1, rgba(palmColor, (0.05 + 0.09 * palmGain) * op));
  ctx.beginPath();
  ctx.roundRect(palmX, py(PALM.y0), palmW, py(PALM.y1) - py(PALM.y0), w * 0.18);
  ctx.fillStyle = palmGrad;
  ctx.fill();
  ctx.strokeStyle = rgba(palmColor, (0.22 + 0.42 * palmGain) * op);
  ctx.lineWidth = Math.max(1, w * (0.009 + 0.006 * palmGain));
  ctx.stroke();

  // knuckle line, just enough to read as the back of a hand
  ctx.beginPath();
  ctx.moveTo(palmX + palmW * 0.08, py(PALM.y0 + 0.075));
  ctx.lineTo(palmX + palmW * 0.92, py(PALM.y0 + 0.045));
  ctx.strokeStyle = rgba(palmColor, (0.12 + 0.2 * palmGain) * op);
  ctx.lineWidth = Math.max(1, w * 0.007);
  ctx.stroke();

  type Drawn = { finger: Finger; tip: { x: number; y: number }; width: number; hit?: { at: number; cue: HandCue } };
  const drawn: Drawn[] = [];

  const capsule = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    width: number,
    finger: Finger,
    hit: { at: number; cue: HandCue } | undefined,
  ): void => {
    const color = opts.fingerColors ? FINGER_RGB[finger] : NEUTRAL;
    const rank = hit ? (1 - hit.at / total) ** 1.7 : 0;
    const lit = hit !== undefined;
    const now = hit?.at === 0;

    ctx.lineCap = 'round';
    ctx.lineWidth = width;

    if (lit) {
      ctx.save();
      ctx.shadowColor = rgba(color, (now ? 0.85 : 0.4) * op);
      ctx.shadowBlur = width * (now ? 1.5 : 0.7);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = rgba(color, (0.34 + 0.6 * rank) * op);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = rgba(color, 0.13 * op);
      ctx.stroke();
    }

    // outline keeps the shape readable when the digit is unlit
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineWidth = Math.max(1, w * 0.007);
    ctx.strokeStyle = rgba(color, (lit ? 0.85 : 0.3) * op);
    ctx.stroke();
    ctx.lineWidth = width;
  };

  for (const digit of DIGITS) {
    const finger = fingerOf(digit);
    const hit = lookup(finger);
    const reach = hit ? (ROW_REACH[hit.cue.row] ?? 0) : 0;
    const width = digit.w * w;
    const from = { x: px(digit.x), y: py(FINGER_BASE_Y + reach * 0.45) };
    const to = { x: px(digit.x), y: py(digit.tipY + digit.w / 2 + reach) };
    capsule(from, to, width, finger, hit);
    drawn.push({ finger, tip: to, width, ...(hit ? { hit } : {}) });
  }

  {
    const hit = lookup('thumb');
    const width = THUMB.w * w;
    const from = { x: px(THUMB.baseX), y: py(THUMB.baseY) };
    const to = { x: px(THUMB.tipX), y: py(THUMB.tipY) };
    capsule(from, to, width, 'thumb', hit);
    drawn.push({ finger: 'thumb', tip: to, width, ...(hit ? { hit } : {}) });
  }

  // the character each lit finger is about to type
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const d of drawn) {
    if (!d.hit) continue;
    const color = opts.fingerColors ? FINGER_RGB[d.finger] : NEUTRAL;
    const rank = (1 - d.hit.at / total) ** 1.7;
    const radius = d.width * 0.46;

    // A static ring round the press due now. It used to pulse; the pulse is the
    // hand's job now, and two beats at two scales fought each other.
    if (d.hit.at === 0) {
      ctx.beginPath();
      ctx.arc(d.tip.x, d.tip.y, radius * 1.4, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.42 * op);
      ctx.lineWidth = Math.max(1, w * 0.012);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(d.tip.x, d.tip.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, (0.55 + 0.42 * rank) * op);
    ctx.fill();

    const glyph = d.hit.cue.char === ' ' ? '␣' : d.hit.cue.char;
    ctx.font = `700 ${radius * 1.25}px ${MONO}`;
    ctx.fillStyle = rgba([9, 11, 16], 0.92 * op);
    ctx.fillText(glyph, d.tip.x, d.tip.y + radius * 0.04);
  }

  // name of the finger to use right now
  {
    const owner = drawn.find((d) => d.hit?.at === 0);
    if (owner) {
      const color = opts.fingerColors ? FINGER_RGB[owner.finger] : NEUTRAL;
      ctx.font = `600 ${Math.max(9, w * 0.088)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = rgba(color, 0.9 * op);
      const name = FINGER_NAME[owner.finger].replace(/^[LR] /, '').toLowerCase();
      ctx.fillText(name, ox + w / 2, oy + h * LABEL_Y);
    }
  }

  ctx.restore();
}

/** Draws both hands into the side panels. */
export function drawHands(
  ctx: CanvasRenderingContext2D,
  left: Box,
  right: Box,
  opts: HandsOptions,
): void {
  drawHand(ctx, left, 'left', opts);
  drawHand(ctx, right, 'right', opts);
}
