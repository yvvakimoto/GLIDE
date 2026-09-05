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
npm run shakyo       # rebuild the 写経 works (whole books) from Project Gutenberg
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
median and p95. Pass a second argument (`lite` / `rich`) to pin `graphics`, and
`GLIDE_VIEWPORT=2560x1440` to check fill rate on a big panel. The
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
| the run log: one row per run, and what makes two runs comparable | `src/core/history.ts` |
| 写経 works: the bundled index, and the lazily-fetched bodies | `src/core/works.ts` |
| where you left off in each work | `src/core/progress.ts` |
| the table of contents overlay | `src/ui/contents-panel.ts` |
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
- **`finished` owns every key, and `space` is not one of them.** A run ends in
  the middle of a keystroke — `tick` flips the phase and `onPhase` raises the
  summary inside one frame — so the space the typist was already reaching for
  lands on the summary a few milliseconds later. While `space` meant "run
  again", the summary was being dismissed by the run that produced it. So
  `main.ts` handles `finished` in its own block ahead of every other shortcut:
  `esc` leaves, `tab` runs again, everything else dies there, and for
  `SUMMARY_GUARD_MS` after the transition even those two are dead, because the
  tail of the run's own typing is still arriving. A new shortcut added to the
  global handler will *not* reach the summary unless it is added to that block
  too, which is the intended default. `verify.mjs` pins all of this, and note
  that its passes bleed settings into each other — the kana passes leave
  `source: 'ja'` and `Space` assigned as a thumb key, so a later pass has to put
  both back before `Space` can mean "start" again.
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
  four fifths of the idle screen's cost under `rich`, the only mode in which any
  of those blurs exist at all.
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
- **`graphics` means exactly one thing: blur or no blur.** `lite` is the default
  and it is the app with no blur in it anywhere; `rich` is opt-in. It has two
  halves and they have to stay in step. The CSS half is **additive** — the base
  stylesheet is the cheap page, and `:root[data-graphics='rich']` hands the
  decoration back — because `<html>` carries no attribute until the module runs,
  and a browser that paints the static markup first must not flash the expensive
  page. The canvas half is a `lite` boolean threaded through `BoardState` into
  `drawKeyboard` / `drawHands` / `drawGuide` / `drawChart`. A new blur or glow
  belongs in both. Resolution is *not* part of it: `renderScale`
  (`render/quality.ts`) caps the device pixel ratio at 2 in both modes, and that
  is measured — `lite` at 2x holds sixty frames a second at 2560x1440 on a CPU
  rasteriser. The three canvases used to hardcode 2.5 each.
- **A stream can end, and two separate things have to notice.** `fill()`
  (`engine.ts`) tops up with `while (text.length - cursor < BUFFER_AHEAD)`, so
  `TextStream.next()` returns `null` for an ordered work and the loop breaks on
  it — without that it spins for ever. Stopping `fill` is only half: `enterUnit`
  empties `viable` and parks the cursor at the end of the text *without touching
  the phase*, so a finished work would sit in `running` with every key dead and
  the clock going. `advance()` completes the run, which is why `EndReason` has a
  third value, `'end'`. Anything new that consumes a stream has to handle both.
- **A bookmark stores where you stopped; the rounding happens at resume.** The
  stored place is a chunk plus a raw character offset into it, and
  `resumePoint` (`works.ts`) is the only thing allowed to turn that into a
  place to start typing — it backs the offset up to the top of the sentence you
  were in. Rounding at read time rather than at write time is what lets the
  rounding rule change without every stored bookmark meaning something slightly
  wrong, and it is the same shape as `resumeAt`'s clamp: a bound that only
  arrives with the body. An *arbitrary* character offset is still not safe to
  resume from — it can land inside a unit, half-way through romaji きゃ — but a
  sentence start is, because a sentence begins after terminating punctuation and
  no unit spans that. `sentenceStart` is the builder's own definition of a
  sentence (`chunkParagraph` in `build-shakyo.mjs` cuts long paragraphs at
  exactly those places), which is why it is derived at runtime instead of baked
  into the data: re-cutting chunks would change every work's `stamp` and make
  every bookmark stale. An offset means nothing outside the chunk it was
  measured in, so `saveBookmark` drops it whenever a writer moves `chunk`
  without saying where in it — a chapter jump — and `resumePoint` drops it when
  the bookmark is `stale` or the chunk had to step back. The place is written
  where a run ends, on a new sentence at most every few seconds, and on
  `pagehide` — never per keystroke; the tick path checks the throttle *before*
  scanning for the sentence, because that scan walks a chunk and it runs from
  the frame loop. Note that the end-of-run write happens *twice* (the run, then
  `pagehide`) with the stats still holding the run's characters, so a sitting is
  counted once by a flag, not by the write.
- **A work's body is fetched, so `source` cannot name one synchronously.**
  `createStream` is called from the `Runner` constructor and from
  `applySettings`, and the settings panel's handlers and `verify.mjs` all assume
  it returns immediately. So `selectWork` in `main.ts` is the funnel: the body
  lands first, and only then does `source` move. A stored work id starts on its
  matching shuffle and swaps in when it arrives. `verify.mjs` must call
  `__glide.selectWork`, never `applySettings`, or it silently gets the fallback.
- **The works build must stay byte-deterministic.** `src/corpus/works/` is
  committed and it is megabytes, so a rebuild that reorders a key or re-cuts a
  chunk adds its whole size to the repository's history again, for ever. No
  timestamps, no insertion-ordered iteration, chunk splitting a pure function of
  the text. The test is `node scripts/build-shakyo.mjs --offline && git diff
  --exit-code src/corpus/works`.
- **Each 写経 work asserts its own chapter count**, in the spirit of the
  death-year check. Gutenberg re-issues editions, and one that changed heading
  style would otherwise ship a single giant chapter in silence. Books that cannot
  be split are listed in `build-shakyo.mjs` as deliberately absent, with the
  reason. Adding one means teaching the detector its shape and *then* pinning the
  count — never relaxing the assertion until it passes.
- **A contents page is headings with nothing between them.** That is how the
  table of contents is discarded, rather than by guessing where in the file it
  sits: monotonicity alone cannot do it, because the contents numbers and the
  body numbers both ascend, so the longest increasing run happily takes half of
  each. Moby Dick found 130 perfectly good headings that way and produced five
  chapters with any text in them.
- **Front matter is dropped, so a late first heading is dangerous.** Everything
  before the first heading goes, which is right for a title page and fatal for a
  mis-detection — Kwaidan matched its first heading 66% of the way in and would
  have shipped a third of the book. Past 35% of the text the headings are not the
  structure and the build keeps everything as one chapter instead. A real preface
  can be a sixth of a slim volume (Yeats's introduction to Gitanjali is 18%), so
  the threshold has to sit well above that.
- **Japanese 写経 is blocked on the editions, and it is measured, not assumed.**
  Of 358 cached 青空文庫 works over 2000 characters, **five** are fully
  ruby-annotated. The all-kana corpus works because it cherry-picks the rare
  fully-annotated *sentences*; a whole work is a far stronger requirement.
  `build-shakyo-ja.mjs` is finished and correct and currently yields one usable
  work, so none ship. Its `--needs` report shows the near misses are short of
  kanji *numerals* rather than vocabulary, because editions leave those to
  context — a narrower gap than it first looks, but the readings are genuinely
  contextual (一 is いち / ひと / いっ), and `PATCHES` stays empty until someone
  reads them in the 底本. Guessing one teaches wrong fingering.
- **`scripts/lib/aozora.mjs` owns the author list, and nothing else may.** The
  1945 death-year rule is a licensing constraint; a second Japanese builder with
  its own copy of the list is how it gets lost. Same for
  `scripts/lib/gutenberg.mjs` and the licence note that says these are texts
  *sourced from* Project Gutenberg rather than Project Gutenberg eBooks.
- **Ruby is read as a pairing, in one offset-tracking pass** (`scripts/lib/ruby.mjs`).
  The old fold in `build-corpus-ja.mjs` is a chain of whole-document `.replace()`
  calls, every one of which deletes characters — safe only because it throws the
  kanji away. The moment you want an *index* into the result, running them in
  sequence is wrong: each pass shifts every offset the previous one produced. So
  the scanner works on one entry per output character, every transform is a
  mark-and-filter over that array, and offsets are taken once at the end.
- **Historical kana is modernised everywhere, including inside readings.** 731 of
  the cached work files carry ゐ/ゑ/ヰ/ヱ inside an `<rt>`, and no kana layout has
  a position for them (`kana-layouts.ts` has none; only romaji can). The typed
  character is modernised and the original kept as a display override. Modernising
  only body text leaves readings untypeable, which is the exact case the rule
  exists for — `tests/ruby.test.ts` pins it.
- **What the Japanese methods can type is settled by `buildUnits`, not by taste**
  (`tests/shakyo-charset.test.ts`). Kana, ー、。・ are safe; the bracket and
  exclamation punctuation of running prose is not. It matters because a character
  no method can key is one `enterUnit` steps over and marks `Correct` — crediting
  the typist for text they never typed.
- **Adding a setting means adding a validation line** in `loadSettings`
  (`src/core/settings.ts`) — persisted values from an older build are merged over
  the defaults and must be range-checked or they silently break behaviour. This got
  sharper with deployment: `localStorage` is keyed by *origin*, not path, so on a
  `user.github.io` the key is shared with every other page hosted there.
- **There are two localStorage keys, and they answer a bad value differently.**
  `settings/v1` *repairs* an out-of-range value to its default; `history/v1`
  (`src/core/history.ts`) *drops* the row. There is no correct fallback for a
  wrong speed — a repaired 0 wpm is as much a lie as the garbage it replaced —
  and unlike a setting, which the next write overwrites, a bad row stays in the
  log poisoning the mean and the personal best for ever. A third store should
  pick whichever of the two rules fits, deliberately.
- **A run has one floor, not two.** `worthKeeping` (`history.ts`) admits a run at
  10 seconds and 25 characters; below that a two-second blur-abort scores several
  hundred wpm, because `INSTANT_WINDOW_MS` is 1500 and `wpmOf` divides by
  elapsed. A *second*, higher bar for the personal best was tried and removed: a
  15 s run whose clock stops at 14.98 s was then recorded, charted and counted in
  the mean while silently not counting as a best, which reads on screen as the
  best being broken. The summary panel says out loud when a run fell below the
  floor, because otherwise it shows a `vs previous` for a run that is not in
  `runs`.
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
