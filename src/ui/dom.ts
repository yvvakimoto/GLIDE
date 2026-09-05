import { renderScale } from '../render/quality';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

type Props = Record<string, string | number | boolean | ((event: Event) => void) | undefined>;

/** Tiny element factory: el('div', { class: 'x', onclick: fn }, [child, 'text']) */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') {
      node.addEventListener(key.replace(/^on/, ''), value as EventListener);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/** Sets textContent only when it changed, to keep per-frame HUD writes cheap. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setOpen(node: HTMLElement, open: boolean): void {
  const value = open ? 'true' : 'false';
  if (node.dataset.open !== value) node.dataset.open = value;
}

/**
 * Sizes a canvas to its laid-out box at the capped device pixel ratio and hands
 * back a context already scaled to CSS pixels, so callers draw in CSS units.
 * Call it after layout has settled — every caller does so from a trailing
 * requestAnimationFrame.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | undefined {
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

/** One labelled figure in a `.cards` grid. */
export const card = (label: string, value: string, unit?: string): HTMLElement =>
  el('div', { class: 'card' }, [
    el('div', { class: 'k', text: label }),
    el('div', { class: 'v' }, [value, unit ? el('small', { text: ` ${unit}` }) : null]),
  ]);
