/**
 * Post-run summary: headline speed, the full speed chart, a per-key heatmap on
 * the same keyboard renderer used during the run, per-finger bars, and the
 * slowest letter pairs.
 */

import { FINGER_COLOR, FINGER_NAME } from '../core/keyboard-geometry';
import { keyLabel } from '../core/layouts';
import { keyLabels, methodKind, type MethodSpec } from '../core/method';
import { physKey } from '../core/keyboard-geometry';
import type { Settings } from '../core/settings';
import type { Summary } from '../core/stats';
import { drawChart } from '../render/chart';
import { boardMetrics, drawKeyboard } from '../render/keyboard';
import { rgba, speedRgb } from '../render/color';
import { renderScale } from '../render/quality';
import { el } from './dom';

export type SummaryContext = {
  root: HTMLElement;
  summary: Summary;
  settings: Settings;
  spec: MethodSpec;
  quit: boolean;
};

type HeatMode = 'errors' | 'speed';

function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | undefined {
  const rect = canvas.getBoundingClientRect();
  const dpr = renderScale();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function heatMap(summary: Summary, mode: HeatMode): Map<string, number> {
  const heat = new Map<string, number>();
  if (mode === 'errors') {
    const rates = summary.perKey.filter((k) => k.count >= 2).map((k) => k.errors / k.count);
    const max = Math.max(0.12, ...rates);
    for (const k of summary.perKey) {
      if (k.count < 2) continue;
      // a floor keeps keys you actually pressed distinguishable from untouched ones
      heat.set(k.code, 0.08 + 0.92 * Math.min(1, k.errors / k.count / max));
    }
    return heat;
  }
  const timed = summary.perKey.filter((k) => k.meanMs > 0);
  if (!timed.length) return heat;
  const values = timed.map((k) => k.meanMs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const k of timed) {
    heat.set(k.code, max - min < 1 ? 0.5 : (k.meanMs - min) / (max - min));
  }
  return heat;
}

const perMinute = (count: number, seconds: number): number => Math.round((count / Math.max(1, seconds)) * 60);

const card = (label: string, value: string, unit?: string): HTMLElement =>
  el('div', { class: 'card' }, [
    el('div', { class: 'k', text: label }),
    el('div', { class: 'v' }, [value, unit ? el('small', { text: ` ${unit}` }) : null]),
  ]);

export function renderSummary(ctx: SummaryContext): void {
  const { summary, settings } = ctx;
  const lite = settings.graphics === 'lite';
  const heroColor = rgba(speedRgb(summary.wpm), 1);
  const seconds = summary.durationMs / 1000;

  const chartCanvas = el('canvas') as HTMLCanvasElement;
  const heatCanvas = el('canvas') as HTMLCanvasElement;
  let heatMode: HeatMode = 'errors';

  const drawHeat = (): void => {
    const fit = fitCanvas(heatCanvas);
    if (!fit) return;
    fit.ctx.clearRect(0, 0, fit.w, fit.h);
    drawKeyboard(fit.ctx, boardMetrics(fit.w, fit.h), {
      // the heatmap always shows legends, even when the run had them hidden
      labels: keyLabels(ctx.spec, settings.labelMode === 'blank' ? 'layout' : settings.labelMode),
      fingerColors: false,
      now: 0,
      lite,
      heat: heatMap(summary, heatMode),
    });
  };

  const drawSpeed = (): void => {
    const fit = fitCanvas(chartCanvas);
    if (!fit) return;
    fit.ctx.clearRect(0, 0, fit.w, fit.h);
    drawChart(fit.ctx, {
      series: summary.series,
      width: fit.w,
      height: fit.h,
      xMax: Math.max(5, seconds),
      maWindow: settings.maWindow,
      axes: true,
      lite,
    });
  };

  const heatButton = (mode: HeatMode, label: string): HTMLElement =>
    el(
      'button',
      {
        type: 'button',
        'aria-pressed': heatMode === mode ? 'true' : 'false',
        onclick: (event: Event) => {
          heatMode = mode;
          const parent = (event.currentTarget as HTMLElement).parentElement;
          for (const child of Array.from(parent?.children ?? [])) {
            child.setAttribute('aria-pressed', child === event.currentTarget ? 'true' : 'false');
          }
          drawHeat();
        },
      },
      [label],
    );

  const maxFingerCount = Math.max(1, ...summary.perFinger.map((f) => f.count));
  const fingerBars = summary.perFinger
    .slice()
    .sort((a, b) => b.count - a.count)
    .map((f) =>
      el('div', { class: 'bar-row' }, [
        el('span', { class: 'name', text: FINGER_NAME[f.finger].toLowerCase() }),
        el('span', { class: 'bar-track' }, [
          el('i', {
            class: 'bar-fill',
            style: `width:${(f.count / maxFingerCount) * 100}%; color:${FINGER_COLOR[f.finger]}`,
          }),
        ]),
        el('span', { class: 'num' }, [
          `${f.count}`,
          f.errors ? el('b', { text: ` -${f.errors}` }) : null,
          f.meanMs ? ` ${Math.round(f.meanMs)}ms` : '',
        ]),
      ]),
    );

  // a single miss on a key pressed once is noise, so ask for a few samples first
  const missed = summary.perKey.filter((k) => k.errors > 0);
  const worstKeys = (missed.filter((k) => k.count >= 3).length ? missed.filter((k) => k.count >= 3) : missed)
    .sort((a, b) => b.errors / b.count - a.errors / a.count || b.errors - a.errors)
    .slice(0, 10);

  const labelFor = (code: string): string => {
    const key = physKey(code);
    if (!key) return code;
    const label = keyLabel(settings.layout, key);
    return label.main === '' ? 'space' : label.main.toLowerCase();
  };

  ctx.root.replaceChildren(
    el('div', { class: 'summary-head' }, [
      el('div', {}, [
        el('div', { class: 'summary-title', text: ctx.quit ? 'run stopped' : 'run complete' }),
        el('div', { class: 'summary-hero' }, [
          el('span', { class: 'num', style: `color:${heroColor}`, text: String(Math.round(summary.wpm)) }),
          el('span', { class: 'unit', text: ctx.spec.script === 'ja' ? 'kana wpm net' : 'wpm net' }),
        ]),
      ]),
      el('div', { class: 'idle-config' }, [
        el('button', { class: 'chip', type: 'button' }, ['layout ', el('b', { text: settings.layout })]),
        el('button', { class: 'chip', type: 'button' }, [
          'ahead ',
          el('b', { text: String(settings.lookahead) }),
        ]),
        el('button', { class: 'chip', type: 'button' }, [
          'time ',
          el('b', { text: `${seconds.toFixed(1)}s` }),
        ]),
      ]),
    ]),

    el('div', { class: 'cards' }, [
      card('raw', String(Math.round(summary.rawWpm)), 'wpm'),
      card('accuracy', summary.accuracy >= 99.95 ? '100' : summary.accuracy.toFixed(1), '%'),
      card('consistency', summary.consistency.toFixed(0), '%'),
      // characters and keystrokes are different numbers now, so give them a card each
      card('characters', String(summary.producedChars)),
      card('keystrokes', String(summary.keystrokes)),
      card('errors', String(summary.errorKeys)),
      card('fixes', String(summary.corrections)),
      card('best streak', String(summary.bestStreak)),
      // Japanese speed is counted in kana, so spell that out and keep the
      // keystroke rate beside it: that is where romaji and thumb-shift differ.
      ...(ctx.spec.script === 'ja'
        ? [
            card('kana/min', String(perMinute(summary.producedChars, seconds))),
            card('keys/min', String(perMinute(summary.keystrokes, seconds))),
          ]
        : []),
      ...(methodKind(ctx.spec) === 'romaji'
        ? [card('keys per kana', (summary.keystrokes / Math.max(1, summary.producedChars)).toFixed(2))]
        : []),
    ]),

    el('div', { class: 'panel-block' }, [
      el('h3', {}, ['speed', el('em', { text: `${settings.maWindow}s moving average, error ticks below` })]),
      el('div', { class: 'chart-wrap' }, [chartCanvas]),
    ]),

    el('div', { class: 'two-col' }, [
      el('div', { class: 'panel-block' }, [
        el('h3', {}, [
          'keyboard',
          el('em', {}, [
            el('span', { class: 'seg', style: 'display:inline-flex' }, [
              heatButton('errors', 'errors'),
              heatButton('speed', 'latency'),
            ]),
          ]),
        ]),
        el('div', { class: 'heat-wrap' }, [heatCanvas]),
      ]),
      el('div', { class: 'panel-block' }, [
        el('h3', {}, ['fingers', el('em', { text: 'keystrokes, misses, mean gap' })]),
        el('div', { class: 'bars' }, fingerBars),
      ]),
    ]),

    el('div', { class: 'two-col' }, [
      el('div', { class: 'panel-block' }, [
        el('h3', {}, ['slowest pairs', el('em', { text: 'mean gap between the two keys' })]),
        el(
          'div',
          { class: 'gram-list' },
          summary.slowGrams.length
            ? summary.slowGrams.map((g) =>
                el('span', { class: 'gram' }, [
                  el('b', { text: g.gram }),
                  el('span', { text: `${Math.round(g.meanMs)}ms` }),
                ]),
              )
            : [el('span', { class: 'gram' }, [el('span', { text: 'not enough data yet' })])],
        ),
      ]),
      el('div', { class: 'panel-block' }, [
        el('h3', {}, ['shakiest keys', el('em', { text: 'miss rate' })]),
        el(
          'div',
          { class: 'gram-list' },
          worstKeys.length
            ? worstKeys.map((k) =>
                el('span', { class: 'gram' }, [
                  el('b', { text: labelFor(k.code) }),
                  el('span', { text: `${Math.round((k.errors / k.count) * 100)}%  (${k.errors}/${k.count})` }),
                ]),
              )
            : [el('span', { class: 'gram' }, [el('span', { text: 'clean run' })])],
        ),
      ]),
    ]),

    el('div', { class: 'summary-foot' }, [
      el('span', {}, [el('kbd', { text: 'space' }), 'run again']),
      el('span', {}, [el('kbd', { text: 'esc' }), 'menu']),
      el('span', {}, [el('kbd', { text: 's' }), 'settings']),
    ]),
  );

  requestAnimationFrame(() => {
    drawSpeed();
    drawHeat();
  });
}
