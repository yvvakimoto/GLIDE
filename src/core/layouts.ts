/**
 * Keyboard layouts: physical key code -> [unshifted, shifted] characters.
 *
 * Every layout shares the physical geometry in `keyboard-geometry.ts`, so a layout
 * is nothing but a relabelling. `charIndex` inverts the mapping and is what both
 * the input resolver and the look-ahead ribbon are built on.
 */

import { physKey, type PhysKey } from './keyboard-geometry';

export type LayoutId = 'qwerty' | 'dvorak' | 'colemak' | 'colemak-dh' | 'workman';

export type Layout = {
  id: LayoutId;
  name: string;
  note: string;
  /** code -> [lower, upper] */
  map: Readonly<Record<string, readonly [string, string]>>;
};

export type KeyStroke = { key: PhysKey; shift: boolean };

/** Rows are given left-to-right; codes come from the physical row order. */
const ROW_CODES = {
  digits: ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'],
  upper: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash'],
  home: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  lower: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
} as const;

/**
 * Builds a code->chars map from four space-separated rows.
 *
 * A token is either one character (a letter, whose shifted form is its uppercase)
 * or exactly two characters, `lower` then `upper`. Two characters keeps the DSL
 * unambiguous for keys whose own label is punctuation: `/?`, `;:`, `'"`.
 */
function rows(digits: string, upper: string, home: string, lower: string): Record<string, readonly [string, string]> {
  const map: Record<string, readonly [string, string]> = {};
  const add = (codes: readonly string[], spec: string) => {
    const tokens = spec.trim().split(/\s+/);
    if (tokens.length !== codes.length) {
      throw new Error(`layout row expects ${codes.length} keys, got ${tokens.length}: ${spec}`);
    }
    codes.forEach((code, i) => {
      const token = tokens[i]!;
      if (token.length === 1) {
        map[code] = [token, token.toUpperCase()];
      } else if (token.length === 2) {
        map[code] = [token[0]!, token[1]!];
      } else {
        throw new Error(`layout token must be 1 or 2 characters: ${token}`);
      }
    });
  };
  add(ROW_CODES.digits, digits);
  add(ROW_CODES.upper, upper);
  add(ROW_CODES.home, home);
  add(ROW_CODES.lower, lower);
  map['Space'] = [' ', ' '];
  return map;
}

/** Number row shared by every layout here except Dvorak, which moves - and =. */
const NUM_ANSI = '`~ 1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0) -_ =+';
const NUM_DVORAK = '`~ 1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0) [{ ]}';
/** the backslash / pipe key, kept as a named constant so the escaping stays readable */
const PIPE = '\\|';

export const LAYOUTS: readonly Layout[] = [
  {
    id: 'qwerty',
    name: 'QWERTY',
    note: 'the one everyone starts on',
    map: rows(
      NUM_ANSI,
      `q w e r t y u i o p [{ ]} ${PIPE}`,
      `a s d f g h j k l ;: '"`,
      'z x c v b n m ,< .> /?',
    ),
  },
  {
    id: 'dvorak',
    name: 'Dvorak',
    note: 'vowels left, consonants right',
    map: rows(
      NUM_DVORAK,
      `'" ,< .> p y f g c r l /? =+ ${PIPE}`,
      'a o e u i d h t n s -_',
      ';: q j k x b m w v z',
    ),
  },
  {
    id: 'colemak',
    name: 'Colemak',
    note: 'QWERTY-adjacent, strong home row',
    map: rows(
      NUM_ANSI,
      `q w f p g j l u y ;: [{ ]} ${PIPE}`,
      `a r s t d h n e i o '"`,
      'z x c v b k m ,< .> /?',
    ),
  },
  {
    id: 'colemak-dh',
    name: 'Colemak-DH',
    note: 'Colemak plus the mod-DH and angle fix',
    map: rows(
      NUM_ANSI,
      `q w f p b j l u y ;: [{ ]} ${PIPE}`,
      `a r s t g m n e i o '"`,
      'x c d v z k h ,< .> /?',
    ),
  },
  {
    id: 'workman',
    name: 'Workman',
    note: 'tuned for lateral finger travel',
    map: rows(
      NUM_ANSI,
      `q d r w b j f u p ;: [{ ]} ${PIPE}`,
      `a s h t g y n e o i '"`,
      'z x m c v k l ,< .> /?',
    ),
  },
];

const BY_ID = new Map<LayoutId, Layout>(LAYOUTS.map((l) => [l.id, l]));

export function getLayout(id: LayoutId): Layout {
  const layout = BY_ID.get(id);
  if (!layout) throw new Error(`unknown layout: ${id}`);
  return layout;
}

const CHAR_INDEX = new Map<LayoutId, Map<string, KeyStroke>>();

/** char -> which physical key to press (and whether shift is held), for one layout. */
export function charIndex(id: LayoutId): Map<string, KeyStroke> {
  const cached = CHAR_INDEX.get(id);
  if (cached) return cached;

  const index = new Map<string, KeyStroke>();
  const layout = getLayout(id);
  for (const [code, [lower, upper]] of Object.entries(layout.map)) {
    const key = physKey(code);
    if (!key) continue;
    if (lower && !index.has(lower)) index.set(lower, { key, shift: false });
    if (upper && upper !== lower && !index.has(upper)) index.set(upper, { key, shift: true });
  }
  // Newlines and tabs are normalised out of the corpus, but map them anyway so a
  // stray character never breaks the ribbon.
  const enter = physKey('Enter');
  if (enter) index.set('\n', { key: enter, shift: false });
  const tab = physKey('Tab');
  if (tab) index.set('\t', { key: tab, shift: false });

  CHAR_INDEX.set(id, index);
  return index;
}

export function resolveChar(id: LayoutId, char: string): KeyStroke | undefined {
  return charIndex(id).get(char);
}

/** The character produced by a physical key press under a layout. */
export function charFor(id: LayoutId, code: string, shift: boolean): string | undefined {
  const pair = getLayout(id).map[code];
  if (!pair) return undefined;
  return shift ? pair[1] : pair[0];
}

/** Label to paint on a keycap: the layout's character, or the key's fixed label. */
export function keyLabel(id: LayoutId, key: PhysKey): { main: string; sub?: string } {
  const pair = getLayout(id).map[key.code];
  if (!pair) return { main: key.label ?? '' };
  const [lower, upper] = pair;
  if (lower === ' ') return { main: '' };
  const isLetter = /^[a-z]$/.test(lower);
  return isLetter ? { main: lower.toUpperCase() } : { main: lower, sub: upper };
}
