# GLIDE — finger-path typing trainer

A typing trainer built around **finger motion** rather than letters. The text you
have to type fills the top half of the screen; the bottom half is a live keyboard
with a smooth ribbon drawn through the next few keys, coloured by the finger that
owns each one and fading out toward the far end. Every keystroke slides the
ribbon forward instead of redrawing it, so the shape of a word becomes something
you recognise before you reach it.

Built for learning Dvorak, but every layout it knows is a first-class citizen.

```bash
npm install
npm run dev        # http://localhost:5273
```

`space` starts a run, `esc` ends it, `tab` restarts, `s` opens settings,
`backspace` always means "go back one", whether or not you are stuck.

## What it does

- **Look-ahead ribbon** — a centripetal Catmull-Rom curve through the next N keys
  (default 6, configurable 0–10), resampled to even arc length so its alpha and
  width taper smoothly. Segment colour interpolates between the finger colours of
  the two keys it connects, so finger handoffs are visible in the ribbon itself.
  Repeated keys get a small lobe so a double tap stays readable. The same finger
  colours tint the look-ahead characters in the text above, under their marks.
- **Finger marks** — a small hand sits over each upcoming character, in the space
  the line already leaves above it. Four ticks trace index / middle / ring /
  pinky, mirrored per hand so each hand's thumb stub falls on its inner side, and
  the finger you need is the lit one. The press due now is drawn larger and
  brighter; a shift or a thumb-shift shows as a bar under the side that has to
  hold it. This is what answers *which finger* without looking away from the
  text — a colour is a code you have to learn first, a hand is not. Turn them off
  under `finger marks` once the motion is in your fingers.
- **Hands** — a schematic of both hands flanks the keyboard. The finger you need
  lights up in its own colour, its fingertip shows the character it is about to
  type, and the digit shifts up or down to hint at the row it has to reach for.
  The next two keys are lit more faintly, so the handover is visible before it
  happens. The ribbon covers the longer view.
- **Mistypes stop you** — by default a wrong key does not advance the cursor.
  Nothing is inserted, so there is nothing to delete: the character you missed is
  marked in place, the caret holds on it, and the moment you hit the right key the
  run carries on from there (with that character flagged as a recovery). Every
  attempt counts against accuracy. Switch to *advance* in settings to mark misses
  and move on instead.
- **Layouts** — Dvorak, QWERTY, Colemak, Colemak-DH, Workman. Fingering is a
  property of the physical key, so switching layout only relabels the board.
- **Japanese** — three ways to type it: romaji on whichever latin layout you are
  learning, or the thumb-shift kana layouts **NICOLA** and **飛鳥123**. See
  [Japanese input](#japanese-input).
- **Two input modes** — *remapped* reads the physical key (`event.code`) and
  translates it through the selected layout, so you can practise Dvorak with the
  OS still on QWERTY. *os layout* trusts `event.key` for people who already
  switched the system layout.
- **Speed graph** — instantaneous WPM as an area, a configurable moving average
  (2/5/10/20 s) as the bright line, error ticks along the floor. Live during the
  run and again, larger, in the summary.
- **Summary** — net and raw WPM, accuracy, consistency, a per-key heatmap
  (miss rate or latency) on the same keyboard renderer, per-finger keystroke
  bars, the slowest letter pairs, and the shakiest keys.
- **Text sources** — public-domain prose, generated drills, and code snippets.
- **Weaning off** — key labels can show the layout, the QWERTY legends actually
  printed on your keyboard, or nothing at all.

## Japanese input

Japanese needs more than a relabelled keyboard, so the runner works in *units*
rather than characters. A unit is one thing you type — for English a character
and one press, for romaji a kana that takes two or three presses and accepts
several spellings, for a kana layout a kana produced by one key plus maybe a
thumb.

**Romaji** accepts what a real IME accepts. `し` takes `si`, `shi` or `ci`; `じゃ`
takes `zya`, `ja` or `jya`; `っ` is the doubled consonant of whatever follows it
(`きっぷ` = `kippu`) or `xtu`/`ltu`; `ん` is a single `n` when the next sound
cannot swallow it and `nn` when it can (`しんぶん` = `sinbunn`, `こんにちは` =
`konnnitiha`). A habitual second `n` after a single-`n` `ん` is swallowed rather
than counted as a miss. The ribbon shows the latin keys, so `きゃ` reads as a
three-key motion.

**NICOLA** and **飛鳥123** give every key three faces: pressed alone, with the
left thumb, with the right thumb. All three are painted on the keycap, and the
thumb key the next press needs is outlined.

### Simultaneous press

The detection defines the window as a *proportion* of the character key's own
press rather than a fixed number of milliseconds: the moment the character key
goes down is 0, the moment it is released — or another key is pressed — is 100,
and a thumb inside the first N% of that span counts as simultaneous.

So at the default 50%, a thumb that arrives within the first half of however long
you happen to hold the character key counts as simultaneous. The nice property is
that the window scales with the typist: fast hands hold keys briefly, so the
window shrinks with them. `0%` accepts only a thumb that was already held; `100%`
accepts one any time before the key is released.

Because the end of that span is in the future, a character pressed with no thumb
held is deferred until the key is released or another key is pressed — a handful
of milliseconds of real typing. The keystroke is timestamped when it went down, so
nothing about the measured speed changes, and a character pressed while a thumb is
already held resolves with no deferral at all.

**連続シフト** (continuous shift) decides whether one thumb press may shift a run
of kana or has to be re-pressed for each one.

### Thumb keys

Both roles are assignable, so the common emulator setups all work — 無変換／変換,
space／変換, 無変換／space, or the Alt keys on a US board:

| key | code |
| --- | --- |
| 無変換 | `NonConvert` |
| 変換 | `Convert` |
| かな | `KanaMode` |
| space | `Space` |
| left / right alt | `AltLeft` / `AltRight` |

無変換 and 変換 do not exist on an ANSI board, so they are drawn in the positions
they occupy on a JIS one — immediately left and right of the space bar, which is
exactly where Alt sits. Assigning `Space` moves the legend onto the bar itself.
A lone thumb press does nothing here: 単独打鍵 has no counterpart in a trainer
whose Japanese text contains no spaces.

The layout tables are transcribed from their sources, not reconstructed:

| layout | source |
| --- | --- |
| NICOLA | the NICOLA specification chart, [as reproduced by msyk](https://www2d.biglobe.ne.jp/~msyk/keyboard/oyayubi/index.html) |
| 飛鳥123 | Ray's final revision, from [this やまぶきR definition](https://hiyokoya6.hateblo.jp/entry/2019/04/27/220801) |

`npm test` covers the window arithmetic — including that the same 70 ms lag counts
as simultaneous inside a long press and not inside a short one — and checks both
layouts against the fifty sounds, the voiced and semi-voiced rows,
the small kana and the punctuation, and pins a sample of positions against the
published charts — including that 飛鳥 is 清濁別置 (が has its own key) while
NICOLA is 清濁同置 (が is か plus a thumb).

Japanese runs report `kana/min` alongside WPM, and romaji runs also report
`keys per kana`, which is the number worth pushing down.

## Text sources

### English

Prose comes from twelve public-domain works on
[Project Gutenberg](https://www.gutenberg.org): *Alice's Adventures in
Wonderland*, *The Adventures of Sherlock Holmes*, *Frankenstein*, *Pride and
Prejudice*, *Meditations*, *Walden*, *The Art of War*, *Moby Dick*, *The
Adventures of Tom Sawyer*, *A Tale of Two Cities*, *The Republic*, and
*Dracula*. Paragraphs are normalised to characters an ANSI keyboard can actually
produce (curly quotes to straight, em dashes to `--`) and filtered for length and
readability. Titles and authors are shown under the text while you type.

Drills are generated from the word and n-gram frequencies of that same prose, so
"common words" really means common in the text you practise on. The home-row and
weak-finger drills are computed per layout at runtime.

Code snippets are hand-written for this project (CC0) and exist to drill the
symbol and number rows.

### Japanese

Japanese prose comes from [青空文庫](https://www.aozora.gr.jp) — 宮沢賢治, 新美南吉,
島崎藤村, 鈴木三重吉 and 竹久夢二, about 1,000 sentences from 175 works.

The author list is bounded by a **1945 death year**, which is not an aesthetic
choice. 青空文庫 publishes what is public domain *in Japan*, but this site is
hosted in the United States, where the URAA restored copyright in foreign works
still protected at home on 1996-01-01. Japan's term was then life + 50 years, so
an author who died in 1945 or earlier was already public domain before that date
and has nothing to restore. 小川未明 (d. 1961) and 楠山正雄 (d. 1954) were
previously the two largest sources here and are out for that reason;
`scripts/build-corpus-ja.mjs` now refuses an author who fails the test.

A trainer can only ask for text you can actually key in, and keying kanji means an
IME conversion step this app deliberately does not model. So the builder folds
Aozora's own ruby annotations into the text — 漢字《かんじ》 becomes かんじ — and keeps
only sentences that come out **entirely in kana**; anything with an unresolved
kanji left in it is dropped. That is why the authors are the ones whose editions
are 総ルビ: partially annotated editions yield almost nothing. What survives is
real literary Japanese written in kana, every character of which every method
here can type. Katakana is displayed as written and typed as its hiragana.

That constraint is also why the corpus grows by reading *more of* a 総ルビ author
rather than by adding authors. 北原白秋, 野口雨情, 山村暮鳥, 与謝野晶子 and
夢野久作 were each tried here and yielded fewer than ten usable sentences between
a whole catalogue; 宮沢賢治 alone gives 120 sentences from his first 40 works and
400 from all 278.

The ruby readings double as a vocabulary list, which is where the kana drills come
from.

### Rebuilding

```bash
npm run corpus       # English, from Project Gutenberg
npm run corpus:ja    # Japanese, from 青空文庫
npm run notice       # NOTICE.md, from whatever the two above produced
npm run fonts:ja     # src/style/fonts-ja.css, the bundled kana subsets
```

Both corpus builders cache their downloads (`scripts/.cache`, `scripts/.cache-ja`)
and take `--offline` to rebuild from the cache alone. Re-run `npm run notice`
after either, so the credits in `NOTICE.md` stay in step with the corpora.

## Deploying

The site is static and self-contained: no server, no API, no analytics, and every
asset relative. `vite.config.ts` sets `base: './'`, so the same `dist/` works at a
domain root, under a project subpath like `https://user.github.io/glide/`, and
straight off the filesystem. **Do not change `base` to an absolute path** — that
is the usual advice for GitHub Pages project sites and it would take the other two
away for no gain.

`.github/workflows/deploy.yml` builds and publishes on every push to `main`:
`npm ci`, `npm test`, `npm run build`, then `upload-pages-artifact` and
`deploy-pages`. Note that `npm run build` runs `tsc --noEmit` across `src` *and*
`tests`, so a type error in a test file fails the deploy — which is the intent.

Two things the workflow file cannot do for you:

1. In the repository settings, set **Pages -> Build and deployment -> Source** to
   **GitHub Actions**. The first deploy fails without it.
2. Pages from a private repository needs a paid GitHub plan. A public repository
   works on the free one.

## Development

```bash
npm test           # layout coverage, spline resampling, WPM/stats math
npm run build      # tsc --noEmit, then a production bundle
npm run preview    # serve the bundle
```

`scripts/verify.mjs` drives the dev server through a whole session with
Playwright — typing by physical key code through the app's own layout tables —
and writes screenshots plus a console-error report:

```bash
node scripts/verify.mjs shots
```

It needs a Chromium build. Either `npx playwright install chromium`, or point it at
one you already have:

```bash
GLIDE_CHROME="$LOCALAPPDATA/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe" node scripts/verify.mjs shots
```

### Layout of the source

| path | what lives there |
| --- | --- |
| `src/core/keyboard-geometry.ts` | the ANSI-60% key table: position, width, finger |
| `src/core/layouts.ts` | code -> characters per latin layout, plus the inverse index |
| `src/core/kana-layouts.ts` | NICOLA and 飛鳥123: code -> three thumb-shift faces |
| `src/core/kana.ts` | kana normalisation, the romaji table, kana segmentation |
| `src/core/method.ts` | text -> units and chords; what to paint on the keycaps |
| `src/core/input.ts` | keyboard events -> presses, including simultaneous detection |
| `src/core/engine.ts` | run state machine, cursor, keystroke log |
| `src/core/stats.ts` | speed series, moving average, summary aggregates |
| `src/core/spline.ts` | Catmull-Rom sampling and arc-length resampling |
| `src/render/guide.ts` | the look-ahead ribbon |
| `src/render/keyboard.ts` | keycaps, finger colours, press bloom, heatmap |
| `src/render/hands.ts` | the hand schematics and the lit finger |
| `src/ui/` | text panel, HUD, settings, summary |

Adding a latin layout means adding one entry to `LAYOUTS` in
`src/core/layouts.ts`: four rows of tokens, where a token is a letter or a
`lower`+`upper` pair. Adding a kana layout means one entry in `KANA_LAYOUTS`:
three planes of rows, `_` for a position the plane leaves empty. Nothing else
needs to change — fingering, the ribbon, the hands, the drills and the heatmap all
derive from it.

## License

GLIDE is MIT-licensed — see [LICENSE](LICENSE).

The build also carries material that is not: Inter, JetBrains Mono and Noto Sans
JP are under the SIL Open Font License 1.1, and the bundled corpora are public
domain. [NOTICE.md](NOTICE.md) has the font licence text, the twelve English
editions with their Project Gutenberg ids, and the 青空文庫 works with the
底本 and the 入力・校正 volunteers credited per work. Regenerate it with
`npm run notice` whenever a corpus is rebuilt.
