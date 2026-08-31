/**
 * The top bar and the small config chips. Values are written only when they
 * change so the per-frame update stays cheap.
 */

import { getLayout } from '../core/layouts';
import { getKanaLayout } from '../core/kana-layouts';
import { sourceLabel, sourceScript } from '../core/corpus';
import type { Settings } from '../core/settings';
import type { Runner } from '../core/engine';
import { rgba, speedRgb } from '../render/color';
import { byId, el, setText } from './dom';

export type HudRefs = {
  wpm: HTMLElement;
  time: HTMLElement;
  acc: HTMLElement;
  streak: HTMLElement;
  progress: HTMLElement;
  source: HTMLElement;
  config: HTMLElement;
  idleConfig: HTMLElement;
  stripMa: HTMLElement;
  brandTag: HTMLElement;
};

export function hudRefs(): HudRefs {
  return {
    wpm: byId('stat-wpm'),
    time: byId('stat-time'),
    acc: byId('stat-acc'),
    streak: byId('stat-streak'),
    progress: byId('progress-fill'),
    source: byId('source-line'),
    config: byId('hud-config'),
    idleConfig: byId('idle-config'),
    stripMa: byId('strip-ma'),
    brandTag: byId('brand-tag'),
  };
}

/** Writes an inline style only when it changed; see `setText`. */
function setStyle(node: HTMLElement, prop: 'color' | 'transform', value: string): void {
  if (node.style[prop] !== value) node.style[prop] = value;
}

const formatClock = (ms: number): string => {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : String(s);
};

/** The chip row: a compact read-out of the run configuration. */
export function renderConfigChips(refs: HudRefs, settings: Settings, openSettings: () => void): void {
  const layout = getLayout(settings.layout);
  const japanese = sourceScript(settings.source) === 'ja';
  const method = !japanese
    ? layout.name
    : settings.jaMethod === 'romaji'
      ? `romaji (${layout.name})`
      : getKanaLayout(settings.jaMethod).name;
  const items: Array<[string, string]> = [
    [japanese ? 'method' : 'layout', method],
    ...(japanese
      ? []
      : ([['input', settings.inputMode === 'remap' ? 'remapped' : 'os layout']] as Array<[string, string]>)),
    ['ahead', String(settings.lookahead)],
    ['time', settings.duration ? `${settings.duration}s` : 'open'],
    ['text', sourceLabel(settings.source)],
  ];

  const chips = () =>
    items.map(([key, value]) =>
      el('button', { class: 'chip', type: 'button', onclick: openSettings, title: 'open settings (s)' }, [
        `${key} `,
        el('b', { text: value }),
      ]),
    );

  refs.config.replaceChildren(...chips());
  refs.idleConfig.replaceChildren(...chips());
  setText(refs.stripMa, `${settings.maWindow}s avg`);
  setText(refs.brandTag, japanese ? `${method} - ${sourceLabel(settings.source)}` : `${layout.name} - ${layout.note}`);
}

export function updateHud(refs: HudRefs, runner: Runner): void {
  const elapsed = runner.elapsedMs;
  const live = runner.phase === 'running' || runner.phase === 'finished';
  const series = runner.stats.series;
  const lastMa = series.length ? series[series.length - 1]!.ma : 0;
  const wpm = !live ? 0 : runner.phase === 'finished' ? runner.stats.netWpm(elapsed) : lastMa;

  setText(refs.wpm, String(Math.round(wpm)));
  setStyle(refs.wpm, 'color', rgba(speedRgb(wpm), 1));

  const remaining = runner.remainingMs;
  setText(refs.time, remaining === null ? (live ? formatClock(elapsed) : 'open') : formatClock(remaining));

  const acc = live ? runner.stats.accuracy() : 100;
  setText(refs.acc, acc >= 99.95 ? '100' : acc.toFixed(1));
  setText(refs.streak, String(runner.stats.currentStreak));

  // scaleX, not width: width is a layout property, it carries the bar's glow
  // with it, and its transition used to be restarted by every frame's new value
  const progress = Math.round((live ? runner.progress : 0) * 1000) / 1000;
  setStyle(refs.progress, 'transform', `scaleX(${progress})`);

  const attribution = runner.attribution;
  setText(
    refs.source,
    attribution ? `${attribution.title}${attribution.author ? ` - ${attribution.author}` : ''}` : '',
  );
}
