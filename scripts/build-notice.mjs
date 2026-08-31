/**
 * Generates NOTICE.md — the third-party attribution that has to travel with a
 * published build.
 *
 *   npm run notice
 *
 * Three obligations meet here. The OFL requires its own text to accompany the
 * font binaries, and the build embeds three faces as woff2. Project Gutenberg
 * asks not to be named as the distributor of texts its licence has been
 * stripped from, so it is credited as the source instead. 青空文庫 asks
 * redistributors to carry the 底本 and the 入力・校正 volunteers' names, which
 * is why scripts/build-corpus-ja.mjs keeps them per work rather than counting
 * works and throwing the rest away.
 *
 * Generated so the credits cannot drift from the corpora: it reads the same
 * JSON the app imports.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const prose = read('src/corpus/prose.json');
const code = read('src/corpus/code.json');
const ja = read('src/corpus/ja.json');

const FONTS = [
  {
    name: 'Inter',
    pkg: '@fontsource/inter',
    upstream: 'https://github.com/rsms/inter',
    used: 'the interface type (weights 400, 500, 600)',
  },
  {
    name: 'JetBrains Mono',
    pkg: '@fontsource/jetbrains-mono',
    upstream: 'https://github.com/JetBrains/JetBrainsMono',
    used: 'the text panel, the keycap legends and the readouts (weights 400, 500, 700, 800)',
  },
  {
    name: 'Noto Sans JP',
    pkg: '@fontsource/noto-sans-jp',
    upstream: 'https://github.com/notofonts/noto-cjk',
    used:
      'kana, for visitors whose system has no Japanese face. Only the subsets covering the characters ' +
      'the app can display are bundled — see src/style/fonts-ja.css (weights 400, 500, 600)',
  },
];

const out = [];
const push = (...lines) => out.push(...lines);

push(
  '# Third-party notices',
  '',
  'GLIDE itself is MIT-licensed; see [LICENSE](LICENSE). The published build also',
  'contains fonts and public-domain texts that carry their own terms, listed here.',
  '',
  '## Fonts',
  '',
  'All three faces are licensed under the **SIL Open Font License, Version 1.1**.',
  'The build embeds them as `woff2`, so the licence travels with them below.',
  '',
);

for (const font of FONTS) {
  push(`- **${font.name}** — ${font.upstream}`, `  Used for ${font.used}. Bundled via \`${font.pkg}\`.`);
}

push('', '<details>', '<summary>SIL Open Font License, Version 1.1</summary>', '', '```');
/* All three packages ship the same OFL body; the copyright lines differ, so
   quote each package's own header and the licence once. */
for (const font of FONTS) {
  const text = readFileSync(`node_modules/${font.pkg}/LICENSE`, 'utf8').trimEnd();
  const [copyright] = text.split('\n');
  push(`${font.name}: ${copyright.trim()}`);
}
push('');
const ofl = readFileSync(`node_modules/${FONTS[0].pkg}/LICENSE`, 'utf8').trimEnd();
push(ofl.split('\n').slice(1).join('\n').trim(), '```', '', '</details>', '');

push(
  '## English prose',
  '',
  `${prose.license}`,
  '',
  'Every passage is drawn from one of these editions. GLIDE strips the Project',
  "Gutenberg header, footer and licence, so the texts it ships are *not* Project",
  'Gutenberg eBooks and the trademark is not claimed for them; the works',
  'themselves are in the public domain.',
  '',
  '| Work | Author | Source |',
  '| --- | --- | --- |',
);
for (const book of prose.sources) {
  push(`| ${book.title} | ${book.author} | [PG ${book.gutenbergId}](${book.url}) |`);
}

push('', '## Code snippets', '', code.license, '');

push(
  '## 日本語（青空文庫）',
  '',
  ja.license,
  '',
  ja.note,
  '',
  'すべて青空文庫の公開作品から、ルビを本文に畳み込んだうえで、漢字が残らない文だけを',
  '抜き出したものです。青空文庫の利用案内にしたがい、底本と入力・校正の担当者を作品ごとに',
  '記載します。',
  '',
);

for (const source of ja.sources) {
  push(
    `### ${source.author}（没 ${source.died}年）`,
    '',
    `${source.url} — ${source.works.length} 作品 / ${source.passages.length} 文`,
    '',
    '<details>',
    '<summary>作品・底本・入力・校正</summary>',
    '',
    '| 作品 | 底本 | 入力・校正 |',
    '| --- | --- | --- |',
  );
  for (const work of source.works) {
    const cell = (value) => (value ?? '—').replace(/\|/g, '\\|');
    push(`| ${cell(work.title)} | ${cell(work.teihon)} | ${cell(work.credits)} |`);
  }
  push('', '</details>', '');
}

writeFileSync('NOTICE.md', `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');

const works = ja.sources.flatMap((s) => s.works);
console.log(
  `NOTICE.md: ${FONTS.length} fonts, ${prose.sources.length} English editions, ` +
    `${ja.sources.length} 作家 / ${works.length} 作品 ` +
    `(${works.filter((w) => !w.teihon).length} without 底本, ${works.filter((w) => !w.credits).length} without credits)`,
);
