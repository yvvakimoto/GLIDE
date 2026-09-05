/**
 * Run state machine: idle -> count-in -> running -> finished.
 *
 * The runner works in *units* rather than characters. A unit is one thing you
 * type: for English that is a character and one keypress, for romaji it is a
 * kana that may take three presses and accept several spellings, for a kana
 * layout it is a kana produced by one key plus maybe a thumb. Character states
 * are still tracked per character, because that is what the text view paints.
 *
 * The runner knows nothing about rendering; views read its public state each
 * frame and react to the callbacks.
 */

import { createStream, sourceScript, type Attribution, type Passage, type TextStream } from './corpus';
import { handOf, keySide, physKey, type Finger } from './keyboard-geometry';
import { InputRouter, type Press } from './input';
import type { InputEvent } from './input';
import {
  buildUnits,
  chordEquals,
  labelOfPress,
  methodKind,
  type Chord,
  type MethodSpec,
  type Unit,
} from './method';
import type { Settings } from './settings';
import { Stats, type Keystroke, type Summary } from './stats';

export type Phase = 'idle' | 'countin' | 'running' | 'finished';

/** Per-character render state. `Fixed` means it was wrong once, then corrected. */
export const CharState = { Pending: 0, Correct: 1, Error: 2, Fixed: 3 } as const;
export type CharState = (typeof CharState)[keyof typeof CharState];

/**
 * How a run ended. 'end' is an ordered source running out — a work finished,
 * rather than a clock or a keypress finishing it.
 */
export type EndReason = 'time' | 'quit' | 'end' | null;

export type KeystrokeEvent = {
  index: number;
  expected: string;
  typed: string;
  correct: boolean;
  code: string;
  finger: Finger;
  shift: boolean;
};

/**
 * One upcoming press, pinned to the text it produces.
 *
 * A cue names the *unit* rather than a character of its own: `index` is the
 * unit's first character and `span` how many characters it covers, so a view can
 * anchor a mark on a kana without knowing anything about kana. `slot` is where
 * this press falls in what the unit still needs, and `at` where it falls in the
 * whole look-ahead — 0 is the press due now.
 */
export type PressCue = {
  /** first character of the unit this press belongs to */
  index: number;
  /** characters the unit covers: 1 for latin and for a kana-layout kana, 2 for きゃ */
  span: number;
  /** position among the presses this unit still needs; 0 is the unit's next */
  slot: number;
  /** position in the whole upcoming press order; 0 is the press due now */
  at: number;
  finger: Finger;
  /**
   * Which hand makes the press. Every finger but the thumb names its own hand; a
   * thumb belongs to whichever side owns the thumb-shift, and otherwise to the
   * side the hand came from, which is how the ribbon aims at the space bar.
   */
  hand: 'left' | 'right';
  /** a Shift must be held — the one on the other hand, as the ribbon draws it */
  shift: boolean;
  /** which thumb-shift must be held; `'none'` for a plain press */
  thumb: Chord['thumb'];
  /** what this press produces */
  label: string;
};

const COUNT_IN_STEP_MS = 600;
const COUNT_IN_STEPS = 3;
/** keep this much text queued ahead of the cursor */
const BUFFER_AHEAD = 700;

type Segment = { start: number; end: number; attribution: Attribution; at?: Passage['at'] };

export class Runner {
  phase: Phase = 'idle';
  text = '';
  states: number[] = [];
  /** character index of the unit being typed */
  cursor = 0;
  stats: Stats;
  endReason: EndReason = null;
  /** true while the cursor is held at a character that was just missed */
  blocked = false;
  /** the character the last wrong press produced, for the flash and the report */
  mistyped: string | undefined;
  /** true once an ordered source has no more text to give */
  exhausted = false;

  onPhase?: (phase: Phase, previous: Phase) => void;
  onKeystroke?: (event: KeystrokeEvent) => void;
  onTextChange?: () => void;

  private settings: Settings;
  private spec: MethodSpec;
  private router: InputRouter;
  private stream: TextStream;
  private segments: Segment[] = [];
  /**
   * Where the last segment lookup landed. `attribution` used to rescan the list
   * from the front every frame, which is fine for a one-minute sprint and not
   * for a work typed straight through, where the buffer grows all session and
   * `mark` would scan it a second time.
   */
  private segAt = 0;
  private units: Unit[] = [];
  private unitIndex = 0;
  private typed: Chord[] = [];
  private viable: number[] = [];
  private absorb: Chord | undefined;
  private stumbleUnit = -1;
  /** the last key struck, which is what decides the side of a following space */
  private lastCode: string | undefined;
  private phaseStartedAt = 0;
  private runStartedAt = 0;
  private runEndedAt = 0;
  private now = 0;

  constructor(settings: Settings) {
    this.settings = settings;
    this.spec = specOf(settings);
    this.router = new InputRouter(routerOptions(settings, this.spec));
    this.stream = createStream(settings.source, settings.layout);
    this.stats = new Stats(settings.maWindow);
    this.reset();
  }

  /** Applies new settings; rebuilds the text if anything about the typing changed. */
  configure(settings: Settings): void {
    const before = this.spec;
    const next = specOf(settings);
    const rebuild =
      settings.source !== this.settings.source ||
      next.script !== before.script ||
      next.latin !== before.latin ||
      next.ja !== before.ja;

    this.settings = settings;
    this.spec = next;
    this.router.configure(routerOptions(settings, next));
    this.stats.setMaWindow(settings.maWindow);
    if (rebuild) {
      this.stream = createStream(settings.source, settings.layout);
      this.reset();
    }
  }

  get activeSettings(): Settings {
    return this.settings;
  }

  get method(): MethodSpec {
    return this.spec;
  }

  reset(): void {
    this.text = '';
    this.states = [];
    this.segments = [];
    this.units = [];
    this.unitIndex = 0;
    this.cursor = 0;
    this.typed = [];
    this.viable = [];
    this.absorb = undefined;
    this.stumbleUnit = -1;
    this.lastCode = undefined;
    this.blocked = false;
    this.mistyped = undefined;
    this.endReason = null;
    this.exhausted = false;
    this.segAt = 0;
    this.router.reset();
    this.stats = new Stats(this.settings.maWindow);
    this.fill();
    this.enterUnit();
    this.setPhase('idle');
    this.onTextChange?.();
  }

  /** Space from idle/finished: count in, then run. */
  beginCountIn(now: number): void {
    if (this.phase === 'running' || this.phase === 'countin') return;
    if (this.phase === 'finished') this.reset();
    this.phaseStartedAt = now;
    this.setPhase('countin');
  }

  startNow(now: number): void {
    if (this.phase === 'running') return;
    this.runStartedAt = now;
    this.phaseStartedAt = now;
    this.setPhase('running');
  }

  abort(now: number): void {
    if (this.phase === 'countin') {
      this.setPhase('idle');
      return;
    }
    if (this.phase !== 'running') return;
    this.runEndedAt = now;
    this.endReason = 'quit';
    this.setPhase('finished');
  }

  private complete(now: number, reason: Exclude<EndReason, null> = 'time'): void {
    this.runEndedAt = now;
    this.endReason = reason;
    this.setPhase('finished');
  }

  /** Drives count-in and the time limit; call once per frame. */
  tick(now: number): void {
    this.now = now;
    if (this.phase === 'countin') {
      if (now - this.phaseStartedAt >= COUNT_IN_STEP_MS * COUNT_IN_STEPS) this.startNow(now);
      return;
    }
    if (this.phase !== 'running') return;
    // a character held long enough stops waiting on its thumb window
    for (const event of this.router.tick(now)) this.apply(event);
    this.stats.sample(this.elapsedMs);
    const limit = this.settings.duration * 1000;
    if (limit > 0 && this.elapsedMs >= limit) this.complete(now);
  }

  /** 3, 2, 1 — the number to paint during the count-in. */
  get countInNumber(): number {
    const step = Math.floor((this.now - this.phaseStartedAt) / COUNT_IN_STEP_MS);
    return Math.max(1, COUNT_IN_STEPS - step);
  }

  /**
   * 3, 2, 1 — the run's own ending, announced while it is still being typed.
   * 0 means paint nothing: an untimed run has no ending to announce, and the
   * phase test is what wipes the number the instant the run stops.
   */
  get countOutNumber(): number {
    const remaining = this.remainingMs;
    if (this.phase !== 'running' || remaining === null) return 0;
    const n = Math.ceil(remaining / 1000);
    return n >= 1 && n <= COUNT_IN_STEPS ? n : 0;
  }

  get elapsedMs(): number {
    if (this.phase === 'finished') return Math.max(0, this.runEndedAt - this.runStartedAt);
    if (this.phase !== 'running') return 0;
    return Math.max(0, this.now - this.runStartedAt);
  }

  get remainingMs(): number | null {
    const limit = this.settings.duration * 1000;
    if (limit <= 0) return null;
    return Math.max(0, limit - this.elapsedMs);
  }

  /** 0..1 through the time limit, or through the work when there is no limit. */
  get progress(): number {
    const limit = this.settings.duration * 1000;
    if (limit > 0) return Math.min(1, this.elapsedMs / limit);
    // `cursor / text.length` sawtooths on an endless source, because `fill`
    // extends the denominator as fast as typing moves the numerator. An ordered
    // work does have an end, and that is the number worth showing.
    const mark = this.mark;
    return mark ? Math.min(1, mark.chars / Math.max(1, mark.total)) : 0;
  }

  /**
   * The segment holding the cursor. The cursor only moves backwards on a
   * backspace, so walking from where the last lookup landed is O(1) in practice.
   */
  private segment(): Segment | undefined {
    while (this.segAt > 0 && this.cursor < this.segments[this.segAt]!.start) this.segAt--;
    while (this.segAt < this.segments.length - 1 && this.cursor >= this.segments[this.segAt]!.end) {
      this.segAt++;
    }
    return this.segments[this.segAt];
  }

  get attribution(): Attribution | undefined {
    return this.segment()?.attribution;
  }

  /**
   * Ordered sources only: where the cursor sits in the work. `offset` is
   * characters into the current *chunk*, not into the segment — a run resumed
   * part-way in has a first segment that starts inside its chunk, and a
   * bookmark written from a segment-relative offset would creep backwards a
   * sentence every time it was resumed.
   */
  get mark(): { chunk: number; offset: number; chars: number; total: number } | undefined {
    const total = this.stream.total;
    if (total === undefined) return undefined;
    const seg = this.segment();
    if (!seg?.at) return undefined;
    const into = this.cursor - seg.start;
    return { chunk: seg.at.chunk, offset: seg.at.offset + into, chars: seg.at.chars + into, total };
  }

  /**
   * Ordered sources: rebuild the buffer starting at `chunk`, `offset`
   * characters into it. A shuffle has no seek, so this is a plain reset for one
   * — deliberately, because re-shuffling the bag on every restart is the thing
   * the bag exists to avoid.
   */
  seek(chunk: number, offset = 0): void {
    this.stream.seek?.(chunk, offset);
    this.reset();
  }

  /**
   * Units completed — kana for Japanese, characters for English.
   *
   * Not a speed numerator: romaji folds きゃ into one unit while a kana layout
   * types it as two keys, so unit counts do not compare across methods.
   * Characters do, and that is what `Stats.producedChars` counts.
   */
  get unitsDone(): number {
    return this.unitIndex;
  }

  /**
   * The next `count` presses, starting with the one due now. The current unit
   * contributes whatever is left of its preferred spelling.
   */
  expectedChords(count: number): Chord[] {
    const out: Chord[] = [];
    if (count <= 0) return out;

    const current = this.units[this.unitIndex];
    const preferred = current?.sequences[this.viable[0] ?? 0];
    if (preferred) {
      for (let i = this.typed.length; i < preferred.length && out.length < count; i++) {
        out.push(preferred[i]!);
      }
    }
    for (let u = this.unitIndex + 1; u < this.units.length && out.length < count; u++) {
      for (const chord of this.units[u]!.sequences[0] ?? []) {
        if (out.length >= count) break;
        out.push(chord);
      }
    }
    return out;
  }

  /**
   * The next `count` presses, each pinned to the text it produces — the same walk
   * as `expectedChords`, in the shape the text panel needs to draw fingering on
   * the characters themselves.
   *
   * It answers per *press*, not per character. The old per-character plan could
   * tell only one truth per unit, so romaji きゃ — three presses on three fingers
   * — was reported entirely as the finger that starts it, and stayed that way
   * even after you had typed the k. Presses already made are left out, so a
   * half-typed きゃ advertises y and a and never k again.
   */
  cuePlan(count: number): PressCue[] {
    const plan: PressCue[] = [];
    if (count <= 0) return plan;

    // The space bar is hit by whichever thumb the hand came from, exactly as the
    // ribbon aims at it (see `spaceTargetX`), so the walk carries the previous key.
    let prevCode = this.lastCode;
    let at = 0;

    for (let u = this.unitIndex; u < this.units.length && at < count; u++) {
      const unit = this.units[u]!;
      const current = u === this.unitIndex;
      const sequence = unit.sequences[current ? this.viable[0] ?? 0 : 0];
      if (!sequence) continue; // nothing on this method types it; step over
      const from = current ? this.typed.length : 0;

      for (let i = from; i < sequence.length && at < count; i++) {
        const chord = sequence[i]!;
        const key = physKey(chord.code);
        const here = at++; // a press the hand must make, whether or not it is drawn
        if (!key) continue;
        const prev = prevCode ? physKey(prevCode) : undefined;
        prevCode = chord.code;
        plan.push({
          index: unit.start,
          span: unit.text.length,
          slot: i - from,
          at: here,
          finger: key.finger,
          hand:
            handOf(key.finger) ??
            (chord.thumb !== 'none' ? chord.thumb : prev ? keySide(prev) : 'right'),
          shift: chord.shift,
          thumb: chord.thumb,
          label: chord.label,
        });
      }
    }
    return plan;
  }

  summary(labelOf: (code: string) => string): Summary {
    return this.stats.summary(this.elapsedMs, labelOf);
  }

  /**
   * Handles a keydown during count-in or a run. Returns true when the event was
   * consumed (so the caller can preventDefault).
   *
   * A kana press may not resolve here: a character key pressed with no thumb held
   * waits for the simultaneous-press window to close (see `InputRouter`), and
   * arrives on a later keyup, the next keydown, or `tick`.
   */
  handleKeydown(event: KeyboardEvent, now: number): boolean {
    if (this.phase !== 'running' && this.phase !== 'countin') return false;

    const { consumed, events } = this.router.keydown(event, now);
    if (!consumed) return false;

    // impatient start: the first real keystroke cuts the count-in short, but the
    // space that opened the run must not be typed into the text
    if (this.phase === 'countin') {
      if (events.some((e) => e.kind === 'press' && e.press.code === 'Space')) return true;
      if (events.length > 0) this.startNow(now);
    }
    this.now = now;
    for (const input of events) this.apply(input);
    return true;
  }

  /** Releasing a character key closes its simultaneous-press window. */
  handleKeyup(event: KeyboardEvent, now: number): boolean {
    const { consumed, events } = this.router.keyup(event, now);
    if (this.phase === 'running' || this.phase === 'countin') {
      this.now = now;
      for (const input of events) this.apply(input);
    }
    return consumed;
  }

  private apply(input: InputEvent): void {
    if (input.kind === 'backspace') {
      this.backspace();
      return;
    }
    this.press(input.press);
  }

  private press(press: Press): void {
    const unit = this.units[this.unitIndex];
    if (!unit) return;

    const label = labelOfPress(this.spec, press) ?? '';
    const chord: Chord = { ...press, label };
    const absorb = this.absorb;
    this.absorb = undefined;

    const at = this.typed.length;
    const stillViable = this.viable.filter((i) => {
      const sequence = unit.sequences[i];
      return sequence !== undefined && at < sequence.length && chordEquals(sequence[at]!, chord);
    });
    const expected = unit.sequences[this.viable[0] ?? 0]?.[at];

    if (stillViable.length > 0) {
      // Speed is measured in characters, so the press that *finishes* the unit is
      // the one that credits them: romaji きゃ scores 2 on the a and 0 before it.
      const finished = stillViable.find((i) => unit.sequences[i]!.length === at + 1);
      this.record(chord, expected, true, press.at, finished === undefined ? 0 : unit.text.length);
      this.blocked = false;
      this.mistyped = undefined;
      this.typed.push(chord);
      this.viable = stillViable;
      if (finished !== undefined) this.completeUnit(unit, unit.sequences[finished]!.length);
      return;
    }

    // a habitual extra keystroke the previous unit tolerates (the second n of ん)
    if (absorb && chordEquals(absorb, chord)) return;

    // A miss wastes the unit in proportion to the presses it needs, so raw speed
    // charges a fumbled romaji kana a third of itself, not a whole one.
    const needed = unit.sequences[this.viable[0] ?? 0]?.length ?? 1;
    this.record(chord, expected, false, press.at, unit.text.length / needed);
    if (this.settings.errorMode === 'block') {
      // The cursor simply does not move. Nothing is inserted, so there is nothing
      // to delete: the next correct press carries on from here, and the character
      // is marked as a recovery when it lands.
      this.markUnit(this.unitIndex, CharState.Error);
      this.blocked = true;
      this.mistyped = label || '?';
      this.stumbleUnit = this.unitIndex;
    } else {
      this.markUnit(this.unitIndex, CharState.Error);
      this.advance();
    }
  }

  /** `chars` is what the press is worth to the speed figures; see `Keystroke`. */
  private record(
    chord: Chord,
    expected: Chord | undefined,
    correct: boolean,
    at: number,
    chars: number,
  ): void {
    const stroke: Keystroke = {
      // the moment the key went down, so a deferred resolution cannot skew speed
      t: Math.max(0, at - this.runStartedAt),
      expected: expected?.label ?? '',
      typed: chord.label,
      correct,
      code: chord.code,
      finger: physKey(chord.code)?.finger ?? 'thumb',
      shift: chord.shift || chord.thumb !== 'none',
      chars,
    };
    this.stats.push(stroke);
    this.lastCode = chord.code;
    this.onKeystroke?.({
      index: this.cursor,
      expected: stroke.expected,
      typed: stroke.typed,
      correct,
      code: chord.code,
      finger: stroke.finger,
      shift: stroke.shift,
    });
  }

  private completeUnit(unit: Unit, matchedLength: number): void {
    const state = this.unitIndex === this.stumbleUnit ? CharState.Fixed : CharState.Correct;
    this.blocked = false;
    this.mistyped = undefined;
    for (let i = 0; i < unit.text.length; i++) this.states[unit.start + i] = state;
    this.stumbleUnit = -1;
    if (unit.absorb && matchedLength === 1) this.absorb = unit.absorb;
    this.advance();
  }

  private advance(): void {
    this.unitIndex++;
    this.fill();
    this.enterUnit();
    // The work ran out. `enterUnit` empties `viable` and parks the cursor at the
    // end of the text without touching the phase, so without this the runner sits
    // in `running` for ever with every key dead and the clock still going.
    // The phase test matters: `reset` runs this same pair while idle.
    if (this.exhausted && this.unitIndex >= this.units.length && this.phase === 'running') {
      this.complete(this.now, 'end');
    }
  }

  /** Prepares matching state for the unit at `unitIndex`, stepping over untypeable ones. */
  private enterUnit(): void {
    this.typed = [];
    for (;;) {
      const unit = this.units[this.unitIndex];
      if (!unit) {
        this.viable = [];
        this.cursor = this.text.length;
        return;
      }
      if (unit.sequences.length === 0) {
        // nothing can produce this character; step over it rather than deadlock
        for (let i = 0; i < unit.text.length; i++) this.states[unit.start + i] = CharState.Correct;
        this.unitIndex++;
        continue;
      }
      this.viable = unit.sequences.map((_, i) => i);
      this.cursor = unit.start;
      return;
    }
  }

  private backspace(): void {
    // A miss leaves nothing behind, so backspace has one meaning throughout: go
    // back one. Being blocked only clears the marker on the way past.
    if (this.blocked) {
      this.blocked = false;
      this.mistyped = undefined;
      this.markUnit(this.unitIndex, CharState.Pending);
    }

    if (this.typed.length > 0) {
      // step back one press inside the current unit
      this.typed.pop();
      this.recomputeViable();
      this.stats.correction();
      return;
    }

    if (this.unitIndex === 0) return;
    this.unitIndex--;
    this.markUnit(this.unitIndex, CharState.Pending);
    this.enterUnit();
    this.stats.correction();
  }

  private markUnit(index: number, state: CharState): void {
    const unit = this.units[index];
    if (!unit) return;
    for (let i = 0; i < unit.text.length; i++) this.states[unit.start + i] = state;
  }

  private recomputeViable(): void {
    const unit = this.units[this.unitIndex];
    if (!unit) return;
    this.viable = unit.sequences
      .map((_, i) => i)
      .filter((i) => {
        const sequence = unit.sequences[i]!;
        if (sequence.length < this.typed.length) return false;
        return this.typed.every((chord, at) => chordEquals(sequence[at]!, chord));
      });
    if (this.viable.length === 0) {
      this.typed = [];
      this.viable = unit.sequences.map((_, i) => i);
    }
  }

  private setPhase(phase: Phase): void {
    if (phase === this.phase) return;
    const previous = this.phase;
    this.phase = phase;
    this.onPhase?.(phase, previous);
  }

  /** Keeps the buffer topped up so a run never runs out of text. */
  private fill(): void {
    let appended = false;
    while (this.text.length - this.cursor < BUFFER_AHEAD) {
      const passage = this.stream.next();
      // An ordered work has reached its end. This is the only way a stream can
      // say so, and without it the loop spins for ever on one with nothing left.
      if (!passage) {
        this.exhausted = true;
        break;
      }
      const start = this.text.length;
      this.text += passage.text;
      for (let i = start; i < this.text.length; i++) this.states.push(CharState.Pending);
      this.units.push(...buildUnits(passage.text, start, this.spec));
      this.segments.push({ start, end: this.text.length, attribution: passage.attribution, at: passage.at });
      appended = true;
    }
    if (appended) this.onTextChange?.();
  }
}

function specOf(settings: Settings): MethodSpec {
  return {
    script: sourceScript(settings.source),
    latin: settings.layout,
    ja: settings.jaMethod,
    thumbs: { left: settings.thumbLeft, right: settings.thumbRight },
  };
}

function routerOptions(settings: Settings, spec: MethodSpec) {
  const kind = methodKind(spec);
  return {
    kind,
    layout: spec.latin,
    // kana layouts read physical keys; there is no OS layout to pass through to
    mode: kind === 'kana' ? ('remap' as const) : settings.inputMode,
    thumbs: {
      left: settings.thumbLeft,
      right: settings.thumbRight,
      percent: settings.thumbPercent,
      continuous: settings.thumbContinuous,
    },
  };
}
