import { beforeEach, describe, expect, it } from 'vitest';

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
    expect(runner.stats.correctChars).toBe(1);
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
      expect(runner.stats.errorChars).toBe(1);
      // the text is untouched: there is nothing to delete
      expect(runner.text[0]).not.toBe('q');
    });

    it('carries on from the same place as soon as the right key lands', () => {
      type(wrongKey());
      expect(typeExpected()).toBe(true);

      expect(runner.cursor).toBe(1);
      expect(runner.blocked).toBe(false);
      expect(runner.states[0]).toBe(CharState.Fixed);
      expect(runner.stats.correctChars).toBe(1);
      expect(runner.stats.errorChars).toBe(1);
    });

    it('counts every attempt, since none of them are swallowed', () => {
      type(wrongKey());
      type(wrongKey());
      type(wrongKey());
      expect(runner.cursor).toBe(0);
      expect(runner.blocked).toBe(true);
      expect(runner.stats.errorChars).toBe(3);
      expect(runner.stats.correctChars).toBe(0);
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
    expect(runner.summary((code) => code).correctChars).toBe(1);
  });
});

describe('Runner, Japanese', () => {
  const start = (patch: Partial<Settings>) => {
    // qwerty so the romaji tests can name latin letters directly
    const s = settings({ source: 'ja', layout: 'qwerty', ...patch });
    const runner = new Runner(s);
    runner.startNow(1000);
    return runner;
  };

  const THUMB_CODE = { left: 'NonConvert', right: 'Convert' } as const;

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

  it('takes several presses per kana in romaji, and one in a kana layout', () => {
    const romaji = start({ jaMethod: 'romaji' });
    typeNext(romaji, 40);
    expect(romaji.stats.correctChars).toBe(40);
    expect(romaji.stats.errorChars).toBe(0);
    // roughly two latin keys per kana
    expect(romaji.unitsDone).toBeGreaterThan(15);
    expect(romaji.unitsDone).toBeLessThan(40);

    for (const jaMethod of ['nicola', 'asuka'] as const) {
      const kana = start({ jaMethod });
      typeNext(kana, 30);
      expect(kana.stats.errorChars, jaMethod).toBe(0);
      expect(kana.unitsDone, jaMethod).toBe(30);
    }
  });

  it('needs the thumb key held for a thumb-shifted kana', () => {
    const runner = start({ jaMethod: 'nicola' });
    // walk to the first press that wants a thumb
    for (let i = 0; i < 60; i++) {
      const chord = runner.expectedChords(1)[0]!;
      if (chord.thumb !== 'none') {
        // without the thumb, the same key is a different kana
        const base = 2000 + i * 200;
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
        return;
      }
      typeNext(runner, 1, 2000 + i * 90);
    }
    throw new Error('no thumb-shifted kana appeared in the first 60 presses');
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
    for (let i = 0; i < 2000; i++) {
      const plan = runner.cuePlan(10);
      if (!plan.length) break;
      const head = plan.filter((c) => c.index === plan[0]!.index);
      if (head.length >= 3 && head[0]!.span === 2) {
        expect(head.map((c) => c.slot)).toEqual([0, 1, 2]);
        expect(head.map((c) => c.at)).toEqual([0, 1, 2]);
        expect(head.map((c) => c.label).join().replace(/,/g, '')).toMatch(/^[a-z]{3}$/);
        // the whole point: the old per-unit plan reported the first finger thrice
        expect(new Set(head.map((c) => c.finger)).size).toBeGreaterThan(1);
        return;
      }
      if (!typeNext(runner, 1, 2000 + i * 80)) break;
    }
    throw new Error('no three-press kana appeared');
  });

  it('drops the presses already made inside a unit', () => {
    const runner = start({ jaMethod: 'romaji' });
    for (let i = 0; i < 2000; i++) {
      const plan = runner.cuePlan(10);
      if (!plan.length) break;
      const head = plan.filter((c) => c.index === plan[0]!.index);
      if (head.length >= 2) {
        const second = head[1]!;
        typeNext(runner, 1, 3000 + i * 80);
        const now = runner.cuePlan(10)[0]!;
        expect(now.label).toBe(second.label);
        expect(now.finger).toBe(second.finger);
        expect(now.index).toBe(second.index);
        expect(now.slot).toBe(0);
        expect(now.at).toBe(0);
        return;
      }
      if (!typeNext(runner, 1, 2000 + i * 80)) break;
    }
    throw new Error('no multi-press kana appeared');
  });

  it('names the hand that presses and the thumb that shifts, separately', () => {
    const runner = start({ jaMethod: 'nicola' });
    for (let i = 0; i < 80; i++) {
      const cue = runner.cuePlan(1)[0]!;
      if (cue.thumb !== 'none') {
        expect(cue.span).toBe(1);
        expect(cue.slot).toBe(0);
        expect(cue.finger).not.toBe('thumb');
        // the hand is the character key's own, never the shifting thumb's
        expect(cue.hand).toBe(cue.finger[0] === 'l' ? 'left' : 'right');
        return;
      }
      if (!typeNext(runner, 1, 2000 + i * 90)) break;
    }
    throw new Error('no thumb-shifted kana appeared in the first 80 presses');
  });

  it('cues the cross-hand press a kana layout is built around', () => {
    // 親指シフト means one hand strikes while the *other* thumb holds; that split
    // is the thing the mark exists to teach, so at least one must turn up.
    const runner = start({ jaMethod: 'nicola' });
    for (let i = 0; i < 200; i++) {
      const cue = runner.cuePlan(1)[0]!;
      if (cue.thumb !== 'none' && cue.thumb !== cue.hand) return;
      if (!typeNext(runner, 1, 2000 + i * 90)) break;
    }
    throw new Error('no cross-hand thumb-shift appeared');
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
    for (let i = 0; i < 400; i++) {
      // a bare し, not the start of しゃ/しゅ/しょ
      const solo = runner.text[runner.cursor] === 'し' && !/[ゃゅょぁぃぅぇぉ]/.test(runner.text[runner.cursor + 1] ?? '');
      if (solo) {
        const units = runner.unitsDone;
        let t = 5000 + i * 90;
        for (const letter of 'shi') {
          runner.handleKeydown(keyFor(settings({ layout: 'qwerty' }), letter), (t += 80));
        }
        // romaji resolves on keydown; the release is irrelevant but harmless
        expect(runner.blocked).toBe(false);
        expect(runner.stats.errorChars).toBe(0);
        expect(runner.unitsDone).toBe(units + 1);
        return;
      }
      if (typeNext(runner, 1, 2000 + i * 90) === 0) break;
    }
    throw new Error('no し appeared in the buffered text');
  });

  it('does not hold a mistype against a stray second n', () => {
    const runner = start({ jaMethod: 'romaji' });
    let lastCursor = -1;
    for (let i = 0; i < 400; i++) {
      const cursor = runner.cursor;
      const isN = runner.text[cursor] === 'ん';
      const firstPressOfUnit = cursor !== lastCursor;
      lastCursor = cursor;
      const units = runner.unitsDone;
      if (typeNext(runner, 1, 3000 + i * 90) === 0) break;

      // ん finished by a single n is the case where a habitual second n is free
      if (isN && firstPressOfUnit && runner.unitsDone === units + 1) {
        const errors = runner.stats.errorChars;
        const strokes = runner.stats.correctChars;
        runner.handleKeydown(keyFor(settings({ layout: 'qwerty' }), 'n'), 9000 + i * 90);
        expect(runner.blocked).toBe(false);
        expect(runner.stats.errorChars).toBe(errors);
        expect(runner.stats.correctChars).toBe(strokes);
        return;
      }
    }
    throw new Error('no single-n ん appeared');
  });
});
