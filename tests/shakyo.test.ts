import { beforeEach, describe, expect, it } from 'vitest';

import { createStream } from '../src/core/corpus';
import { Runner } from '../src/core/engine';
import { charIndex } from '../src/core/layouts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings';
import { buildUnits, type MethodSpec } from '../src/core/method';
import { registerWork, resumePoint, sentenceStart, type Work } from '../src/core/works';
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

/**
 * A work with sentences in it. CHUNKS deliberately has no punctuation, which is
 * the wrong shape for everything about resuming part-way into a paragraph.
 */
const PROSE = ['One fish. Two fish? Three fish! ', 'a paragraph that never ends '];
const SECOND = 10; // 'One fish. ' — the start of the second sentence
const THIRD = 20; // 'One fish. Two fish? '

/**
 * A work longer than BUFFER_AHEAD, so the stream really is several chunks past
 * the cursor while it is being typed. That gap is the whole subject of the
 * reset tests: CHUNKS is drained by a single fill and cannot show it.
 */
const LONG = Array.from(
  { length: 12 },
  (_, i) => `${'abcdefghijkl'[i]} alpha beta gamma delta epsilon zeta eta theta iota. `.repeat(2),
);
const LONG_TEXT = LONG.join('');

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

  it('starts part-way into a chunk, once, when the seek carries an offset', () => {
    registerWork(makeWork(PROSE, 'work/prose'));
    const stream = createStream('work/prose', DEFAULT_SETTINGS.layout);
    stream.seek?.(0, SECOND);

    const first = stream.next();
    expect(first?.text).toBe(PROSE[0]!.slice(SECOND));
    // chars is absolute in the work, and it counts the part that was skipped
    expect(first?.at).toEqual({ chunk: 0, chars: SECOND, offset: SECOND });

    // the offset is spent: the next chunk arrives whole
    const second = stream.next();
    expect(second?.text).toBe(PROSE[1]);
    expect(second?.at).toEqual({ chunk: 1, chars: PROSE[0]!.length, offset: 0 });
  });

  it('never skips a whole chunk: that would be an empty passage', () => {
    registerWork(makeWork(PROSE, 'work/prose'));
    const stream = createStream('work/prose', DEFAULT_SETTINGS.layout);
    stream.seek?.(0, 9999);
    expect(stream.next()?.text).toBe(PROSE[0]!.slice(PROSE[0]!.length - 1));
    stream.seek?.(0, -3);
    expect(stream.next()?.text).toBe(PROSE[0]);
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

  it('seek can land part-way into a chunk, and the mark stays chunk-relative', () => {
    registerWork(makeWork(PROSE, 'work/prose'));
    const resumed = new Runner(settings({ source: 'work/prose' }));
    resumed.seek(0, SECOND);
    expect(resumed.text).toBe(PROSE[0]!.slice(SECOND) + PROSE[1]);
    // offset counts from the top of the chunk, not from the top of the buffer:
    // a segment-relative offset would walk the bookmark back a sentence on every
    // resume
    expect(resumed.mark).toEqual({
      chunk: 0,
      offset: SECOND,
      chars: SECOND,
      total: PROSE.join('').length,
    });

    resumed.startNow(1000);
    resumed.handleKeydown(keyFor(s, resumed.text[resumed.cursor]!), 1100);
    expect(resumed.mark?.offset).toBe(SECOND + 1);
    expect(resumed.mark?.chars).toBe(SECOND + 1);
  });

  it('still finishes a work that was resumed part-way in', () => {
    registerWork(makeWork(PROSE, 'work/prose'));
    const resumed = new Runner(settings({ source: 'work/prose' }));
    resumed.seek(0, SECOND);
    let clock = 1000;
    resumed.startNow(clock);
    const rest = PROSE[0]!.slice(SECOND) + PROSE[1];
    for (let i = 0; i < rest.length; i++) {
      resumed.handleKeydown(keyFor(s, resumed.text[resumed.cursor]!), (clock += 100));
    }
    expect(resumed.phase).toBe('finished');
    expect(resumed.endReason).toBe('end');
  });

  it('seek rebuilds the buffer from the given chunk', () => {
    runner.seek(2);
    expect(runner.text).toBe(CHUNKS[2]);
    expect(runner.cursor).toBe(0);
    expect(runner.phase).toBe('idle');
    expect(runner.mark?.chunk).toBe(2);
  });

  it('reset rebuilds at the cursor, not at the stream', () => {
    registerWork(makeWork(LONG, 'work/long'));
    const long = new Runner(settings({ source: 'work/long' }));
    let clock = 1000;
    long.startNow(clock);
    // the stream is genuinely ahead: that is the state reset used to rebuild from
    expect(long.text.length).toBeGreaterThanOrEqual(700);
    expect(long.exhausted).toBe(false);

    for (let i = 0; i < 40; i++) {
      long.handleKeydown(keyFor(s, long.text[long.cursor]!), (clock += 100));
    }
    const before = long.mark!;
    expect(before.chars).toBe(40);

    long.reset();
    expect(long.phase).toBe('idle');
    expect(long.cursor).toBe(0);
    // the place is untouched by a reset, and the text under it is the text that
    // was under it — not whatever the buffer had run on ahead to
    expect(long.mark).toEqual(before);
    expect(long.text.length).toBeGreaterThan(0);
    expect(LONG_TEXT.slice(before.chars, before.chars + long.text.length)).toBe(long.text);
  });

  it('reset keeps the place even when the whole work was already buffered', () => {
    for (let i = 0; i < 3; i++) typeExpected();
    const before = runner.mark;
    runner.reset();
    expect(runner.text).toBe(WHOLE.slice(3));
    expect(runner.mark).toEqual(before);
  });

  it('reset on a finished work leaves it finished, not a character short', () => {
    for (let i = 0; i < WHOLE.length; i++) typeExpected();
    runner.reset();
    // the end of the work is the one place the offset is a whole chunk long,
    // which the stream's own clamp would turn into the last character
    expect(runner.text).toBe('');
    expect(runner.exhausted).toBe(true);
  });

  it('a seek is not undone by the rewind inside reset', () => {
    for (let i = 0; i < CHUNKS[0]!.length; i++) typeExpected();
    runner.seek(2);
    expect(runner.text).toBe(CHUNKS[2]);
    expect(runner.mark?.chunk).toBe(2);
    runner.seek(0);
    expect(runner.text).toBe(WHOLE);
    expect(runner.mark?.chunk).toBe(0);
  });

  it('a shuffle has nothing to rewind, and resets as it always did', () => {
    const shuffle = new Runner(settings({ source: 'prose' }));
    let clock = 1000;
    shuffle.startNow(clock);
    for (let i = 0; i < 5; i++) {
      shuffle.handleKeydown(keyFor(s, shuffle.text[shuffle.cursor]!), (clock += 100));
    }
    expect(() => shuffle.reset()).not.toThrow();
    expect(shuffle.mark).toBeUndefined();
    expect(shuffle.text.length).toBeGreaterThan(0);
  });

  it('changing the source rebuilds from the top of the new work', () => {
    registerWork(makeWork(PROSE, 'work/prose'));
    for (let i = 0; i < CHUNKS[0]!.length + 2; i++) typeExpected();
    // the place was measured in the stream being replaced, so a rebuild starts
    // at the top and it is main.ts's job to put the reader back
    expect(runner.configure(settings({ source: 'work/prose' }))).toBe(true);
    expect(runner.text).toBe(PROSE.join(''));
    expect(runner.mark?.chunk).toBe(0);
    expect(runner.mark?.chars).toBe(0);
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

  it('remembers the offset into the chunk, unrounded', () => {
    saveBookmark('work/test', { chunk: 3, offset: 47, chars: 400, stamp: 'abc' });
    expect(bookmarkOf(loadProgress(), 'work/test', 'abc').offset).toBe(47);
  });

  it('drops the offset when a writer moves the chunk without one', () => {
    saveBookmark('work/test', { chunk: 3, offset: 47, stamp: 'abc' });
    // a chapter jump says which chunk and nothing else; the old chunk's offset
    // means nothing in the new one
    saveBookmark('work/test', { chunk: 9, stamp: 'abc' });
    expect(bookmarkOf(loadProgress(), 'work/test', 'abc').offset).toBe(0);
  });

  it('keeps the offset when only the count of a sitting is written', () => {
    saveBookmark('work/test', { chunk: 3, offset: 47, stamp: 'abc' });
    saveBookmark('work/test', { sessions: 2 });
    expect(bookmarkOf(loadProgress(), 'work/test', 'abc').offset).toBe(47);
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
          'work/a': { chunk: -7, offset: 'nope', furthest: 'nope', chars: null, stamp: 'abc' },
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
    expect(works['work/a']!.offset).toBe(0);
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

describe('sentenceStart', () => {
  it('puts the top of a chunk at zero', () => {
    expect(sentenceStart(PROSE[0]!, 0)).toBe(0);
    expect(sentenceStart(PROSE[0]!, 4)).toBe(0);
  });

  it('walks back to the sentence the offset is inside', () => {
    expect(sentenceStart(PROSE[0]!, SECOND + 4)).toBe(SECOND);
    expect(sentenceStart(PROSE[0]!, THIRD + 1)).toBe(THIRD);
  });

  it('leaves an offset that is already a sentence start where it is', () => {
    // a sentence you finished is not handed back to you
    expect(sentenceStart(PROSE[0]!, SECOND)).toBe(SECOND);
    expect(sentenceStart(PROSE[0]!, THIRD)).toBe(THIRD);
  });

  it('never returns the end of the chunk', () => {
    // the last sentence ends at text.length, because the chunk carries its own
    // separator; seeking there would skip the chunk entirely
    expect(sentenceStart(PROSE[0]!, PROSE[0]!.length)).toBe(THIRD);
  });

  it('has nowhere to go in a chunk with no sentence end in it', () => {
    expect(sentenceStart(PROSE[1]!, 20)).toBe(0);
    expect(sentenceStart('', 0)).toBe(0);
  });

  it('needs the space, so a decimal is not a sentence', () => {
    expect(sentenceStart('it cost 3.14 in total. ', 12)).toBe(0);
  });

  it('reads an abbreviation as a sentence end, as the builder does', () => {
    // the cost is a resume that starts a few words later than it had to, which
    // is why this is pinned rather than fixed
    expect(sentenceStart('Mr. Smith went out. ', 10)).toBe(4);
  });

  it('cuts Japanese at 。 without asking for a space', () => {
    expect(sentenceStart('これはあれ。それはどれ。もうひとつ。', 8)).toBe(6);
    expect(sentenceStart('「あれ」といった。それから。', 20)).toBe(9);
  });

  it('lands on a unit boundary under every Japanese method', () => {
    // the hazard the offset exists against: a character offset can fall inside a
    // unit, half-way through romaji きゃ. A sentence start cannot, because a
    // sentence begins after 。 and no unit spans that.
    const text = 'きゃくがきた。しゃしんをとる。ぎゅうにゅう。';
    for (const method of ['romaji', 'nicola', 'asuka'] as const) {
      const spec: MethodSpec = {
        script: 'ja',
        latin: 'qwerty',
        ja: method,
        thumbs: { left: 'NonConvert', right: 'Convert' },
      };
      const starts = new Set(buildUnits(text, 0, spec).map((unit) => unit.start));
      for (let i = 0; i < text.length; i++) {
        expect(starts.has(sentenceStart(text, i)), `${method} at ${i}`).toBe(true);
      }
    }
  });
});

describe('resumePoint', () => {
  const work = makeWork(PROSE, 'work/prose');

  it('resumes at the top of the sentence that was interrupted', () => {
    const mark = { ...emptyBookmark('test'), chunk: 0, offset: SECOND + 5 };
    expect(resumePoint(mark, work)).toEqual({ chunk: 0, offset: SECOND });
  });

  it('resumes at the top of a paragraph when that is where you stopped', () => {
    const mark = { ...emptyBookmark('test'), chunk: 1, offset: 4 };
    expect(resumePoint(mark, work)).toEqual({ chunk: 1, offset: 0 });
  });

  it('drops the offset when the text has been re-cut underneath it', () => {
    const mark = { ...emptyBookmark('test'), chunk: 0, offset: SECOND + 5, stale: true };
    expect(resumePoint(mark, work)).toEqual({ chunk: 0, offset: 0 });
  });

  it('drops the offset when the work shrank and the chunk had to step back', () => {
    const mark = { ...emptyBookmark('test'), chunk: 40, offset: 12 };
    expect(resumePoint(mark, work)).toEqual({ chunk: 1, offset: 0 });
  });

  it('copes with an offset past the end of its chunk', () => {
    const mark = { ...emptyBookmark('test'), chunk: 0, offset: 9999 };
    expect(resumePoint(mark, work)).toEqual({ chunk: 0, offset: THIRD });
  });
});
