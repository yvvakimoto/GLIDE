/**
 * Thumb-shift kana layouts.
 *
 * A kana layout gives every key three faces: pressed alone, pressed with the
 * left thumb key, pressed with the right thumb key. One kana per keystroke, so
 * a unit here is always a single character.
 *
 * Key positions are named by `KeyboardEvent.code`, which reports the *physical*
 * position. On a JIS keyboard the keys printed @ [ : ] report BracketLeft,
 * BracketRight, Quote and Backslash respectively, so those are the names used
 * below. Which keys play the two thumb-shift roles is a setting; see
 * `THUMB_CANDIDATES` in settings.ts and `thumbDrawKey` below.
 *
 * Sources:
 * - NICOLA: the NICOLA specification chart as reproduced at
 *   https://www2d.biglobe.ne.jp/~msyk/keyboard/oyayubi/index.html
 * - 飛鳥123: Ray's final revision, transcribed from the やまぶきR definition
 *   published at https://hiyokoya6.hateblo.jp/entry/2019/04/27/220801
 */

import { physKey } from './keyboard-geometry';

export type Thumb = 'none' | 'left' | 'right';
export type KanaLayoutId = 'nicola' | 'asuka';

export type KanaPress = { code: string; thumb: Thumb };

export type KanaLayout = {
  id: KanaLayoutId;
  name: string;
  note: string;
  /** code -> [alone, left thumb, right thumb]; '' means the key has no kana there */
  map: Readonly<Record<string, readonly [string, string, string]>>;
};

/**
 * Where a thumb role is *drawn*.
 *
 * Which key plays each role is a setting (see `THUMB_CANDIDATES`), but 無変換 and
 * 変換 are not on an ANSI board, so they are shown in the positions they occupy
 * on a JIS one: immediately left and right of the space bar, which is exactly
 * where AltLeft and AltRight sit. Space is the exception — it is drawn on the bar.
 */
export function thumbDrawKey(role: Exclude<Thumb, 'none'>, code: string): string {
  if (code === 'Space') return 'Space';
  return role === 'left' ? 'AltLeft' : 'AltRight';
}

const ROW1_11 = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft'];
const ROW1_12 = [...ROW1_11, 'BracketRight'];
const ROW2_10 = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];
const ROW2_12 = [...ROW2_10, 'Quote', 'Backslash'];
const ROW3_10 = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];

/** `_` marks a position the plane leaves empty. */
function plane(codes: readonly string[][], rows: readonly string[][]): Map<string, string>[] {
  return rows.map((planeRows) => {
    const out = new Map<string, string>();
    planeRows.forEach((spec, rowIndex) => {
      const tokens = spec.trim().split(/\s+/);
      const rowCodes = codes[rowIndex]!;
      if (tokens.length !== rowCodes.length) {
        throw new Error(`kana row ${rowIndex} expects ${rowCodes.length} keys, got ${tokens.length}`);
      }
      tokens.forEach((token, i) => {
        if (token !== '_') out.set(rowCodes[i]!, token);
      });
    });
    return out;
  });
}

function build(codes: readonly string[][], planes: readonly string[][]): Record<string, readonly [string, string, string]> {
  const [alone, left, right] = plane(codes, planes);
  const map: Record<string, readonly [string, string, string]> = {};
  for (const row of codes) {
    for (const code of row) {
      map[code] = [alone!.get(code) ?? '', left!.get(code) ?? '', right!.get(code) ?? ''];
    }
  }
  return map;
}

const NICOLA_MAP = build(
  [ROW1_11, ROW2_10, ROW3_10],
  [
    [
      '。 か た こ さ ら ち く つ ， 、',
      'う し て け せ は と き い ん',
      '． ひ す ふ へ め そ ね ほ ・',
    ],
    [
      'ぁ え り ゃ れ ぱ ぢ ぐ づ ぴ _',
      'を あ な ゅ も ば ど ぎ ぽ _',
      'ぅ ー ろ や ぃ ぷ ぞ ぺ ぼ _',
    ],
    [
      '_ が だ ご ざ よ に る ま ぇ _',
      'ヴ じ で げ ぜ み お の ょ っ',
      '_ び ず ぶ べ ぬ ゆ む わ ぉ',
    ],
  ],
);

const ASUKA_MAP = build(
  [ROW1_12, ROW2_12, ROW3_10],
  [
    [
      '「 ー _ び ％ _ _ と は ぽ 」 _',
      'き し う て ぎ ゆ ん い か た ほ ・',
      'じ ち に り ぶ ゃ っ ょ ゅ さ',
    ],
    [
      'ぃ ひ け ぁ ぅ ヴ ！ よ ふ へ ） _',
      'だ あ が ば ぇ ず る す ま で げ _',
      'ぜ ね せ ぴ ぉ や え 、 。 ？',
    ],
    [
      '（ べ れ ぺ ～ ぢ ぬ ど め ぞ ご _',
      'わ お な ら ぷ づ く の こ そ ろ _',
      'ぱ ぐ み ざ ＊ む を つ も ぼ',
    ],
  ],
);

export const KANA_LAYOUTS: readonly KanaLayout[] = [
  {
    id: 'nicola',
    name: 'NICOLA',
    note: '親指シフトの標準。清濁同置',
    map: NICOLA_MAP,
  },
  {
    id: 'asuka',
    name: '飛鳥123',
    note: 'Ray氏の最終版。清濁別置で交互打鍵が多い',
    map: ASUKA_MAP,
  },
];

const BY_ID = new Map<KanaLayoutId, KanaLayout>(KANA_LAYOUTS.map((l) => [l.id, l]));

export function getKanaLayout(id: KanaLayoutId): KanaLayout {
  const layout = BY_ID.get(id);
  if (!layout) throw new Error(`unknown kana layout: ${id}`);
  return layout;
}

const THUMBS: readonly Thumb[] = ['none', 'left', 'right'];
const KANA_INDEX = new Map<KanaLayoutId, Map<string, KanaPress>>();

/** kana -> which key to press, and with which thumb. */
export function kanaIndex(id: KanaLayoutId): Map<string, KanaPress> {
  const cached = KANA_INDEX.get(id);
  if (cached) return cached;

  const index = new Map<string, KanaPress>();
  for (const [code, faces] of Object.entries(getKanaLayout(id).map)) {
    if (!physKey(code)) continue;
    faces.forEach((kana, i) => {
      if (kana && !index.has(kana)) index.set(kana, { code, thumb: THUMBS[i]! });
    });
  }
  KANA_INDEX.set(id, index);
  return index;
}

/** The kana a physical press produces, for showing what was actually typed. */
export function kanaFor(id: KanaLayoutId, code: string, thumb: Thumb): string | undefined {
  const faces = getKanaLayout(id).map[code];
  if (!faces) return undefined;
  const kana = faces[THUMBS.indexOf(thumb)];
  return kana || undefined;
}

/** Every character a kana layout can produce. */
export function kanaCharset(id: KanaLayoutId): Set<string> {
  return new Set(kanaIndex(id).keys());
}
