/**
 * Shared 青空文庫 plumbing: the author list, the character set, and the fetch
 * cache.
 *
 * The author list lives here and nowhere else, and that is the point of this
 * file. `died` is not decoration, it is a licensing rule (see CUTOFF below), and
 * a second Japanese builder carrying its own copy of the list is the obvious way
 * for that rule to be quietly lost. Both builders import this; neither declares
 * an author of its own.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const CACHE = join(HERE, '..', '.cache-ja');

/**
 * 青空文庫 publishes what is public domain *in Japan*, but this corpus ships
 * inside a site hosted in the United States, where the URAA restored copyright
 * in foreign works that were still protected in their home country on
 * 1996-01-01. Japan's term was then life + 50 years, so an author who died in
 * 1945 or earlier had already passed into the Japanese public domain before that
 * date and has nothing to restore. An author who died later — 小川未明 (1961)
 * and 楠山正雄 (1954) were both on this list once — may still be under US
 * copyright however freely 青空文庫 may distribute them. Do not add an author
 * without checking this.
 */
export const CUTOFF = 1945;

/*
 * `works` is how deep to read that author's card list, and it is their whole
 * published catalogue rather than a round number. 宮沢賢治 gives 120 sentences
 * at 40 works and 400 at 278; the cache makes a re-run cheap, while a thin
 * corpus makes the Japanese modes repeat. Do not trim these to save fetches.
 *
 * These are children's-literature authors because their editions are 総ルビ —
 * every kanji carries a reading — which is what makes both the all-kana corpus
 * and the 写経 works possible at all.
 */
export const AUTHORS = [
  { id: 81, name: '宮沢賢治', died: 1933, works: 278 },
  { id: 121, name: '新美南吉', died: 1943, works: 126 },
  { id: 158, name: '島崎藤村', died: 1943, works: 56 },
  { id: 107, name: '鈴木三重吉', died: 1936, works: 32 },
  { id: 212, name: '竹久夢二', died: 1934, works: 27 },
];

for (const author of AUTHORS) {
  if (!(author.died <= CUTOFF)) {
    throw new Error(
      `${author.name} (没 ${author.died}) は ${CUTOFF} 年より後の没年です。` +
        '米国で著作権が回復している可能性があるため、この一覧には入れられません。',
    );
  }
}

/** Everything a kana layout (and the romaji tables) can produce. */
export const TYPEABLE = new Set([
  ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
  ...'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
  ...'ぁぃぅぇぉゃゅょっ',
  ...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  ...'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ',
  ...'ァィゥェォャュョッ',
  ...'ー、。',
]);

/**
 * Historical kana that appear constantly in 総ルビ readings and that no kana
 * layout can produce.
 *
 * 731 of the cached work files carry one of these inside an <rt>. Romaji can
 * type them (kana.ts has wi/we), but NICOLA and 飛鳥123 have no position for
 * them at all, and inventing one would teach wrong fingering against a
 * published layout chart. So the *typed* text is modernised and the original is
 * kept as a display override, which is the same mechanism kanji use: the page
 * still shows what the 底本 says, and the fingers get something every method can
 * actually produce. The count is reported per work so it is never silent.
 */
export const KANA_MODERNISED = { ゐ: 'い', ゑ: 'え', ヰ: 'イ', ヱ: 'エ' };

export const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetches an Aozora page, caching it under scripts/.cache-ja. */
export async function fetchText(url, name, offline = false) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file)) return readFile(file, 'utf8');
  if (offline) return null;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'glide-typing-trainer/0.1 (corpus builder)' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.warn(`  ${res.status} ${url}`);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // Aozora mixes encodings: the work files are Shift_JIS, most index pages
    // are UTF-8. Sniff the declared charset from the ASCII-safe prefix.
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 1024)).toLowerCase();
    const charset = head.includes('shift_jis') || head.includes('shift-jis') ? 'shift_jis' : 'utf-8';
    const text = new TextDecoder(charset).decode(buf);
    await writeFile(file, text, 'utf8');
    await sleep(120);
    return text;
  } catch (err) {
    console.warn(`  ${url}: ${err.message}`);
    return null;
  }
}

/**
 * The body of the 奥付 div, matched by counting nesting rather than stopping at
 * the first `</div>`.
 *
 * That distinction is not academic: a ※ note in the 奥付 sometimes quotes a long
 * passage of the work, and 青空文庫 wraps the quote in its own `<div>`. A lazy
 * `[\s\S]*?</div>` then ends at the quote's close, which is *before* the 入力 and
 * 校正 lines — 宮沢賢治's 種山ヶ原 lost its credits exactly this way.
 */
export function biblioBlock(html) {
  const open = '<div class="bibliographical_information">';
  const start = html.indexOf(open);
  if (start < 0) return null;

  const from = start + open.length;
  let depth = 1;
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = from;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, m.index);
  }
  // unbalanced markup: the 奥付 is the last thing on the page, so take the rest
  return html.slice(from);
}
