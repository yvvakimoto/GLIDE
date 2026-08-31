/**
 * The input-method layer: turns text into the keystrokes that produce it.
 *
 * Everything downstream — the runner, the ribbon, the hands, the keycaps —
 * speaks in `Chord`s (one physical press) and `Unit`s (one thing you type, which
 * may take several presses and may accept several spellings). Latin typing is
 * the degenerate case: one unit, one sequence, one chord.
 */

import { romajiUnits, toHiragana } from './kana';
import {
  getKanaLayout,
  kanaFor,
  kanaIndex,
  thumbDrawKey,
  type KanaLayoutId,
  type Thumb,
} from './kana-layouts';
import { physKey } from './keyboard-geometry';
import { charIndex, getLayout, keyLabel, resolveChar, type LayoutId } from './layouts';
import type { LabelMode } from './settings';

export type Script = 'latin' | 'ja';
export type JaMethod = 'romaji' | KanaLayoutId;
export type MethodKind = 'latin' | 'romaji' | 'kana';

export type MethodSpec = {
  script: Script;
  /** latin layout, used for latin text and for romaji */
  latin: LayoutId;
  /** how Japanese is typed */
  ja: JaMethod;
  /** which physical keys carry the thumb-shift roles */
  thumbs: { left: string; right: string };
};

/** The key a thumb role is drawn on, for this spec. */
export const thumbKeyOf = (spec: MethodSpec, role: Exclude<Thumb, 'none'>): string =>
  thumbDrawKey(role, role === 'left' ? spec.thumbs.left : spec.thumbs.right);

export type Chord = {
  code: string;
  shift: boolean;
  thumb: Thumb;
  /** what this press produces, for display on dots and fingertips */
  label: string;
};

export type Unit = {
  /** index of the first character in the run text */
  start: number;
  /** characters this unit covers */
  text: string;
  /** accepted keystroke sequences, canonical first */
  sequences: Chord[][];
  /** a chord that may be pressed once more without penalty (the second n of ん) */
  absorb?: Chord;
};

export const methodKind = (spec: MethodSpec): MethodKind =>
  spec.script === 'latin' ? 'latin' : spec.ja === 'romaji' ? 'romaji' : 'kana';

export const chordEquals = (a: Chord, b: Chord): boolean =>
  a.code === b.code && a.shift === b.shift && a.thumb === b.thumb;

function latinChord(layout: LayoutId, char: string): Chord | undefined {
  const stroke = resolveChar(layout, char);
  if (!stroke) return undefined;
  return { code: stroke.key.code, shift: stroke.shift, thumb: 'none', label: char };
}

function spellingToChords(layout: LayoutId, spelling: string): Chord[] | undefined {
  const chords: Chord[] = [];
  for (const letter of spelling) {
    const chord = latinChord(layout, letter);
    if (!chord) return undefined;
    chords.push(chord);
  }
  return chords;
}

/**
 * Segments `text` into units. `offset` is where this text starts in the run
 * buffer, so unit positions line up with the character states.
 */
export function buildUnits(text: string, offset: number, spec: MethodSpec): Unit[] {
  const kind = methodKind(spec);

  if (kind === 'latin') {
    return [...text].map((char, i) => {
      const chord = latinChord(spec.latin, char);
      return {
        start: offset + i,
        text: char,
        sequences: chord ? [[chord]] : [],
      };
    });
  }

  if (kind === 'romaji') {
    const units: Unit[] = [];
    let at = offset;
    for (const unit of romajiUnits(text)) {
      const sequences = unit.spellings
        .map((spelling) => spellingToChords(spec.latin, spelling))
        .filter((chords): chords is Chord[] => chords !== undefined);
      const absorb = unit.absorb ? latinChord(spec.latin, unit.absorb) : undefined;
      units.push({
        start: at,
        text: unit.text,
        sequences,
        ...(absorb ? { absorb } : {}),
      });
      at += unit.text.length;
    }
    return units;
  }

  const layout = spec.ja as KanaLayoutId;
  const index = kanaIndex(layout);
  return [...text].map((char, i) => {
    const press = index.get(char) ?? index.get(toHiragana(char));
    return {
      start: offset + i,
      text: char,
      sequences: press
        ? [[{ code: press.code, shift: false, thumb: press.thumb, label: char }]]
        : [],
    };
  });
}

/** Short legends for the keys that can take a thumb role. */
const THUMB_LEGEND: Readonly<Record<string, string>> = {
  NonConvert: '無変換',
  Convert: '変換',
  KanaMode: 'かな',
  Space: '親指',
  AltLeft: 'alt',
  AltRight: 'alt',
};

export type KeyLabel = {
  main: string;
  /** shifted form, for latin punctuation keys */
  sub?: string;
  /** left-thumb face */
  tl?: string;
  /** right-thumb face */
  tr?: string;
};

/** What to paint on each keycap. */
export function keyLabels(spec: MethodSpec, mode: LabelMode): Map<string, KeyLabel> {
  const labels = new Map<string, KeyLabel>();
  const kind = methodKind(spec);

  if (kind === 'kana') {
    const layout = getKanaLayout(spec.ja as KanaLayoutId);
    for (const [code, faces] of Object.entries(layout.map)) {
      const key = physKey(code);
      if (!key) continue;
      if (mode === 'blank') continue;
      if (mode === 'physical') {
        labels.set(code, keyLabel('qwerty', key));
        continue;
      }
      const [alone, left, right] = faces;
      labels.set(code, {
        main: alone,
        ...(left ? { tl: left } : {}),
        ...(right ? { tr: right } : {}),
      });
    }
    // the two thumb-shift keys, labelled with whichever key is assigned to them
    for (const role of ['left', 'right'] as const) {
      const assigned = role === 'left' ? spec.thumbs.left : spec.thumbs.right;
      labels.set(thumbDrawKey(role, assigned), { main: THUMB_LEGEND[assigned] ?? assigned });
    }
    return labels;
  }

  if (mode === 'blank') return labels;
  const source: LayoutId = mode === 'physical' ? 'qwerty' : spec.latin;
  for (const code of Object.keys(getLayout(spec.latin).map)) {
    const key = physKey(code);
    if (key) labels.set(code, keyLabel(source, key));
  }
  return labels;
}

/** The character a press produces right now, for reporting a mistype. */
export function labelOfPress(
  spec: MethodSpec,
  press: { code: string; shift: boolean; thumb: Thumb },
): string | undefined {
  if (methodKind(spec) === 'kana') return kanaFor(spec.ja as KanaLayoutId, press.code, press.thumb);
  const pair = getLayout(spec.latin).map[press.code];
  if (!pair) return undefined;
  return (press.shift ? pair[1] : pair[0]) || undefined;
}

/** Characters this method can produce at all — used by the startup self-check. */
export function methodCharset(spec: MethodSpec): Set<string> {
  const kind = methodKind(spec);
  if (kind === 'kana') return new Set(kanaIndex(spec.ja as KanaLayoutId).keys());
  return new Set(charIndex(spec.latin).keys());
}
