import { describe, expect, it } from 'vitest';

import { corpusCharset, createStream, listSources } from '../src/core/corpus';
import { romajiUnits, toHiragana } from '../src/core/kana';
import { KANA_LAYOUTS, kanaFor, kanaIndex, type KanaLayoutId } from '../src/core/kana-layouts';
import { buildUnits, methodKind, type MethodSpec } from '../src/core/method';

/**
 * `next()` returns null only when an ordered work runs out. Every source here is
 * endless, so a null is a bug worth failing on rather than a `!` worth writing.
 */
type Stream = ReturnType<typeof createStream>;
const nextOf = (stream: Stream) => {
  const passage = stream.next();
  if (!passage) throw new Error(`${stream.id} ran out, but only an ordered work does that`);
  return passage;
};


const THUMBS = { left: 'NonConvert', right: 'Convert' };
const spec = (ja: MethodSpec['ja']): MethodSpec => ({ script: 'ja', latin: 'qwerty', ja, thumbs: THUMBS });

/** The canonical spelling of a piece of kana text under one method. */
const canonical = (text: string, method: MethodSpec['ja']): string =>
  buildUnits(text, 0, spec(method))
    .flatMap((unit) => unit.sequences[0] ?? [])
    .map((chord) => chord.label)
    .join('');

describe('kana normalisation', () => {
  it('folds katakana onto hiragana for lookup', () => {
    expect(toHiragana('ガラス')).toBe('がらす');
    expect(toHiragana('シャツ')).toBe('しゃつ');
    expect(toHiragana('あア、。')).toBe('ああ、。');
  });
});

describe('romaji segmentation', () => {
  it('keeps one unit per kana and merges youon', () => {
    expect(romajiUnits('あい').map((u) => u.text)).toEqual(['あ', 'い']);
    expect(romajiUnits('きゃく').map((u) => u.text)).toEqual(['きゃ', 'く']);
    expect(romajiUnits('しゅうしょく').map((u) => u.text)).toEqual(['しゅ', 'う', 'しょ', 'く']);
  });

  it('accepts every mainstream spelling of a kana', () => {
    const shi = romajiUnits('し')[0]!;
    expect(shi.spellings).toContain('si');
    expect(shi.spellings).toContain('shi');
    const ja = romajiUnits('じゃ')[0]!;
    expect(ja.spellings).toEqual(expect.arrayContaining(['zya', 'ja', 'jya']));
  });

  it('doubles the following consonant for っ', () => {
    const [sokuon, ka] = romajiUnits('っか');
    expect(sokuon!.spellings).toContain('k');
    expect(sokuon!.spellings).toContain('xtu');
    expect(ka!.spellings[0]).toBe('ka');
    // both ssi and sshi must survive, since し accepts si and shi
    expect(romajiUnits('っし')[0]!.spellings).toContain('s');
  });

  it('spells っ out when nothing follows it', () => {
    expect(romajiUnits('っ')[0]!.spellings).toEqual(['xtu', 'ltu']);
  });

  it('lets ん be a single n only when the next sound cannot swallow it', () => {
    const before_ka = romajiUnits('んか')[0]!;
    expect(before_ka.spellings[0]).toBe('n');
    expect(before_ka.absorb).toBe('n');

    for (const risky of ['んあ', 'んな', 'んや']) {
      const unit = romajiUnits(risky)[0]!;
      expect(unit.spellings, risky).not.toContain('n');
      expect(unit.spellings[0], risky).toBe('nn');
      expect(unit.absorb, risky).toBeUndefined();
    }
    // at the very end of the text there is nothing to disambiguate against
    expect(romajiUnits('ん')[0]!.spellings[0]).toBe('nn');
  });

  it('spells whole phrases the way an IME would', () => {
    expect(canonical('かいてき', 'romaji')).toBe('kaiteki');
    expect(canonical('きっぷ', 'romaji')).toBe('kippu');
    expect(canonical('しんぶん', 'romaji')).toBe('sinbunn');
    expect(canonical('ちゃんと', 'romaji')).toBe('tyanto');
    expect(canonical('こんにちは', 'romaji')).toBe('konnnitiha');
    expect(canonical('ー、。', 'romaji')).toBe('-,.');
  });
});

describe('kana layouts', () => {
  it('gives each layout three distinct faces per key', () => {
    for (const layout of KANA_LAYOUTS) {
      const faces = Object.values(layout.map);
      expect(faces.length, layout.id).toBeGreaterThan(28);
      for (const [alone, left, right] of faces) {
        const used = [alone, left, right].filter(Boolean);
        expect(new Set(used).size, `${layout.id} ${used.join('/')}`).toBe(used.length);
      }
    }
  });

  it('covers every kana of the fifty sounds, voiced and small', () => {
    const required = [
      ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
      ...'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
      ...'ぁぃぅぇぉゃゅょっ',
      ...'ー、。',
    ];
    for (const layout of KANA_LAYOUTS) {
      const index = kanaIndex(layout.id);
      const missing = required.filter((kana) => !index.has(kana));
      expect(missing, `${layout.id} is missing ${missing.join('')}`).toEqual([]);
    }
  });

  it('round-trips kana through the key that produces it', () => {
    for (const layout of KANA_LAYOUTS) {
      for (const [kana, press] of kanaIndex(layout.id)) {
        expect(kanaFor(layout.id, press.code, press.thumb), `${layout.id} ${kana}`).toBe(kana);
      }
    }
  });

  it('places NICOLA the way the specification chart does', () => {
    const at = (kana: string) => kanaIndex('nicola').get(kana);
    expect(at('う')).toEqual({ code: 'KeyA', thumb: 'none' });
    expect(at('ん')).toEqual({ code: 'Semicolon', thumb: 'none' });
    expect(at('あ')).toEqual({ code: 'KeyS', thumb: 'left' });
    expect(at('お')).toEqual({ code: 'KeyJ', thumb: 'right' });
    expect(at('が')).toEqual({ code: 'KeyW', thumb: 'right' });
    expect(at('ば')).toEqual({ code: 'KeyH', thumb: 'left' });
    expect(at('ぱ')).toEqual({ code: 'KeyY', thumb: 'left' });
    expect(at('っ')).toEqual({ code: 'Semicolon', thumb: 'right' });
    expect(at('ー')).toEqual({ code: 'KeyX', thumb: 'left' });
  });

  it('places 飛鳥123 the way its definition file does', () => {
    const at = (kana: string) => kanaIndex('asuka').get(kana);
    expect(at('き')).toEqual({ code: 'KeyA', thumb: 'none' });
    expect(at('ん')).toEqual({ code: 'KeyJ', thumb: 'none' });
    expect(at('っ')).toEqual({ code: 'KeyM', thumb: 'none' });
    expect(at('ー')).toEqual({ code: 'KeyW', thumb: 'none' });
    expect(at('あ')).toEqual({ code: 'KeyS', thumb: 'left' });
    expect(at('お')).toEqual({ code: 'KeyS', thumb: 'right' });
    // 清濁別置: the voiced kana sits on its own key, not on か + a thumb
    expect(at('が')).toEqual({ code: 'KeyD', thumb: 'left' });
    expect(at('か')).toEqual({ code: 'KeyL', thumb: 'none' });
    expect(at('、')).toEqual({ code: 'Comma', thumb: 'left' });
    expect(at('。')).toEqual({ code: 'Period', thumb: 'left' });
  });

  it('builds one single-press unit per kana', () => {
    for (const layout of KANA_LAYOUTS) {
      const units = buildUnits('かんじ', 0, spec(layout.id));
      expect(units.length, layout.id).toBe(3);
      for (const unit of units) {
        expect(unit.sequences.length, layout.id).toBe(1);
        expect(unit.sequences[0]!.length, layout.id).toBe(1);
      }
    }
  });

  it('reports the method kind', () => {
    expect(methodKind({ script: 'latin', latin: 'dvorak', ja: 'romaji', thumbs: THUMBS })).toBe('latin');
    expect(methodKind(spec('romaji'))).toBe('romaji');
    expect(methodKind(spec('nicola'))).toBe('kana');
    expect(methodKind(spec('asuka'))).toBe('kana');
  });
});

describe('Japanese corpus', () => {
  it('can be typed end to end by every method', () => {
    const charset = corpusCharset('ja');
    expect(charset.size).toBeGreaterThan(60);
    for (const method of ['romaji', 'nicola', 'asuka'] as const) {
      const unmappable = [...charset].filter((char) => {
        const units = buildUnits(char, 0, spec(method));
        return units.length === 0 || units.some((u) => u.sequences.length === 0);
      });
      expect(unmappable, `${method} cannot type ${unmappable.join('')}`).toEqual([]);
    }
  });

  it('offers Japanese prose and drills, all in kana', () => {
    const japanese = listSources().filter((s) => s.script === 'ja');
    expect(japanese.length).toBeGreaterThan(4);
    const kanaOnly = /^[ぁ-ゖァ-ヺー、。]+$/;
    for (const source of japanese) {
      const stream = createStream(source.id, 'qwerty');
      for (let i = 0; i < 8; i++) {
        const passage = nextOf(stream);
        expect(passage.text.length, source.id).toBeGreaterThan(4);
        expect(kanaOnly.test(passage.text), `${source.id}: ${passage.text}`).toBe(true);
      }
    }
  });

  it('does not pad Japanese passages with spaces', () => {
    const stream = createStream('ja', 'qwerty');
    for (let i = 0; i < 10; i++) expect(nextOf(stream).text).not.toContain(' ');
  });
});

describe('kana layout ids', () => {
  it('exposes exactly the two layouts the settings offer', () => {
    const ids: KanaLayoutId[] = KANA_LAYOUTS.map((l) => l.id);
    expect(ids).toEqual(['nicola', 'asuka']);
  });
});
