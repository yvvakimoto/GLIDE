# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GLIDE, a typing trainer built around finger motion: the text fills the top half of
the screen, a live keyboard fills the bottom, and a smooth ribbon is drawn through
the next N keys. It supports latin layouts (Dvorak, QWERTY, Colemak, Colemak-DH,
Workman) and Japanese by three methods (romaji, and the thumb-shift kana layouts
NICOLA and 飛鳥123). See README.md for the user-facing description.

Vanilla TypeScript on Vite — no UI framework. The app is a `requestAnimationFrame`
loop over a canvas plus a small amount of DOM.

## Commands

```bash
npm run dev          # http://localhost:5273
npm test             # vitest, whole suite
npm run build        # tsc --noEmit, then a production bundle
npm run corpus       # rebuild the English corpus from Project Gutenberg
npm run corpus:ja    # rebuild the Japanese corpus from 青空文庫
npm run notice       # regenerate NOTICE.md from the corpora — run after either corpus
npm run perf         # frame-time probe against the dev server, see below
npm run fonts:ja     # regenerate src/style/fonts-ja.css, the bundled kana subsets
```

```bash
npx vitest run tests/input.test.ts               # one file
npx vitest run -t 'simultaneous'                 # one test by name
node scripts/build-corpus-ja.mjs --offline       # rebuild from the download cache
```

Both corpus builders cache downloads (`scripts/.cache`, `scripts/.cache-ja`) and
accept `--offline`.

## Verifying a change

`npm test` covers the logic. For anything visible, drive the real app:

```bash
node scripts/verify.mjs shots
```

It runs a whole session in Playwright — idle, settings, count-in, ~200 keystrokes
typed by physical key code through the app's own layout tables, a mistype, the
summary, then Japanese passes for all three methods — writes screenshots to
`shots/`, and reports console errors. It needs the dev server up and a Chromium:

```bash
GLIDE_CHROME="$LOCALAPPDATA/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe" node scripts/verify.mjs shots
```

Read the screenshots. Several real bugs in this project were only visible in one
(a canvas blowing past the viewport, a layout table that silently lost a key).

For anything that touches drawing, measure it too:

```bash
GLIDE_CHROME="$LOCALAPPDATA/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe" node scripts/perf.mjs before
```

`scripts/perf.mjs` samples `requestAnimationFrame` deltas for a few seconds in
each of the three phases that matter — idle, running, finished — and prints the
median and p95. Pass a second argument (`full` / `lite`) to pin `graphics`. The
headless shell renders through SwiftShader, with no GPU at all, which is exactly
the machine this is for: the numbers are absolute nonsense as frame rates and an
excellent proxy for fill rate. Take a reading, `git stash`, take another.

## Architecture

The keystone idea: **the runner works in units and chords, not characters.**

- A **`Chord`** (`src/core/method.ts`) is one physical press: `{code, shift, thumb, label}`.
- A **`Unit`** is one thing you type. It carries *several* accepted chord sequences.
  For English a unit is one character and one chord. For romaji it is a kana that
  may take three presses and accepts `si`/`shi`/`ci`. For a kana layout it is a
  kana produced by one key plus maybe a thumb.
- Everything downstream — ribbon, hands, keycaps, stats — speaks only in chords, so
  the three input methods share one pipeline with no special cases.

The flow, and the file to look in:

| stage | file |
| --- | --- |
| physical key table: position, width, finger | `src/core/keyboard-geometry.ts` |
| latin layouts: code -> characters, and the inverse | `src/core/layouts.ts` |
| kana layouts: code -> three thumb-shift faces | `src/core/kana-layouts.ts` |
| kana normalisation, romaji table, kana segmentation | `src/core/kana.ts` |
| text -> units and chords; keycap legends | `src/core/method.ts` |
| keyboard events -> presses; simultaneous detection | `src/core/input.ts` |
| run state machine, cursor, matching, keystroke log, `cuePlan` | `src/core/engine.ts` |
| speed series, moving average, summary aggregates | `src/core/stats.ts` |
| the look-ahead ribbon | `src/render/guide.ts` |
| keycaps, finger colours, press bloom, heatmap | `src/render/keyboard.ts` |
| the hand schematics | `src/render/hands.ts` |
| canvas owner: sizing, flashes, ribbon animation | `src/render/board.ts` |
| text panel, HUD, settings, summary | `src/ui/` |

`src/main.ts` owns the frame loop and the global key handling; views read the
runner's public state each frame and react to its callbacks. The runner knows
nothing about rendering.

### Things that will bite

- **Layout tables are transcribed from published sources, not derived.** NICOLA and
  飛鳥123 cite their sources in `kana-layouts.ts`; `tests/japanese.test.ts` pins a
  sample of positions against those charts. Do not "correct" a table without
  checking the source — a wrong table teaches wrong fingering.
- **Kana layout tables contain backslashes** (and so does `layouts.ts`). Writing
  those files through a Bash heredoc silently eats one level of backslash escaping,
  which once made the whole `\`/`|` key unmappable. Use the Write tool for any file
  containing a backslash.
- **The board is ANSI.** JIS keys are addressed by the code they actually report:
  `@`→`BracketLeft`, `[`→`BracketRight`, `:`→`Quote`, `]`→`Backslash`. 無変換/変換
  have no ANSI key, so `thumbDrawKey` draws them at the Alt positions, which is
  where they sit on a JIS board.
- **The simultaneous-press window is a share, not a duration**: it is measured
  against the character key's own press span, not a fixed number of milliseconds. A character pressed with
  no thumb held is therefore deferred until release or the next key. Presses are
  timestamped at keydown so deferral never skews the measured speed. Details in
  `src/core/input.ts`.
- **Speed counts characters produced; accuracy counts presses.** `Keystroke.chars`
  is the numerator of every speed figure: on a correct press it is the characters
  the press *finished* — a unit's whole span on its last press, and 0 half-way
  through romaji きゃ — and on a miss the share of the unit it wasted. That is
  the only reason the three Japanese methods can be compared at all; counting
  presses scored romaji about twice as fast for the same passage. Latin is the
  degenerate case, one press one character, so latin numbers are unchanged, and
  nothing in `stats.ts` branches on the script. Do not reach for
  `Runner.unitsDone` instead: romaji folds きゃ into one unit while a kana layout
  types it as two keys, so unit counts are not comparable across methods either —
  which is exactly what the old `kana/min` card got wrong.
- **The text panel answers "which finger", and it does it per *press*.**
  `Runner.cuePlan` is what `ui/text-view.ts` draws the finger marks and the tint
  from. It walks the same preferred sequences as `expectedChords`, so the two
  agree press for press — a test pins that, because if they ever drift the mark
  names one finger while the ribbon points at another. It reports the press
  *due now*, not the unit's first: half-way through romaji `きゃ` the answer is
  `y`, not `k`.
- **The rendered window grows and trims; it is never re-cut.** The runner tops
  its buffer up several times a run (`fill`), and the text panel used to re-cut
  its window around the cursor on every top-up. A window that starts at a
  different character wraps every line somewhere new, so the whole panel jumped
  while the text under the cursor had not changed — it read as the run resetting
  itself. `TextView.sync` therefore only ever appends after the last line and
  drops *whole* lines off the top, and the frame that drops them runs with
  `.text-track.snap` so neither the track's transform nor the caret animates a
  move that cancels out anyway.
- **The marks live in the leading, and that is why `--line-h` is 2.25.** They are
  absolutely positioned, so they add no line box and the viewport is still three
  lines; but the tick-length differences that say *which* finger need a band to
  be drawn in, and 1.85 did not leave one. `.text-track` also carries one blank
  line of `padding-top`, so the cursor's line is never visible line 0, whose mark
  band would fall inside the viewport's top mask fade. That padding is counted by
  `offsetTop`, which is why the scroll is `-(line - 1) * lineHeight`.
- **Mark width is capped by the character cell.** A latin cell is 0.61em, and at
  the bottom of the `--font-size` clamp that is twelve pixels; a mark any wider
  smears into its neighbour. Height is the free dimension, so the comb is taller
  than it is wide. `scripts/verify.mjs` asserts no collisions and no mark eaten by
  the mask fade, at both window sizes.
- **The hand schematics pulse per *hand*, not per finger** (`render/hands.ts`).
  Left-or-right is the first decision and it has to land in peripheral vision, so
  the hand that owns the press due now gets the animation — aura, palm tint, a few
  percent of scale — the idle hand is dimmed, and the fingertip ring is static.
  `cueIndex` must therefore return only its own hand's cues: the digits are looked
  up by name and would not notice a stray one, but "is this hand active" reads the
  whole map, and both hands then claim every press.
- **A canvas in a grid needs an explicit row.** `.lower { grid-template-rows:
  minmax(0, 1fr) }` is load-bearing: without it `height: 100%` resolves against a
  content-sized row and the canvas expands to its intrinsic 2:1 aspect.
- **The frame loop is gated, and the board is not redrawn unless something moved.**
  `main.ts` draws the board every frame only while `phase` is `running` or
  `countin`, or while `board.busy(now)` (a press bloom or the ribbon slide is
  still alive); otherwise it waits for `boardDirty`. Anything that changes what
  the board should look like has to set that flag — `onPhase`, `onKeystroke`,
  `onTextChange`, `applySettings`, and `board.onInvalidate` from the canvas's
  ResizeObserver. Add a new source of board state and you must add a sixth. The
  speed strip has the same shape keyed on `stats.series.length`, because the
  chart only gains a point every `SAMPLE_MS`.
- **The keycaps are baked, not drawn.** `BoardView` renders all sixty-one caps
  into an offscreen canvas and blits it, rebaking only when `capSignature`
  changes — metrics, dpr, `fingerColors`, `fade`, `lite`, `nextCode`, and the
  contents of the `upcoming` and `holds` maps, plus the identity of `labels` and
  `heat`. **Any new input to `drawKeyboard` must go into that signature**, or it
  will render once and then be stuck. Live presses are drawn on top by
  `drawKeyFlash`, which repaints the whole cap rather than stamping the bloom
  over it, because the bloom belongs under the border and the gloss.
- **Nothing may repaint inside an element with `backdrop-filter`.** A repaint
  anywhere in that subtree makes the browser re-run the filter over the whole
  viewport, so one small animation inside an overlay costs a full-screen blur per
  frame. That is why the idle screen's `space` hint pulses in `steps(10)` rather
  than smoothly, and why the drifting background parks (`data-covered` on
  `<html>`) whenever an overlay is up. Both are invisible and both are worth
  four fifths of the idle screen's cost.
- **Blur is the budget.** The background wash carries no `filter` — its circles
  are radial gradients that fade to transparent, so they were already soft and
  the 90px blur over 140% of the viewport was buying nothing at the price of a
  full-screen convolution every frame the circles moved. Canvas `shadowBlur` is
  the same trap: each one is a render-to-offscreen, blur and composite. Reach for
  a soft gradient before reaching for a blur.
- **The ribbon is stroked in bands, and the alpha is pre-composited for it.**
  `guide.ts` groups the sampled curve into fourteen constant-colour bands and
  strokes each as one path, instead of one `stroke()` per sample segment — which
  was ~334 draw calls a frame. Overlapping round caps used to lay the colour down
  several times, and the ribbon's weight came from that build-up, so `overlaid()`
  raises each band's alpha by `1 - (1 - a)^coats` to land in the same place.
  Change the sample count or the band count and that compensation follows.
- **`requestAnimationFrame` does not run in a hidden tab**, so the app renders
  nothing when the browser pane is not displayed. That is why verification goes
  through Playwright rather than the in-app browser.
- **Playwright cannot synthesise `NonConvert`/`Convert`.** The kana passes in
  `verify.mjs` use the Alt stand-ins and a Space assignment; the JIS codes are
  covered by unit tests instead.
- **`graphics: 'lite'` has two halves and they have to stay in step.** The CSS
  half is `:root[data-graphics='lite']` rules, written from `applySettings`; the
  canvas half is a `lite` boolean threaded through `BoardState` into
  `drawKeyboard` / `drawHands` / `drawGuide` / `drawChart`, plus `renderScale`
  (`render/quality.ts`), which is the only place the device-pixel cap lives — the
  three canvases used to hardcode 2.5 each. A new blur or glow belongs in both.
- **Adding a setting means adding a validation line** in `loadSettings`
  (`src/core/settings.ts`) — persisted values from an older build are merged over
  the defaults and must be range-checked or they silently break behaviour. This got
  sharper with deployment: `localStorage` is keyed by *origin*, not path, so on a
  `user.github.io` the key is shared with every other page hosted there.
- **The Japanese author list is bounded by a 1945 death year**, and that is a
  licensing constraint, not a taste one. 青空文庫 publishes what is public domain
  *in Japan*; the site is hosted in the US, where the URAA restored copyright in
  foreign works still protected at home on 1996-01-01. Japan's term was then life +
  50, so an author who died by 1945 has nothing to restore. `AUTHORS` in
  `scripts/build-corpus-ja.mjs` carries a `died` field and the script throws on a
  later one. 小川未明 (1961) and 楠山正雄 (1954) were removed for this.
- **The corpus grows by reading deeper, not wider.** Only 総ルビ editions survive
  the all-kana filter, and there are few of them: five replacement authors were
  tried and gave under ten sentences each. The `works` numbers in `AUTHORS` are
  whole catalogues on purpose — 宮沢賢治 yields 120 sentences at 40 works and 400
  at 278. Do not trim them to save fetches.
- **`src/style/fonts-ja.css` is generated, and it is deliberately partial.**
  `app.css` has always *named* `'Noto Sans JP'` in its fallback stacks, but naming
  a face is not shipping one, so before this every kana was tofu on a machine
  without a Japanese system font — invisible in development, and most of a public
  URL's audience. Fontsource splits Japanese 124 ways by codepoint, so a subset
  costs ~9 KB whether you want one glyph from it or three hundred; the generator
  therefore bundles only the subsets covering `TYPEABLE` plus the 無変換 / 変換
  keycap labels. The authors' names in the picker are knowingly left out — they
  would add 15 subsets and 134 KB per weight. Canvas cannot read `--mono`, so the
  stack in `render/keyboard.ts` has to be kept in step with `app.css` by hand.

### Deployment

`.github/workflows/deploy.yml` publishes to GitHub Pages on every push to `main`.
Two things about it are load-bearing:

- **`base: './'` in `vite.config.ts` must stay relative.** It is what makes one
  `dist/` work at a domain root, under a `/<repo>/` project subpath and over
  `file://`. The usual GitHub Pages advice — `base: '/<repo>/'` — would trade two
  of those away and couple the build to the repository name.
- **`npm run build` is `tsc --noEmit && vite build`, and `tsconfig.json` covers
  `tests`.** A type error in a test file fails the deploy. That is intended.

`scripts/verify.mjs` cannot check a deployed build: it drives `window.__glide`,
which `main.ts` gates behind `import.meta.env.DEV`. Verify against `npm run dev`,
and check the production bundle by hand through `npm run preview`.

### Corpora

`src/corpus/*.json` is generated but committed, because the app must work offline.

`NOTICE.md` is generated too (`npm run notice`) and is where the OFL text and the
青空文庫 底本 / 入力・校正 credits live, per work. Rebuild it after either corpus.

Japanese passages are **all-kana by construction**: the builder folds 青空文庫's own
ruby into the text (漢字《かんじ》 → かんじ) and keeps only sentences with no kanji
left, since typing kanji would need an IME conversion step this app does not model.
That is why the authors are the ones whose editions are 総ルビ. Katakana is
displayed as written and typed as its hiragana.

Drills are generated at runtime from frequency data, and the layout-aware ones
("home row", "weak fingers") derive from whichever layout is active — never add a
per-layout drill data file.

## Extending

Adding a latin layout is one entry in `LAYOUTS` (`src/core/layouts.ts`): four rows
of tokens, where a token is a letter or a `lower`+`upper` pair. Adding a kana layout
is one entry in `KANA_LAYOUTS`: three planes of rows, `_` for an empty position.
Fingering, the ribbon, the hands, the drills and the heatmap all derive from it.
