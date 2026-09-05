import { describe, expect, it } from 'vitest';

import { buildUnits, type MethodSpec } from '../src/core/method';

/**
 * What every Japanese method can actually produce.
 *
 * 写経 works are whole books, so they carry punctuation the all-kana sentence
 * corpus never had to think about — it simply dropped any sentence containing
 * it. Which characters are safe is not a matter of taste: a character no method
 * can key is one `enterUnit` steps over and marks Correct, so the typist is
 * credited for text they never typed. This pins the answer, so the builder's
 * stripping rule has something to be right or wrong against.
 */
const JA_SPECS: MethodSpec[] = (['romaji', 'nicola', 'asuka'] as const).map((ja) => ({
  script: 'ja',
  latin: 'qwerty',
  ja,
  thumbs: { left: 'NonConvert', right: 'Convert' },
}));

/** Exactly the question main.ts's startup coverage check asks. */
const canType = (spec: MethodSpec, ch: string): boolean => {
  const units = buildUnits(ch, 0, spec);
  return units.length > 0 && units.every((u) => u.sequences.length > 0);
};

const everyMethodTypes = (ch: string): boolean => JA_SPECS.every((spec) => canType(spec, ch));

describe('the Japanese methods', () => {
  it('all produce kana, the long vowel, and the three separators', () => {
    for (const ch of [...'ー、。・', ...'あんカヴぁっ']) {
      expect(everyMethodTypes(ch), ch).toBe(true);
    }
  });

  it('do not all produce the bracket and exclamation punctuation of running prose', () => {
    // build-shakyo-ja.mjs strips these from the typed text for this reason, and
    // rewrites ！？ to 。 rather than dropping the sentence end with them
    for (const ch of [...'「」『』？！（）：；']) {
      expect(everyMethodTypes(ch), ch).toBe(false);
    }
  });

  it('cannot produce historical kana, which is why readings are modernised', () => {
    // romaji can (wi/we), but the thumb-shift layouts have no position for them,
    // and inventing one would teach wrong fingering against a published chart
    for (const ch of [...'ゐゑ']) {
      expect(everyMethodTypes(ch), ch).toBe(false);
    }
  });
});
