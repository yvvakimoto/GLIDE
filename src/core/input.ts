/**
 * Keyboard events in, presses out.
 *
 * For latin and romaji a keydown is a press and that is the end of it. Kana
 * layouts need *simultaneous* detection, which is where the interesting part is.
 *
 * The window is not a fixed number of milliseconds but a proportion of the
 * character key's own press: take the moment the character key goes down as 0
 * and the moment it is released — or another key is pressed — as 100, and a
 * thumb inside the first N% of that span counts as simultaneous.
 *
 * So with the window at 50%, a thumb key that arrives within the first half of
 * however long you happen to hold the character key counts as simultaneous. The
 * nice property is that it scales with the typist: fast hands hold keys briefly,
 * so the window shrinks with them.
 *
 * Because the end of that span is in the future, a character key pressed with no
 * thumb held has to be *deferred* until the character key is released or another
 * key is pressed. That is a handful of milliseconds of real typing, and the
 * keystroke is timestamped when it went down, so nothing about the measured
 * speed changes. A character pressed while a thumb is already held resolves
 * immediately — which is the common case once the motion is learned.
 */

import { charIndex, type LayoutId } from './layouts';
import type { Thumb } from './kana-layouts';
import type { MethodKind } from './method';
import type { InputMode } from './settings';

export type Press = {
  code: string;
  shift: boolean;
  thumb: Thumb;
  /** when the character key went down, so deferral cannot skew the timing */
  at: number;
};

export type InputEvent = { kind: 'press'; press: Press } | { kind: 'backspace' };

export type ThumbConfig = {
  /** physical key code for each thumb-shift role */
  left: string;
  right: string;
  /**
   * Share of the character key's press span in which a thumb still counts as
   * simultaneous, in percent. The default is 50; 100 accepts a thumb any time
   * before the key is released.
   */
  percent: number;
  /** 連続シフト: one thumb press may shift a run of characters, not just one */
  continuous: boolean;
};

export type RouterOptions = {
  kind: MethodKind;
  layout: LayoutId;
  mode: InputMode;
  thumbs: ThumbConfig;
};

const IGNORED_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Enter', 'Tab', 'Escape',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete', 'ContextMenu', 'NumLock', 'ScrollLock', 'Pause', 'PrintScreen',
  'Convert', 'NonConvert', 'KanaMode', 'HiraganaKatakana', 'Process', 'Dead',
]);

const FUNCTION_KEY = /^F\d{1,2}$/;

/** A held character key cannot defer forever; real typing never gets near this. */
const MAX_DEFER_MS = 500;

type Held = { at: number; consumed: boolean };
type Pending = { code: string; at: number; thumb?: { role: Exclude<Thumb, 'none'>; at: number } };

export type RouterResult = { consumed: boolean; events: InputEvent[] };

const NOTHING: RouterResult = { consumed: false, events: [] };

export class InputRouter {
  private opts: RouterOptions;
  private held = new Map<Exclude<Thumb, 'none'>, Held>();
  private pending: Pending | undefined;

  constructor(opts: RouterOptions) {
    this.opts = opts;
  }

  configure(opts: RouterOptions): void {
    const changed =
      opts.kind !== this.opts.kind ||
      opts.thumbs.left !== this.opts.thumbs.left ||
      opts.thumbs.right !== this.opts.thumbs.right;
    this.opts = opts;
    if (changed) this.reset();
  }

  reset(): void {
    this.held.clear();
    this.pending = undefined;
  }

  /** Which thumb role a code plays, if any. Only kana layouts have thumb roles. */
  private roleOf(code: string): Exclude<Thumb, 'none'> | undefined {
    if (this.opts.kind !== 'kana') return undefined;
    if (code === this.opts.thumbs.left) return 'left';
    if (code === this.opts.thumbs.right) return 'right';
    return undefined;
  }

  /** The thumb role available to shift a character right now. */
  private availableThumb(): { role: Exclude<Thumb, 'none'>; at: number } | undefined {
    for (const role of ['left', 'right'] as const) {
      const state = this.held.get(role);
      if (!state) continue;
      if (!this.opts.thumbs.continuous && state.consumed) continue;
      return { role, at: state.at };
    }
    return undefined;
  }

  keydown(event: KeyboardEvent, now: number): RouterResult {
    if (event.ctrlKey || event.metaKey) return NOTHING;

    const role = this.roleOf(event.code);
    if (role) {
      if (!this.held.has(role)) this.held.set(role, { at: now, consumed: false });
      // a thumb arriving mid-press is what the window is about
      if (this.pending && !this.pending.thumb) this.pending.thumb = { role, at: now };
      return { consumed: true, events: [] };
    }

    if (event.key === 'Backspace') {
      // a pending character settles before the correction lands
      const events = this.flush(now);
      events.push({ kind: 'backspace' });
      return { consumed: true, events };
    }

    if (IGNORED_KEYS.has(event.key) || FUNCTION_KEY.test(event.key)) return NOTHING;
    if (this.opts.kind !== 'kana' && event.altKey) return NOTHING;

    if (this.opts.kind === 'kana') {
      if (!event.code) return NOTHING;
      // pressing another key ends the previous character's span
      const events = this.flush(now);
      const thumb = this.availableThumb();
      if (thumb) {
        this.consume(thumb.role);
        events.push({ kind: 'press', press: { code: event.code, shift: false, thumb: thumb.role, at: now } });
      } else {
        this.pending = { code: event.code, at: now };
      }
      return { consumed: true, events };
    }

    const press = this.latinPress(event, now);
    if (!press) return NOTHING;
    return { consumed: true, events: [{ kind: 'press', press }] };
  }

  keyup(event: KeyboardEvent, now: number): RouterResult {
    const role = this.roleOf(event.code);
    if (role) {
      this.held.delete(role);
      return { consumed: true, events: [] };
    }
    // releasing the character key ends its span, which decides the thumb question
    if (this.pending?.code === event.code) {
      return { consumed: true, events: this.flush(now) };
    }
    return NOTHING;
  }

  /** Flushes a press whose span has run long enough to stop waiting. */
  tick(now: number): InputEvent[] {
    if (this.pending && now - this.pending.at >= MAX_DEFER_MS) return this.flush(now);
    return [];
  }

  /** True while a character is waiting on the simultaneous-press window. */
  get deferring(): boolean {
    return this.pending !== undefined;
  }

  private flush(spanEnd: number): InputEvent[] {
    const pending = this.pending;
    if (!pending) return [];
    this.pending = undefined;

    const span = Math.max(1, spanEnd - pending.at);
    const window = (span * Math.min(100, Math.max(0, this.opts.thumbs.percent))) / 100;
    const thumb = pending.thumb && pending.thumb.at - pending.at <= window ? pending.thumb.role : 'none';
    if (thumb !== 'none') this.consume(thumb);

    return [{ kind: 'press', press: { code: pending.code, shift: false, thumb, at: pending.at } }];
  }

  private consume(role: Exclude<Thumb, 'none'>): void {
    if (this.opts.thumbs.continuous) return;
    const state = this.held.get(role);
    if (state) state.consumed = true;
  }

  private latinPress(event: KeyboardEvent, now: number): Press | undefined {
    if (this.opts.mode === 'passthrough') {
      if ([...event.key].length !== 1) return undefined;
      const stroke = charIndex(this.opts.layout).get(event.key);
      if (!stroke) return undefined;
      return { code: stroke.key.code, shift: stroke.shift, thumb: 'none', at: now };
    }
    return { code: event.code, shift: event.shiftKey, thumb: 'none', at: now };
  }
}
