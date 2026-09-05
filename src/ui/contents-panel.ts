/**
 * The table of contents for 写経: which work, how far in, and a way to jump.
 *
 * It is its own overlay rather than a section of the settings panel for four
 * reasons: a novel is sixty chapters and `.settings` is already twenty rows
 * tall; it needs the full scrollable height; it has to be reachable from the
 * *summary*, which the settings panel is not; and `renderSettingsPanel` rebuilds
 * everything on every value change, which is not a thing to do to two hundred
 * chapter rows.
 *
 * Nothing here animates. The overlay sits inside a backdrop-filter under `rich`,
 * where any repaint re-runs a full-viewport blur — so no transitions on the
 * rows, and the chapter bars are static fills rather than animated widths.
 */

import type { Bookmark } from '../core/progress';
import { resumePoint, type Work, type WorkMeta } from '../core/works';
import { el } from './dom';

export type WorkLoadState =
  | { state: 'idle' }
  | { state: 'loading'; id: string }
  | { state: 'error'; id: string; message: string };

export type ContentsPanelOptions = {
  root: HTMLElement;
  /** every work this build shipped, from the bundled index */
  works: readonly WorkMeta[];
  /** the work on show, if one is chosen */
  meta: WorkMeta | undefined;
  /** its body, once loaded — only the chapter *ranges* need it */
  work: Work | undefined;
  bookmark: (Bookmark & { stale: boolean }) | undefined;
  load: WorkLoadState;
  /** run length in seconds, so the foot can say what space will do */
  duration: number;
  onPickWork: (id: string) => void;
  onJump: (chapter: number) => void;
  onRestart: () => void;
  onClose: () => void;
};

const group = (n: number): string => n.toLocaleString('en-US');

const unitOf = (meta: WorkMeta | undefined): string => (meta?.script === 'ja' ? '字' : ' chars');

function workSelect(opts: ContentsPanelOptions): HTMLElement {
  const select = el('select', { class: 'source-select' }) as HTMLSelectElement;
  if (!opts.works.length) {
    select.append(el('option', { value: '', text: 'no works in this build yet' }));
    select.disabled = true;
    return select;
  }
  if (!opts.meta) select.append(el('option', { value: '', text: 'pick a work' }));

  const groups = new Map<string, WorkMeta[]>();
  for (const work of opts.works) {
    const key = work.script === 'ja' ? '日本語' : 'English';
    const bucket = groups.get(key);
    if (bucket) bucket.push(work);
    else groups.set(key, [work]);
  }
  for (const [label, items] of groups) {
    const optgroup = el('optgroup', { label });
    for (const work of items) {
      const option = el('option', {
        value: work.id,
        text: `${work.title} — ${work.author}`,
      }) as HTMLOptionElement;
      if (work.id === opts.meta?.id) option.selected = true;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  select.addEventListener('change', () => {
    if (select.value) opts.onPickWork(select.value);
  });
  return select;
}

function progressBlock(opts: ContentsPanelOptions): HTMLElement {
  const { meta, bookmark } = opts;
  const chars = bookmark?.chars ?? 0;
  const total = meta?.chars ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((chars / total) * 100)) : 0;
  const unit = unitOf(meta);
  const when = bookmark?.at
    ? new Date(bookmark.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : 'not started';

  return el('div', { class: 'setting' }, [
    el('div', { class: 'label' }, [
      'progress',
      el('em', { text: 'characters typed, of the whole work' }),
    ]),
    el('div', { class: 'bars' }, [
      el('div', { class: 'bar-row' }, [
        el('span', { class: 'name', text: `${percent}%` }),
        el('span', { class: 'bar-track' }, [el('i', { class: 'bar-fill', style: `width:${percent}%` })]),
        el('span', { class: 'num', text: total ? `${group(chars)} / ${group(total)}${unit}` : '-' }),
      ]),
    ]),
    el('div', { class: 'stack' }, [
      el('div', { class: 'stack-row' }, [
        el('span', { class: 'stack-key', text: 'last read' }),
        el('span', { text: when }),
      ]),
      el('div', { class: 'stack-row' }, [
        el('span', { class: 'stack-key', text: 'sessions' }),
        el('span', { text: String(bookmark?.sessions ?? 0) }),
      ]),
    ]),
  ]);
}

/** The message that belongs above the chapter list, if any. */
function warning(opts: ContentsPanelOptions): HTMLElement | null {
  const { load, meta, bookmark } = opts;
  if (load.state === 'error') {
    return el('p', {
      class: 'setting-warn',
      text: 'could not fetch this work. It downloads once and then works offline, but the first time needs a connection.',
    });
  }
  if (load.state === 'loading') {
    const size = meta?.bytes ? ` (${Math.round(meta.bytes / 1024)} KB)` : '';
    return el('p', {
      class: 'setting-warn',
      text: `fetching the text${size} — once, and then it works offline.`,
    });
  }
  if (bookmark?.stale) {
    return el('p', {
      class: 'setting-warn',
      text: 'this text has been re-issued since you last read it, so your place may have shifted. Start over to be sure.',
    });
  }
  return null;
}

function chapterRows(opts: ContentsPanelOptions): HTMLElement[] {
  const { work, meta, bookmark } = opts;

  // Before the body lands the index still knows the titles, so the list is drawn
  // rather than left blank. It just cannot say where you are in it yet.
  if (!work) {
    return (meta?.chapterTitles ?? []).map((title, i) =>
      el('div', { class: 'toc-row', 'data-state': 'ahead', 'aria-disabled': 'true' }, [
        el('span', { class: 'n', text: String(i + 1) }),
        el('span', { class: 't', text: title }),
      ]),
    );
  }

  const at = bookmark?.chunk ?? 0;
  const furthest = bookmark?.furthest ?? 0;

  return work.chapters.map((chapter, i) => {
    const end = chapter.start + chapter.count;
    const here = chapter.start <= at && at < end;
    const state = end <= furthest ? 'done' : here ? 'here' : 'ahead';
    const through =
      here && chapter.count > 0 ? Math.round(((at - chapter.start) / chapter.count) * 100) : 0;

    return el(
      'button',
      {
        class: 'toc-row',
        type: 'button',
        'data-state': state,
        'aria-current': here ? 'true' : 'false',
        onclick: () => opts.onJump(i),
      },
      [
        el('span', { class: 'n', text: String(i + 1) }),
        el('span', { class: 't', text: chapter.title }),
        el('span', { class: 'c', text: `${group(chapter.chars)}${unitOf(meta)}` }),
        el('i', { class: 'toc-bar' }, [el('i', { style: `width:${state === 'done' ? 100 : through}%` })]),
      ],
    );
  });
}

function footNote(opts: ContentsPanelOptions): string {
  if (!opts.meta) return 'pick a work to begin';
  // Only the body can say whether the place rounds back to the top of its
  // paragraph or to a sentence inside it, so before it lands this says the
  // paragraph and nothing finer.
  const point = opts.work && opts.bookmark ? resumePoint(opts.bookmark, opts.work) : undefined;
  const chunk = point?.chunk ?? opts.bookmark?.chunk ?? 0;
  const where = point?.offset
    ? `part-way into paragraph ${chunk + 1}`
    : chunk === 0
      ? 'from the beginning'
      : `at paragraph ${chunk + 1}`;
  const length = opts.duration > 0 ? `${opts.duration}s` : 'open';
  return `space resumes ${where}  ·  run time: ${length}`;
}

export function renderContentsPanel(opts: ContentsPanelOptions): void {
  const warn = warning(opts);
  const rows = chapterRows(opts);

  opts.root.replaceChildren(
    el('div', { class: 'settings-head' }, [
      el('h2', { text: 'contents' }),
      el('button', { class: 'text-btn', type: 'button', onclick: opts.onClose }, ['close  esc']),
    ]),

    el('div', { class: 'panel-block' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'label' }, [
          'work',
          el('em', { text: 'pick one and type it straight through, a sitting at a time' }),
        ]),
        workSelect(opts),
      ]),
      ...(opts.meta ? [progressBlock(opts)] : []),
      ...(warn ? [warn] : []),
    ]),

    el('div', { class: 'panel-block' }, [
      el('h3', {}, [
        'chapters',
        el('em', { text: rows.length ? 'the one you are in is lit; pick any to jump' : '' }),
      ]),
      rows.length
        ? el('div', { class: 'toc' }, rows)
        : el('div', { class: 'gram-list' }, [
            el('span', { class: 'gram' }, [
              el('span', { text: opts.meta ? 'no chapters listed' : 'no work chosen' }),
            ]),
          ]),
    ]),

    el('div', { class: 'settings-foot' }, [
      el('span', { text: footNote(opts) }),
      ...(opts.meta
        ? [el('button', { class: 'text-btn', type: 'button', onclick: opts.onRestart }, ['start over'])]
        : []),
    ]),
  );
}
