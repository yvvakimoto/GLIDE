import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CharState, Runner } from '../src/core/engine';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { charIndex } from '../src/core/layouts';
import { BOARD_UNITS_X, FINGER_ORDER } from '../src/core/keyboard-geometry';

/** Minimal stand-in for the fields `resolveInput` reads. */
function keydown(code: string, shift = false, key?: string): KeyboardEvent {
  return {
    code,
    key: key ?? (code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase()),
    shiftKey: shift,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  } as KeyboardEvent;
}

/** The physical key that types `char` under the runner's layout. */
function keyFor(settings: Settings, char: string): KeyboardEvent {
  const stroke = charIndex(settings.layout).get(char);
  if (!stroke) throw new Error(`unmappable character: ${JSON.stringify(char)}`);
  return keydown(stroke.key.code, stroke.shift);
}

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  source: 'drill-words',
  duration: 0,
  ...patch,
});

describe('Runner', () => {
  let s: Settings;
  let runner: Runner;
  let t: number;

  const type = (event: KeyboardEvent) => runner.handleKeydown(event, (t += 100));
  const typeExpected = () => type(keyFor(s, runner.text[runner.cursor]!));

  beforeEach(() => {
    s = settings();
    runner = new Runner(s);
    t = 1000;
    runner.startNow(t);
  });

  it('buffers text and starts at the beginning', () => {
    expect(runner.phase).toBe('running');
    expect(runner.text.length).toBeGreaterThan(600);
    expect(runner.cursor).toBe(0);
  });

  it('advances on a correct keystroke', () => {
    const expected = runner.text[0]!;
    expect(typeExpected()).toBe(true);
    expect(runner.cursor).toBe(1);
    expect(runner.states[0]).toBe(CharState.Correct);
    expect(runner.stats.correctKeys).toBe(1);
    expect(runner.mistyped).toBeUndefined();
    expect(expected).toBe(runner.text[0]);
  });

  describe('block mode (default)', () => {
    const wrongKey = () => keyFor(s, runner.text[runner.cursor] === 'q' ? 'z' : 'q');

    it('holds the cursor on a mistype without inserting anything', () => {
      type(wrongKey());

      expect(runner.cursor).toBe(0);
      expect(runner.blocked).toBe(true);
      expect(runner.states[0]).toBe(CharState.Error);
      expect(runner.stats.errorKeys).toBe(1);
      // the text is untouched: there is nothing to delete
      expect(runner.text[0]).not.toBe('q');
    });

    it('carries on from the same place as soon as the right key lands', () => {
      type(wrongKey());
      expect(typeExpected()).toBe(true);

      expect(runner.cursor).toBe(1);
      expect(runner.blocked).toBe(false);
      expect(runner.states[0]).toBe(CharState.Fixed);
      expect(runner.stats.correctKeys).toBe(1);
      expect(runner.stats.errorKeys).toBe(1);
    });

    it('counts every attempt, since none of them are swallowed', () => {
      type(wrongKey());
      type(wrongKey());
      type(wrongKey());
      expect(runner.cursor).toBe(0);
      expect(runner.blocked).toBe(true);
      expect(runner.stats.errorKeys).toBe(3);
      expect(runner.stats.correctKeys).toBe(0);
      expect(runner.stats.accuracy()).toBe(0);
    });

    it('lets backspace walk back over characters already typed', () => {
      typeExpected();
      typeExpected();
      expect(runner.cursor).toBe(2);
      type(keydown('Backspace', false, 'Backspace'));
      expect(runner.cursor).toBe(1);
      expect(runner.states[1]).toBe(CharState.Pending);
    });

    it('keeps one meaning for backspace: go back one, block or no block', () => {
      typeExpected();
      type(wrongKey());
      expect(runner.blocked).toBe(true);

      type(keydown('Backspace', false, 'Backspace'));
      expect(runner.blocked).toBe(false);
      expect(runner.cursor).toBe(0);
      // neither the missed character nor the one stepped over stays marked
      expect(runner.states[0]).toBe(CharState.Pending);
      expect(runner.states[1]).toBe(CharState.Pending);
    });
  });

  describe('advance mode', () => {
    beforeEach(() => {
      s = settings({ errorMode: 'advance' });
      runner = new Runner(s);
      t = 1000;
      runner.startNow(t);
    });

    it('marks the miss and moves on', () => {
      type(keyFor(s, runner.text[0] === 'q' ? 'z' : 'q'));
      expect(runner.cursor).toBe(1);
      expect(runner.blocked).toBe(false);
      expect(runner.mistyped).toBeUndefined();
      expect(runner.states[0]).toBe(CharState.Error);
    });
  });

  it('ignores modifier combinations and unknown keys', () => {
    expect(type({ ...keydown('KeyA'), ctrlKey: true } as KeyboardEvent)).toBe(false);
    expect(type(keydown('F5', false, 'F5'))).toBe(false);
    expect(type(keydown('ArrowLeft', false, 'ArrowLeft'))).toBe(false);
    expect(runner.cursor).toBe(0);
  });

  it('reports the finger and layout character of each keystroke', () => {
    const seen: Array<{ code: string; finger: string; expected: string }> = [];
    runner.onKeystroke = (event) => seen.push(event);
    typeExpected();
    expect(seen.length).toBe(1);
    expect(seen[0]!.expected).toBe(runner.text[0]);
    expect(seen[0]!.finger).toMatch(/^(l[2-5]|r[2-5]|thumb)$/);
  });

  it('reports the presses that are due next', () => {
    const chords = runner.expectedChords(3);
    expect(chords.length).toBe(3);
    expect(chords[0]!.label).toBe(runner.text[0]);
  });

  it('plans the same presses the ribbon draws', () => {
    // The marks and the ribbon are two halves of one screen; if these two walks
    // ever disagree the text names one finger while the board points at another.
    const same = () =>
      expect(runner.cuePlan(8).map((c) => c.label)).toEqual(
        runner.expectedChords(8).map((c) => c.label),
      );
    same();
    typeExpected();
    typeExpected();
    same();
  });

  it('gives one cue per character on a latin layout', () => {
    const plan = runner.cuePlan(3);
    expect(plan.length).toBe(3);
    plan.forEach((cue, i) => {
      expect(cue.span).toBe(1);
      expect(cue.slot).toBe(0);
      expect(cue.at).toBe(i);
      expect(cue.index).toBe(i);
      expect(cue.thumb).toBe('none');
      expect(cue.label).toBe(runner.text[i]);
      expect(cue.finger).toMatch(/^(l[2-5]|r[2-5]|thumb)$/);
      if (cue.finger !== 'thumb') expect(cue.hand).toBe(cue.finger[0] === 'l' ? 'left' : 'right');
    });
  });

  it('gives the space bar to the thumb of the hand that just typed', () => {
    for (let i = 0; i < 200 && runner.text[runner.cursor] !== ' '; i++) typeExpected();
    expect(runner.text[runner.cursor]).toBe(' ');

    const previous = charIndex(s.layout).get(runner.text[runner.cursor - 1]!)!;
    const side = previous.key.x + previous.key.w / 2 < BOARD_UNITS_X / 2 ? 'left' : 'right';

    const cue = runner.cuePlan(1)[0]!;
    expect(cue.finger).toBe('thumb');
    expect(cue.hand).toBe(side);
  });

  it('counts the cue budget in presses', () => {
    expect(runner.cuePlan(0)).toEqual([]);
    expect(runner.cuePlan(1).length).toBe(1);
    expect(runner.cuePlan(5000).length).toBeLessThanOrEqual(5000);
  });

  it('anchors the cues on the character under the cursor', () => {
    typeExpected();
    expect(runner.cuePlan(1)[0]!.index).toBe(runner.cursor);
  });

  it('ends on esc and reports why', () => {
    typeExpected();
    runner.abort(t + 500);
    expect(runner.phase).toBe('finished');
    expect(runner.endReason).toBe('quit');
    expect(runner.summary((code) => code).correctKeys).toBe(1);
  });
});

describe('Runner, Japanese', () => {
  /**
   * Most of these tests want a passage containing some particular thing — a
   * 拗音, a thumb-shifted kana, a bare し — and walk forward until one turns up.
   * The corpus is drawn from a shuffled bag, so with a live `Math.random` that
   * walk is a lottery, and one of these used to lose it about a quarter of the
   * time. Fixing the bag makes the passage the same on every run: the shuffle
   * degenerates to one deterministic permutation of the whole corpus, so the
   * text is still many different passages, just always the same ones in the
   * same order. `afterEach` puts `Math.random` back.
   */
  const start = (patch: Partial<Settings>) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // qwerty so the romaji tests can name latin letters directly
    const s = settings({ source: 'ja', layout: 'qwerty', ...patch });
    const runner = new Runner(s);
    runner.startNow(1000);
    return runner;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const THUMB_CODE = { left: 'NonConvert', right: 'Convert' } as const;

  /**
   * One monotonic clock for the whole block. The walks below run for as long as
   * they need to, so a test cannot pick a timestamp for the presses that follow
   * one — it would have to guess how far the walk went, and typing into the
   * past skews every gap the stats measure.
   */
  let t = 0;
  beforeEach(() => {
    t = 2000;
  });
  /** The next press time. 120ms clears the 90ms a single `typeNext` spans. */
  const tick = (): number => (t += 120);

  /**
   * Types the presses the runner says are next, holding a thumb key when the
   * chord calls for one and always releasing the character key, since that is
   * what closes the simultaneous-press window.
   */
  const typeNext = (runner: Runner, count: number, at = 2000): number => {
    let t = at;
    let done = 0;
    for (let i = 0; i < count; i++) {
      const chord = runner.expectedChords(1)[0];
      if (!chord) break;
      const thumb = chord.thumb === 'none' ? undefined : THUMB_CODE[chord.thumb];
      if (thumb) runner.handleKeydown(keydown(thumb, false, thumb), (t += 10));
      runner.handleKeydown(keydown(chord.code, chord.shift), (t += 30));
      runner.handleKeyup(keydown(chord.code, chord.shift), (t += 40));
      if (thumb) runner.handleKeyup(keydown(thumb, false, thumb), (t += 10));
      done++;
    }
    return done;
  };

  /** Types this method's presses until the cursor reaches `chars` of the text. */
  const typeUpTo = (runner: Runner, chars: number): void => {
    while (runner.cursor < chars && typeNext(runner, 1, tick()) === 1);
  };

  /**
   * A bound on the walks below. It is a guard against looping forever, not a
   * budget: how deep into a passage the first 拗音 sits is the corpus's
   * business and it moves whenever the corpus is rebuilt, so the bound is set
   * far past anything the corpus plausibly asks for. Hitting it means the thing
   * never appears at all, which is a regression worth failing on.
   */
  const WALK_LIMIT = 20_000;

  /**
   * Types presses until `found` holds, and leaves the runner sitting there.
   * `what` names the thing for the failure message.
   */
  const walkTo = (runner: Runner, what: string, found: (r: Runner) => boolean): void => {
    for (let i = 0; i < WALK_LIMIT; i++) {
      if (found(runner)) return;
      if (typeNext(runner, 1, tick()) === 0) break;
    }
    throw new Error(`no ${what} appeared in the buffered text`);
  };

  /** The cues for the unit under the cursor — one per press it takes. */
  const headCues = (runner: Runner) => {
    const plan = runner.cuePlan(10);
    return plan.filter((c) => c.index === plan[0]?.index);
  };

  it('takes several presses per kana in romaji, and one in a kana layout', () => {
    const romaji = start({ jaMethod: 'romaji' });
    typeNext(romaji, 40);
    expect(romaji.stats.correctKeys).toBe(40);
    expect(romaji.stats.errorKeys).toBe(0);
    // roughly two latin keys per kana
    expect(romaji.unitsDone).toBeGreaterThan(15);
    expect(romaji.unitsDone).toBeLessThan(40);

    for (const jaMethod of ['nicola', 'asuka'] as const) {
      const kana = start({ jaMethod });
      typeNext(kana, 30);
      expect(kana.stats.errorKeys, jaMethod).toBe(0);
      expect(kana.unitsDone, jaMethod).toBe(30);
    }
  });

  it('measures the same speed for the same kana, whichever method typed them', () => {
    // The point of counting characters rather than presses: romaji spends about
    // twice the keystrokes on a passage, and must not score twice the speed.
    const run = (jaMethod: Settings['jaMethod']) => {
      // `start` fixes the passage bag, so both methods are handed the same text
      const runner = start({ jaMethod });
      typeUpTo(runner, 120);
      return runner;
    };

    const romaji = run('romaji');
    const nicola = run('nicola');

    expect(romaji.text.slice(0, 120)).toBe(nicola.text.slice(0, 120));
    expect(romaji.stats.producedChars).toBeGreaterThanOrEqual(120);
    expect(nicola.stats.producedChars).toBe(romaji.stats.producedChars);
    expect(nicola.stats.netWpm(60_000)).toBeCloseTo(romaji.stats.netWpm(60_000), 6);

    // ...while the keystroke counts still show the difference in effort
    const keys = (r: Runner) => r.stats.correctKeys + r.stats.errorKeys;
    expect(keys(romaji)).toBeGreaterThan(keys(nicola) * 1.5);
  });

  it('counts a romaji cluster once, on the press that finishes it', () => {
    const runner = start({ jaMethod: 'romaji' });
    // walk to a unit that spans two characters (きゃ and friends)
    walkTo(runner, 'two-character kana', (r) => r.cuePlan(1)[0]?.span === 2);

    const cue = runner.cuePlan(1)[0]!;
    expect(cue.span).toBe(2);
    const before = runner.stats.producedChars;
    const presses = runner.cuePlan(8).filter((c) => c.index === cue.index).length;
    expect(presses).toBeGreaterThan(1);
    for (let i = 0; i < presses; i++) {
      expect(runner.stats.producedChars, `press ${i}`).toBe(before);
      typeNext(runner, 1, tick());
    }
    expect(runner.stats.producedChars).toBe(before + 2);
  });

  it('needs the thumb key held for a thumb-shifted kana', () => {
    const runner = start({ jaMethod: 'nicola' });
    // walk to the first press that wants a thumb
    walkTo(runner, 'thumb-shifted kana', (r) => r.expectedChords(1)[0]!.thumb !== 'none');

    const chord = runner.expectedChords(1)[0]!;
    // what the walk stopped on, said again so the compiler can see it too
    if (chord.thumb === 'none') throw new Error('walked to a chord that wants no thumb');

    // without the thumb, the same key is a different kana
    const base = tick();
    runner.handleKeydown(keydown(chord.code), base);
    runner.handleKeyup(keydown(chord.code), base + 40);
    expect(runner.blocked).toBe(true);
    expect(runner.mistyped).not.toBe(chord.label);

    // no deleting: pressing the thumb and the key together carries on
    const thumb = THUMB_CODE[chord.thumb];
    runner.handleKeydown(keydown(thumb, false, thumb), base + 80);
    runner.handleKeydown(keydown(chord.code), base + 100);
    expect(runner.blocked).toBe(false);
    expect(runner.states[runner.cursor - 1]).toBe(CharState.Fixed);
  });

  it('plans the same presses the ribbon draws, by every method', () => {
    for (const jaMethod of ['romaji', 'nicola', 'asuka'] as const) {
      const runner = start({ jaMethod });
      typeNext(runner, 3);
      expect(runner.cuePlan(8).map((c) => c.label), jaMethod).toEqual(
        runner.expectedChords(8).map((c) => c.label),
      );
    }
  });

  it('tells the truth about a kana that takes three fingers', () => {
    // 拗音 such as きゃ: one unit, two characters, three presses on three keys.
    const runner = start({ jaMethod: 'romaji' });
    walkTo(runner, 'three-press kana', (r) => {
      const head = headCues(r);
      return head.length >= 3 && head[0]!.span === 2;
    });

    const head = headCues(runner);
    expect(head.map((c) => c.slot)).toEqual([0, 1, 2]);
    expect(head.map((c) => c.at)).toEqual([0, 1, 2]);
    expect(head.map((c) => c.label).join().replace(/,/g, '')).toMatch(/^[a-z]{3}$/);
    // the whole point: the old per-unit plan reported the first finger thrice
    expect(new Set(head.map((c) => c.finger)).size).toBeGreaterThan(1);
  });

  it('drops the presses already made inside a unit', () => {
    const runner = start({ jaMethod: 'romaji' });
    walkTo(runner, 'multi-press kana', (r) => headCues(r).length >= 2);

    const second = headCues(runner)[1]!;
    typeNext(runner, 1, tick());
    const now = runner.cuePlan(10)[0]!;
    expect(now.label).toBe(second.label);
    expect(now.finger).toBe(second.finger);
    expect(now.index).toBe(second.index);
    expect(now.slot).toBe(0);
    expect(now.at).toBe(0);
  });

  it('names the hand that presses and the thumb that shifts, separately', () => {
    const runner = start({ jaMethod: 'nicola' });
    walkTo(runner, 'thumb-shifted kana', (r) => r.cuePlan(1)[0]!.thumb !== 'none');

    const cue = runner.cuePlan(1)[0]!;
    expect(cue.span).toBe(1);
    expect(cue.slot).toBe(0);
    expect(cue.finger).not.toBe('thumb');
    // the hand is the character key's own, never the shifting thumb's
    expect(cue.hand).toBe(cue.finger[0] === 'l' ? 'left' : 'right');
  });

  it('cues the cross-hand press a kana layout is built around', () => {
    // 親指シフト means one hand strikes while the *other* thumb holds; that split
    // is the thing the mark exists to teach, so at least one must turn up.
    const runner = start({ jaMethod: 'nicola' });
    walkTo(runner, 'cross-hand thumb-shift', (r) => {
      const cue = r.cuePlan(1)[0]!;
      return cue.thumb !== 'none' && cue.thumb !== cue.hand;
    });
  });

  it('never cues a key that is not on the board', () => {
    for (const jaMethod of ['nicola', 'asuka'] as const) {
      const runner = start({ jaMethod });
      for (const cue of runner.cuePlan(10)) {
        expect(FINGER_ORDER, jaMethod).toContain(cue.finger);
        expect(['left', 'right'], jaMethod).toContain(cue.hand);
      }
    }
  });

  it('accepts any spelling the romaji table allows', () => {
    // walk to a し and finish it with `shi` rather than the canonical `si`
    const runner = start({ jaMethod: 'romaji' });
    // a bare し, not the start of しゃ/しゅ/しょ
    walkTo(runner, 'bare し', (r) =>
      r.text[r.cursor] === 'し' && !/[ゃゅょぁぃぅぇぉ]/.test(r.text[r.cursor + 1] ?? ''));

    const units = runner.unitsDone;
    for (const letter of 'shi') {
      runner.handleKeydown(keyFor(settings({ layout: 'qwerty' }), letter), tick());
    }
    // romaji resolves on keydown; the release is irrelevant but harmless
    expect(runner.blocked).toBe(false);
    expect(runner.stats.errorKeys).toBe(0);
    expect(runner.unitsDone).toBe(units + 1);
  });

  it('does not hold a mistype against a stray second n', () => {
    // This one cannot use `walkTo`: whether a ん took a single press is only
    // knowable from the state either side of that press, so it looks before and
    // after each one rather than at a standing cue.
    const runner = start({ jaMethod: 'romaji' });
    let lastCursor = -1;
    for (let i = 0; i < WALK_LIMIT; i++) {
      const cursor = runner.cursor;
      const isN = runner.text[cursor] === 'ん';
      const firstPressOfUnit = cursor !== lastCursor;
      lastCursor = cursor;
      const units = runner.unitsDone;
      if (typeNext(runner, 1, tick()) === 0) break;

      // ん finished by a single n is the case where a habitual second n is free
      if (isN && firstPressOfUnit && runner.unitsDone === units + 1) {
        const errors = runner.stats.errorKeys;
        const strokes = runner.stats.correctKeys;
        runner.handleKeydown(keyFor(settings({ layout: 'qwerty' }), 'n'), tick());
        expect(runner.blocked).toBe(false);
        expect(runner.stats.errorKeys).toBe(errors);
        expect(runner.stats.correctKeys).toBe(strokes);
        return;
      }
    }
    throw new Error('no single-n ん appeared');
  });
});
