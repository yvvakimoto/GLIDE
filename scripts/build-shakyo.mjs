/**
 * Builds the 写経 works: whole public-domain books, in order, chapter by chapter.
 *
 *   node scripts/build-shakyo.mjs [--offline] [--report]
 *
 * Output is src/corpus/works-index.json (bundled: metadata and chapter titles)
 * plus one src/corpus/works/<id>.json per work (fetched on demand). Downloads
 * share scripts/.cache with build-corpus.mjs, so a book either builder has
 * already fetched is free.
 *
 * This is a separate script from build-corpus.mjs rather than a mode of it,
 * because the two want opposite things from the same text. build-corpus samples
 * forty paragraphs spread across a book and *skips* anything that looks like a
 * chapter heading; 写経 needs every paragraph in order and needs the headings
 * most of all. They share the download cache, the wrapper strip and the
 * character normalisation through ./lib/gutenberg.mjs, and nothing else.
 *
 * OUTPUT MUST BE BYTE-DETERMINISTIC. These files are committed and they are
 * large, so a rebuild that reorders a key or re-cuts a chunk adds its whole size
 * to the repository's history again, for ever. Nothing here iterates a Set or a
 * Map whose order depends on insertion, no timestamp is written, and the chunk
 * splitting is a pure function of the text. `node scripts/build-shakyo.mjs
 * --offline && git diff --exit-code src/corpus/works` is the test.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  LICENSE_NOTE,
  ROOT,
  UNTYPEABLE_CHAR,
  applyReplacements,
  download,
  stripGutenbergWrapper,
} from './lib/gutenberg.mjs';

const OUT = join(ROOT, 'src', 'corpus');
const WORKS_DIR = join(OUT, 'works');
const OFFLINE = process.argv.includes('--offline');
const REPORT = process.argv.includes('--report');

/**
 * The works, with the number of chapters each is expected to yield.
 *
 * The count is an assertion, in the spirit of the death-year check in
 * build-corpus-ja.mjs: Project Gutenberg re-issues editions, and a re-issue that
 * changes heading style would otherwise ship one giant chapter in silence. Run
 * with --report to see what detection actually found before setting a number.
 * `chapters: null` means "whatever it finds", for a work with no real divisions.
 */
const WORKS = [
  { id: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', chapters: 12 },
  { id: 84, title: 'Frankenstein', author: 'Mary Wollstonecraft Shelley', chapters: 24 },
  { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen', chapters: 61 },
  { id: 74, title: 'The Adventures of Tom Sawyer', author: 'Mark Twain', chapters: 35 },
  { id: 345, title: 'Dracula', author: 'Bram Stoker', chapters: 27 },
  { id: 1080, title: 'A Modest Proposal', author: 'Jonathan Swift', chapters: null },
  { id: 16, title: 'Peter Pan', author: 'J. M. Barrie', chapters: 17 },
  { id: 1260, title: 'Jane Eyre', author: 'Charlotte Bronte', chapters: 38 },
  { id: 768, title: 'Wuthering Heights', author: 'Emily Bronte', chapters: 34 },
  { id: 174, title: 'The Picture of Dorian Gray', author: 'Oscar Wilde', chapters: 20 },
  { id: 5200, title: 'Metamorphosis', author: 'Franz Kafka', chapters: 3 },
  { id: 64317, title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', chapters: 9 },
  { id: 2542, title: "A Doll's House", author: 'Henrik Ibsen', chapters: 3 },
  { id: 35, title: 'The Time Machine', author: 'H. G. Wells', chapters: 16 },
  { id: 2701, title: 'Moby Dick', author: 'Herman Melville', chapters: 135 },

  /*
   * Eastern works, on the same public-domain basis as the rest: US public domain
   * via Project Gutenberg. Translators are credited where the edition names one,
   * because for a translated work the translator wrote these sentences.
   *
   * Several have a chapter count of 1. That is not a failure and not data loss --
   * the whole text is there and the bookmark still works paragraph by paragraph.
   * Their editions head sections with titles rather than numbers, and the titled
   * fallback only fires when it can find two it trusts. A coarse contents list is
   * the honest outcome; a confident wrong one would not be.
   */
  { id: 7164, title: 'Gitanjali', author: 'Rabindranath Tagore', chapters: 103 },
  { id: 216, title: 'The Tao Teh King', author: 'Laozi, tr. James Legge', chapters: 5 },
  { id: 3330, title: 'The Analects of Confucius', author: 'Confucius, tr. James Legge', chapters: 19 },
  { id: 12096, title: 'Bushido, the Soul of Japan', author: 'Inazo Nitobe', chapters: 4 },
  { id: 769, title: 'The Book of Tea', author: 'Kakuzo Okakura', chapters: 1 },
  { id: 1210, title: 'Kwaidan', author: 'Lafcadio Hearn', chapters: 1 },
  { id: 4018, title: 'Japanese Fairy Tales', author: 'Yei Theodora Ozaki', chapters: 16 },
  { id: 246, title: 'The Rubaiyat of Omar Khayyam', author: 'Omar Khayyam, tr. Edward FitzGerald', chapters: 1 },
  { id: 8130, title: 'Glimpses of Unfamiliar Japan', author: 'Lafcadio Hearn', chapters: 1 },
];

/*
 * Deliberately not here yet, each for a reason detection cannot currently meet.
 * Adding one means teaching the detector its shape and *then* pinning the count,
 * never relaxing the assertion until it passes:
 *
 *   205  Walden          - chapters are titled ("Economy"), never numbered
 *   43   Jekyll and Hyde - same
 *   1661 Sherlock Holmes - stories titled "ADVENTURE I.", numbering interleaved
 *                          with the roman numerals of their own sections
 *   2701 Moby Dick       - 135 numbered chapters, but the headings sit in the
 *                          same block as the paragraph that follows them
 *   98   A Tale of Two Cities, 36 The War of the Worlds
 *                        - numbering restarts inside each Book. The division
 *                          handling below finds the Books, but not yet every
 *                          chapter under them.
 */


/** A chunk is a paragraph, or a slice of a long one at a sentence boundary. */
const MIN_CHUNK = 200;
const MAX_CHUNK = 400;

/** Above this share of characters stripped, the edition is not what we think it is. */
const MAX_STRIPPED = 0.002;

const HEADING_WORD = /^(chapter|book|part|act|scene|volume|letter|canto|section|stave)\b/i;
const ROMAN_ONLY = /^[IVXLCDM]{1,7}\.?$/;
const ARABIC_ONLY = /^\d{1,3}\.?$/;

const ROMAN_VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/** A division is a Book or Part: chapter numbering restarts inside each one. */
const DIVISION_WORD = /^(book|part|volume)/i;

/** "Book the First", "BOOK TWO" - divisions are as often worded as numbered. */
const WORD_NUMBERS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function romanValue(text) {
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const here = ROMAN_VALUES[text[i]];
    const next = ROMAN_VALUES[text[i + 1]];
    if (here === undefined) return null;
    total += next !== undefined && next > here ? -here : here;
  }
  return total;
}

/** The chapter number a heading line claims, or null. */
function numberOf(line) {
  const worded = line.match(
    /^(?:chapter|book|part|act|scene|volume|letter|canto|section|stave)\s+([IVXLCDM]+|\d{1,3})\b/i,
  );
  const bare = line.match(/^([IVXLCDM]{1,7}|\d{1,3})\.?$/);
  const token = (worded ?? bare)?.[1];
  if (token) return /^\d+$/.test(token) ? Number(token) : romanValue(token.toUpperCase());

  const worded2 = line.match(/^(?:book|part|volume)\s+(?:the\s+)?([a-z]+)/i);
  const word = worded2?.[1]?.toLowerCase();
  return word && word in WORD_NUMBERS ? WORD_NUMBERS[word] : null;
}

/** Splits into trimmed paragraphs, blank-line separated. */
function paragraphsOf(body) {
  return body
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/** Whether a block reads as a heading, and what it is called. */
function headingOf(block) {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 3) return null;
  // 72 rather than a rounder 60: five of Moby Dick's chapter titles run to 68
  // characters, and a heading still has to start with a heading word, survive
  // monotonicity and have prose under it, so the ceiling is not what is doing
  // the work here.
  if (lines.some((line) => line.length > 72)) return null;

  const first = lines[0];
  const title = applyReplacements(lines.join(' - ')).replace(/\s+/g, ' ');

  if (HEADING_WORD.test(first) || ROMAN_ONLY.test(first) || ARABIC_ONLY.test(first)) {
    return { title, n: numberOf(first), division: DIVISION_WORD.test(first) };
  }

  /*
   * A titled heading: a short line in capitals, two or more words, not ending
   * like a sentence. Only ever used as a fallback, because this is the loose end
   * of the detector — real prose in small caps or a shouted line of dialogue can
   * match it, which is why numbered headings always win and why the per-work
   * chapter count stays an assertion.
   */
  if (lines.length === 1 && /^[A-Z][A-Z0-9 '(),.:;!?-]+$/.test(first) && !/[.,;:]$/.test(first)) {
    const words = first.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 9) return { title, n: null, division: false, titled: true };
  }
  return null;
}

/**
 * Keeps only the longest run of headings whose numbers strictly increase.
 *
 * This one step is what makes detection trustworthy. A table of contents carries
 * the same headings as the body, so its numbers restart at 1 immediately before
 * the body's do; running heads repeat a number; "Chapter" occurs inside prose.
 * All three break monotonicity and all three fall out here, which is far more
 * robust than guessing from position in the file.
 */
function longestIncreasing(items) {
  if (!items.length) return [];
  const best = items.map(() => 1);
  const from = items.map(() => -1);
  let endAt = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      if (items[j].n < items[i].n && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        from[i] = j;
      }
    }
    if (best[i] > best[endAt]) endAt = i;
  }
  const out = [];
  for (let i = endAt; i >= 0; i = from[i]) {
    out.push(items[i]);
    if (from[i] < 0) break;
  }
  return out.reverse();
}

/** One paragraph as typeable text, plus how many characters had to go. */
function cleanParagraph(block) {
  const joined = applyReplacements(block.replace(/\n/g, ' '));
  const collapsed = joined.replace(/[ \t]+/g, ' ').trim();
  const stripped = collapsed.replace(UNTYPEABLE_CHAR, '');
  return { text: stripped, dropped: collapsed.length - stripped.length };
}

/**
 * Cuts a paragraph into chunks at sentence boundaries.
 *
 * Never merges paragraphs and never crosses a chapter: a chunk is the resume
 * granularity, so its boundaries have to be places a reader would accept being
 * put back to.
 */
function chunkParagraph(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const sentences = text.match(/[^.!?]*[.!?]+["']?(?:\s+|$)/g) ?? [text];
  const out = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHUNK && current.length >= MIN_CHUNK) {
      out.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  // a single sentence longer than MAX_CHUNK stays whole; splitting mid-sentence
  // would put the reader back somewhere with no context
  return out.length ? out : [text];
}

function buildWork(meta, raw) {
  const body = stripGutenbergWrapper(raw);
  const blocks = paragraphsOf(body);

  const candidates = [];
  const titled = [];
  for (const [index, block] of blocks.entries()) {
    const heading = headingOf(block);
    if (!heading) continue;
    if (heading.n !== null) candidates.push({ ...heading, index });
    else if (heading.titled) titled.push({ ...heading, index });
  }

  /*
   * Chapter numbers restart inside each Book, so one global monotonic run would
   * keep only the first Book's worth and silently drop the rest of the novel.
   * Find the Books first, then run the monotonic filter *within* each — which is
   * also what removes each Book's own table-of-contents copy.
   */
  /*
   * Drop the table of contents, structurally rather than positionally.
   *
   * A contents page is headings with nothing between them; the body is headings
   * separated by prose. So a candidate whose very next block is also a candidate
   * is a contents entry, and the whole listing falls away without anyone having
   * to know where in the file it sits.
   *
   * Monotonicity alone does not do this. The contents numbers and the body
   * numbers both ascend, so the longest increasing run happily takes the first
   * half of one and the second half of the other — which is how Moby Dick found
   * 130 perfectly good headings and produced five chapters with any text in
   * them, the rest being the empty gaps between contents lines.
   */
  const isCandidate = new Set(candidates.map((c) => c.index));
  const titledAt = new Set(titled.map((c) => c.index));
  const bodyCandidates = candidates.filter((c) => !isCandidate.has(c.index + 1));

  const divisions = longestIncreasing(bodyCandidates.filter((c) => c.division));
  const chapterCandidates = bodyCandidates.filter((c) => !c.division);

  /*
   * Two readings of the structure, and the one that explains more of the book
   * wins.
   *
   * Segmenting by Book is what rescues a novel whose chapter numbers restart in
   * each part. But "BOOK I." also turns up *inside* a chapter — Moby Dick's
   * cetology chapter is built out of them — and taking those as the top level
   * then hunts for chapters only within one chapter, finding almost none. Rather
   * than trying to tell the two apart by shape, build both and compare: a false
   * division set covers a sliver of the text and loses badly.
   */
  const flat = longestIncreasing(chapterCandidates);

  let nested = [];
  if (divisions.length >= 2) {
    for (const [i, division] of divisions.entries()) {
      const until = i + 1 < divisions.length ? divisions[i + 1].index : Infinity;
      const within = chapterCandidates.filter((c) => c.index > division.index && c.index < until);
      const kept = longestIncreasing(within);
      nested.push(...kept.map((c) => ({ ...c, title: `${division.title} - ${c.title}` })));
    }
    if (nested.length < divisions.length) nested = divisions;
  }

  let headings = nested.length > flat.length ? nested : flat;

  if (headings.length < 2 && titled.length >= 2) {
    // Numbering found nothing, so fall back to titled headings. The contents
    // rule applies here too, and position stands in for the number, which is
    // what keeps them all rather than collapsing to a longest run of one.
    const bodyTitled = titled.filter((c) => !isCandidate.has(c.index + 1) && !titledAt.has(c.index + 1));
    headings = bodyTitled.map((c, i) => ({ ...c, n: i + 1 }));
  }

  if (REPORT) {
    console.log(`  ${candidates.length} heading candidates, ${headings.length} after monotonicity`);
    for (const h of headings.slice(0, 4)) console.log(`    #${h.n} ${h.title}`);
  }

  /*
   * Everything before the first heading is front matter and is dropped. That is
   * right for a title page and a preface, and catastrophic if the first heading
   * was detected late: Kwaidan matched its first heading two thirds of the way
   * in and silently shipped a third of the book.
   *
   * So measure what dropping would cost. Past a modest share of the text, the
   * headings are not the book's structure and the honest answer is one chapter
   * with everything in it.
   */
  const blockChars = blocks.map((b) => b.length);
  const bodyChars = blockChars.reduce((n, c) => n + c, 0);
  const wouldDrop = headings.length
    ? blockChars.slice(0, headings[0].index).reduce((n, c) => n + c, 0)
    : 0;
  // 35%: a real preface can be a sixth of a slim volume — Yeats's introduction to
  // Gitanjali is 18% of it and dropping it is correct — while a mis-detection
  // lands far higher; Kwaidan's first match was 66% in.
  const frontMatterTooBig = bodyChars > 0 && wouldDrop / bodyChars > 0.35;

  // A bad split is worse than no split, so fall back to the whole work.
  const sections =
    headings.length >= 2 && !frontMatterTooBig
      ? headings.map((h, i) => ({
          title: h.title,
          from: h.index + 1,
          to: i + 1 < headings.length ? headings[i + 1].index : blocks.length,
        }))
      : [{ title: '(whole work)', from: 0, to: blocks.length }];

  const skipped = headings.length >= 2 && !frontMatterTooBig ? headings[0].index : 0;
  if (frontMatterTooBig) {
    console.warn(
      `  headings ignored: the first is ${Math.round((wouldDrop / bodyChars) * 100)}% into the text`,
    );
  }

  const chunks = [];
  const chapters = [];
  const offsets = [0];
  let dropped = 0;
  let kept = 0;

  for (const section of sections) {
    const start = chunks.length;
    const before = offsets[offsets.length - 1];
    for (let i = section.from; i < section.to; i++) {
      const block = blocks[i];
      // a heading inside a division is a sub-heading; keep its text as prose
      const { text, dropped: lost } = cleanParagraph(block);
      dropped += lost;
      if (!text) continue;
      kept += text.length;
      const pieces = chunkParagraph(text);
      for (const [k, piece] of pieces.entries()) {
        // the separator lives in the chunk, so the stream never touches text
        const t = `${piece} `;
        chunks.push(k === 0 ? { t, p: 1 } : { t });
        offsets.push(offsets[offsets.length - 1] + t.length);
      }
    }
    const count = chunks.length - start;
    if (!count) continue;
    chapters.push({
      id: `c${chapters.length + 1}`,
      title: section.title,
      start,
      count,
      chars: offsets[offsets.length - 1] - before,
    });
  }

  const chars = offsets[offsets.length - 1];
  const share = kept ? dropped / kept : 0;
  if (share > MAX_STRIPPED) {
    throw new Error(
      `${meta.title}: stripped ${dropped} of ${kept} characters (${(share * 100).toFixed(2)}%) - is this the edition we think it is?`,
    );
  }

  const charset = [...new Set(chunks.map((c) => c.t).join(''))]
    .sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
    .join('');

  const stamp = createHash('sha256')
    .update(chunks.map((c) => c.t).join(' '))
    .digest('hex')
    .slice(0, 12);

  return {
    work: {
      id: `work/pg${meta.id}`,
      title: meta.title,
      author: meta.author,
      url: `https://www.gutenberg.org/ebooks/${meta.id}`,
      script: 'latin',
      stamp,
      chars,
      chapters,
      offsets,
      chunks,
    },
    stats: { dropped, skipped, chars, charset },
  };
}

async function main() {
  await mkdir(WORKS_DIR, { recursive: true });
  const index = [];
  const failures = [];

  for (const meta of WORKS) {
    console.log(`${meta.title}`);
    const raw = await download(meta.id, OFFLINE);
    if (!raw) {
      console.warn('  skipped (unavailable)');
      continue;
    }

    let built;
    try {
      built = buildWork(meta, raw);
    } catch (error) {
      console.error(`  FAILED: ${error.message}`);
      failures.push(`${meta.title}: ${error.message}`);
      continue;
    }
    const { work, stats } = built;

    if (meta.chapters !== null && work.chapters.length !== meta.chapters) {
      const message = `${meta.title}: found ${work.chapters.length} chapters, expected ${meta.chapters}`;
      console.error(`  FAILED: ${message}`);
      failures.push(message);
      continue;
    }

    const file = join(WORKS_DIR, `pg${meta.id}.json`);
    const json = `${JSON.stringify(work)}\n`;
    await writeFile(file, json, 'utf8');
    const bytes = (await stat(file)).size;

    console.log(
      `  ${work.chapters.length} chapters, ${work.chunks.length} chunks, ` +
        `${work.chars.toLocaleString()} chars, ${Math.round(bytes / 1024)} KB` +
        (stats.dropped ? `, ${stats.dropped} stripped` : '') +
        (stats.skipped ? `, ${stats.skipped} front-matter blocks dropped` : ''),
    );

    index.push({
      id: work.id,
      title: work.title,
      author: work.author,
      url: work.url,
      script: work.script,
      chars: work.chars,
      chunks: work.chunks.length,
      stamp: work.stamp,
      chapterTitles: work.chapters.map((c) => c.title),
      charset: stats.charset,
      bytes,
    });
  }

  if (failures.length) {
    console.error(`\n${failures.length} work(s) failed:`);
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }

  // Anything left from a previous run whose work has since been removed.
  const wanted = new Set(index.map((w) => `pg${w.id.replace('work/pg', '')}.json`));
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
        note: 'Generated by scripts/build-shakyo.mjs. Chapter lists and sizes only - the text of each work is fetched on demand from works/<id>.json.',
        license: LICENSE_NOTE,
        works: index,
      },
      null,
      1,
    )}\n`,
    'utf8',
  );

  const chars = index.reduce((n, w) => n + w.chars, 0);
  const bytes = index.reduce((n, w) => n + w.bytes, 0);
  console.log(
    `\n${index.length} works, ${chars.toLocaleString()} chars, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}

main();
