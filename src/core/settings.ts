import { LAYOUTS, type LayoutId } from './layouts';
import { listSources } from './corpus';
import type { JaMethod } from './method';

export type InputMode = 'remap' | 'passthrough';
export type ErrorMode = 'block' | 'advance';
export type LabelMode = 'layout' | 'physical' | 'blank';
export type GraphicsMode = 'lite' | 'rich';

export type Settings = {
  /** latin layout, used for English text and for romaji input */
  layout: LayoutId;
  /** how Japanese text is typed */
  jaMethod: JaMethod;
  /** remap: read event.code and translate. passthrough: trust event.key (OS already set to the layout). */
  inputMode: InputMode;
  /** how many upcoming keys the ribbon shows (0 hides it) */
  lookahead: number;
  /** run length in seconds; 0 = untimed (runs until Esc) */
  duration: number;
  /** corpus source id, see core/corpus.ts */
  source: string;
  errorMode: ErrorMode;
  /** physical key code driving the left thumb-shift role (kana layouts) */
  thumbLeft: string;
  /** physical key code driving the right thumb-shift role */
  thumbRight: string;
  /** simultaneous-press window, as a share of the key's press span */
  thumbPercent: number;
  /** 連続シフト: one thumb press shifts a run of characters, not just one */
  thumbContinuous: boolean;
  /** draw the hand schematics beside the keyboard */
  showHands: boolean;
  /** draw a little hand over each upcoming character, with the finger it wants lit */
  fingerMarks: boolean;
  /** moving-average window, seconds */
  maWindow: number;
  labelMode: LabelMode;
  fingerColors: boolean;
  sound: boolean;
  /** the background loop; its own switch, because it is four megabytes and an opinion */
  music: boolean;
  /**
   * `lite`, the default, is the app with no blur in it anywhere: no background
   * wash, no frosted overlays, no canvas shadow, and a lower device-pixel cap.
   * `rich` hands all of that back, and costs most of a frame on integrated
   * graphics to do it. Every cue the trainer actually teaches with — the ribbon,
   * the finger colours, the marks, the hands — is in both.
   */
  graphics: GraphicsMode;
};

export const DURATIONS = [15, 30, 60, 120, 300, 0] as const;
export const JA_METHODS: readonly JaMethod[] = ['romaji', 'nicola', 'asuka'];

/**
 * Keys that can take a thumb-shift role. The JIS keys flanking the space bar are
 * the real thing; Alt sits in the same places on a US board, and Space itself is
 * a common choice for one of the two.
 */
export const THUMB_CANDIDATES: ReadonlyArray<{ code: string; label: string; note: string }> = [
  { code: 'NonConvert', label: '無変換', note: 'JIS, left of space' },
  { code: 'Space', label: 'space', note: 'the bar itself' },
  { code: 'Convert', label: '変換', note: 'JIS, right of space' },
  { code: 'KanaMode', label: 'かな', note: 'JIS, far right' },
  { code: 'AltLeft', label: 'left alt', note: 'US stand-in' },
  { code: 'AltRight', label: 'right alt', note: 'US stand-in' },
];

/** 50 is the usual default; 100 accepts a thumb any time before the key is released. */
export const THUMB_PERCENTS = [0, 25, 50, 75, 100] as const;
export const LOOKAHEAD_RANGE = { min: 0, max: 10 } as const;
export const MA_WINDOWS = [2, 5, 10, 20] as const;
export const GRAPHICS_MODES: readonly GraphicsMode[] = ['lite', 'rich'];

export const DEFAULT_SETTINGS: Settings = {
  layout: 'dvorak',
  jaMethod: 'romaji',
  inputMode: 'remap',
  lookahead: 6,
  duration: 60,
  source: 'prose',
  errorMode: 'block',
  thumbLeft: 'NonConvert',
  thumbRight: 'Convert',
  thumbPercent: 50,
  thumbContinuous: true,
  maWindow: 5,
  labelMode: 'layout',
  showHands: true,
  fingerMarks: true,
  fingerColors: true,
  sound: true,
  music: true,
  graphics: 'lite',
};

const STORAGE_KEY = 'dvorak-trainer/settings/v1';

/**
 * Every stored value gets checked below, and none of them are checked for the
 * sake of tidiness. localStorage is keyed by *origin*, not by path, so once the
 * app is served from a user's github.io every other page that user hosts there
 * shares this key — as does an older build of GLIDE itself, whose `layout` or
 * `source` may name something that no longer exists. An unvalidated value walks
 * straight into the runner, so adding a setting means adding a line here.
 */
export const LAYOUT_IDS: ReadonlySet<string> = new Set(LAYOUTS.map((l) => l.id));
const SOURCE_IDS: ReadonlySet<string> = new Set(listSources().map((s) => s.id));
const LABEL_MODES: readonly LabelMode[] = ['layout', 'physical', 'blank'];
const BOOLEANS = [
  'thumbContinuous',
  'showHands',
  'fingerMarks',
  'fingerColors',
  'sound',
  'music',
] as const satisfies ReadonlyArray<keyof Settings>;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function loadSettings(): Settings {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : undefined;
  } catch {
    stored = undefined;
  }
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings> | undefined) };
  merged.lookahead = clamp(Math.round(merged.lookahead), LOOKAHEAD_RANGE.min, LOOKAHEAD_RANGE.max);
  if (!DURATIONS.includes(merged.duration as (typeof DURATIONS)[number])) merged.duration = DEFAULT_SETTINGS.duration;
  // values saved by an older build may no longer exist
  if (merged.errorMode !== 'block' && merged.errorMode !== 'advance') {
    merged.errorMode = DEFAULT_SETTINGS.errorMode;
  }
  if (!JA_METHODS.includes(merged.jaMethod)) merged.jaMethod = DEFAULT_SETTINGS.jaMethod;

  const codes = new Set(THUMB_CANDIDATES.map((c) => c.code));
  if (!codes.has(merged.thumbLeft)) merged.thumbLeft = DEFAULT_SETTINGS.thumbLeft;
  if (!codes.has(merged.thumbRight)) merged.thumbRight = DEFAULT_SETTINGS.thumbRight;
  // one key cannot be both thumbs
  if (merged.thumbLeft === merged.thumbRight) {
    merged.thumbLeft = DEFAULT_SETTINGS.thumbLeft;
    merged.thumbRight = DEFAULT_SETTINGS.thumbRight;
  }
  merged.thumbPercent = clamp(Math.round(merged.thumbPercent), 0, 100);
  if (!MA_WINDOWS.includes(merged.maWindow as (typeof MA_WINDOWS)[number])) merged.maWindow = DEFAULT_SETTINGS.maWindow;

  if (!LAYOUT_IDS.has(merged.layout)) merged.layout = DEFAULT_SETTINGS.layout;
  if (!SOURCE_IDS.has(merged.source)) merged.source = DEFAULT_SETTINGS.source;
  if (merged.inputMode !== 'remap' && merged.inputMode !== 'passthrough') {
    merged.inputMode = DEFAULT_SETTINGS.inputMode;
  }
  if (!LABEL_MODES.includes(merged.labelMode)) merged.labelMode = DEFAULT_SETTINGS.labelMode;
  if (!GRAPHICS_MODES.includes(merged.graphics)) merged.graphics = DEFAULT_SETTINGS.graphics;
  for (const key of BOOLEANS) {
    if (typeof merged[key] !== 'boolean') merged[key] = DEFAULT_SETTINGS[key];
  }
  return merged;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / storage disabled — settings just won't persist */
  }
}
