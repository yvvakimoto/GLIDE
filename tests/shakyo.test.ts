import { beforeEach, describe, expect, it } from 'vitest';

import { createStream } from '../src/core/corpus';
import { Runner } from '../src/core/engine';
import { charIndex } from '../src/core/layouts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { registerWork, type Work } from '../src/core/works';
import {
  MAX_WORKS,
  bookmarkOf,
  clearAllProgress,
  clearBookmark,
  loadProgress,
  resumeAt,
  saveBookmark,
  emptyBookmark,
} from '../src/core/progress';
import { installStorage, type MemoryStorage } from './memory-storage';

function keydown(code: string, shift = false): KeyboardEvent {
  return {
    code,
    key: code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase(),
    shiftKey: shift,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  } as KeyboardEvent;
}

function keyFor(settings: Settings, char: string): KeyboardEvent {
  const stroke = charIndex(settings.layout).get(char);
  if (!stroke) throw new Error(`unmappable character: ${JSON.stringify(char)}`);
  return keydown(stroke.key.code, stroke.shift);
}

/** A short ordered work. Deliberately far below BUFFER_AHEAD, so one fill drains it. */
function makeWork(texts: readonly string[], id = 'work/test'): Work {
  const offsets = [0];
  for (const t of texts) offsets.push(offsets[offsets.length - 1]! + t.length);
  const chars = offsets[texts.length]!;
  return {
    id,
    title: 'Test Work',
    author: 'nobody',
    script: 'latin',
    chunks: texts.map((t) => ({ t })),
    chapters: [{ id: 'one', title: 'Only chapter', start: 0, count: texts.length, chars }],
    offsets,
    chars,
    stamp: 'test',
  };
}

const CHUNKS = ['alpha beta ', 'gamma delta ', 'epsilon zeta '];
const WHOLE = CHUNKS.join('');

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  source: 'work/test',
  duration: 0,
  ...patch,
});

describe('an ordered work stream', () => {
  beforeEach(() => registerWork(makeWork(CHUNKS)));

  it('walks its chunks in order and then says it is out', () => {
    const stream = createStream('work/test', DEFAULT_SETTINGS.layout);
    expect(stream.total).toBe(WHOLE.length);
    for (const [i, text] of CHUNKS.entries()) {
      const passage = stream.next();
      expect(passage?.text).toBe(text);
      expect(passage?.at?.chunk).toBe(i);
    }
    // the null is what stops Runner.fill's while loop
    expect(stream.next()).toBeNull();
    expect(stream.next()).toBeNull();
  });

  it('restarts at a chunk when told to seek', () => {
    const stream = createStream('work/test', DEFAULT_SETTINGS.layout);
    stream.next();
    stream.seek?.(2);
    expect(stream.next()?.text).toBe(CHUNKS[2]);
    expect(stream.next()).toBeNull();
  });

  it('clamps a seek past either end rather than emitting nothing sensible', () => {
    const stream = createStream('work/test', DEFAULT_SETTINGS.layout);
    stream.seek?.(-5);
    expect(stream.next()?.text).toBe(CHUNKS[0]);
    stream.seek?.(999);
    expect(stream.next()).toBeNull();
  });

  it('leaves an endless source alone: a shuffle has no seek to call', () => {
    const stream = createStream('prose', 'dvorak');
    expect(stream.total).toBeUndefined();
    expect(stream.seek).toBeUndefined();
    expect(stream.next()).not.toBeNull();
  });
});

describe('Runner on a work', () => {
  let s: Settings;
  let runner: Runner;
  let t: number;

  const type = (event: KeyboardEvent) => runner.handleKeydown(event, (t += 100));
  const typeExpected = () => type(keyFor(s, runner.text[runner.cursor]!));

  beforeEach(() => {
    registerWork(makeWork(CHUNKS));
    s = settings();
    // If fill() did not stop on an exhausted stream this line would never return.
    runner = new Runner(s);
    t = 1000;
    runner.startNow(t);
  });

  it('buffers the whole work and stops asking for more', () => {
    expect(runner.text).toBe(WHOLE);
    expect(runner.exhausted).toBe(true);
  });

  it('finishes the run when the work runs out', () => {
    for (let i = 0; i < WHOLE.length; i++) {
      expect(runner.phase, `at ${i}`).toBe('running');
      expect(typeExpected()).toBe(true);
    }
    expect(runner.phase).toBe('finished');
    expect(runner.endReason).toBe('end');
    // and the run has a real duration, not a zero one
    expect(runner.summary((c) => c).durationMs).toBeGreaterThan(0);
  });

  it('is inert once the work is finished', () => {
    for (let i = 0; i < WHOLE.length; i++) typeExpected();
    const before = { cursor: runner.cursor, keys: runner.stats.correctKeys };
    expect(type(keydown('KeyA'))).toBe(false);
    expect(runner.cursor).toBe(before.cursor);
    expect(runner.stats.correctKeys).toBe(before.keys);
  });

  it('reports where the cursor sits in the work, across chunk boundaries', () => {
    expect(runner.mark).toEqual({ chunk: 0, offset: 0, chars: 0, total: WHOLE.length });

    // finish chunk 0: the mark is the chunk you are about to type, not the one done
    for (let i = 0; i < CHUNKS[0]!.length; i++) typeExpected();
    expect(runner.mark?.chunk).toBe(1);
    expect(runner.mark?.offset).toBe(0);
    expect(runner.mark?.chars).toBe(CHUNKS[0]!.length);

    typeExpected();
    expect(runner.mark?.chunk).toBe(1);
    expect(runner.mark?.offset).toBe(1);
  });

  it('has no mark on an endless source', () => {
    const shuffle = new Runner(settings({ source: 'prose' }));
    expect(shuffle.mark).toBeUndefined();
  });

  it('measures progress against the work, and it only ever rises', () => {
    expect(runner.progress).toBe(0);
    let last = 0;
    for (let i = 0; i < WHOLE.length; i++) {
      typeExpected();
      expect(runner.progress).toBeGreaterThanOrEqual(last);
      last = runner.progress;
    }
    expect(runner.progress).toBeCloseTo(1, 5);
  });

  it('an untimed shuffle reports no progress rather than a sawtooth', () => {
    const shuffle = new Runner(settings({ source: 'prose' }));
    shuffle.startNow(1000);
    expect(shuffle.progress).toBe(0);
  });

  it('seek rebuilds the buffer from the given chunk', () => {
    runner.seek(2);
    expect(runner.text).toBe(CHUNKS[2]);
    expect(runner.cursor).toBe(0);
    expect(runner.phase).toBe('idle');
    expect(runner.mark?.chunk).toBe(2);
  });
});

describe('bookmarks', () => {
  const KEY = 'dvorak-trainer/progress/v1';
  let store: MemoryStorage;

  beforeEach(() => {
    store = installStorage();
  });

  it('starts every work at the beginning', () => {
    const mark = bookmarkOf(loadProgress(), 'work/test', 'abc');
    expect(mark.chunk).toBe(0);
    expect(mark.stale).toBe(false);
  });

  it('remembers a place and moves the trail forward with it', () => {
    saveBookmark('work/test', { chunk: 12, chars: 400, stamp: 'abc' });
    const mark = bookmarkOf(loadProgress(), 'work/test', 'abc');
    expect(mark.chunk).toBe(12);
    expect(mark.furthest).toBe(12);
    expect(mark.chars).toBe(400);
  });

  it('keeps the trail when you jump backwards', () => {
    saveBookmark('work/test', { chunk: 30, stamp: 'abc' });
    saveBookmark('work/test', { chunk: 4, stamp: 'abc' });
    const mark = bookmarkOf(loadProgress(), 'work/test', 'abc');
    expect(mark.chunk).toBe(4);
    expect(mark.furthest).toBe(30);
  });

  it('flags a bookmark written against a different cut of the text', () => {
    saveBookmark('work/test', { chunk: 12, stamp: 'abc' });
    expect(bookmarkOf(loadProgress(), 'work/test', 'abc').stale).toBe(false);
    // a rebuild that re-cut the chunks moves the same number somewhere else
    expect(bookmarkOf(loadProgress(), 'work/test', 'xyz').stale).toBe(true);
  });

  it('survives anything else on the origin writing to the key', () => {
    for (const junk of ['{', 'null', '[]', '{"works":5}', '{"works":[1,2]}', '']) {
      store.setItem(KEY, junk);
      expect(loadProgress().works).toEqual({});
    }
  });

  it('repairs the shape of a row rather than losing the place', () => {
    store.setItem(
      KEY,
      JSON.stringify({
        works: {
          'work/a': { chunk: -7, furthest: 'nope', chars: null, stamp: 'abc' },
          'work/b': 'not an object',
          '': { chunk: 3 },
        },
      }),
    );
    const works = loadProgress().works;
    // a place is worth keeping even when the numbers around it were junk; this is
    // the opposite call from history.ts, and deliberately so
    expect(Object.keys(works)).toEqual(['work/a']);
    expect(works['work/a']!.chunk).toBe(0);
    expect(works['work/a']!.furthest).toBe(0);
  });

  it('keeps a bookmark for a work this build no longer ships', () => {
    saveBookmark('work/retired', { chunk: 5, stamp: 'abc' });
    expect(loadProgress().works['work/retired']?.chunk).toBe(5);
  });

  it('prunes to the newest MAX_WORKS', () => {
    for (let i = 0; i < MAX_WORKS + 6; i++) {
      saveBookmark(`work/${i}`, { chunk: i, at: 1_000 + i, stamp: 'abc' });
    }
    const works = loadProgress().works;
    expect(Object.keys(works)).toHaveLength(MAX_WORKS);
    expect(works['work/0']).toBeUndefined();
    expect(works[`work/${MAX_WORKS + 5}`]).toBeDefined();
  });

  it('forgets a work on request', () => {
    saveBookmark('work/test', { chunk: 9, stamp: 'abc' });
    clearBookmark('work/test');
    expect(loadProgress().works['work/test']).toBeUndefined();

    saveBookmark('work/other', { chunk: 2, stamp: 'abc' });
    clearAllProgress();
    expect(loadProgress().works).toEqual({});
  });
});

describe('resumeAt', () => {
  it('resumes where the bookmark says', () => {
    expect(resumeAt({ ...emptyBookmark(), chunk: 7 }, 40)).toBe(7);
  });

  it('steps back when the work shrank under the bookmark', () => {
    // landing on chunkCount would start a run with nothing in it
    expect(resumeAt({ ...emptyBookmark(), chunk: 40 }, 40)).toBe(39);
    expect(resumeAt({ ...emptyBookmark(), chunk: 900 }, 40)).toBe(39);
  });

  it('copes with a work that has no chunks at all', () => {
    expect(resumeAt({ ...emptyBookmark(), chunk: 5 }, 0)).toBe(0);
  });
});
