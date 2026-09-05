/**
 * Reads 青空文庫 markup into *two* things at once: the kana you type, and the
 * characters to show in their place.
 *
 * build-corpus-ja.mjs folds ruby away — 漢字《かんじ》 becomes かんじ and the kanji
 * is gone — which is safe precisely because nothing downstream needs to know
 * where it was. 写経 does need to know, and that changes the shape of the job
 * completely.
 *
 * The old fold is a chain of whole-document .replace() calls. Every one of them
 * deletes characters, so the moment you want an *index* into the result, running
 * them in sequence is wrong: each pass shifts every offset the previous pass
 * produced. So this is a rewrite rather than an edit, and it works on an array
 * of one entry per output character. Every transform becomes a mark-and-filter
 * over that array, offsets are taken only at the very end, and there is no
 * ordering left to get wrong.
 *
 * The output indexes the TYPED string, because that is the coordinate space the
 * runner, the units, the states, the cursor and the caret all already use. A
 * view that ignores `display` renders exactly what the app renders today.
 */

import { ENTITIES, KANA_MODERNISED } from './aozora.mjs';

/**
 * @param {string} html a work's main_text, or one section of it
 * @returns {{ text: string, display: Array<[number, number, string]>, gaiji: number }}
 */
export function readRuby(html) {
  // The notes span carries ［＃改丁］ and friends; it is not body text at all.
  const src = html.replace(/<span class="notes">[\s\S]*?<\/span>/g, '');

  /** @type {Array<{ ch: string, id: number | null, drop: boolean }>} */
  const chars = [];
  /** @type {string[]} */
  const bases = [];
  let gaiji = 0;

  const push = (text, id) => {
    for (const ch of text) chars.push({ ch, id, drop: false });
  };

  const token = /<ruby>([\s\S]*?)<\/ruby>|<br\s*\/?>|<img[^>]*>|<[^>]+>|&[a-z]+;|[^<&]+/g;
  for (let m = token.exec(src); m; m = token.exec(src)) {
    const whole = m[0];

    if (whole.startsWith('<ruby>')) {
      const inner = m[1].replace(/<rp>[\s\S]*?<\/rp>/g, '');
      const reading = [...inner.matchAll(/<rt>([^<]*)<\/rt>/g)].map((r) => r[1]).join('');
      // the base is whatever is left once the readings and the tags are gone,
      // which covers both <rb>漢字</rb><rt>かんじ</rt> and the bare form
      const base = inner.replace(/<rt>[\s\S]*?<\/rt>/g, '').replace(/<[^>]+>/g, '').trim();
      if (!reading) {
        // ruby with no reading is just text
        push(base, null);
        continue;
      }
      bases.push(base || reading);
      push(reading, bases.length - 1);
      continue;
    }

    if (/^<br/.test(whole)) {
      push('\n', null);
      continue;
    }

    if (/^<img/.test(whole)) {
      // an inline image in body text is a 外字: a character with no codepoint.
      // Count it; the caller rejects the work rather than shipping a hole.
      if (/gaiji/.test(whole)) gaiji++;
      continue;
    }

    if (whole.startsWith('<')) continue;

    if (whole.startsWith('&')) {
      push(ENTITIES[whole] ?? '', null);
      continue;
    }

    push(whole, null);
  }

  /*
   * Aozora's editorial markup, removed over the character array rather than over
   * a string, so that a run which happened to be split by a tag is still matched
   * as one thing.
   */
  const markSpan = (open, close) => {
    for (let i = 0; i < chars.length; i++) {
      if (chars[i].drop) continue;
      if (!startsAt(chars, i, open)) continue;
      let j = i;
      while (j < chars.length && !startsAt(chars, j, close)) j++;
      if (j >= chars.length) continue;
      for (let k = i; k < j + close.length; k++) if (chars[k]) chars[k].drop = true;
      i = j + close.length - 1;
    }
  };
  markSpan('［＃', '］');
  markSpan('《', '》');
  for (const entry of chars) {
    if (entry.ch === '｜' || entry.ch === '|') entry.drop = true;
  }

  const kept = chars.filter((entry) => !entry.drop);

  /*
   * Historical kana is modernised for the fingers and kept for the eye — the
   * same mechanism as kanji, one character wide.
   *
   * Every occurrence is modernised, readings included. That is the whole point:
   * a reading is exactly where ゐ and ゑ turn up (731 of the cached work files
   * have one inside an <rt>), and no kana layout has a position for them. What
   * differs is only whether an override is needed to show the original — inside
   * a reading the kanji is already on screen, so there is nothing to add.
   */
  for (const entry of kept) {
    const modern = KANA_MODERNISED[entry.ch];
    if (!modern) continue;
    if (entry.id === null) {
      bases.push(entry.ch);
      entry.id = bases.length - 1;
    }
    entry.ch = modern;
  }

  const text = kept.map((entry) => entry.ch).join('');

  /** @type {Array<[number, number, string]>} */
  const display = [];
  for (let i = 0; i < kept.length; ) {
    const { id } = kept[i];
    if (id === null) {
      i++;
      continue;
    }
    let j = i;
    while (j < kept.length && kept[j].id === id) j++;
    display.push([i, j - i, bases[id]]);
    i = j;
  }

  return { text, display, gaiji };
}

function startsAt(chars, at, needle) {
  for (let k = 0; k < needle.length; k++) {
    if (chars[at + k]?.ch !== needle[k]) return false;
  }
  return true;
}
