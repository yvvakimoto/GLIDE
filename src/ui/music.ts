/**
 * The background loop: two <audio> decks crossfading into each other at the
 * seam, on the context `audio.ts` owns.
 *
 * Why not the textbook seamless loop — decodeAudioData into an AudioBuffer with
 * loopStart/loopEnd — is arithmetic: 384 s x 44.1 kHz x 2 ch x 4 B is 135 MB
 * resident, in an app that counts the cost of a blur. So it streams, which means
 * <audio>, which means no sample-accurate looping. And a crossfade is needed
 * anyway: the track has no silence in it anywhere, its last second sits at
 * -18.4 dBFS against -22.0 for its first five, and MP3 carries encoder delay and
 * tail padding on top — `loop` cuts audibly on all three counts.
 *
 * Streaming also keeps the whole thing off the main thread. Decode and mixing
 * are the browser's audio thread; the only work here is `tick`, comparing two
 * numbers about four times a second.
 */

import { armAudio, audioBus, resumeAudio } from './audio';
import TRACK from '../assets/drifting-prelude.mp3?url';

/**
 * The track's mean is -18.7 dBFS, so this lands it near -33 dBFS mean with peaks
 * around -18. The click is 0.07 x a 0.5..0.9 oscillator, i.e. -29..-24 dBFS peak:
 * the music sits just under the thing it must not mask. Tune by ear in 0.12..0.25.
 */
const LEVEL = 0.18;
/**
 * The crossfade. Long, for three reasons in descending order of force: the head
 * is 4.7 dB quieter than the tail, and over one second that step reads as a dip
 * where over five it reads as the piece settling; it has to dwarf a quarter
 * second of `timeupdate` granularity plus the `play()` lead below; and five
 * seconds is what ambient material wants anyway.
 */
const FADE = 5;
/** `timeupdate` only fires ~4/s, so ask for the swap this much early or the
 *  outgoing deck runs out mid-curve and the tail of the fade is silence. */
const GUARD = 0.5;
/** `play()` is not instant. These milliseconds of the incoming head play at
 *  gain 0 and are lost, which is invisible; without them the fade starts on
 *  silence. */
const LEAD = 0.06;
/** how long the other deck gets to fetch before it is needed. */
const PRELOAD = 30;
/** the on/off and tab-return fades. */
const RAMP = 1.2;
/** HAVE_FUTURE_DATA. Named because `3` in a readyState test says nothing. */
const READY = 3;

const CURVE_N = 64;

/**
 * cos/sin, because the tail and the head are two different points of the same
 * piece: musically related, not phase-correlated. Uncorrelated signals sum in
 * power, so the pair that holds the level flat is the one whose *squares* sum to
 * one. A linear pair digs a 3 dB hole in the middle of every seam.
 */
export function equalPower(rising: boolean, n: number = CURVE_N): Float32Array {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (Math.PI / 2);
    curve[i] = rising ? Math.sin(t) : Math.cos(t);
  }
  return curve;
}

export type LoopAction = 'wait' | 'warm' | 'swap';

/**
 * What the front deck's position asks for. Pure, because the real seam is 379
 * seconds into a session and nothing else would ever exercise this arithmetic.
 *
 * `duration` is NaN until metadata lands, and stays wrong on an MP3 with no
 * Xing header — hence the finite check rather than trusting the subtraction.
 */
export function loopAction(at: number, duration: number): LoopAction {
  if (!Number.isFinite(at) || !Number.isFinite(duration) || duration <= FADE + GUARD) return 'wait';
  const left = duration - at;
  if (left <= FADE + GUARD) return 'swap';
  if (left <= FADE + GUARD + PRELOAD) return 'warm';
  return 'wait';
}

export type MusicDebug = {
  enabled: boolean;
  armed: boolean;
  front: 0 | 1;
  at: number;
  ready: number;
  paused: [boolean, boolean];
  gains: [number, number];
  level: number;
};

type Deck = { el: HTMLAudioElement; gain: GainNode };

export class Music {
  private enabled: boolean;
  private visible = true;
  private decks: [Deck, Deck] | undefined;
  private level: GainNode | undefined;
  private front: 0 | 1 = 0;
  /** the outgoing deck is parked — paused and rewound — once its curve ends. */
  private parkAt = Infinity;
  /** an off-fade is running; pause both decks when it ends. */
  private stopAt = Infinity;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** The setting moved, or the first gesture arrived and it was already on. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.fadeOut();
      return;
    }
    if (!this.build()) return;
    if (this.visible) this.start();
  }

  /**
   * Whether another gesture could still do anything for it. The AudioContext is
   * not the only gate: `HTMLMediaElement.play()` has an autoplay policy of its
   * own, and it refuses outside a gesture even on a page whose context is long
   * since running — so a context that is `running` is not proof the music
   * started. main.ts's unlock hook stays installed until this says so.
   */
  get settled(): boolean {
    if (!this.enabled) return true; // nothing to start
    if (!this.visible) return true; // deliberately paused; setVisible will start it
    return this.decks !== undefined && !this.decks[this.front].el.paused;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.decks) return;
    if (!visible) {
      // No fade on the way out: it would be the last thing heard before the tab
      // goes, and a hidden tab is hard-cut by the browser anyway. Pausing here
      // is also what keeps the scheduler out of a background tab entirely.
      for (const deck of this.decks) deck.el.pause();
      return;
    }
    if (this.enabled) this.start();
  }

  /**
   * Build the graph. Once — `createMediaElementSource` throws on a second call
   * for the same element, so the decks outlive every toggle; turning the music
   * off pauses them and never tears them down.
   */
  private build(): boolean {
    if (this.decks) return true;
    const bus = armAudio() ?? audioBus();
    if (!bus) return false;
    resumeAudio();
    const { ctx } = bus;

    const level = ctx.createGain();
    level.gain.value = 0;
    level.connect(bus.out);

    const decks = [0, 1].map((i) => {
      // No src, and preload 'none': `new Audio(url)` defaults preload to 'auto'
      // and would fetch 4.4 MB the moment it was constructed. Deck 0 gets its
      // src below; deck 1 not until `warm`, thirty seconds before it is needed,
      // by which time deck 0's response is complete and deck 1's request is a
      // conditional GET or a cache hit. Two concurrent requests could be neither.
      const el = new Audio();
      el.preload = 'none';
      // The safety net, not the mechanism: if a boundary is ever missed — deck
      // not buffered, `timeupdate` starved — this costs one audible seam rather
      // than permanent silence, and the trigger falls false when it wraps.
      el.loop = true;
      el.addEventListener('timeupdate', () => this.tick());
      const gain = ctx.createGain();
      gain.gain.value = i === 0 ? 1 : 0;
      ctx.createMediaElementSource(el).connect(gain).connect(level);
      return { el, gain };
    }) as [Deck, Deck];

    decks[0].el.preload = 'auto';
    decks[0].el.src = TRACK;

    this.decks = decks;
    this.level = level;
    return true;
  }

  /** Play the front deck from wherever it was left; toggling must not restart
   *  the piece. Ramps up rather than cutting in. */
  private start(): void {
    const bus = audioBus();
    if (!this.decks || !this.level || !bus) return;
    resumeAudio();
    this.stopAt = Infinity;
    void this.decks[this.front].el.play().catch(() => {});
    const now = bus.ctx.currentTime;
    this.level.gain.cancelScheduledValues(now);
    this.level.gain.setValueAtTime(this.level.gain.value, now);
    this.level.gain.linearRampToValueAtTime(LEVEL, now + RAMP);
  }

  private fadeOut(): void {
    const bus = audioBus();
    if (!this.decks || !this.level || !bus) return;
    const now = bus.ctx.currentTime;
    this.level.gain.cancelScheduledValues(now);
    this.level.gain.setValueAtTime(this.level.gain.value, now);
    this.level.gain.linearRampToValueAtTime(0, now + RAMP);
    // The pause rides `tick` rather than a timer: the events are already
    // arriving four times a second, and a timer would be throttled to one.
    this.stopAt = now + RAMP;
  }

  private tick(): void {
    const bus = audioBus();
    if (!this.decks || !bus) return;
    const now = bus.ctx.currentTime;

    if (now >= this.parkAt) {
      // The invariant that keeps seeking off the hot path: an idle deck is
      // always paused at 0, so a swap never waits on a `seeked` event. The
      // reset happens here, a whole FADE later, with all the slack in the world.
      const idle = this.decks[this.front === 0 ? 1 : 0];
      idle.el.pause();
      idle.el.currentTime = 0;
      this.parkAt = Infinity;
    }
    if (now >= this.stopAt) {
      for (const deck of this.decks) deck.el.pause();
      this.stopAt = Infinity;
      return;
    }
    if (!this.enabled || !this.visible) return;

    const front = this.decks[this.front];
    const back = this.decks[this.front === 0 ? 1 : 0];
    switch (loopAction(front.el.currentTime, front.el.duration)) {
      case 'warm':
        if (!back.el.src) {
          back.el.preload = 'auto';
          back.el.src = TRACK;
        }
        return;
      case 'swap':
        if (back.el.readyState >= READY && this.parkAt === Infinity) this.swap(now);
        return;
      default:
        return;
    }
  }

  private swap(now: number): void {
    if (!this.decks) return;
    const from = this.decks[this.front];
    const to = this.decks[this.front === 0 ? 1 : 0];
    const t0 = now + LEAD;
    void to.el.play().catch(() => {});
    ramp(from.gain, equalPower(false), t0);
    ramp(to.gain, equalPower(true), t0);
    this.front = this.front === 0 ? 1 : 0;
    this.parkAt = t0 + FADE;
  }

  /** dev only: what verify.mjs reads. */
  debug(): MusicDebug {
    const decks = this.decks;
    const front = decks?.[this.front];
    return {
      enabled: this.enabled,
      armed: decks !== undefined,
      front: this.front,
      at: front ? front.el.currentTime : -1,
      ready: front ? front.el.readyState : -1,
      paused: decks ? [decks[0].el.paused, decks[1].el.paused] : [true, true],
      gains: decks ? [decks[0].gain.gain.value, decks[1].gain.gain.value] : [0, 0],
      level: this.level ? this.level.gain.value : 0,
    };
  }

  /**
   * dev only: jump the front deck to just short of the seam. The real one is 379
   * seconds into a session, so this is the only way the crossfade gets looked at.
   */
  loopNow(): boolean {
    if (!this.decks) return false;
    const front = this.decks[this.front];
    if (!Number.isFinite(front.el.duration)) return false;
    // Warm the other deck first: `swap` will not fire until it is buffered.
    const back = this.decks[this.front === 0 ? 1 : 0];
    if (!back.el.src) {
      back.el.preload = 'auto';
      back.el.src = TRACK;
    }
    front.el.currentTime = front.el.duration - (FADE + GUARD + 0.2);
    return true;
  }
}

function ramp(node: GainNode, curve: Float32Array, at: number): void {
  // setValueCurveAtTime throws if two curves overlap. Ours are 379 seconds
  // apart and `parkAt` guards the swap, but the cancel is one line of insurance.
  node.gain.cancelScheduledValues(at);
  node.gain.setValueCurveAtTime(curve, at, FADE);
}
