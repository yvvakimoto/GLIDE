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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AUTHORS,
  CUTOFF,
  ENTITIES,
  ROOT,
  TYPEABLE,
  biblioBlock,
  fetchText as fetchCached,
} from './lib/aozora.mjs';

const OUT = join(ROOT, 'src', 'corpus');
const OFFLINE = process.argv.includes('--offline');
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 999;

const MIN_LEN = 16;
const MAX_LEN = 64;
/** a source with fewer sentences than this is not worth listing */
const MIN_SENTENCES = 25;

const fetchText = (url, name) => fetchCached(url, name, OFFLINE);

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
