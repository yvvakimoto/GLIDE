/**
 * Builds the Japanese 写経 works: whole 青空文庫 texts, kanji shown, kana typed.
 *
 *   node scripts/build-shakyo-ja.mjs [--offline] [--report]
 *
 * The all-kana corpus (build-corpus-ja.mjs) folds ruby away and keeps only the
 * sentences that survive with no kanji left. That is the right answer for a
 * drill and the wrong one for 写経, where the point is to sit with a whole work:
 * so here the ruby is *kept* as a pairing, the reading becomes what you type and
 * the kanji becomes what you see. See scripts/lib/ruby.mjs for why that had to
 * be a rewrite of the fold rather than an edit to it.
 *
 * The author list, the 1945 death-year rule behind it and the download cache all
 * live in ./lib/aozora.mjs, shared with the all-kana builder. Neither script
 * declares an author of its own; that rule is a licensing constraint and a
 * second copy of the list is how it gets lost.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { AUTHORS, CUTOFF, ROOT, TYPEABLE, biblioBlock, fetchText } from './lib/aozora.mjs';
import { readRuby } from './lib/ruby.mjs';

const OUT = join(ROOT, 'src', 'corpus');
const WORKS_DIR = join(OUT, 'works');
const OFFLINE = process.argv.includes('--offline');
const REPORT = process.argv.includes('--report');

/** A work shorter than this is not a sitting, let alone a series of them. */
const MIN_CHARS = 2000;
/** Works kept per author, longest first, so the picker stays readable. */
const PER_AUTHOR = 5;

const MAX_PARAGRAPH = 120;
const MIN_CHUNK = 40;
const MAX_CHUNK = 100;

/**
 * What may appear in the typed text.
 *
 * TYPEABLE is kana plus ー、。 — the set the all-kana corpus already proves every
 * method can produce. ・ is added because tests/shakyo-charset.test.ts confirms
 * all three methods have it, and running prose uses it.
 */
const ALLOWED = new Set([...TYPEABLE, '・']);

/**
 * ！ and ？ become 。 rather than vanishing, so a sentence still ends where the
 * author ended it - the same call build-corpus-ja.mjs makes.
 */
const REWRITE = { '！': '。', '？': '。', '!': '。', '?': '。' };

/**
 * A kanji left in the text is one whose reading the edition never gave, and
 * there is no way to type it. 写経 wants the whole work, so a single unread
 * kanji rejects the work rather than leaving a hole in it.
 *
 * Everything else that cannot be typed - brackets, dashes, ideographic spaces,
 * the long tail of running-prose punctuation - is removed and counted instead.
 * Listing that punctuation exhaustively was tried first and is a trap: the list
 * is never complete, and every character missing from it rejected a work whose
 * kanji were in fact perfectly well annotated.
 */
const IDEOGRAPH = /[㐀-䶿一-鿿豈-﫿]/;

/** How many missing readings still counts as "within reach", for --needs. */
const NEAR_MISS = 8;

/** Works that came close, so the shortfall is reportable rather than invisible. */
const nearMisses = [];

/** Applies the rewrite and the restriction, carrying the display spans with it. */
function restrict(text, display) {
  const map = new Array(text.length).fill(-1);
  const unexpected = new Map();
  let stripped = 0;
  let out = '';

  for (let i = 0; i < text.length; i++) {
    const raw = text[i];
    const ch = REWRITE[raw] ?? raw;
    if (ALLOWED.has(ch)) {
      map[i] = out.length;
      out += ch;
      continue;
    }
    if (ch === '\n') continue;
    if (IDEOGRAPH.test(ch)) unexpected.set(ch, (unexpected.get(ch) ?? 0) + 1);
    else stripped++;
  }

  const moved = [];
  for (const [start, len, base] of display) {
    let from = -1;
    let count = 0;
    for (let i = start; i < start + len; i++) {
      if (map[i] < 0) continue;
      if (from < 0) from = map[i];
      count++;
    }
    if (from >= 0 && count > 0) moved.push([from, count, base]);
  }
  return { text: out, display: moved, unexpected, stripped };
}

/** Split points must not fall inside a display span, or the kanji is cut in half. */
function spanEndAt(display, at) {
  for (const [start, len] of display) {
    if (at > start && at < start + len) return start + len;
  }
  return at;
}

/** One section's text into chunks, with each chunk's own display spans. */
function chunkSection(text, display) {
  const cuts = [];
  let at = 0;
  while (at < text.length) {
    let to = Math.min(text.length, at + MAX_PARAGRAPH);
    if (to < text.length) {
      // prefer a sentence end inside the window
      const window = text.slice(at + MIN_CHUNK, at + MAX_CHUNK + 1);
      const dot = window.lastIndexOf('。');
      to = dot >= 0 ? at + MIN_CHUNK + dot + 1 : Math.min(text.length, at + MAX_CHUNK);
      to = spanEndAt(display, to);
    }
    cuts.push([at, to]);
    at = to;
  }

  return cuts
    .map(([from, to]) => {
      const slice = text.slice(from, to);
      const spans = display
        .filter(([s, l]) => s >= from && s + l <= to)
        .map(([s, l, base]) => [s - from, l, base]);
      return { t: slice, ...(spans.length ? { d: spans } : {}) };
    })
    .filter((chunk) => chunk.t.length > 0);
}

/** The 見出し headings Aozora marks, and the html between them. */
function sectionsOf(mainHtml) {
  const re = /<h[1-6][^>]*class="[^"]*midashi[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/g;
  const found = [];
  for (let m = re.exec(mainHtml); m; m = re.exec(mainHtml)) {
    found.push({ title: readRuby(m[1]).text.trim(), at: m.index, end: re.lastIndex });
  }
  if (found.length < 2) return [{ title: '', html: mainHtml }];
  return found.map((h, i) => ({
    title: h.title,
    html: mainHtml.slice(h.end, i + 1 < found.length ? found[i + 1].at : mainHtml.length),
  }));
}

function bibliography(html) {
  const block = biblioBlock(html);
  if (!block) return {};
  const plain = block.replace(/<[^>]+>/g, '\n').replace(/[ \t]+/g, ' ');
  const teihon = plain.match(/底本：([^\n]+)/)?.[1]?.trim();
  const credits = [plain.match(/入力：([^\n]+)/)?.[1]?.trim(), plain.match(/校正：([^\n]+)/)?.[1]?.trim()]
    .filter(Boolean)
    .join('、');
  return { ...(teihon ? { teihon } : {}), ...(credits ? { credits } : {}) };
}

async function collectWork(dir, cardId) {
  const cardHtml = await fetchText(
    `https://www.aozora.gr.jp/cards/${dir}/card${cardId}.html`,
    `card_${dir}_${cardId}.html`,
    OFFLINE,
  );
  if (!cardHtml) return null;
  const file = [...cardHtml.matchAll(/files\/(\d+_\d+\.html)/g)].map((m) => m[1])[0];
  if (!file) return null;
  const title = (cardHtml.match(/<title>([^<]*)<\/title>/) ?? [])[1]
    ?.replace(/^図書カード：/, '')
    .trim();

  const workHtml = await fetchText(
    `https://www.aozora.gr.jp/cards/${dir}/files/${file}`,
    `work_${dir}_${file}`,
    OFFLINE,
  );
  if (!workHtml) return null;
  const main = workHtml.match(/<div class="main_text">([\s\S]*?)<\/div>/);
  if (!main) return null;

  const chunks = [];
  const chapters = [];
  const offsets = [0];
  const unexpected = new Map();
  let gaiji = 0;
  let stripped = 0;

  for (const section of sectionsOf(main[1])) {
    const read = readRuby(section.html);
    gaiji += read.gaiji;
    const { text, display, unexpected: bad, stripped: lost } = restrict(read.text, read.display);
    for (const [ch, n] of bad) unexpected.set(ch, (unexpected.get(ch) ?? 0) + n);
    stripped += lost;
    if (!text.trim()) continue;

    const start = chunks.length;
    const before = offsets[offsets.length - 1];
    for (const chunk of chunkSection(text, display)) {
      chunks.push(chunk);
      offsets.push(offsets[offsets.length - 1] + chunk.t.length);
    }
    const count = chunks.length - start;
    if (!count) continue;
    chapters.push({
      id: `c${chapters.length + 1}`,
      title: section.title || `${chapters.length + 1}`,
      start,
      count,
      chars: offsets[offsets.length - 1] - before,
    });
  }

  return {
    title: title || `作品${cardId}`,
    cardId,
    chunks,
    chapters,
    offsets,
    chars: offsets[offsets.length - 1],
    gaiji,
    stripped,
    unexpected,
    ...bibliography(workHtml),
  };
}

async function main() {
  await mkdir(WORKS_DIR, { recursive: true });

  const existing = JSON.parse(
    await import('node:fs/promises')
      .then((fs) => fs.readFile(join(OUT, 'works-index.json'), 'utf8'))
      .catch(() => '{"works":[]}'),
  );
  // the English works are built by the other script; keep them
  const index = (existing.works ?? []).filter((w) => w.script !== 'ja');

  for (const author of AUTHORS) {
    console.log(`${author.name} (没 ${author.died})`);
    const person = await fetchText(
      `https://www.aozora.gr.jp/index_pages/person${author.id}.html`,
      `person${author.id}.html`,
      OFFLINE,
    );
    if (!person) {
      console.warn('  skipped (unavailable)');
      continue;
    }
    const cards = [
      ...new Set(
        [...person.matchAll(/cards\/(\d{6})\/card(\d+)\.html/g)].map((m) => `${m[1]}/${m[2]}`),
      ),
    ];

    const candidates = [];
    let rejectedGaiji = 0;
    let rejectedKanji = 0;
    for (const card of cards.slice(0, author.works)) {
      const [dir, id] = card.split('/');
      const work = await collectWork(dir, id);
      if (!work || work.chars < MIN_CHARS) continue;
      if (work.gaiji > 0) {
        rejectedGaiji++;
        if (REPORT) console.log(`    - ${work.title}: ${work.gaiji} 外字`);
        continue;
      }
      if (work.unexpected.size > 0) {
        rejectedKanji++;
        const missing = [...work.unexpected.entries()].sort((a, b) => b[1] - a[1]);
        if (missing.length <= NEAR_MISS) {
          nearMisses.push({ author: author.name, title: work.title, chars: work.chars, missing });
        }
        if (REPORT) {
          const top = [...work.unexpected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          console.log(`    - ${work.title}: ${top.map(([c, n]) => `${c}x${n}`).join(' ')}`);
        }
        continue;
      }
      candidates.push(work);
    }

    candidates.sort((a, b) => b.chars - a.chars || a.title.localeCompare(b.title, 'ja'));
    const kept = candidates.slice(0, PER_AUTHOR);
    console.log(
      `  ${cards.length} works listed, ${candidates.length} fully ruby'd, keeping ${kept.length}` +
        ` (rejected: ${rejectedKanji} unread kanji, ${rejectedGaiji} gaiji)`,
    );

    for (const work of kept) {
      const id = `work/az${work.cardId}`;
      const body = {
        id,
        title: work.title,
        author: author.name,
        url: `https://www.aozora.gr.jp/cards/${String(author.id).padStart(6, '0')}/card${work.cardId}.html`,
        script: 'ja',
        stamp: createHash('sha256')
          .update(work.chunks.map((c) => c.t).join(''))
          .digest('hex')
          .slice(0, 12),
        chars: work.chars,
        chapters: work.chapters,
        offsets: work.offsets,
        chunks: work.chunks,
      };
      const file = join(WORKS_DIR, `az${work.cardId}.json`);
      await writeFile(file, `${JSON.stringify(body)}\n`, 'utf8');
      const bytes = (await stat(file)).size;

      const charset = [...new Set(work.chunks.map((c) => c.t).join(''))]
        .sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
        .join('');
      const displayCharset = [
        ...new Set(work.chunks.flatMap((c) => (c.d ?? []).map(([, , base]) => base)).join('')),
      ]
        .sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
        .join('');

      console.log(
        `    ${work.title}: ${work.chapters.length} 章 / ${work.chars.toLocaleString()} 字 / ` +
          `${displayCharset.length} 種の漢字 / ${Math.round(bytes / 1024)} KB`,
      );

      index.push({
        id,
        title: work.title,
        author: author.name,
        url: body.url,
        script: 'ja',
        chars: work.chars,
        chunks: work.chunks.length,
        stamp: body.stamp,
        chapterTitles: work.chapters.map((c) => c.title),
        charset,
        displayCharset,
        bytes,
        ...(work.teihon ? { teihon: work.teihon } : {}),
        ...(work.credits ? { credits: work.credits } : {}),
      });
    }
  }

  index.sort((a, b) => (a.script === b.script ? a.id.localeCompare(b.id) : a.script < b.script ? -1 : 1));

  const wanted = new Set(index.map((w) => `${w.id.replace('work/', '')}.json`));
  for (const name of await readdir(WORKS_DIR)) {
    if (name.endsWith('.json') && !wanted.has(name)) {
      await rm(join(WORKS_DIR, name));
      console.log(`removed stale ${name}`);
    }
  }

  await writeFile(
    join(OUT, 'works-index.json'),
    `${JSON.stringify(
      {
        note: 'Generated by scripts/build-shakyo.mjs and scripts/build-shakyo-ja.mjs. Chapter lists and sizes only - the text of each work is fetched on demand from works/<id>.json.',
        license: existing.license,
        noteJa: `日本語は青空文庫より、没年 ${CUTOFF} 年以前の作家に限る。漢字はルビで表示し、入力は仮名。歴史的仮名遣いは打鍵のため現代仮名に直し、原字は表示に残す。`,
        works: index,
      },
      null,
      1,
    )}\n`,
    'utf8',
  );

  if (nearMisses.length) {
    nearMisses.sort((a, b) => a.missing.length - b.missing.length || b.chars - a.chars);
    console.log(`
${nearMisses.length} works are within ${NEAR_MISS} readings of being usable:`);
    for (const near of nearMisses.slice(0, 30)) {
      const list = near.missing.map(([ch, n]) => `${ch}(${n})`).join(' ');
      console.log(`  ${near.author} ${near.title} - ${near.chars.toLocaleString()} chars - ${list}`);
    }
  }

  const ja = index.filter((w) => w.script === 'ja');
  console.log(
    `\n${ja.length} 作品 / ${ja.reduce((n, w) => n + w.chars, 0).toLocaleString()} 字 / ` +
      `${(ja.reduce((n, w) => n + w.bytes, 0) / 1024 / 1024).toFixed(1)} MB`,
  );
}

main();
