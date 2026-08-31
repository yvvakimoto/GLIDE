/**
 * Physical keyboard geometry (ANSI 60%).
 *
 * Fingers belong to *physical positions*, characters belong to *layouts* — so this
 * table is shared by every layout and never changes. Coordinates are in keycap
 * units (1u = one alphanumeric keycap) with the origin at the top-left of the
 * board; `render/keyboard.ts` scales units to pixels.
 */

export type Finger = 'l5' | 'l4' | 'l3' | 'l2' | 'thumb' | 'r2' | 'r3' | 'r4' | 'r5';

export type PhysKey = {
  /** KeyboardEvent.code */
  code: string;
  row: 0 | 1 | 2 | 3 | 4;
  /** left edge, in keycap units */
  x: number;
  /** width, in keycap units */
  w: number;
  finger: Finger;
  /** true for the eight resting positions (asdf / jkl;) */
  home: boolean;
  /** fixed label for non-character keys (character keys are labelled by the layout) */
  label?: string;
};

export const ROW_COUNT = 5;
/** total board width in keycap units */
export const BOARD_UNITS_X = 15;
/** total board height in keycap units */
export const BOARD_UNITS_Y = 5;

const FINGER_OF_CODE: Record<string, Finger> = {};
const assign = (finger: Finger, codes: string[]) => {
  for (const code of codes) FINGER_OF_CODE[code] = finger;
};

assign('l5', ['Backquote', 'Digit1', 'KeyQ', 'KeyA', 'KeyZ', 'Tab', 'CapsLock', 'ShiftLeft', 'ControlLeft']);
assign('l4', ['Digit2', 'KeyW', 'KeyS', 'KeyX']);
assign('l3', ['Digit3', 'KeyE', 'KeyD', 'KeyC']);
assign('l2', ['Digit4', 'Digit5', 'KeyR', 'KeyT', 'KeyF', 'KeyG', 'KeyV', 'KeyB']);
assign('thumb', ['Space', 'AltLeft', 'MetaLeft', 'AltRight', 'MetaRight']);
assign('r2', ['Digit6', 'Digit7', 'KeyY', 'KeyU', 'KeyH', 'KeyJ', 'KeyN', 'KeyM']);
assign('r3', ['Digit8', 'KeyI', 'KeyK', 'Comma']);
assign('r4', ['Digit9', 'KeyO', 'KeyL', 'Period']);
assign('r5', [
  'Digit0', 'Minus', 'Equal', 'Backspace',
  'KeyP', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Enter',
  'Slash', 'ShiftRight', 'ControlRight', 'ContextMenu',
]);

const HOME_CODES = new Set(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']);

/** [code, width, fixed label] — widths default to 1u, labels default to the layout's character */
type RowSpec = Array<[code: string, w?: number, label?: string]>;

const ROWS: Array<{ row: PhysKey['row']; startX: number; keys: RowSpec }> = [
  {
    row: 0,
    startX: 0,
    keys: [
      ['Backquote'], ['Digit1'], ['Digit2'], ['Digit3'], ['Digit4'], ['Digit5'], ['Digit6'],
      ['Digit7'], ['Digit8'], ['Digit9'], ['Digit0'], ['Minus'], ['Equal'], ['Backspace', 2, 'del'],
    ],
  },
  {
    row: 1,
    startX: 0,
    keys: [
      ['Tab', 1.5, 'tab'], ['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR'], ['KeyT'], ['KeyY'], ['KeyU'],
      ['KeyI'], ['KeyO'], ['KeyP'], ['BracketLeft'], ['BracketRight'], ['Backslash', 1.5],
    ],
  },
  {
    row: 2,
    startX: 0,
    keys: [
      ['CapsLock', 1.75, 'caps'], ['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyH'],
      ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon'], ['Quote'], ['Enter', 2.25, 'enter'],
    ],
  },
  {
    row: 3,
    startX: 0,
    keys: [
      ['ShiftLeft', 2.25, 'shift'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyB'], ['KeyN'],
      ['KeyM'], ['Comma'], ['Period'], ['Slash'], ['ShiftRight', 2.75, 'shift'],
    ],
  },
  {
    row: 4,
    startX: 0,
    keys: [
      ['ControlLeft', 1.25, 'ctrl'], ['MetaLeft', 1.25, 'meta'], ['AltLeft', 1.25, 'alt'],
      ['Space', 6.25, ''], ['AltRight', 1.25, 'alt'], ['MetaRight', 1.25, 'meta'],
      ['ContextMenu', 1.25, 'menu'], ['ControlRight', 1.25, 'ctrl'],
    ],
  },
];

function buildKeys(): PhysKey[] {
  const keys: PhysKey[] = [];
  for (const { row, startX, keys: spec } of ROWS) {
    let x = startX;
    for (const [code, w = 1, label] of spec) {
      keys.push({
        code,
        row,
        x,
        w,
        finger: FINGER_OF_CODE[code] ?? 'thumb',
        home: HOME_CODES.has(code),
        ...(label === undefined ? {} : { label }),
      });
      x += w;
    }
  }
  return keys;
}

export const PHYS_KEYS: readonly PhysKey[] = buildKeys();

const BY_CODE = new Map<string, PhysKey>(PHYS_KEYS.map((k) => [k.code, k]));

export function physKey(code: string): PhysKey | undefined {
  return BY_CODE.get(code);
}

/** Centre of a key, in keycap units. */
export function keyCenter(key: PhysKey): { x: number; y: number } {
  return { x: key.x + key.w / 2, y: key.row + 0.5 };
}

/**
 * The hand a finger belongs to. The thumb is genuinely ambiguous — which is why
 * the table has no `hand` field — so it answers undefined and the caller, which
 * knows whether a thumb-shift is in play, decides.
 */
export function handOf(finger: Finger): 'left' | 'right' | undefined {
  if (finger === 'thumb') return undefined;
  return finger.startsWith('l') ? 'left' : 'right';
}

/**
 * Which of the four comb slots a finger occupies, counted inward from the index
 * finger: 0 index, 1 middle, 2 ring, 3 pinky. The `Finger` ids already carry the
 * anatomical digit number, so this is just the offset. The thumb has no slot.
 */
export function fingerSlot(finger: Finger): number {
  return finger === 'thumb' ? -1 : Number(finger[1]) - 2;
}

/** Which side of the board a key sits on, for resolving the thumb that hits it. */
export function keySide(key: PhysKey): 'left' | 'right' {
  return key.x + key.w / 2 < BOARD_UNITS_X / 2 ? 'left' : 'right';
}

export const FINGER_ORDER: readonly Finger[] = ['l5', 'l4', 'l3', 'l2', 'thumb', 'r2', 'r3', 'r4', 'r5'];

/** Warm on the left hand, cool on the right — reads as one rainbow across the board. */
export const FINGER_COLOR: Record<Finger, string> = {
  l5: '#ff3d6e',
  l4: '#ff8a3d',
  l3: '#f7d24a',
  l2: '#b6f24a',
  thumb: '#7d8798',
  r2: '#3df2b6',
  r3: '#3dd6ff',
  r4: '#6b8dff',
  r5: '#b46bff',
};

export const FINGER_NAME: Record<Finger, string> = {
  l5: 'L pinky',
  l4: 'L ring',
  l3: 'L middle',
  l2: 'L index',
  thumb: 'Thumb',
  r2: 'R index',
  r3: 'R middle',
  r4: 'R ring',
  r5: 'R pinky',
};

/** rgb triple of a finger colour, for interpolation in canvas code */
export const FINGER_RGB: Record<Finger, [number, number, number]> = Object.fromEntries(
  FINGER_ORDER.map((f) => {
    const hex = FINGER_COLOR[f];
    return [f, [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ]];
  }),
) as Record<Finger, [number, number, number]>;
