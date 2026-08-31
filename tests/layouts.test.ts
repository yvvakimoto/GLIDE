import { describe, expect, it } from 'vitest';

import { corpusCharset, createStream, listSources } from '../src/core/corpus';
import { PHYS_KEYS, physKey } from '../src/core/keyboard-geometry';
import { charFor, charIndex, getLayout, keyLabel, LAYOUTS, resolveChar } from '../src/core/layouts';

describe('layouts', () => {
  it('maps the same 48 physical keys in every layout', () => {
    for (const layout of LAYOUTS) {
      const codes = Object.keys(layout.map);
      expect(codes.length, layout.id).toBe(48); // 13 + 13 + 11 + 10 + space
      for (const code of codes) expect(physKey(code), `${layout.id} ${code}`).toBeDefined();
    }
  });

  it('can type every character in the bundled English corpora', () => {
    const charset = corpusCharset('latin');
    expect(charset.size).toBeGreaterThan(60);
    for (const layout of LAYOUTS) {
      const index = charIndex(layout.id);
      const missing = [...charset].filter((c) => !index.has(c));
      expect(missing, `${layout.id} is missing ${JSON.stringify(missing)}`).toEqual([]);
    }
  });

  it('remaps physical keys to Dvorak characters', () => {
    expect(charFor('dvorak', 'KeyU', false)).toBe('g');
    expect(charFor('dvorak', 'KeyK', false)).toBe('t');
    expect(charFor('dvorak', 'Semicolon', false)).toBe('s');
    expect(charFor('dvorak', 'KeyQ', true)).toBe('"');
    expect(charFor('dvorak', 'Minus', false)).toBe('[');
  });

  it('keeps QWERTY as the identity mapping', () => {
    expect(charFor('qwerty', 'KeyA', false)).toBe('a');
    expect(charFor('qwerty', 'KeyA', true)).toBe('A');
    expect(charFor('qwerty', 'Slash', false)).toBe('/');
    expect(charFor('qwerty', 'Slash', true)).toBe('?');
    expect(charFor('qwerty', 'Backslash', false)).toBe('\\');
    expect(charFor('qwerty', 'Backslash', true)).toBe('|');
  });

  it('round-trips characters back to the key that produces them', () => {
    for (const layout of LAYOUTS) {
      for (const [code, [lower, upper]] of Object.entries(getLayout(layout.id).map)) {
        for (const [char, shift] of [
          [lower, false],
          [upper, true],
        ] as Array<[string, boolean]>) {
          const stroke = resolveChar(layout.id, char);
          expect(stroke, `${layout.id} ${char}`).toBeDefined();
          // another key may own the same character first; what matters is that
          // pressing the resolved key with the resolved modifier yields the char
          expect(charFor(layout.id, stroke!.key.code, stroke!.shift)).toBe(char);
          expect(charFor(layout.id, code, shift)).toBe(char);
        }
      }
    }
  });

  it('labels letter keys in uppercase and punctuation with its shifted pair', () => {
    const a = physKey('KeyA')!;
    expect(keyLabel('dvorak', a)).toEqual({ main: 'A' });
    const slash = physKey('Slash')!;
    expect(keyLabel('qwerty', slash)).toEqual({ main: '/', sub: '?' });
  });

  it('assigns every physical key to a finger, with eight home positions', () => {
    expect(PHYS_KEYS.filter((k) => k.home).length).toBe(8);
    for (const key of PHYS_KEYS) expect(key.finger, key.code).toBeTruthy();
  });
});

describe('corpus', () => {
  it('offers prose, drill and code sources', () => {
    const sources = listSources();
    for (const kind of ['prose', 'drill', 'code'] as const) {
      expect(sources.some((s) => s.kind === kind), kind).toBe(true);
    }
  });

  it('streams passages that always end with a separator space', () => {
    for (const id of ['prose', 'drill-home', 'drill-bigrams', 'code']) {
      const stream = createStream(id, 'dvorak');
      for (let i = 0; i < 20; i++) {
        const passage = stream.next();
        expect(passage.text.length, id).toBeGreaterThan(8);
        expect(passage.text.endsWith(' '), id).toBe(true);
        expect(passage.attribution.title.length, id).toBeGreaterThan(0);
      }
    }
  });

  it('keeps home-row drills on the layout home row', () => {
    const stream = createStream('drill-home', 'dvorak');
    const allowed = new Set('aoeuidhtns- ');
    const text = Array.from({ length: 12 }, () => stream.next().text).join('');
    const stray = [...text].filter((c) => !allowed.has(c));
    expect(stray).toEqual([]);
  });
});
