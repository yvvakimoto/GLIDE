import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './style/fonts-ja.css';
import './style/app.css';

import { corpusCharset } from './core/corpus';
import { Runner, type EndReason } from './core/engine';
import { recordRun, rowOf, type RunEnd } from './core/history';
import { physKey } from './core/keyboard-geometry';
import { buildUnits, keyLabels, methodCharset, methodKind, type KeyLabel, type MethodSpec } from './core/method';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './core/settings';
import { BoardView } from './render/board';
import { drawChart } from './render/chart';
import { renderScale } from './render/quality';
import { byId, setOpen } from './ui/dom';
import { hudRefs, renderConfigChips, updateHud } from './ui/hud';
import { renderSettingsPanel } from './ui/settings-panel';
import { Clicker } from './ui/sound';
import { renderSummary } from './ui/summary';
import { TextView } from './ui/text-view';

const DEFAULT_THUMBS = { left: DEFAULT_SETTINGS.thumbLeft, right: DEFAULT_SETTINGS.thumbRight };

/** Dev-time guard: every corpus character must be reachable by every method. */
function checkCoverage(): void {
  if (!import.meta.env.DEV) return;
  const specs: MethodSpec[] = [
    ...(['qwerty', 'dvorak', 'colemak', 'colemak-dh', 'workman'] as const).map(
      (latin): MethodSpec => ({ script: 'latin', latin, ja: 'romaji', thumbs: DEFAULT_THUMBS }),
    ),
    ...(['romaji', 'nicola', 'asuka'] as const).map(
      (ja): MethodSpec => ({ script: 'ja', latin: 'qwerty', ja, thumbs: DEFAULT_THUMBS }),
    ),
  ];
  for (const spec of specs) {
    const charset = corpusCharset(spec.script);
    const missing = [...charset].filter((c) => !canType(spec, c));
    if (missing.length) {
      const name = spec.script === 'ja' ? spec.ja : spec.latin;
      console.warn(`[glide] ${name} cannot type: ${missing.map((c) => JSON.stringify(c)).join(' ')}`);
    }
  }
}

/** A character is typeable when the method can spell it out. */
function canType(spec: MethodSpec, char: string): boolean {
  if (methodKind(spec) === 'romaji') {
    return buildUnitsCanType(spec, char);
  }
  return methodCharset(spec).has(char);
}

function buildUnitsCanType(spec: MethodSpec, char: string): boolean {
  const units = buildUnits(char, 0, spec);
  return units.length > 0 && units.every((unit) => unit.sequences.length > 0);
}

let settings: Settings = loadSettings();
const runner = new Runner(settings);
const refs = hudRefs();
const clicker = new Clicker(settings.sound);

const boardCanvas = byId<HTMLCanvasElement>('board-canvas');
const speedCanvas = byId<HTMLCanvasElement>('speed-canvas');
const board = new BoardView(boardCanvas);
const textView = new TextView(byId('text-viewport'));

const overlays = {
  idle: byId('overlay-idle'),
  count: byId('overlay-count'),
  summary: byId('overlay-summary'),
  settings: byId('overlay-settings'),
};
const countNumber = byId('count-number');
const countOut = byId('count-out');
const summaryRoot = byId('summary');
const settingsRoot = byId('settings');

/**
 * A run ends in the middle of a keystroke: the space the typist was already
 * reaching for lands a few milliseconds after the summary has opened. For that
 * long the summary answers to nothing at all.
 */
const SUMMARY_GUARD_MS = 600;

let settingsOpen = false;
let lastCountNumber = 0;
let lastCountOut = 0;
let finishedAt = -Infinity;
/** the board is redrawn on demand outside a run; see `frame` */
let boardDirty = true;

board.onInvalidate = () => {
  boardDirty = true;
};

let labelCache: { key: string; value: Map<string, KeyLabel> } | undefined;

/** Keycap legends for the active method; recomputed only when the method changes. */
function labels(): Map<string, KeyLabel> {
  const spec = runner.method;
  const key = `${spec.script}/${spec.latin}/${spec.ja}/${settings.labelMode}`;
  if (labelCache?.key !== key) labelCache = { key, value: keyLabels(spec, settings.labelMode) };
  return labelCache.value;
}

/** Legends for the summary, always legible even if the run hid the keycaps. */
function summaryLegend(): (code: string) => string {
  const legends = keyLabels(runner.method, 'layout');
  return (code) => legends.get(code)?.main || physKey(code)?.label || code;
}

function applySettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  clicker.enabled = settings.sound;
  runner.configure(settings);
  renderConfigChips(refs, settings, openSettings);
  if (settingsOpen) renderPanel();
  textView.sync(runner.text, runner.cursor);
  // the stylesheet reads this to drop the blurs; the canvases read the setting
  document.documentElement.dataset.graphics = settings.graphics;
  boardDirty = true;
  stripEpoch++;
}

function renderPanel(): void {
  renderSettingsPanel({
    root: settingsRoot,
    settings,
    onChange: applySettings,
    onClose: closeSettings,
  });
}

function openSettings(): void {
  if (runner.phase === 'running' || runner.phase === 'countin') return;
  settingsOpen = true;
  renderPanel();
}

function closeSettings(): void {
  settingsOpen = false;
}

runner.onTextChange = () => {
  textView.sync(runner.text, runner.cursor);
  boardDirty = true;
};

runner.onKeystroke = (event) => {
  board.noteKeystroke(event.code, event.correct, performance.now());
  clicker.click(event.correct);
  boardDirty = true;
};


window.addEventListener('keyup', (event) => {
  if (runner.handleKeyup(event, performance.now())) event.preventDefault();
});

/** A run is only ever finished by the timer or by the typist. */
const endOf = (reason: EndReason): RunEnd => (reason === 'time' ? 'time' : 'quit');

runner.onPhase = (phase, previous) => {
  boardDirty = true;
  if (phase === 'countin' || (phase === 'running' && previous !== 'countin')) board.reset();
  if (phase === 'finished') {
    finishedAt = performance.now();
    const summary = runner.summary(summaryLegend());
    // Record before rendering, so the chart's last point is the run you just did.
    const run = rowOf(summary, settings, runner.method.script, endOf(runner.endReason));
    const history = recordRun(run);
    renderSummary({
      root: summaryRoot,
      summary,
      settings,
      spec: runner.method,
      quit: runner.endReason === 'quit',
      history,
      run,
    });
  }
};

window.addEventListener('keydown', (event) => {
  const now = performance.now();

  if (settingsOpen) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
    return;
  }

  // Alt is not disqualifying: on a US keyboard it can stand in for a thumb key
  if (event.ctrlKey || event.metaKey) return;

  const kana = methodKind(runner.method) === 'kana';
  if (event.altKey && !kana) return;

  // a key acting as a thumb shift belongs to the runner, never to a shortcut
  const isThumbKey =
    kana && (event.code === settings.thumbLeft || event.code === settings.thumbRight);

  // The summary owns every key while it is up. `space` used to run again from
  // here, and it is exactly the key the typist was mid-word on when the clock
  // ran out — the summary was being dismissed by the run that produced it. So
  // the shortcuts are `esc` and `tab` alone, and for the first moments even
  // those are dead, because the tail of the run's own typing is still arriving.
  if (runner.phase === 'finished') {
    const guarded = now - finishedAt < SUMMARY_GUARD_MS;
    if (!isThumbKey && event.key === 'Escape') {
      event.preventDefault();
      if (!guarded) runner.reset();
      return;
    }
    if (!isThumbKey && event.key === 'Tab') {
      event.preventDefault();
      if (!guarded) {
        runner.reset();
        board.reset();
        runner.beginCountIn(now);
      }
      return;
    }
    // everything else dies here; space would otherwise scroll the overlay
    if (event.code === 'Space') event.preventDefault();
    return;
  }

  if (!isThumbKey && event.key === 'Escape') {
    event.preventDefault();
    if (runner.phase === 'running' || runner.phase === 'countin') runner.abort(now);
    return;
  }

  if (!isThumbKey && event.key === 'Tab') {
    event.preventDefault();
    runner.reset();
    board.reset();
    runner.beginCountIn(now);
    return;
  }

  const idle = runner.phase === 'idle';

  if (idle && event.code === 'Space' && !event.altKey) {
    event.preventDefault();
    clicker.arm();
    runner.beginCountIn(now);
    return;
  }

  if (idle && !isThumbKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    openSettings();
    return;
  }

  if (runner.handleKeydown(event, now)) event.preventDefault();
});

window.addEventListener('blur', () => {
  if (runner.phase === 'running') runner.abort(performance.now());
});

const stripCtx = speedCanvas.getContext('2d');
let stripWidth = 0;
let stripHeight = 0;
let stripScale = 0;
let stripEpoch = 0;
let stripLaidOut = -1;
/** the last state the strip was drawn for: series length, and the sliding window */
let stripSeries = -1;
let stripDrawnAt = -Infinity;

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    stripEpoch++;
  }).observe(speedCanvas);
}

/**
 * The strip is redrawn on new data, not on new frames. `stats.ts` samples every
 * 250 ms, so sixty redraws a second were fifteen times more than the chart had
 * anything to say — and each one carried a blurred stroke the width of the bar.
 * An untimed run is the exception: its x window slides continuously, so it gets
 * a capped ten frames a second.
 */
const STRIP_SLIDE_MS = 100;

function drawSpeedStrip(now: number): void {
  if (!stripCtx) return;

  const series = runner.stats.series.length;
  const sliding = settings.duration === 0 && runner.phase === 'running';
  const stale =
    stripEpoch !== stripLaidOut ||
    series !== stripSeries ||
    (sliding && now - stripDrawnAt >= STRIP_SLIDE_MS);
  if (!stale) return;
  stripSeries = series;
  stripDrawnAt = now;

  const dpr = renderScale();
  if (stripEpoch !== stripLaidOut || dpr !== stripScale) {
    stripLaidOut = stripEpoch;
    stripScale = dpr;
    const rect = speedCanvas.getBoundingClientRect();
    stripWidth = Math.max(1, Math.round(rect.width));
    stripHeight = Math.max(1, Math.round(rect.height));
    speedCanvas.width = Math.round(stripWidth * dpr);
    speedCanvas.height = Math.round(stripHeight * dpr);
  }
  stripCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stripCtx.clearRect(0, 0, stripWidth, stripHeight);

  const elapsed = runner.elapsedMs / 1000;
  const windowed = settings.duration === 0;
  const xMax = windowed ? Math.max(30, elapsed) : settings.duration;
  const xMin = windowed ? Math.max(0, xMax - 30) : 0;

  drawChart(stripCtx, {
    series: runner.stats.series,
    width: stripWidth,
    height: stripHeight,
    xMax,
    xMin,
    maWindow: settings.maWindow,
    readout: true,
    lite: settings.graphics === 'lite',
    padding: { top: 16, right: 30, bottom: 6, left: 4 },
  });
}

function frame(): void {
  const now = performance.now();
  runner.tick(now);

  const phase = runner.phase;
  setOpen(overlays.idle, phase === 'idle' && !settingsOpen);
  setOpen(overlays.count, phase === 'countin');
  setOpen(overlays.summary, phase === 'finished' && !settingsOpen);
  setOpen(overlays.settings, settingsOpen);

  // An overlay is a full-viewport backdrop blur, and the browser can only leave
  // it alone while what is behind it holds still — the drifting background on its
  // own is enough to make it re-blur the whole screen every frame. Through nine
  // pixels of blur that drift is not visible anyway, so it parks while a panel is
  // up. The stylesheet reads this; every phase but `running` has an overlay.
  const covered = phase !== 'running' ? 'true' : 'false';
  if (document.documentElement.dataset.covered !== covered) {
    document.documentElement.dataset.covered = covered;
  }

  if (phase === 'countin') {
    const n = runner.countInNumber;
    if (n !== lastCountNumber) {
      lastCountNumber = n;
      countNumber.textContent = String(n);
      countNumber.classList.remove('pop');
      void countNumber.offsetWidth;
      countNumber.classList.add('pop');
    }
  } else {
    lastCountNumber = 0;
  }

  const out = runner.countOutNumber;
  if (out !== lastCountOut) {
    lastCountOut = out;
    countOut.textContent = out ? String(out) : '';
    countOut.classList.remove('tick');
    void countOut.offsetWidth;
    if (out) countOut.classList.add('tick');
  }

  textView.update(runner.text, runner.states, runner.cursor, runner.cuePlan(settings.lookahead), {
    blocked: runner.blocked,
    lookahead: settings.lookahead,
    fingerColors: settings.fingerColors,
    fingerMarks: settings.fingerMarks,
    live: phase !== 'finished',
  });

  // Outside a run the board is a still picture behind a full-screen backdrop
  // blur, and repainting it sixty times a second is what stops the compositor
  // caching that blur. So it is drawn on demand: on a phase change, a settings
  // change or a resize, and for as long as the last press is still blooming.
  if (phase === 'running' || phase === 'countin' || board.busy(now) || boardDirty) {
    boardDirty = false;
    board.draw({
      labels: labels(),
      spec: runner.method,
      fingerColors: settings.fingerColors,
      showHands: settings.showHands,
      chords: runner.expectedChords(settings.lookahead),
      now,
      guideOpacity: phase === 'finished' ? 0 : phase === 'idle' ? 0.8 : 1,
      lite: settings.graphics === 'lite',
      ...(phase === 'finished' ? { fade: 0.5 } : {}),
    });
  }

  drawSpeedStrip(now);
  updateHud(refs, runner);

  requestAnimationFrame(frame);
}

/** Dev-only handle used by scripts/verify.mjs to drive the app deterministically. */
function exposeDevHooks(): void {
  if (!import.meta.env.DEV) return;
  Object.defineProperty(window, '__glide', {
    value: {
      runner,
      get settings() {
        return settings;
      },
      applySettings,
      /** the presses that type `char` under the active method */
      pressesFor: (char: string) => {
        const units = buildUnits(char, 0, runner.method);
        const sequence = units[0]?.sequences[0];
        return sequence ? sequence.map((c) => ({ code: c.code, shift: c.shift, thumb: c.thumb })) : null;
      },
      /** the fingering the text panel is drawing, straight from the runner */
      cuePlan: (n = 1) => runner.cuePlan(n),
      /** the presses due next, straight from the runner */
      nextPresses: (n = 1) =>
        runner.expectedChords(n).map((c) => ({ code: c.code, shift: c.shift, thumb: c.thumb, label: c.label })),
      /** advance one press without pressing a key, to reach an interesting spot */
      skip: () => {
        const chord = runner.expectedChords(1)[0];
        if (!chord) return false;
        const now = performance.now();
        runner.handleKeydown(
          { code: chord.code, key: chord.label, shiftKey: chord.shift, ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent,
          now,
        );
        runner.handleKeyup(
          { code: chord.code, key: chord.label, shiftKey: chord.shift, ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent,
          now + 1,
        );
        return true;
      },
      snapshot: () => ({
        phase: runner.phase,
        blocked: runner.blocked,
        cursor: runner.cursor,
        wpm: runner.stats.netWpm(runner.elapsedMs),
        accuracy: runner.stats.accuracy(),
        chars: runner.stats.producedChars,
        correct: runner.stats.correctKeys,
        errors: runner.stats.errorKeys,
        series: runner.stats.series.length,
        upcoming: runner.expectedChords(8).map((c) => c.label).join(''),
      }),
    },
    configurable: true,
  });
}

/**
 * GLIDE is a finger-motion trainer: there is no touch input path anywhere, and
 * there is not going to be one. On a phone the page still lays out and still
 * shows "space to start", which reads as a broken app rather than as the wrong
 * device — so say which it is. `any-hover: none` is the test that means *no*
 * attached input can hover, so a laptop with a touchscreen is not caught.
 */
function noteInputRequirements(): void {
  const note = byId('idle-note');
  const touchOnly =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(any-pointer: coarse) and (any-hover: none)').matches;
  if (!touchOnly) return;
  note.textContent =
    'GLIDE needs a physical keyboard — it teaches where your fingers go, so there is nothing here an on-screen keyboard can practise. Open this on a laptop or desktop.';
  note.hidden = false;
}

document.documentElement.dataset.graphics = settings.graphics;
checkCoverage();
exposeDevHooks();
noteInputRequirements();
renderConfigChips(refs, settings, openSettings);
textView.sync(runner.text, runner.cursor);
requestAnimationFrame(frame);
