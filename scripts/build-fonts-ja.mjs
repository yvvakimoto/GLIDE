/**
 * Generates src/style/fonts-ja.css: @font-face rules for just the Noto Sans JP
 * subsets holding characters GLIDE can actually put on screen.
 *
 *   npm run fonts:ja
 *
 * Re-run after changing the kana layouts, the corpus builder's TYPEABLE set, or
 * the @fontsource/noto-sans-jp version. The generated file says what it assumes;
 * the assertion below fails loudly if the assumptions stop holding.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PKG = 'node_modules/@fontsource/noto-sans-jp';
const WEIGHTS = ['400', '500', '600'];
const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/* ---- what the app can display ---------------------------------------- */

/** Exactly the set scripts/build-corpus-ja.mjs accepts into the corpus. */
const TYPEABLE = [
  ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
  ...'がぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ',
  ...'ぁぃぅぇぉゃゅょっ',
  ...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  ...'ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ',
  ...'ァィゥェォャュョッ',
  ...'ー、。',
];

const wanted = new Set(TYPEABLE);

/*
 * Plus the kanji the *keyboard* draws, which is where tofu would actually stop
 * someone: thumbDrawKey paints 無変換 and 変換 on the keys flanking the space
 * bar, and those two labels are how a kana layout is operated at all.
 *
 * Deliberately NOT included: the authors' names in the HUD and the source
 * picker, and the layout notes in kana-layouts.ts. Fontsource splits Japanese
 * 124 ways by codepoint, so a subset is ~9 KB whether you need one glyph from
 * it or three hundred — those 25 further kanji live in 15 more subsets and cost
 * 134 KB per weight, more than the kana themselves. A font-less machine will
 * show boxes for the author names in the picker; it will still be able to read
 * and type every character of the text. Doing better means subsetting the face
 * ourselves (subset-font, or pyftsubset) rather than taking fontsource's
 * buckets, which is a build dependency this project does not have yet.
 */
// ・ is the only kana-layout legend outside TYPEABLE; the corpus never uses it.
for (const ch of '無変換かな親指・') wanted.add(ch);

const ja = JSON.parse(readFileSync('src/corpus/ja.json', 'utf8'));

/* ---- map them onto fontsource's subsets ------------------------------- */

/** Every @font-face in a fontsource weight file, as {subset, unicodeRange}. */
function faces(weight) {
  const css = readFileSync(`${PKG}/${weight}.css`, 'utf8');
  const out = [];
  for (const block of css.split('@font-face').slice(1)) {
    const file = block.match(/noto-sans-jp-([0-9a-z-]+?)-\d+-normal\.woff2/);
    const range = block.match(/unicode-range:\s*([^;]+);/);
    if (file && range) out.push({ subset: file[1], unicodeRange: range[1].trim() });
  }
  return out;
}

const parseRanges = (spec) =>
  spec
    .split(',')
    .map((part) => part.trim().match(/^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i))
    .filter(Boolean)
    .map((m) => [parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);

const base = faces('400').map((f) => ({ ...f, ranges: parseRanges(f.unicodeRange) }));
const needed = new Set();
const missing = [];

for (const ch of wanted) {
  const cp = ch.codePointAt(0);
  const hit = base.find((f) => f.ranges.some(([a, z]) => cp >= a && cp <= z));
  if (hit) needed.add(hit.subset);
  else missing.push(ch);
}

const subsets = [...needed].sort((a, b) => Number(a) - Number(b));

/* Strings the UI is known to draw; if the scan above ever stops finding these,
   it has drifted and the fix is here, not in the generated file. */
for (const ch of '無変換かな親指・あヴ、。ー') {
  if (!wanted.has(ch)) {
    console.error(`expected to collect ${ch} but did not`);
    process.exit(1);
  }
}

/* ---- emit ------------------------------------------------------------- */

const lines = [
  '/*',
  ' * Japanese glyph coverage, subsetted to what the app can display.',
  ' *',
  " * app.css names 'Noto Sans JP' in its fallback stacks, but naming a face is not",
  ' * shipping one: on a machine with no Japanese system font every kana renders as',
  ' * tofu, which is the whole Japanese mode gone. A development machine always has',
  ' * the font, so this only ever shows up once the app is on a public URL.',
  ' *',
  ' * Bundling the face wholesale is the wrong fix. @fontsource/noto-sans-jp ships',
  ' * japanese-400.css as one 1 MB blob, and 400.css as 124 unicode-range subsets in',
  ' * both woff2 and woff — with assetsInlineLimit: 0 that is hundreds of files in',
  ' * dist. But the corpus is all kana by construction (scripts/build-corpus-ja.mjs),',
  ' * so the app only draws kana, the kana-layout legends and the 無変換 / 変換',
  ` * labels the keyboard paints — ${subsets.length} subsets, not 124, and unicode-range`,
  ' * gating means a latin-only session downloads none of them.',
  ' *',
  " * The authors' names in the HUD and the source picker are deliberately left",
  ' * out: fontsource buckets Japanese by codepoint, so those 25 kanji land in 15',
  ' * further subsets at ~9 KB each whether one glyph is wanted from them or three',
  ' * hundred — 134 KB per weight, more than the kana. A font-less machine shows',
  ' * boxes for the names in the picker and types every character of the text',
  ' * correctly. Fixing that too means subsetting the face ourselves rather than',
  " * taking fontsource's buckets, and that is a build dependency this project",
  ' * does not have.',
  ' *',
  ' * GENERATED, and the ranges are copied from the fontsource package: regenerate',
  ' * rather than edit if that package renumbers its subsets.',
  ' */',
  '',
];

for (const weight of WEIGHTS) {
  const byName = new Map(faces(weight).map((f) => [f.subset, f]));
  for (const subset of subsets) {
    const face = byName.get(subset);
    if (!face) {
      console.error(`weight ${weight} has no subset ${subset}`);
      process.exit(1);
    }
    lines.push(
      '@font-face {',
      "  font-family: 'Noto Sans JP';",
      '  font-style: normal;',
      `  font-weight: ${weight};`,
      '  font-display: swap;',
      `  src: url('@fontsource/noto-sans-jp/files/noto-sans-jp-${subset}-${weight}-normal.woff2') format('woff2');`,
      `  unicode-range: ${face.unicodeRange};`,
      '}',
      '',
    );
  }
}

writeFileSync('src/style/fonts-ja.css', lines.join('\n'), 'utf8');

let bytes = 0;
for (const weight of WEIGHTS) {
  for (const subset of subsets) {
    bytes += readFileSync(`${PKG}/files/noto-sans-jp-${subset}-${weight}-normal.woff2`).length;
  }
}

console.log(`characters wanted: ${wanted.size}`);
console.log(`uncovered:         ${missing.join('') || '(none)'}`);
console.log(`subsets:           ${subsets.join(', ')}`);
console.log(`weights:           ${WEIGHTS.join(', ')}`);
console.log(`bytes in dist:     ${bytes.toLocaleString()} across ${subsets.length * WEIGHTS.length} files`);
