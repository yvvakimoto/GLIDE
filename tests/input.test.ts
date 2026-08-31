import { describe, expect, it } from 'vitest';

import { InputRouter, type InputEvent, type Press, type ThumbConfig } from '../src/core/input';

const key = (code: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    code,
    key: code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase(),
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...extra,
  }) as KeyboardEvent;

const thumbs = (patch: Partial<ThumbConfig> = {}): ThumbConfig => ({
  left: 'NonConvert',
  right: 'Convert',
  percent: 50,
  continuous: true,
  ...patch,
});

const kana = (patch: Partial<ThumbConfig> = {}) =>
  new InputRouter({ kind: 'kana', layout: 'qwerty', mode: 'remap', thumbs: thumbs(patch) });

const presses = (events: InputEvent[]): Press[] =>
  events.flatMap((e) => (e.kind === 'press' ? [e.press] : []));

describe('InputRouter, latin', () => {
  const router = new InputRouter({
    kind: 'latin',
    layout: 'dvorak',
    mode: 'remap',
    thumbs: thumbs(),
  });

  it('resolves a press on keydown, with no thumb and no waiting', () => {
    const out = router.keydown(key('KeyU'), 100);
    expect(out.consumed).toBe(true);
    expect(presses(out.events)).toEqual([{ code: 'KeyU', shift: false, thumb: 'none', at: 100 }]);
    expect(router.deferring).toBe(false);
  });

  it('passes backspace through and ignores modifier combinations', () => {
    expect(router.keydown(key('Backspace', { key: 'Backspace' }), 1).events).toEqual([
      { kind: 'backspace' },
    ]);
    expect(router.keydown(key('KeyA', { ctrlKey: true }), 1).consumed).toBe(false);
    expect(router.keydown(key('KeyA', { altKey: true }), 1).consumed).toBe(false);
    expect(router.keydown(key('F5', { key: 'F5' }), 1).consumed).toBe(false);
  });

  it('maps a typed character back to its key in passthrough mode', () => {
    const passthrough = new InputRouter({
      kind: 'latin',
      layout: 'dvorak',
      mode: 'passthrough',
      thumbs: thumbs(),
    });
    // the OS is on Dvorak, so 'g' arrives from the physical KeyU
    const out = passthrough.keydown(key('Whatever', { key: 'g' }), 5);
    expect(presses(out.events)[0]!.code).toBe('KeyU');
  });
});

describe('InputRouter, kana simultaneous press', () => {
  it('shifts immediately when the thumb is already held', () => {
    const router = kana();
    expect(router.keydown(key('NonConvert'), 100).events).toEqual([]);
    const out = router.keydown(key('KeyA'), 140);
    expect(presses(out.events)).toEqual([{ code: 'KeyA', shift: false, thumb: 'left', at: 140 }]);
    // no deferral at all in the common case
    expect(router.deferring).toBe(false);
  });

  it('holds a lone character back until its span ends', () => {
    const router = kana();
    expect(presses(router.keydown(key('KeyA'), 100).events)).toEqual([]);
    expect(router.deferring).toBe(true);
    const out = router.keyup(key('KeyA'), 180);
    expect(presses(out.events)).toEqual([{ code: 'KeyA', shift: false, thumb: 'none', at: 100 }]);
  });

  it('counts a thumb inside the window, and not one after it', () => {
    // span is 100..200, so at 50% the window closes at 150
    const inside = kana({ percent: 50 });
    inside.keydown(key('KeyA'), 100);
    inside.keydown(key('Convert'), 140);
    expect(presses(inside.keyup(key('KeyA'), 200).events)[0]!.thumb).toBe('right');

    const outside = kana({ percent: 50 });
    outside.keydown(key('KeyA'), 100);
    outside.keydown(key('Convert'), 170);
    expect(presses(outside.keyup(key('KeyA'), 200).events)[0]!.thumb).toBe('none');
  });

  it('scales the window with the press, not with the clock', () => {
    // the same 70ms lag is late in a short press and early in a long one
    const quick = kana({ percent: 50 });
    quick.keydown(key('KeyA'), 0);
    quick.keydown(key('Convert'), 70);
    expect(presses(quick.keyup(key('KeyA'), 100).events)[0]!.thumb).toBe('none');

    const slow = kana({ percent: 50 });
    slow.keydown(key('KeyA'), 0);
    slow.keydown(key('Convert'), 70);
    expect(presses(slow.keyup(key('KeyA'), 300).events)[0]!.thumb).toBe('right');
  });

  it('accepts a thumb any time before release at 100, and only a held one at 0', () => {
    const loose = kana({ percent: 100 });
    loose.keydown(key('KeyA'), 0);
    loose.keydown(key('Convert'), 95);
    expect(presses(loose.keyup(key('KeyA'), 100).events)[0]!.thumb).toBe('right');

    const strict = kana({ percent: 0 });
    strict.keydown(key('KeyA'), 0);
    strict.keydown(key('Convert'), 1);
    expect(presses(strict.keyup(key('KeyA'), 100).events)[0]!.thumb).toBe('none');
  });

  it('ends the span when another key is pressed, and never loses a press', () => {
    const router = kana({ percent: 100 });
    router.keydown(key('KeyA'), 100);
    // the second character closes the first one's span
    const out = router.keydown(key('KeyS'), 160);
    expect(presses(out.events)).toEqual([{ code: 'KeyA', shift: false, thumb: 'none', at: 100 }]);
    expect(presses(router.keyup(key('KeyS'), 220).events)).toEqual([
      { code: 'KeyS', shift: false, thumb: 'none', at: 160 },
    ]);
  });

  it('stops waiting on a character that is held down absurdly long', () => {
    const router = kana();
    router.keydown(key('KeyA'), 0);
    expect(router.tick(400)).toEqual([]);
    expect(presses(router.tick(600))[0]).toEqual({ code: 'KeyA', shift: false, thumb: 'none', at: 0 });
    expect(router.deferring).toBe(false);
  });

  it('settles a pending character before a backspace lands', () => {
    const router = kana();
    router.keydown(key('KeyA'), 100);
    const out = router.keydown(key('Backspace', { key: 'Backspace' }), 150);
    expect(out.events.map((e) => e.kind)).toEqual(['press', 'backspace']);
  });

  it('honours 連続シフト: one thumb press shifts a run, or only one character', () => {
    const continuous = kana({ continuous: true });
    continuous.keydown(key('NonConvert'), 0);
    expect(presses(continuous.keydown(key('KeyA'), 10).events)[0]!.thumb).toBe('left');
    expect(presses(continuous.keydown(key('KeyS'), 60).events)[0]!.thumb).toBe('left');

    const single = kana({ continuous: false });
    single.keydown(key('NonConvert'), 0);
    expect(presses(single.keydown(key('KeyA'), 10).events)[0]!.thumb).toBe('left');
    // the thumb is spent; the next character is unshifted
    single.keydown(key('KeyS'), 60);
    expect(presses(single.keyup(key('KeyS'), 100).events)[0]!.thumb).toBe('none');
    // releasing and pressing the thumb again re-arms it
    single.keyup(key('NonConvert'), 110);
    single.keydown(key('NonConvert'), 120);
    expect(presses(single.keydown(key('KeyD'), 130).events)[0]!.thumb).toBe('left');
  });

  it('takes any assigned key as a thumb, including space', () => {
    const router = kana({ left: 'Space', right: 'Convert' });
    expect(router.keydown(key('Space'), 0).events).toEqual([]);
    expect(presses(router.keydown(key('KeyA'), 20).events)[0]!.thumb).toBe('left');
    // and the keys it is not assigned to are ordinary characters again
    const plain = kana({ left: 'NonConvert', right: 'Convert' });
    plain.keydown(key('Space'), 0);
    expect(presses(plain.keyup(key('Space'), 40).events)[0]!.code).toBe('Space');
  });

  it('drops held state when the assignment changes', () => {
    const router = kana();
    router.keydown(key('NonConvert'), 0);
    router.configure({
      kind: 'kana',
      layout: 'qwerty',
      mode: 'remap',
      thumbs: thumbs({ left: 'AltLeft' }),
    });
    router.keydown(key('KeyA'), 20);
    expect(presses(router.keyup(key('KeyA'), 60).events)[0]!.thumb).toBe('none');
  });
});
