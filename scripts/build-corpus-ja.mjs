/**
 * Builds src/corpus/ja.json from 青空文庫 (Aozora Bunko) public-domain works.
 *
 *   node scripts/build-corpus-ja.mjs [--offline] [--limit N]
 *
 * A typing trainer can only ask for text the learner can actually key in, and
 * keying kanji means an IME conversion step that is out of scope here. So this
 * keeps only sentences that are *entirely* kana after Aozora's own ruby
 * annotations have been folded in: 漢字《かんじ》 becomes かんじ, and any sentence
 * with an unresolved kanji left in it is dropped. What survives is real
 * literary Japanese, written in kana, every character of which can be typed on
 * every layout the app knows.
 *
 * Ruby readings double as a vocabulary list, which is where the kana drills
 * come from.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE = join(HERE, '.cache-ja');
const OUT = join(ROOT, 'src', 'corpus');
const OFFLINE = process.argv.includes('--offline');
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 999;

/**
 * Aozora person ids, verified against index_pages/person{id}.html.
 *
 * These are children's-literature authors because their editions are 総ルビ —
 * every kanji carries a reading — which is what makes a fully-kana sentence
 * recoverable. Partially-annotated editions (漱石, 芥川, 太宰) yield almost
 * nothing once unresolved kanji are dropped, so they are not worth the fetch.
 *
 * `died` is not decoration: it is the selection rule. 青空文庫 publishes what is
 * public domain *in Japan*, but this corpus ships inside a site hosted in the
 * United States, where the URAA restored copyright in foreign works that were
 * still protected in their home country on 1996-01-01. Japan's term was then
 * life + 50 years, so an author who died in 1945 or earlier had already passed
 * into the Japanese public domain before that date and has nothing to restore.
 * An author who died later — 小川未明 (1961) and 楠山正雄 (1954) were both in
 * this list once — may still be under US copyright however freely 青空文庫 may
 * distribute them, so they are out. Do not add an author without checking this.
 */
const CUTOFF = 1945;

/*
 * `works` is how deep to read that author's card list, and it is set to their
 * whole published catalogue rather than a round number. That matters more than
 * it looks: 小川未明 alone used to supply half the corpus, and once he was out
 * the shortfall could not be made up by adding authors — 北原白秋, 野口雨情,
 * 山村暮鳥, 与謝野晶子 and 夢野久作 were all tried here and yielded between one
 * and nine usable sentences each, because their editions are not 総ルビ, and
 * 有島武郎 (52 works read) and 宮原晃一郎 (26) came in under MIN_SENTENCES.
 * Reading the *whole* catalogue of the authors who are 総ルビ is what makes up
 * the difference instead: 宮沢賢治 gives 120 sentences at 40 works and 400 at
 * 278. So do not trim these numbers back to save fetches — the cache makes a
 * re-run cheap, while a thin corpus makes the Japanese modes repeat.
 */
const AUTHORS = [
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

const MIN_LEN = 16;
const MAX_LEN = 64;
/** a source with fewer sentences than this is not worth listing */
const MIN_SENTENCES = 25;

/** Everything a kana layout (and the romaji tables) can produce. */
const TYPEABLE = new Set([
  ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
  ...'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
  ...'ぁぃぅぇぉゃゅょっ',
  ...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  ...'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ',
  ...'ァィゥェォャュョッ',
  ...'ー、。',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, name) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file)) return readFile(file, 'utf8');
  if (OFFLINE) return null;

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

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/** Folds ruby into the base text and strips Aozora's editorial markup. */
function resolveRuby(html) {
  return html
    .replace(/<span class="notes">[\s\S]*?<\/span>/g, '')
    .replace(/<rp>[\s\S]*?<\/rp>/g, '')
    // <ruby><rb>漢字</rb><rt>かんじ</rt></ruby> -> かんじ
    .replace(/<ruby>[\s\S]*?<rt>([^<]*)<\/rt>[\s\S]*?<\/ruby>/g, '$1')
    .replace(/<ruby>[\s\S]*?<\/ruby>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, (m) => ENTITIES[m] ?? '')
    .replace(/［＃[^］]*］/g, '')
    .replace(/《[^》]*》/g, '')
    .replace(/[｜|]/g, '');
}

/** Collects ruby readings as a vocabulary list. */
function rubyReadings(html, into) {
  for (const m of html.matchAll(/<rt>([^<]*)<\/rt>/g)) {
    const reading = m[1].trim();
    if (reading.length < 2 || reading.length > 6) continue;
    if ([...reading].every((c) => TYPEABLE.has(c) && c !== '、' && c !== '。')) {
      into.set(reading, (into.get(reading) ?? 0) + 1);
    }
  }
}

function sentences(text) {
  return text
    .replace(/[　\s]+/g, '')
    .split(/(?<=[。！？])/)
    .map((s) => s.replace(/[！？]/g, '。'))
    .filter(Boolean);
}

function keepSentence(s) {
  if (s.length < MIN_LEN || s.length > MAX_LEN) return false;
  if (!s.endsWith('。')) return false;
  for (const ch of s) if (!TYPEABLE.has(ch)) return false;
  // a wall of kana with no punctuation at all reads as a run-on; allow it, but
  // require at least a few distinct characters so drills are not degenerate
  return new Set(s).size >= 8;
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
function biblioBlock(html) {
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

/**
 * Pulls the 奥付 out of a work page: the 底本 it was transcribed from and the
 * volunteers who typed and proofread it. 青空文庫 asks that these travel with
 * any redistribution of the text, and this builder is a redistribution, so the
 * credits go into ja.json and from there into NOTICE.md.
 */
function bibliography(html) {
  const body = biblioBlock(html);
  if (!body) return {};
  const lines = body
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.replace(/[\r　]+/g, ' ').trim())
    .filter(Boolean);

  const after = (label) => {
    const hit = lines.find((line) => line.startsWith(label));
    return hit ? hit.slice(label.length).trim() : undefined;
  };
  const credits = ['入力', '校正']
    .map((label) => {
      const who = after(`${label}：`);
      return who ? `${label}：${who}` : null;
    })
    .filter(Boolean);

  const teihon = after('底本：');
  return {
    ...(teihon ? { teihon } : {}),
    ...(credits.length ? { credits: credits.join('、') } : {}),
  };
}

async function collectWork(dir, cardId, vocabulary) {
  const cardHtml = await fetchText(
    `https://www.aozora.gr.jp/cards/${dir}/card${cardId}.html`,
    `card_${dir}_${cardId}.html`,
  );
  if (!cardHtml) return null;

  const file = [...cardHtml.matchAll(/files\/(\d+_\d+\.html)/g)].map((m) => m[1])[0];
  if (!file) return null;
  const title = (cardHtml.match(/<title>([^<]*)<\/title>/) ?? [])[1]?.replace(/^図書カード：/, '').trim();

  const workHtml = await fetchText(
    `https://www.aozora.gr.jp/cards/${dir}/files/${file}`,
    `work_${dir}_${file}`,
  );
  if (!workHtml) return null;

  const main = workHtml.match(/<div class="main_text">([\s\S]*?)<\/div>/);
  if (!main) return null;

  rubyReadings(main[1], vocabulary);
  const kept = sentences(resolveRuby(main[1])).filter(keepSentence);
  return {
    title: title || `作品${cardId}`,
    ...bibliography(workHtml),
    sentences: [...new Set(kept)],
  };
}

function buildDrills(allSentences, vocabulary) {
  const bigrams = new Map();
  const trigrams = new Map();
  for (const s of allSentences) {
    const kana = [...s].filter((c) => c !== '、' && c !== '。');
    for (let i = 0; i + 2 <= kana.length; i++) {
      const g = kana.slice(i, i + 2).join('');
      bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
    }
    for (let i = 0; i + 3 <= kana.length; i++) {
      const g = kana.slice(i, i + 3).join('');
      trigrams.set(g, (trigrams.get(g) ?? 0) + 1);
    }
  }
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
      .slice(0, n)
      .map(([k]) => k);

  return {
    generatedFrom: 'frequencies of the bundled all-kana Aozora sentences, plus ruby readings',
    words: top(vocabulary, 900),
    bigrams: top(bigrams, 150),
    trigrams: top(trigrams, 150),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const sources = [];
  const vocabulary = new Map();
  const all = [];

  for (const author of AUTHORS) {
    console.log(author.name);
    const person = await fetchText(
      `https://www.aozora.gr.jp/index_pages/person${author.id}.html`,
      `person${author.id}.html`,
    );
    if (!person) {
      console.warn('  skipped (unavailable)');
      continue;
    }
    const cards = [...new Set([...person.matchAll(/cards\/(\d{6})\/card(\d+)\.html/g)].map((m) => `${m[1]}/${m[2]}`))];
    const limit = Math.min(author.works, LIMIT);
    console.log(`  ${cards.length} works listed, reading up to ${limit}`);

    const sentences = [];
    const works = [];
    for (const card of cards.slice(0, limit)) {
      const [dir, id] = card.split('/');
      const work = await collectWork(dir, id, vocabulary);
      if (!work || work.sentences.length === 0) continue;
      // cap per work so one long novel cannot dominate
      const take = work.sentences.slice(0, 30);
      sentences.push(...take);
      works.push({
        title: work.title,
        ...(work.teihon ? { teihon: work.teihon } : {}),
        ...(work.credits ? { credits: work.credits } : {}),
      });
    }

    console.log(`  ${sentences.length} all-kana sentences from ${works.length} works`);
    if (sentences.length < MIN_SENTENCES) continue;
    sources.push({
      id: `aozora${author.id}`,
      author: author.name,
      died: author.died,
      url: `https://www.aozora.gr.jp/index_pages/person${author.id}.html`,
      works,
      passages: [...new Set(sentences)],
    });
    all.push(...sentences);
  }

  if (!sources.length) {
    console.error('\n日本語コーパスを構築できませんでした。ネットワークを確認してください。');
    process.exit(1);
  }

  await writeFile(
    join(OUT, 'ja.json'),
    `${JSON.stringify(
      {
        license: 'パブリックドメイン。青空文庫より、没後の著作権保護期間が日本・米国とも満了した作家に限る。',
        note: `没年 ${CUTOFF} 年以前の作家のみ。底本と入力・校正の担当者は works に記載。`,
        sources,
      },
      null,
      1,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(OUT, 'ja-drills.json'),
    `${JSON.stringify(buildDrills(all, vocabulary), null, 1)}\n`,
    'utf8',
  );

  const chars = all.reduce((n, s) => n + s.length, 0);
  console.log(`\n${sources.length} 作家 / ${all.length} 文 / ${chars.toLocaleString()} 字 / 語彙 ${vocabulary.size}`);
}

main();
