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
