/**
 * Where this run sits against every run before it.
 *
 * The chart is the same drawChart the run itself uses, with the x axis reading
 * run numbers instead of seconds — one implementation, one look. What it is
 * *not* is a second speed chart: the point of this panel is the trend, so the
 * moving average across runs is the line that matters and the per-run dots are
 * the scatter around it.
 */

import { MIN_RUN_CHARS, MIN_RUN_MS, sameSetup, type HistoryRow } from '../core/history';
import type { Settings } from '../core/settings';
import type { SamplePoint } from '../core/stats';
import { drawChart } from '../render/chart';
import { card, el, fitCanvas } from './dom';

export type HistoryPanelContext = {
  /** the whole log, oldest first, already including this run if it was kept */
  rows: readonly HistoryRow[];
  /** the run just finished */
  current: HistoryRow;
  settings: Settings;
  lite: boolean;
};

type Scope = 'setup' | 'all';

/** How many runs the trend line averages over. */
const MA_RUNS = 5;

/**
 * History rows as chart points, x being the run number.
 *
 * `errors` is the one field that must not be passed through. In a run it counts
 * errors inside a 250 ms window — one or two — and the chart draws each as
 * `5 + errors * 3` pixels. A run's total error count is 10-30, which would put a
 * fence of 35-95 px pickets across the whole plot. Miss rate, capped, is the
 * honest analogue at the scale the renderer expects.
 */
function toSeries(rows: readonly HistoryRow[]): SamplePoint[] {
  return rows.map((row, i) => {
    const from = Math.max(0, i - MA_RUNS + 1);
    let sum = 0;
    for (let k = from; k <= i; k++) sum += rows[k]!.wpm;
    return {
      t: i + 1,
      wpm: row.wpm,
      raw: row.raw,
      ma: sum / (i - from + 1),
      errors: Math.min(6, Math.round((100 - row.acc) / 2)),
    };
  });
}

const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function historyPanel(ctx: HistoryPanelContext): { node: HTMLElement; draw: () => void } {
  let scope: Scope = 'setup';

  const canvas = el('canvas') as HTMLCanvasElement;
  const cards = el('div', { class: 'cards' });
  const wrap = el('div', { class: 'chart-wrap' }, [canvas]);
  const note = el('div', { class: 'gram-list' });

  const visible = (): readonly HistoryRow[] =>
    scope === 'all' ? ctx.rows : ctx.rows.filter((r) => sameSetup(r, ctx.current));

  const drawChartInto = (rows: readonly HistoryRow[]): void => {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    fit.ctx.clearRect(0, 0, fit.w, fit.h);
    drawChart(fit.ctx, {
      series: toSeries(rows),
      width: fit.w,
      height: fit.h,
      xMin: 0,
      xMax: rows.length,
      maWindow: ctx.settings.maWindow,
      axes: true,
      lite: ctx.lite,
      // run numbers, not seconds; tick 0 sits left of the first run so it has no label
      xLabel: (t) => (t < 1 ? '' : `#${Math.round(t)}`),
      axisNote: `wpm  /  ${MA_RUNS}-run moving average`,
    });
  };

  const apply = (): void => {
    const rows = visible();
    // Every row in the log already cleared history.ts's floor, so every row is a
    // fair candidate for the best; a second threshold here only produced a dash
    // beside a populated mean.
    const best = rows.length ? Math.max(...rows.map((r) => r.wpm)) : undefined;
    const recent = rows.slice(-10);
    const priors = rows.filter((r) => r.at !== ctx.current.at);
    const previous = priors[priors.length - 1];
    const delta = previous ? ctx.current.wpm - previous.wpm : undefined;

    cards.replaceChildren(
      card('personal best', best === undefined ? '—' : String(Math.round(best)), 'wpm'),
      card('last 10', recent.length ? String(Math.round(mean(recent.map((r) => r.wpm)))) : '—', 'wpm'),
      card(
        'vs previous',
        delta === undefined ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
        delta === undefined ? undefined : 'wpm',
      ),
      card('runs', String(rows.length)),
    );

    // A run below the floor never entered the log, so it is not in `runs` and not
    // in the best — but it still has a `vs previous`, which reads as the counts
    // being wrong unless the panel says outright that this run did not count.
    const recorded = rows.some((r) => r.at === ctx.current.at);
    const message = !recorded
      ? `this run was too short to record — a run needs ${MIN_RUN_MS / 1000}s and ${MIN_RUN_CHARS} characters`
      : rows.length < 2
        ? 'one run so far — the trend appears from the second'
        : '';

    // drawChart needs two points to draw anything at all, so leave it out rather
    // than showing an empty grid that looks like a bug.
    const enough = rows.length >= 2;
    wrap.hidden = !enough;
    note.hidden = message === '';
    if (message) note.replaceChildren(el('span', { class: 'gram' }, [el('span', { text: message })]));
    if (enough) drawChartInto(rows);
  };

  const scopeButton = (value: Scope, label: string): HTMLElement =>
    el(
      'button',
      {
        type: 'button',
        'aria-pressed': scope === value ? 'true' : 'false',
        onclick: (event: Event) => {
          scope = value;
          const parent = (event.currentTarget as HTMLElement).parentElement;
          for (const child of Array.from(parent?.children ?? [])) {
            child.setAttribute('aria-pressed', child === event.currentTarget ? 'true' : 'false');
          }
          apply();
        },
      },
      [label],
    );

  const node = el('div', { class: 'panel-block' }, [
    el('h3', {}, [
      'progress',
      el('em', {}, [
        el('span', { class: 'seg', style: 'display:inline-flex' }, [
          scopeButton('setup', 'this setup'),
          scopeButton('all', 'everything'),
        ]),
      ]),
    ]),
    cards,
    wrap,
    note,
  ]);

  return { node, draw: apply };
}
