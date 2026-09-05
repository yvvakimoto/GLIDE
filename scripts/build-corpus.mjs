/**
 * Builds src/corpus/prose.json and src/corpus/drills.json from Project Gutenberg
 * plain-text editions (all public domain in the US).
 *
 *   node scripts/build-corpus.mjs [--offline]
 *
 * Raw downloads are cached under scripts/.cache so reruns are free. `--offline`
 * uses only what is already cached. Non-ASCII source characters are written as
 * escapes so this file stays ASCII-clean on every platform.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LICENSE_NOTE,
  ROOT,
  TYPEABLE,
  applyReplacements,
  download,
  stripGutenbergWrapper,
} from './lib/gutenberg.mjs';

const OUT = join(ROOT, 'src', 'corpus');
const OFFLINE = process.argv.includes('--offline');

/** Public-domain long-form works. */
const BOOKS = [
  { id: 11, title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll' },
  { id: 1661, title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle' },
  { id: 84, title: 'Frankenstein', author: 'Mary Wollstonecraft Shelley' },
  { id: 1342, title: 'Pride and Prejudice', author: 'Jane Austen' },
  { id: 2680, title: 'Meditations', author: 'Marcus Aurelius' },
  { id: 205, title: 'Walden', author: 'Henry David Thoreau' },
  { id: 132, title: 'The Art of War', author: 'Sun Tzu' },
  { id: 2701, title: 'Moby Dick', author: 'Herman Melville' },
  { id: 74, title: 'The Adventures of Tom Sawyer', author: 'Mark Twain' },
  { id: 98, title: 'A Tale of Two Cities', author: 'Charles Dickens' },
  { id: 1497, title: 'The Republic', author: 'Plato' },
  { id: 345, title: 'Dracula', author: 'Bram Stoker' },
];

const PER_BOOK = 40;
const MIN_LEN = 190;
const MAX_LEN = 560;

function normalise(text) {
  let out = applyReplacements(text);
  out = out.replace(/[ \t]+/g, ' ').trim();
  // drop a leading section marker: "XVII. ", "12. ", "3) "
  return out.replace(/^(?:[IVXLCDM]{1,7}|\d{1,3})\s*[.)]\s+(?=["'A-Z])/, '');
}

function looksLikeProse(p) {
  if (p.length < MIN_LEN || p.length > MAX_LEN) return false;
  if (!TYPEABLE.test(p)) return false;
  if (!/^["']?[A-Z]/.test(p)) return false;
  if (!/[.!?"']$/.test(p)) return false;
  if (/[[\]{}@#|\\~^]/.test(p)) return false;
  if (/gutenberg|ebook|copyright|transcriber|footnote|illustration/i.test(p)) return false;
  if (/^(chapter|book|part|act|scene|volume|letter|canto)\b/i.test(p)) return false;
  if (/\d{3,}/.test(p)) return false;
  const letters = p.replace(/[^A-Za-z]/g, '');
  if (!letters.length) return false;
  const upper = (p.match(/[A-Z]/g) ?? []).length;
  if (upper / letters.length > 0.2) return false;
  if (p.split(' ').some((w) => w.length > 18)) return false;
  return true;
}

function extractPassages(raw) {
  const paragraphs = stripGutenbergWrapper(raw)
    .split(/\n[ \t]*\n+/)
    .map((chunk) => normalise(chunk.replace(/\n/g, ' ')))
    .filter(looksLikeProse);

  const seen = new Set();
  const unique = [];
  for (const p of paragraphs) {
    const key = p.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  if (unique.length <= PER_BOOK) return unique;

  // spread the sample across the whole book instead of taking the opening chapters
  const step = unique.length / PER_BOOK;
  return Array.from({ length: PER_BOOK }, (_, i) => unique[Math.floor(i * step)]);
}

function buildDrills(allPassages) {
  const wordCount = new Map();
  const bigramCount = new Map();
  const trigramCount = new Map();

  for (const passage of allPassages) {
    const words = passage.toLowerCase().match(/[a-z']+/g) ?? [];
    for (const raw of words) {
      const word = raw.replace(/^'+|'+$/g, '');
      if (word.length < 2 || word.length > 9) continue;
      wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
      for (let i = 0; i + 2 <= word.length; i++) {
        const g = word.slice(i, i + 2);
        if (/^[a-z]{2}$/.test(g)) bigramCount.set(g, (bigramCount.get(g) ?? 0) + 1);
      }
      for (let i = 0; i + 3 <= word.length; i++) {
        const g = word.slice(i, i + 3);
        if (/^[a-z]{3}$/.test(g)) trigramCount.set(g, (trigramCount.get(g) ?? 0) + 1);
      }
    }
  }

  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([k]) => k);

  return {
    generatedFrom: 'word and n-gram frequencies of the bundled public-domain prose',
    words: top(wordCount, 1200),
    bigrams: top(bigramCount, 160),
    trigrams: top(trigramCount, 160),
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const sources = [];
  const all = [];

  for (const book of BOOKS) {
    console.log(book.title);
    const raw = await download(book.id, OFFLINE);
    if (!raw) {
      console.warn('  skipped (unavailable)');
      continue;
    }
    const passages = extractPassages(raw);
    console.log(`  ${passages.length} passages`);
    if (passages.length < 5) continue;
    sources.push({
      id: `pg${book.id}`,
      title: book.title,
      author: book.author,
      gutenbergId: book.id,
      url: `https://www.gutenberg.org/ebooks/${book.id}`,
      passages,
    });
    all.push(...passages);
  }

  if (!sources.length) {
    console.error('\nNo sources built. Re-run with network access, or keep the committed corpus.');
    process.exit(1);
  }

  await writeFile(
    join(OUT, 'prose.json'),
    `${JSON.stringify(
      { license: LICENSE_NOTE, sources },
      null,
      1,
    )}\n`,
    'utf8',
  );
  await writeFile(join(OUT, 'drills.json'), `${JSON.stringify(buildDrills(all), null, 1)}\n`, 'utf8');

  const chars = all.reduce((n, p) => n + p.length, 0);
  console.log(`\n${sources.length} books, ${all.length} passages, ${chars.toLocaleString()} chars`);
}

main();
