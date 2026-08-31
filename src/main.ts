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
import { Runner } from './core/engine';
import { physKey } from './core/keyboard-geometry';
import { buildUnits, keyLabels, methodCharset, methodKind, type KeyLabel, type MethodSpec } from './core/method';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './core/settings';
import { BoardView } from './render/board';
import { drawChart } from './render/chart';
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
const summaryRoot = byId('summary');
const settingsRoot = byId('settings');

let settingsOpen = false;
let lastCountNumber = 0;

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

runner.onTextChange = () => textView.sync(runner.text, runner.cursor);

runner.onKeystroke = (event) => {
  board.noteKeystroke(event.code, event.correct, performance.now());
  clicker.click(event.correct);
};


window.addEventListener('keyup', (event) => {
  if (runner.handleKeyup(event, performance.now())) event.preventDefault();
});

runner.onPhase = (phase, previous) => {
  if (phase === 'countin' || (phase === 'running' && previous !== 'countin')) board.reset();
  if (phase === 'finished') {
    renderSummary({
      root: summaryRoot,
      summary: runner.summary(summaryLegend()),
      settings,
      spec: runner.method,
      units: runner.unitsDone,
      quit: runner.endReason === 'quit',
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

  if (!isThumbKey && event.key === 'Escape') {
    event.preventDefault();
    if (runner.phase === 'running' || runner.phase === 'countin') runner.abort(now);
    else if (runner.phase === 'finished') runner.reset();
    return;
  }

  if (!isThumbKey && event.key === 'Tab') {
    event.preventDefault();
    runner.reset();
    board.reset();
    runner.beginCountIn(now);
    return;
  }

  const idle = runner.phase === 'idle' || runner.phase === 'finished';

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

function drawSpeedStrip(now: number): void {
  const rect = speedCanvas.getBoundingClientRect();
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (speedCanvas.width !== Math.round(w * dpr) || speedCanvas.height !== Math.round(h * dpr)) {
    speedCanvas.width = Math.round(w * dpr);
    speedCanvas.height = Math.round(h * dpr);
  }
  const ctx = speedCanvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const elapsed = runner.elapsedMs / 1000;
  const windowed = settings.duration === 0;
  const xMax = windowed ? Math.max(30, elapsed) : settings.duration;
  const xMin = windowed ? Math.max(0, xMax - 30) : 0;

  drawChart(ctx, {
    series: runner.stats.series,
    width: w,
    height: h,
    xMax,
    xMin,
    maWindow: settings.maWindow,
    readout: true,
    padding: { top: 16, right: 30, bottom: 6, left: 4 },
  });
  void now;
}

function frame(): void {
  const now = performance.now();
  runner.tick(now);

  const phase = runner.phase;
  setOpen(overlays.idle, phase === 'idle' && !settingsOpen);
  setOpen(overlays.count, phase === 'countin');
  setOpen(overlays.summary, phase === 'finished' && !settingsOpen);
  setOpen(overlays.settings, settingsOpen);

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

  textView.update(runner.text, runner.states, runner.cursor, runner.cuePlan(settings.lookahead), {
    blocked: runner.blocked,
    lookahead: settings.lookahead,
    fingerColors: settings.fingerColors,
    fingerMarks: settings.fingerMarks,
    live: phase !== 'finished',
  });

  board.draw({
    labels: labels(),
    spec: runner.method,
    fingerColors: settings.fingerColors,
    showHands: settings.showHands,
    chords: runner.expectedChords(settings.lookahead),
    now,
    guideOpacity: phase === 'finished' ? 0 : phase === 'idle' ? 0.8 : 1,
    ...(phase === 'finished' ? { fade: 0.5 } : {}),
  });

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
        correct: runner.stats.correctChars,
        errors: runner.stats.errorChars,
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

checkCoverage();
exposeDevHooks();
noteInputRequirements();
renderConfigChips(refs, settings, openSettings);
textView.sync(runner.text, runner.cursor);
requestAnimationFrame(frame);
