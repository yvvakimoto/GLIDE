/**
 * The upper half: the text being typed, and the fingering drawn onto it.
 *
 * Characters are individual spans grouped into per-word inline-blocks so words
 * never break mid-wrap. Two layers sit on top of them:
 *
 * - a finger tint on the look-ahead run, the same colours the ribbon uses;
 * - a **finger mark** over each upcoming character: a four-tick comb whose tick
 *   heights trace index / middle / ring / pinky, mirrored per hand, with the one
 *   you need lit. Colour is the weakest channel there is for nine categories, and
 *   it is the only one the text carried before; a hand shape needs no code to be
 *   memorised first, which is the whole point of putting it here rather than in
 *   the schematics at the far corners of the board.
 *
 * Marks live in their own absolutely-positioned layer, placed from the spans'
 * offsets exactly as the caret is. They therefore add no line box, so the three
 * visible lines stay three visible lines.
 */

import { CharState, type PressCue } from '../core/engine';
import { FINGER_COLOR, fingerSlot } from '../core/keyboard-geometry';

/**
 * Characters rendered around the cursor. The window is *grown and trimmed*, not
 * re-cut: see `sync`.
 */
const WINDOW_BEFORE = 240;
const WINDOW_AFTER = 620;
/** grow the tail once the window holds less than this much look-ahead */
const REWINDOW_MARGIN = 160;
/** lines kept above the cursor before whole lines are dropped off the top */
const KEEP_LINES = 4;

/** characters that keep a latin word in one unbreakable group */
const WORD_CHAR = /[A-Za-z0-9'-]/;

/** lookahead maxes out at 10, and a run of holds cannot outnumber the presses */
const MARK_POOL = 12;

const STATE_CLASS = ['', 'ok', 'bad', 'fixed'] as const;

export type TextViewOptions = {
  /** the cursor is held at this character because it was just missed */
  blocked: boolean;
  /** settings.lookahead, so the fade ramp keeps its shape as units are consumed */
  lookahead: number;
  fingerColors: boolean;
  fingerMarks: boolean;
  /** false outside a run, when there is nothing to look ahead to */
  live: boolean;
};

export class TextView {
  private track: HTMLElement;
  private caret: HTMLElement;
  private markLayer: HTMLElement;
  private marks: HTMLElement[] = [];
  private spans: HTMLElement[] = [];
  private start = 0;
  private end = 0;
  /** exactly the characters in the DOM, so a changed buffer is recognised */
  private rendered = '';
  /** the last word group, when it ended mid-word and an append must continue it */
  private openGroup: HTMLElement | null = null;
  /** the next layout must not be animated: everything moved by the same amount */
  private snap = false;
  private renderedStates: number[] = [];
  private tinted: number[] = [];
  private lineHeight = 0;
  private fontSize = 0;
  private measuredEpoch = -1;
  private lastCursor = -1;
  private stuckAt: number | null = null;
  private lastBlocked = false;
  private lastPlan = '';
  private lastTint = '';
  /**
   * Bumped whenever the geometry underneath the overlays changes — a rebuild, or
   * a resize, which rewraps the text. Without it both the marks and the caret go
   * stale until the next keystroke.
   */
  private geomEpoch = 0;
  private laidOut = -1;

  constructor(private viewport: HTMLElement) {
    this.track = document.createElement('div');
    this.track.className = 'text-track';

    this.markLayer = document.createElement('div');
    this.markLayer.className = 'mark-layer';
    for (let i = 0; i < MARK_POOL; i++) {
      const mark = document.createElement('i');
      mark.className = 'fmark';
      mark.hidden = true;
      // four ticks: index, middle, ring, pinky, reversed by CSS for the left hand
      for (let k = 0; k < 4; k++) mark.appendChild(document.createElement('b'));
      this.markLayer.appendChild(mark);
      this.marks.push(mark);
    }

    this.caret = document.createElement('span');
    this.caret.className = 'caret';
    this.viewport.replaceChildren(this.track);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        this.geomEpoch++;
      }).observe(this.viewport);
    }
  }

  /**
   * Brings the rendered window in line with the buffer. Call whenever the text
   * changes; `update` calls it every frame.
   *
   * The window is grown and trimmed, never re-cut. The runner tops its buffer up
   * several times a run, and re-cutting the window around the cursor on each
   * top-up started the render at a different character, so every line wrapped
   * somewhere new: the whole panel jumped while the text under the cursor had
   * not changed at all, which reads as the run resetting itself. Growth is
   * invisible instead — characters are only ever appended after the last line,
   * and only *whole lines* are dropped off the top, so nothing still on screen
   * is ever re-wrapped. A full rebuild is left for when the buffer really is
   * different text: a reset, or a new source.
   */
  sync(text: string, cursor: number): void {
    if (
      this.spans.length === 0 ||
      cursor < this.start ||
      cursor > this.end ||
      text.slice(this.start, this.end) !== this.rendered
    ) {
      this.rebuild(text, cursor);
      return;
    }
    this.grow(text, cursor);
    this.trim(cursor);
  }

  /** Renders the window from scratch around the cursor. */
  private rebuild(text: string, cursor: number): void {
    let from = Math.max(0, cursor - WINDOW_BEFORE);
    while (from > 0 && text[from - 1] !== ' ') from--;
    const to = groupEnd(text, Math.min(text.length, cursor + WINDOW_AFTER));

    this.start = from;
    this.end = from;
    this.rendered = '';
    this.spans = [];
    this.renderedStates = [];
    this.tinted = [];
    this.openGroup = null;

    const frag = document.createDocumentFragment();
    this.appendRange(text, from, to, frag);
    this.track.replaceChildren(frag);
    this.track.appendChild(this.markLayer);
    this.track.appendChild(this.caret);
    this.lineHeight = 0;
    this.lastCursor = -1;
    this.lastBlocked = false;
    this.lastPlan = '';
    this.lastTint = '';
    this.stuckAt = null;
    this.geomEpoch++;
    this.snap = true;
  }

  /**
   * Renders `text[from..to)` into word groups on `into`, and takes over the
   * bookkeeping for them.
   *
   * Latin words must not break mid-word, so they stay in one inline-block.
   * Japanese has no spaces, so every non-latin character ends a group and the
   * line can wrap almost anywhere, as it should. A group left open at the tail is
   * carried over, so a later append continues that word rather than starting a
   * second group the line could break between.
   */
  private appendRange(text: string, from: number, to: number, into: Node): void {
    let word = this.openGroup;
    for (let i = from; i < to; i++) {
      if (!word) {
        word = document.createElement('span');
        word.className = 'word';
      }
      const ch = text[i]!;
      const span = document.createElement('span');
      span.className = 'ch';
      if (ch === ' ') {
        span.classList.add('space');
        span.textContent = ' ';
      } else {
        span.textContent = ch;
      }
      word.appendChild(span);
      this.spans.push(span);
      this.renderedStates.push(-1);
      if (!WORD_CHAR.test(ch)) {
        // an open group is already in the track; only a new one needs placing
        if (!word.parentNode) into.appendChild(word);
        word = null;
      }
    }
    if (word && !word.parentNode) into.appendChild(word);
    this.openGroup = word;
    this.rendered += text.slice(from, to);
    this.end = to;
  }

  /**
   * Appends what the look-ahead now needs. Nothing already laid out can move:
   * new characters can only extend the last line and the ones after it.
   */
  private grow(text: string, cursor: number): void {
    if (this.end >= text.length || this.end - cursor >= REWINDOW_MARGIN) return;
    const to = groupEnd(text, Math.min(text.length, cursor + WINDOW_AFTER));
    if (to <= this.end) return;
    const frag = document.createDocumentFragment();
    this.appendRange(text, this.end, to, frag);
    this.track.insertBefore(frag, this.markLayer);
  }

  /**
   * Drops whole lines off the top once they are well behind the cursor.
   *
   * Whole lines only: what remains starts exactly where a line started, so it
   * wraps exactly as it did. Every offset below moves up by the lines removed and
   * the track's own transform moves with them, so the trim cancels itself out on
   * screen — provided neither is animated, which is what `snap` is for.
   */
  private trim(cursor: number): void {
    if (cursor === this.lastCursor) return;
    if (this.spans.length <= WINDOW_BEFORE + WINDOW_AFTER) return;
    this.measure();
    const head = this.spans[cursor - this.start];
    if (!head || !this.lineHeight) return;
    const limit = head.offsetTop - KEEP_LINES * this.lineHeight;
    if (limit <= 0) return;

    const doomed: HTMLElement[] = [];
    let drop = 0;
    for (const node of this.track.children) {
      if (node === this.markLayer) break;
      const group = node as HTMLElement;
      // the whole group must clear the limit: a word longer than a line wraps
      // inside its own box, and half of it is not a line boundary
      if (group.offsetTop + group.offsetHeight > limit) break;
      doomed.push(group);
      drop += group.childElementCount;
    }
    if (drop === 0) return;

    for (const group of doomed) group.remove();
    this.spans.splice(0, drop);
    this.renderedStates.splice(0, drop);
    this.rendered = this.rendered.slice(drop);
    this.start += drop;
    this.geomEpoch++;
    this.snap = true;
  }

  /**
   * Cheap per-frame update: state classes, look-ahead tint, finger marks, caret.
   *
   * `opts.blocked` means the cursor is being held at this character because it
   * was just missed; nothing was inserted, so the character itself is marked.
   */
  update(
    text: string,
    states: readonly number[],
    cursor: number,
    cues: readonly PressCue[],
    opts: TextViewOptions,
  ): void {
    this.sync(text, cursor);

    // A trim or a rebuild moved every offset under the overlays by the same
    // amount, and the track's transform moves with them; animating either would
    // turn an invisible bookkeeping step into a visible slide.
    const snap = this.snap;
    this.snap = false;
    if (snap) this.track.classList.add('snap');

    if (this.stuckAt !== null && (!opts.blocked || this.stuckAt !== cursor)) {
      this.spans[this.stuckAt - this.start]?.classList.remove('stuck');
      this.stuckAt = null;
    }
    if (opts.blocked && this.stuckAt === null) {
      const span = this.spans[cursor - this.start];
      if (span) {
        span.classList.add('stuck');
        this.stuckAt = cursor;
      }
    }

    for (let i = 0; i < this.spans.length; i++) {
      const state = states[this.start + i] ?? CharState.Pending;
      if (this.renderedStates[i] === state) continue;
      const span = this.spans[i]!;
      span.classList.remove('ok', 'bad', 'fixed');
      const cls = STATE_CLASS[state];
      if (cls) span.classList.add(cls);
      this.renderedStates[i] = state;
    }

    // One cue per unit: the press that unit still needs next. A three-press kana
    // contributes one mark and one tint, and both name the press due now.
    const leads = opts.live ? cues.filter((cue) => cue.slot === 0) : [];
    const span = Math.max(1, opts.lookahead);

    // Finger tint on the look-ahead run. Like the marks below, this only moves
    // on a keystroke, and it used to clear and rewrite an inline colour, an
    // inline opacity and a class on every look-ahead span every frame — leaving
    // the document style-dirty for the canvas sizing to trip over.
    // `blocked` is in the signature because a mistype marks the character under
    // the cursor without moving the plan, and a character that is no longer
    // pending must lose its tint.
    let tint = `${this.start}|${cursor}|${opts.blocked}|${opts.fingerColors}|${span}`;
    for (const cue of leads) tint += `|${cue.index}.${cue.span}.${cue.at}${cue.finger}`;
    if (tint !== this.lastTint || this.geomEpoch !== this.laidOut) {
      this.lastTint = tint;
      for (const index of this.tinted) {
        const node = this.spans[index - this.start];
        if (node) {
          node.style.color = '';
          node.style.opacity = '';
          node.classList.remove('lead');
        }
      }
      this.tinted = [];
      for (const cue of leads) {
        const ramp = (1 - cue.at / span) ** 1.3;
        for (let i = cue.index; i < cue.index + cue.span; i++) {
          const node = this.spans[i - this.start];
          if (!node || states[i] !== CharState.Pending) continue;
          if (opts.fingerColors) node.style.color = FINGER_COLOR[cue.finger];
          node.style.opacity = String(0.45 + 0.55 * ramp);
          node.classList.add('lead');
          this.tinted.push(i);
        }
      }
    }

    this.layoutMarks(opts.fingerMarks ? leads : [], opts);

    if (
      cursor !== this.lastCursor ||
      opts.blocked !== this.lastBlocked ||
      this.geomEpoch !== this.laidOut
    ) {
      this.lastCursor = cursor;
      this.lastBlocked = opts.blocked;
      this.moveCaret(cursor, opts.blocked);
    }
    this.laidOut = this.geomEpoch;

    if (snap) {
      // flush the un-animated values before the transitions come back
      void this.track.offsetHeight;
      this.track.classList.remove('snap');
    }
  }

  /**
   * Places the marks. The plan only changes on a keystroke, so the signature
   * check skips the geometry reads on the ~59 frames out of 60 where nothing has
   * moved; a resize forces the pass through `geomEpoch`.
   */
  private layoutMarks(leads: readonly PressCue[], opts: TextViewOptions): void {
    let plan = String(opts.fingerColors);
    for (const cue of leads) {
      plan += `|${cue.index}.${cue.at}${cue.finger}${cue.thumb}${cue.shift ? 'S' : ''}`;
    }
    if (plan === this.lastPlan && this.geomEpoch === this.laidOut) return;
    this.lastPlan = plan;

    this.measure();
    // Height is the free dimension and the one that carries the finger, so the
    // comb is taller than it is wide, like the hand it stands for. Width is
    // capped by the character cell further down: two marks must never touch, and
    // a latin cell at the smallest font size is only twelve pixels across.
    const size = Math.max(9, this.fontSize * 0.42);
    const nominal = Math.max(10, this.fontSize * 0.55);
    const trackWidth = this.track.clientWidth;
    const ramp = Math.max(1, opts.lookahead);

    // read every offset first, then write: one layout flush for the whole pass
    const boxes = leads.map((cue) => {
      const head = this.spans[cue.index - this.start];
      if (!head) return undefined;
      const tail = this.spans[cue.index + cue.span - 1 - this.start] ?? head;
      const wrapped = tail.offsetTop !== head.offsetTop;
      return {
        left: head.offsetLeft,
        top: head.offsetTop,
        // a unit that wrapped mid-way anchors on its first character alone
        width: wrapped ? head.offsetWidth : tail.offsetLeft + tail.offsetWidth - head.offsetLeft,
      };
    });

    leads.forEach((cue, i) => {
      const mark = this.marks[i];
      const box = boxes[i];
      if (!mark) return;
      if (!box) {
        mark.hidden = true;
        return;
      }
      // A kana cell has room to spare; a latin one at the smallest font size has
      // none, so the comb shrinks to fit rather than smearing into its neighbour.
      const width = Math.min((box.width / cue.span) * 0.92, nominal);
      // The press due now is drawn larger, but only as much larger as its own
      // cell allows.
      const scale = cue.at === 0 ? Math.min(1.3, Math.max(1, (box.width * 1.12) / width)) : 1;
      const w = width * scale;
      const h = size * scale;
      const x = Math.min(Math.max(0, box.left + (box.width - w) / 2), Math.max(0, trackWidth - w));
      const y = box.top - h - this.fontSize * 0.05;
      const fade = (1 - cue.at / ramp) ** 1.3;

      mark.hidden = false;
      mark.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      mark.style.setProperty('--fm-w', `${w}px`);
      mark.style.setProperty('--fm-h', `${h}px`);
      mark.style.setProperty('--fm-a', String(0.5 + 0.5 * fade));
      mark.style.setProperty('--fm-color', opts.fingerColors ? FINGER_COLOR[cue.finger] : '');
      mark.dataset.hand = cue.hand;
      mark.dataset.slot = cue.finger === 'thumb' ? 'thumb' : String(fingerSlot(cue.finger));
      const hold = cue.thumb !== 'none' ? cue.thumb : cue.shift ? 'shift' : '';
      if (hold) mark.dataset.hold = hold;
      else delete mark.dataset.hold;
      mark.classList.toggle('now', cue.at === 0);
    });

    for (let i = leads.length; i < this.marks.length; i++) this.marks[i]!.hidden = true;
  }

  /**
   * Line height comes from the computed style, not from a span's `offsetHeight`:
   * an inline box reports its own content box, not the line box, and the marks
   * are placed against the line to within a pixel. Re-measured whenever the
   * geometry changes, because `--font-size` is a `clamp` on the viewport width.
   */
  private measure(): void {
    if (this.measuredEpoch === this.geomEpoch && this.lineHeight) return;
    const style = getComputedStyle(this.viewport);
    this.fontSize = parseFloat(style.fontSize) || 16;
    this.lineHeight = parseFloat(style.lineHeight) || this.fontSize * 1.85;
    this.measuredEpoch = this.geomEpoch;
  }

  private moveCaret(cursor: number, blocked = false): void {
    const span = this.spans[cursor - this.start] ?? this.spans[this.spans.length - 1];
    if (!span) return;
    this.measure();

    this.caret.style.transform = `translate(${span.offsetLeft}px, ${span.offsetTop}px)`;
    // the character's own box, not the line box, so the bar keeps its proportions
    this.caret.style.height = `${span.offsetHeight || this.lineHeight}px`;
    this.caret.classList.toggle('stuck', blocked);

    // `offsetTop` is measured from the track's border edge, so it counts the
    // blank line of padding: the cursor's line is line 1 at the very start of a
    // passage and never line 0, whose mark band would fall in the viewport's top
    // mask fade. That is exactly the headroom the padding buys.
    const line = Math.round(span.offsetTop / Math.max(1, this.lineHeight));
    this.track.style.transform = `translateY(${-(line - 1) * this.lineHeight}px)`;
  }
}

/**
 * Extends `to` past the end of the word it lands in, so the window always ends
 * on a group boundary and the next append cannot split that word in two.
 */
function groupEnd(text: string, to: number): number {
  while (to > 0 && to < text.length && WORD_CHAR.test(text[to - 1]!)) to++;
  return to;
}
