/**
 * Shared Project Gutenberg plumbing: the download cache, the wrapper strip, and
 * the character normalisation that turns typographic text into something an
 * ANSI keyboard can produce.
 *
 * Extracted so build-corpus.mjs (sampled passages) and build-shakyo.mjs (whole
 * works) cannot drift apart on any of the three — in particular on the licence
 * note, which is a claim about what the output is and is not.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const CACHE = join(HERE, '..', '.cache');

/**
 * stripGutenbergWrapper() removes the Project Gutenberg License along with the
 * header and footer, so the trademark must not ride along on what is left.
 * These are public-domain texts *sourced from* Project Gutenberg; they are no
 * longer Project Gutenberg eBooks.
 */
export const LICENSE_NOTE =
  'Public domain. Texts sourced from Project Gutenberg, with its header, footer and licence removed; not distributed as Project Gutenberg eBooks.';

/** Characters a standard ANSI keyboard can produce. */
export const TYPEABLE = /^[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]+$/;
export const UNTYPEABLE_CHAR = /[^A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

export const REPLACEMENTS = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[–—―]/g, '--'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[«»]/g, '"'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/[à-å]/g, 'a'],
  [/[è-ë]/g, 'e'],
  [/[ì-ï]/g, 'i'],
  [/[ò-ö]/g, 'o'],
  [/[ù-ü]/g, 'u'],
  [/ç/g, 'c'],
  [/ñ/g, 'n'],
  [/[À-Å]/g, 'A'],
  [/[È-Ë]/g, 'E'],
  [/£/g, '$'],
  [/[†‡§¶]/g, ''],
  [/_/g, ''],
];

/** Typographic characters to ANSI ones. Length-changing, so never index across it. */
export function applyReplacements(text) {
  let out = text;
  for (const [pattern, to] of REPLACEMENTS) out = out.replace(pattern, to);
  return out;
}

/** Fetches a book's plain text, caching it under scripts/.cache. */
export async function download(id, offline = false) {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, `pg${id}.txt`);
  if (existsSync(file)) return readFile(file, 'utf8');
  if (offline) return null;

  const urls = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'dvorak-typing-trainer/0.1 (corpus builder)' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        console.warn(`  ${res.status} ${url}`);
        continue;
      }
      const text = await res.text();
      await writeFile(file, text, 'utf8');
      return text;
    } catch (err) {
      console.warn(`  ${url}: ${err.message}`);
    }
  }
  return null;
}

export function stripGutenbergWrapper(raw) {
  const body0 = raw.replace(/\r\n/g, '\n');
  const start = body0.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  let body = start >= 0 ? body0.slice(body0.indexOf('\n', start) + 1) : body0;
  const end = body.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  if (end >= 0) body = body.slice(0, end);
  return body;
}
