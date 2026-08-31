/**
 * Settings overlay. Rebuilt from scratch whenever it opens or a value changes —
 * it is small enough that diffing would be more code than it saves.
 */

import { ATTRIBUTION_NOTE, listSources, sourceScript } from '../core/corpus';
import { KANA_LAYOUTS } from '../core/kana-layouts';
import { LAYOUTS } from '../core/layouts';
import {
  DEFAULT_SETTINGS,
  DURATIONS,
  LOOKAHEAD_RANGE,
  MA_WINDOWS,
  THUMB_CANDIDATES,
  THUMB_PERCENTS,
  type Settings,
} from '../core/settings';
import { el } from './dom';

export type SettingsPanelOptions = {
  root: HTMLElement;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
};

function row(label: string, hint: string, control: Node, warn?: string): HTMLElement {
  return el('div', { class: 'setting' }, [
    el('div', { class: 'label' }, [label, el('em', { text: hint })]),
    control,
    warn ? el('p', { class: 'setting-warn', text: warn }) : null,
  ]);
}

/**
 * 無変換 and 変換 are the defaults because they are the real thumb-shift keys and
 * because a JIS board is the likeliest place a kana layout gets typed. They also
 * do not exist on an ANSI board, where the two selectors then point at keys that
 * can never fire: the run starts, the ribbon asks for a shifted kana, and nothing
 * the visitor presses produces it. That is a fine default on the machine this was
 * written on and a dead end for most of the people a public URL reaches, so when
 * the combination cannot work, say so where the fix is.
 */
const JIS_ONLY = new Set(['NonConvert', 'Convert', 'KanaMode']);

function segmented<T extends string | number | boolean>(
  options: Array<{ value: T; label: string; sub?: string }>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  return el(
    'div',
    { class: 'seg' },
    options.map((option) =>
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': option.value === current ? 'true' : 'false',
          onclick: () => onPick(option.value),
        },
        [option.label, option.sub ? el('small', { text: option.sub }) : null],
      ),
    ),
  );
}

export function renderSettingsPanel(opts: SettingsPanelOptions): void {
  const s = opts.settings;
  const set = opts.onChange;
  const japanese = sourceScript(s.source) === 'ja';
  const kanaMethod = s.jaMethod !== 'romaji';

  const sourceSelect = el('select', { class: 'source-select' }) as HTMLSelectElement;
  let currentGroup = '';
  let group: HTMLOptGroupElement | undefined;
  for (const source of listSources()) {
    if (source.group !== currentGroup) {
      currentGroup = source.group;
      group = el('optgroup', { label: source.group }) as HTMLOptGroupElement;
      sourceSelect.append(group);
    }
    const option = el('option', { value: source.id, text: `${source.label} — ${source.sublabel}` });
    if (source.id === s.source) option.setAttribute('selected', '');
    (group ?? sourceSelect).append(option);
  }
  sourceSelect.value = s.source;
  sourceSelect.addEventListener('change', () => set({ source: sourceSelect.value }));

  const lookaheadValue = el('span', { class: 'range-value', text: String(s.lookahead) });
  const lookahead = el('input', {
    type: 'range',
    min: String(LOOKAHEAD_RANGE.min),
    max: String(LOOKAHEAD_RANGE.max),
    step: '1',
    value: String(s.lookahead),
  }) as HTMLInputElement;
  lookahead.addEventListener('input', () => {
    lookaheadValue.textContent = lookahead.value;
    set({ lookahead: Number(lookahead.value) });
  });

  opts.root.replaceChildren(
    el('div', { class: 'settings-head' }, [
      el('h2', { text: 'settings' }),
      el('button', { class: 'text-btn', type: 'button', onclick: opts.onClose }, ['close  esc']),
    ]),

    el('div', { class: 'panel-block' }, [
      row(
        'layout',
        'the latin layout: used for English text, and for romaji input',
        segmented(
          LAYOUTS.map((l) => ({ value: l.id, label: l.name, sub: l.note })),
          s.layout,
          (layout) => set({ layout }),
        ),
      ),
      row(
        'japanese',
        japanese
          ? 'kana layouts read physical keys plus a thumb shift: 無変換 / 変換, or Alt on a US board'
          : 'applies once you pick a Japanese text below',
        segmented(
          [
            { value: 'romaji' as const, label: 'romaji', sub: `on ${s.layout}` },
            ...KANA_LAYOUTS.map((l) => ({ value: l.id, label: l.name, sub: l.note })),
          ],
          s.jaMethod,
          (jaMethod) => set({ jaMethod }),
        ),
      ),
      row(
        'input',
        'remapped reads physical keys, so the OS can stay on QWERTY. os layout trusts what the OS sends. Kana layouts always read physical keys.',
        segmented(
          [
            { value: 'remap' as const, label: 'remapped', sub: 'reads physical keys' },
            { value: 'passthrough' as const, label: 'os layout', sub: 'reads characters' },
          ],
          s.inputMode,
          (inputMode) => set({ inputMode }),
        ),
      ),
      row(
        'thumb keys',
        'which keys carry the two thumb shifts. Picking one that is already the other swaps them.',
        el('div', { class: 'stack' }, [
          el('div', { class: 'stack-row' }, [
            el('span', { class: 'stack-key', text: 'left' }),
            segmented(
              THUMB_CANDIDATES.map((c) => ({ value: c.code, label: c.label, sub: c.note })),
              s.thumbLeft,
              (code) => set(code === s.thumbRight ? { thumbLeft: code, thumbRight: s.thumbLeft } : { thumbLeft: code }),
            ),
          ]),
          el('div', { class: 'stack-row' }, [
            el('span', { class: 'stack-key', text: 'right' }),
            segmented(
              THUMB_CANDIDATES.map((c) => ({ value: c.code, label: c.label, sub: c.note })),
              s.thumbRight,
              (code) => set(code === s.thumbLeft ? { thumbRight: code, thumbLeft: s.thumbRight } : { thumbRight: code }),
            ),
          ]),
        ]),
        kanaMethod && (JIS_ONLY.has(s.thumbLeft) || JIS_ONLY.has(s.thumbRight))
          ? `${[s.thumbLeft, s.thumbRight]
              .filter((code) => JIS_ONLY.has(code))
              .map((code) => THUMB_CANDIDATES.find((c) => c.code === code)?.label ?? code)
              .join(' and ')} only exist on a Japanese (JIS) keyboard. If yours is a US or European board, pick left alt and right alt instead — otherwise the thumb shift will never fire.`
          : undefined,
      ),
      row(
        'simultaneous',
        'the window is a share of the character key’s own press: a thumb inside the first N% of it counts as simultaneous, so the window scales with your speed. 50 is the usual default.',
        segmented(
          THUMB_PERCENTS.map((p) => ({
            value: p,
            label: `${p}%`,
            ...(p === 0 ? { sub: 'held only' } : p === 100 ? { sub: 'until release' } : {}),
          })),
          s.thumbPercent,
          (thumbPercent) => set({ thumbPercent }),
        ),
      ),
      row(
        'continuous shift',
        '連続シフト: on, one thumb press shifts a whole run; off, it shifts one kana and must be re-pressed.',
        segmented(
          [
            { value: true, label: 'on' },
            { value: false, label: 'off', sub: 're-press each kana' },
          ],
          s.thumbContinuous,
          (thumbContinuous) => set({ thumbContinuous }),
        ),
      ),
      row(
        'keys ahead',
        'how far the ribbon looks into the future. 0 hides it.',
        el('div', { class: 'range-row' }, [lookahead, lookaheadValue]),
      ),
    ]),

    el('div', { class: 'panel-block' }, [
      row(
        'run time',
        'space starts the clock; esc ends early',
        segmented(
          DURATIONS.map((d) => ({ value: d, label: d ? `${d}s` : 'open' })),
          s.duration,
          (duration) => set({ duration }),
        ),
      ),
      row(
        'text',
        'English from Project Gutenberg, Japanese from Aozora Bunko, both public domain. Drills are generated from their own frequencies.',
        sourceSelect,
      ),
      row(
        'mistypes',
        'block: the cursor holds until you hit the right key. advance: mark the miss and carry on.',
        segmented(
          [
            { value: 'block' as const, label: 'block', sub: 'retry in place' },
            { value: 'advance' as const, label: 'advance', sub: 'mark and go' },
          ],
          s.errorMode,
          (errorMode) => set({ errorMode }),
        ),
      ),
    ]),

    el('div', { class: 'panel-block' }, [
      row(
        'moving average',
        'smoothing window for the speed line',
        segmented(
          MA_WINDOWS.map((w) => ({ value: w, label: `${w}s` })),
          s.maWindow,
          (maWindow) => set({ maWindow }),
        ),
      ),
      row(
        'key labels',
        'hide them once the motion is in your fingers',
        segmented(
          [
            { value: 'layout' as const, label: 'layout' },
            { value: 'physical' as const, label: 'qwerty', sub: 'what is printed' },
            { value: 'blank' as const, label: 'blank' },
          ],
          s.labelMode,
          (labelMode) => set({ labelMode }),
        ),
      ),
      row(
        'hands',
        'the schematic beside the keyboard, with the next finger lit',
        segmented(
          [
            { value: true, label: 'on' },
            { value: false, label: 'off' },
          ],
          s.showHands,
          (showHands) => set({ showHands }),
        ),
      ),
      row(
        'finger marks',
        'a small hand over each upcoming character, with the finger it wants lit',
        segmented(
          [
            { value: true, label: 'on' },
            { value: false, label: 'off' },
          ],
          s.fingerMarks,
          (fingerMarks) => set({ fingerMarks }),
        ),
      ),
      row(
        'finger colours',
        'colour the keys, the ribbon and the look-ahead text by finger',
        segmented(
          [
            { value: true, label: 'on' },
            { value: false, label: 'off' },
          ],
          s.fingerColors,
          (fingerColors) => set({ fingerColors }),
        ),
      ),
      row(
        'graphics',
        'rich adds the background glow, the frosted panels and the soft shadows back. Nothing the trainer teaches with is in either one alone',
        segmented(
          [
            { value: 'lite' as const, label: 'lite', sub: 'no blur anywhere' },
            { value: 'rich' as const, label: 'rich', sub: 'wants a real gpu' },
          ],
          s.graphics,
          (graphics) => set({ graphics }),
        ),
      ),
      row(
        'keypress sound',
        'a short synthesised click, quiet by default',
        segmented(
          [
            { value: true, label: 'on' },
            { value: false, label: 'off' },
          ],
          s.sound,
          (sound) => set({ sound }),
        ),
      ),
    ]),

    el('div', { class: 'settings-foot' }, [
      el('span', { text: ATTRIBUTION_NOTE }),
      el('button', { class: 'text-btn', type: 'button', onclick: () => set({ ...DEFAULT_SETTINGS }) }, [
        'reset to defaults',
      ]),
    ]),
  );
}
