/**
 * Kana handling: normalisation, the romaji table, and segmentation of kana text
 * into typing units.
 *
 * A unit is "one thing you type": for romaji that is a kana or a kana cluster
 * (きゃ) whose latin spelling has several accepted forms (si/shi/ci), for a kana
 * layout it is a single kana. Alternatives matter — a learner who types `shi`
 * should not be told they are wrong — so a unit carries every accepted spelling
 * and the runner accepts whichever one the fingers take.
 */

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** カタカナ -> ひらがな, for looking up what to press. Display keeps the original. */
export function toHiragana(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - KANA_OFFSET) : ch;
  }
  return out;
}

export const isKanaChar = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x3041 && code <= 0x3096) || (code >= KATAKANA_START && code <= 0x30fa);
};

/**
 * kana (or kana cluster) -> accepted latin spellings, canonical first.
 *
 * Only spellings a mainstream IME accepts are listed; the point is to not
 * penalise a habit, not to catalogue every possibility.
 */
const ROMAJI: Record<string, string> = {
  あ: 'a', い: 'i yi', う: 'u wu whu', え: 'e', お: 'o',
  か: 'ka ca', き: 'ki', く: 'ku cu qu', け: 'ke', こ: 'ko co',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'si shi ci', す: 'su', せ: 'se ce', そ: 'so',
  ざ: 'za', じ: 'zi ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'ti chi', つ: 'tu tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'di', づ: 'du', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'hu fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'wo',
  ゔ: 'vu', ヴ: 'vu',

  // small kana on their own
  ぁ: 'xa la', ぃ: 'xi li', ぅ: 'xu lu', ぇ: 'xe le', ぉ: 'xo lo',
  ゃ: 'xya lya', ゅ: 'xyu lyu', ょ: 'xyo lyo', っ: 'xtu ltu xtsu',
  ゎ: 'xwa lwa',

  // youon clusters
  きゃ: 'kya', きぃ: 'kyi', きゅ: 'kyu', きぇ: 'kye', きょ: 'kyo',
  ぎゃ: 'gya', ぎぃ: 'gyi', ぎゅ: 'gyu', ぎぇ: 'gye', ぎょ: 'gyo',
  しゃ: 'sya sha', しぃ: 'syi', しゅ: 'syu shu', しぇ: 'sye she', しょ: 'syo sho',
  じゃ: 'zya ja jya', じぃ: 'zyi jyi', じゅ: 'zyu ju jyu', じぇ: 'zye je jye', じょ: 'zyo jo jyo',
  ちゃ: 'tya cha cya', ちぃ: 'tyi', ちゅ: 'tyu chu cyu', ちぇ: 'tye che', ちょ: 'tyo cho cyo',
  ぢゃ: 'dya', ぢゅ: 'dyu', ぢょ: 'dyo',
  にゃ: 'nya', にぃ: 'nyi', にゅ: 'nyu', にぇ: 'nye', にょ: 'nyo',
  ひゃ: 'hya', ひぃ: 'hyi', ひゅ: 'hyu', ひぇ: 'hye', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びぇ: 'bye', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴぇ: 'pye', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みぇ: 'mye', みょ: 'myo',
  りゃ: 'rya', りぃ: 'ryi', りゅ: 'ryu', りぇ: 'rye', りょ: 'ryo',
  ふぁ: 'fa hwa', ふぃ: 'fi hwi', ふぇ: 'fe hwe', ふぉ: 'fo hwo', ふゅ: 'fyu',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  てぃ: 'thi', てぇ: 'the', てゅ: 'thu',
  でぃ: 'dhi', でぇ: 'dhe', でゅ: 'dhu',
  とぅ: 'twu', どぅ: 'dwu',
  うぁ: 'wha', うぃ: 'wi whi', うぇ: 'we whe', うぉ: 'who',
  いぇ: 'ye',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo',
  くぁ: 'qa kwa', くぃ: 'qi kwi', くぇ: 'qe kwe', くぉ: 'qo kwo',
  ぐぁ: 'gwa',

  // punctuation, as the JIS romaji IME maps it
  ー: '-', '、': ',', '。': '.', '・': '/', '「': '[', '」': ']',
  '！': '!', '？': '?', '　': ' ',
};

/** small kana that attach to the preceding kana */
const SMALL = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ']);
const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

export type RomajiUnit = {
  /** characters of the source text this unit covers */
  text: string;
  /** accepted latin spellings, canonical first */
  spellings: string[];
  /** a spelling that may be typed once more with no penalty (the second n of ん) */
  absorb?: string;
};

const spellingsOf = (kana: string): string[] | undefined => {
  const entry = ROMAJI[kana];
  return entry ? entry.split(' ') : undefined;
};

/**
 * Splits kana text into romaji units.
 *
 * Two cases need lookahead: っ is typed by doubling the next consonant, and ん
 * may be a single `n` only when the next sound cannot absorb it.
 */
export function romajiUnits(text: string): RomajiUnit[] {
  const chars = [...text];
  const units: RomajiUnit[] = [];

  // first pass: group kana into clusters, leaving っ and ん as markers
  type Slot = { text: string; spellings: string[] | undefined };
  const slots: Slot[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    const pair = next !== undefined && SMALL.has(next) ? ch + next : undefined;

    if (pair) {
      const paired = spellingsOf(toHiragana(pair)) ?? spellingsOf(pair);
      if (paired) {
        slots.push({ text: pair, spellings: paired });
        i++;
        continue;
      }
    }
    const single = spellingsOf(toHiragana(ch)) ?? spellingsOf(ch);
    slots.push({ text: ch, spellings: single });
  }

  // second pass: resolve っ and ん against what follows
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const plain = toHiragana(slot.text);
    const following = slots[i + 1];

    if (plain === 'っ') {
      const doubled = new Set<string>();
      for (const spelling of following?.spellings ?? []) {
        const first = spelling[0];
        if (first && /[a-z]/.test(first) && !VOWELS.has(first) && first !== 'n') doubled.add(first);
      }
      units.push({ text: slot.text, spellings: [...doubled, 'xtu', 'ltu'] });
      continue;
    }

    if (plain === 'ん') {
      // `n` alone is enough unless the next sound would swallow it
      const risky = (following?.spellings ?? []).some((s) => {
        const first = s[0];
        return first !== undefined && (VOWELS.has(first) || first === 'n' || first === 'y');
      });
      const spellings = risky || !following ? ['nn', 'xn'] : ['n', 'nn', 'xn'];
      units.push({
        text: slot.text,
        spellings,
        ...(spellings[0] === 'n' ? { absorb: 'n' } : {}),
      });
      continue;
    }

    units.push({ text: slot.text, spellings: slot.spellings ?? [] });
  }

  return units;
}

/** Every character the romaji tables can type. */
export function romajiCharset(): Set<string> {
  const set = new Set<string>();
  for (const kana of Object.keys(ROMAJI)) {
    for (const ch of kana) set.add(ch);
    // katakana forms are typed through their hiragana entry
    for (const ch of kana) {
      const code = ch.codePointAt(0)!;
      if (code >= 0x3041 && code <= 0x3096) set.add(String.fromCodePoint(code + KANA_OFFSET));
    }
  }
  return set;
}
