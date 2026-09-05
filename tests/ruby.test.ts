import { describe, expect, it } from 'vitest';

import { readRuby } from '../scripts/lib/ruby.mjs';

/** The markup Aozora actually emits. */
const ruby = (base: string, reading: string) =>
  `<ruby><rb>${base}</rb><rp>（</rp><rt>${reading}</rt><rp>）</rp></ruby>`;

describe('readRuby', () => {
  it('passes plain text through with nothing to display', () => {
    const out = readRuby('そのばんの ことです。');
    expect(out.text).toBe('そのばんの ことです。');
    expect(out.display).toEqual([]);
  });

  it('types the reading and shows the base', () => {
    const out = readRuby(ruby('銀河', 'ぎんが'));
    expect(out.text).toBe('ぎんが');
    expect(out.display).toEqual([[0, 3, '銀河']]);
  });

  it('indexes the typed string, not the markup', () => {
    const out = readRuby(`あの${ruby('銀河', 'ぎんが')}のはずれ`);
    expect(out.text).toBe('あのぎんがのはずれ');
    expect(out.display).toEqual([[2, 3, '銀河']]);
    const [start, len, base] = out.display[0]!;
    expect(out.text.slice(start, start + len)).toBe('ぎんが');
    expect(base).toBe('銀河');
  });

  it('keeps two ruby runs apart', () => {
    const out = readRuby(`${ruby('風', 'かぜ')}と${ruby('雲', 'くも')}`);
    expect(out.text).toBe('かぜとくも');
    expect(out.display).toEqual([
      [0, 2, '風'],
      [3, 2, '雲'],
    ]);
  });

  it('drops editorial markup without shifting the offsets after it', () => {
    const out = readRuby(`［＃５字下げ］${ruby('峠', 'とうげ')}をこえた`);
    expect(out.text).toBe('とうげをこえた');
    expect(out.display).toEqual([[0, 3, '峠']]);
  });

  it('drops the 《…》 form and its ｜ anchor', () => {
    const out = readRuby('｜山《やま》のうえ');
    expect(out.text).toBe('山のうえ');
    expect(out.display).toEqual([]);
  });

  it('keeps the text inside emphasis and other inline tags', () => {
    const out = readRuby('しずかな<em class="sesame_dot">よる</em>でした');
    expect(out.text).toBe('しずかなよるでした');
  });

  it('turns a line break into a newline, not into nothing', () => {
    expect(readRuby('うえ<br />した').text).toBe('うえ\nした');
  });

  it('modernises historical kana in body text and shows the original', () => {
    const out = readRuby('ゐなか');
    expect(out.text).toBe('いなか');
    expect(out.display).toEqual([[0, 1, 'ゐ']]);
  });

  it('shows the kanji, not the old kana, when the two coincide', () => {
    // inside a reading the display is already the kanji; that is what belongs
    // on screen, and the typed text still has to be something a kana layout can
    // produce
    const out = readRuby(ruby('居', 'ゐ'));
    expect(out.text).toBe('い');
    expect(out.display).toEqual([[0, 1, '居']]);
  });

  it('counts gaiji rather than swallowing them', () => {
    const out = readRuby('<img src="../../../gaiji/1-2/1-2-22.png" class="gaiji" />のこと');
    expect(out.gaiji).toBe(1);
    expect(out.text).toBe('のこと');
  });

  it('treats ruby with no reading as plain text', () => {
    const out = readRuby('<ruby><rb>山</rb><rt></rt></ruby>');
    expect(out.text).toBe('山');
    expect(out.display).toEqual([]);
  });

  it('produces spans that are sorted, non-overlapping and inside the text', () => {
    const out = readRuby(
      `${ruby('春', 'はる')}と${ruby('修羅', 'しゅら')}、ゐどばたの${ruby('話', 'はなし')}`,
    );
    let previousEnd = 0;
    for (const [start, len] of out.display) {
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(len).toBeGreaterThan(0);
      expect(start + len).toBeLessThanOrEqual(out.text.length);
      previousEnd = start + len;
    }
  });
});
