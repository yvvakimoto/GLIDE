/**
 * Text sources: bundled public-domain prose in English and Japanese, code
 * snippets, and layout-aware generated drills.
 *
 * Drills are generated per layout, not stored: "home row" means the home row of
 * whatever layout is active, so the same drill teaches Dvorak's `aoeuidhtns` and
 * QWERTY's `asdfghjkl` without a second data file.
 *
 * The Japanese passages are all-kana by construction (see
 * scripts/build-corpus-ja.mjs) because typing kanji would mean an IME conversion
 * step, which is not what a finger-motion trainer is for.
 */

import proseData from '../corpus/prose.json';
import codeData from '../corpus/code.json';
import drillData from '../corpus/drills.json';
import jaData from '../corpus/ja.json';
import jaDrillData from '../corpus/ja-drills.json';
import { getLayout, type LayoutId } from './layouts';
import { physKey, type Finger } from './keyboard-geometry';
import type { Script } from './method';

export type SourceKind = 'prose' | 'code' | 'drill';

export type SourceOption = {
  id: string;
  label: string;
  sublabel: string;
  kind: SourceKind;
  script: Script;
  group: string;
};

export type Attribution = {
  title: string;
  author: string;
  url?: string;
};

export type Passage = {
  text: string;
  attribution: Attribution;
};

export type TextStream = {
  id: string;
  label: string;
  script: Script;
  next(): Passage;
};

type Book = {
  id: string;
  title: string;
  author: string;
  url: string;
  passages: string[];
};

const BOOKS: Book[] = proseData.sources.map((s) => ({
  id: s.id,
  title: s.title,
  author: s.author,
  url: s.url,
  passages: s.passages,
}));

const CODE_SETS = codeData.sources.map((s) => ({
  id: s.id,
  title: s.title,
  author: s.author,
  passages: s.passages,
}));

const JA_AUTHORS = jaData.sources.map((s) => ({
  id: s.id,
  author: s.author,
  url: s.url,
  // ja.json carries a per-work entry (title, 底本, 入力/校正) so the credits
  // 青空文庫 asks redistributors to keep survive the build; the picker only
  // needs how many there were.
  works: s.works.length,
  passages: s.passages,
}));

const DRILLS = [
  { id: 'drill-words', label: 'Common words', sublabel: 'top 1200 words by frequency' },
  { id: 'drill-home', label: 'Home row only', sublabel: 'words your layout keeps on row 2' },
  { id: 'drill-bigrams', label: 'Bigram burst', sublabel: 'the most frequent letter pairs' },
  { id: 'drill-trigrams', label: 'Trigram burst', sublabel: 'the most frequent letter triples' },
  { id: 'drill-weak', label: 'Weak fingers', sublabel: 'ring and pinky heavy words' },
] as const;

const JA_DRILLS = [
  { id: 'ja-drill-words', label: 'Kana words', sublabel: 'frequent readings, harvested from ruby' },
  { id: 'ja-drill-bigrams', label: 'Kana pairs', sublabel: 'the most frequent two-kana runs' },
  { id: 'ja-drill-trigrams', label: 'Kana triples', sublabel: 'the most frequent three-kana runs' },
] as const;

export function listSources(): SourceOption[] {
  return [
    {
      id: 'prose',
      label: 'Prose shuffle',
      sublabel: `all ${BOOKS.length} books, mixed`,
      kind: 'prose',
      script: 'latin',
      group: 'Prose (English)',
    },
    ...BOOKS.map((b): SourceOption => ({
      id: b.id,
      label: b.title,
      sublabel: b.author,
      kind: 'prose',
      script: 'latin',
      group: 'Prose (English)',
    })),
    {
      id: 'ja',
      label: 'Kana prose shuffle',
      sublabel: `${JA_AUTHORS.length} Aozora authors, mixed`,
      kind: 'prose',
      script: 'ja',
      group: 'Japanese (all kana)',
    },
    ...JA_AUTHORS.map((a): SourceOption => ({
      id: a.id,
      label: a.author,
      sublabel: `${a.works} works`,
      kind: 'prose',
      script: 'ja',
      group: 'Japanese (all kana)',
    })),
    ...JA_DRILLS.map((d): SourceOption => ({
      id: d.id,
      label: d.label,
      sublabel: d.sublabel,
      kind: 'drill',
      script: 'ja',
      group: 'Japanese (all kana)',
    })),
    ...DRILLS.map((d): SourceOption => ({
      id: d.id,
      label: d.label,
      sublabel: d.sublabel,
      kind: 'drill',
      script: 'latin',
      group: 'Drills (English)',
    })),
    {
      id: 'code',
      label: 'Code shuffle',
      sublabel: 'all snippet sets, mixed',
      kind: 'code',
      script: 'latin',
      group: 'Code',
    },
    ...CODE_SETS.map((c): SourceOption => ({
      id: c.id,
      label: c.title,
      sublabel: c.author,
      kind: 'code',
      script: 'latin',
      group: 'Code',
    })),
  ];
}

const BY_ID = new Map(listSources().map((s) => [s.id, s]));

export function sourceLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function sourceScript(id: string): Script {
  return BY_ID.get(id)?.script ?? 'latin';
}

function pick<T>(items: readonly T[]): T | undefined {
  if (!items.length) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/** A shuffled bag, so passages don't repeat until the whole set has been seen. */
function bag<T>(items: readonly T[]): () => T | undefined {
  let queue: T[] = [];
  return () => {
    if (!items.length) return undefined;
    if (!queue.length) {
      queue = [...items];
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const a = queue[i]!;
        queue[i] = queue[j]!;
        queue[j] = a;
      }
    }
    return queue.pop();
  };
}

/** Letters the layout puts on a given physical row. */
function lettersOnRow(layout: LayoutId, row: number): Set<string> {
  const set = new Set<string>();
  for (const [code, [lower]] of Object.entries(getLayout(layout).map)) {
    const key = physKey(code);
    if (key?.row === row && /^[a-z]$/.test(lower)) set.add(lower);
  }
  return set;
}

/** Letters the layout assigns to the given fingers. */
function lettersOnFingers(layout: LayoutId, fingers: readonly Finger[]): Set<string> {
  const wanted = new Set(fingers);
  const set = new Set<string>();
  for (const [code, [lower]] of Object.entries(getLayout(layout).map)) {
    const key = physKey(code);
    if (key && wanted.has(key.finger) && /^[a-z]$/.test(lower)) set.add(lower);
  }
  return set;
}

const DRILL_TOKENS = 12;

function tokenDrill(tokens: readonly string[], count = DRILL_TOKENS): string {
  const source = tokens.length ? tokens : ['the'];
  return Array.from({ length: count }, () => pick(source)!).join(' ');
}

/** Turns n-grams into pronounceable-ish tokens so the hands keep a rhythm. */
function gramDrill(grams: readonly string[], count = 10): string {
  const source = grams.length ? grams : ['th'];
  return Array.from({ length: count }, () => {
    const a = pick(source)!;
    const b = pick(source)!;
    return Math.random() < 0.5 ? a.repeat(3) : a + b + a;
  }).join(' ');
}

function makeLatinDrill(id: string, layout: LayoutId): TextStream {
  const meta = DRILLS.find((d) => d.id === id) ?? DRILLS[0];
  const attribution: Attribution = { title: meta.label, author: 'generated drill' };

  const only = (allowed: Set<string>, min = 60) => {
    const kept = drillData.words.filter((w) => [...w].every((c) => allowed.has(c)));
    return kept.length >= min ? kept : drillData.words.slice(0, 300);
  };

  let nextText: () => string;
  switch (id) {
    case 'drill-home': {
      const words = only(lettersOnRow(layout, 2));
      nextText = () => tokenDrill(words);
      break;
    }
    case 'drill-weak': {
      const weak = lettersOnFingers(layout, ['l5', 'l4', 'r4', 'r5']);
      const scored = drillData.words
        .map((w) => ({ w, score: [...w].filter((c) => weak.has(c)).length / w.length }))
        .filter((e) => e.score >= 0.4)
        .map((e) => e.w);
      const words = scored.length >= 60 ? scored : drillData.words.slice(0, 300);
      nextText = () => tokenDrill(words);
      break;
    }
    case 'drill-bigrams':
      nextText = () => gramDrill(drillData.bigrams);
      break;
    case 'drill-trigrams':
      nextText = () => gramDrill(drillData.trigrams);
      break;
    default:
      nextText = () => tokenDrill(drillData.words);
  }

  return {
    id,
    label: meta.label,
    script: 'latin',
    next: () => ({ text: `${nextText()} `, attribution }),
  };
}

/** Japanese drills. Kana runs together, so 、 separates the tokens instead of a space. */
function makeJaDrill(id: string): TextStream {
  const meta = JA_DRILLS.find((d) => d.id === id) ?? JA_DRILLS[0];
  const attribution: Attribution = { title: meta.label, author: 'generated drill' };

  const nextText = (): string => {
    switch (id) {
      case 'ja-drill-bigrams':
        return `${Array.from({ length: 12 }, () => pick(jaDrillData.bigrams)!.repeat(2)).join('、')}。`;
      case 'ja-drill-trigrams':
        return `${Array.from({ length: 9 }, () => pick(jaDrillData.trigrams)!.repeat(2)).join('、')}。`;
      default:
        return `${Array.from({ length: 10 }, () => pick(jaDrillData.words)!).join('、')}。`;
    }
  };

  return { id, label: meta.label, script: 'ja', next: () => ({ text: nextText(), attribution }) };
}

function makePassageStream(
  id: string,
  label: string,
  script: Script,
  entries: ReadonlyArray<{ text: string; attribution: Attribution }>,
): TextStream {
  const draw = bag(entries);
  const separator = script === 'ja' ? '' : ' ';
  const fallback = {
    text: script === 'ja' ? 'あいうえお。' : 'the quick brown fox jumps over the lazy dog ',
    attribution: { title: label, author: '' },
  };
  return {
    id,
    label,
    script,
    next: () => {
      const entry = draw();
      if (!entry) return fallback;
      return { text: `${entry.text}${separator}`, attribution: entry.attribution };
    },
  };
}

/** Creates the passage stream for a source id; unknown ids fall back to mixed prose. */
export function createStream(sourceId: string, layout: LayoutId): TextStream {
  if (sourceId.startsWith('ja-drill-')) return makeJaDrill(sourceId);
  if (sourceId.startsWith('drill-')) return makeLatinDrill(sourceId, layout);

  const jaEntries = (authors: typeof JA_AUTHORS) =>
    authors.flatMap((a) =>
      a.passages.map((text) => ({
        text,
        attribution: { title: 'Aozora Bunko, all kana', author: a.author, url: a.url } satisfies Attribution,
      })),
    );

  if (sourceId === 'ja') return makePassageStream(sourceId, 'Kana prose shuffle', 'ja', jaEntries(JA_AUTHORS));
  const jaAuthor = JA_AUTHORS.find((a) => a.id === sourceId);
  if (jaAuthor) return makePassageStream(sourceId, jaAuthor.author, 'ja', jaEntries([jaAuthor]));

  const bookEntries = (books: readonly Book[]) =>
    books.flatMap((b) =>
      b.passages.map((text) => ({
        text,
        attribution: { title: b.title, author: b.author, url: b.url } satisfies Attribution,
      })),
    );

  const codeEntries = (sets: typeof CODE_SETS) =>
    sets.flatMap((c) =>
      c.passages.map((text) => ({
        text,
        attribution: { title: c.title, author: c.author } satisfies Attribution,
      })),
    );

  if (sourceId === 'code') return makePassageStream(sourceId, 'Code shuffle', 'latin', codeEntries(CODE_SETS));
  const codeSet = CODE_SETS.find((c) => c.id === sourceId);
  if (codeSet) return makePassageStream(sourceId, codeSet.title, 'latin', codeEntries([codeSet]));

  const book = BOOKS.find((b) => b.id === sourceId);
  if (book) return makePassageStream(sourceId, book.title, 'latin', bookEntries([book]));

  return makePassageStream('prose', 'Prose shuffle', 'latin', bookEntries(BOOKS));
}

/** Every distinct character the bundled corpora can produce, per script. */
export function corpusCharset(script: Script): Set<string> {
  const set = new Set<string>();
  const add = (text: string) => {
    for (const ch of text) set.add(ch);
  };
  if (script === 'ja') {
    for (const a of JA_AUTHORS) a.passages.forEach(add);
    jaDrillData.words.forEach(add);
    jaDrillData.bigrams.forEach(add);
    jaDrillData.trigrams.forEach(add);
    add('、。');
    return set;
  }
  for (const b of BOOKS) b.passages.forEach(add);
  for (const c of CODE_SETS) c.passages.forEach(add);
  drillData.words.forEach(add);
  drillData.bigrams.forEach(add);
  drillData.trigrams.forEach(add);
  return set;
}

export const ATTRIBUTION_NOTE = `${proseData.license} / ${jaData.license}`;
