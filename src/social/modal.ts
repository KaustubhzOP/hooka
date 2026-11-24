/** Tiny modal + DOM helpers shared by the account, social and online screens. */

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export interface Modal { el: HTMLElement; body: HTMLElement; close(): void; setTitle(t: string): void }

let current: Modal | null = null;

export function openModal(title: string, opts: { onClose?: () => void; closable?: boolean; wide?: boolean } = {}): Modal {
  current?.close();
  const body = h('div', { class: 'modalBody' });
  const titleEl = h('h2', { class: 'modalTitle' }, title);
  const closeBtn = opts.closable === false ? null : h('button', { class: 'modalClose', 'aria-label': 'Close', onclick: () => modal.close() }, '✕');
  const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'modalHead' }, titleEl, closeBtn), body);
  const backdrop = h('div', { class: 'modalBackdrop', onmousedown: (e: Event) => { if (e.target === backdrop && opts.closable !== false) modal.close(); } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && opts.closable !== false) modal.close(); e.stopPropagation(); };
  const modal: Modal = {
    el: box, body,
    setTitle: t => { titleEl.textContent = t; },
    close() {
      if (!backdrop.isConnected) return;
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      if (current === modal) current = null;
      opts.onClose?.();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  current = modal;
  setTimeout(() => box.querySelector<HTMLElement>('input, button.primary')?.focus(), 30);
  return modal;
}

export function isModalOpen(): boolean { return !!current; }

/** A status line under a form. */
export function status(): { el: HTMLElement; set(text: string, kind?: 'ok' | 'err' | 'info'): void } {
  const el = h('p', { class: 'formStatus' });
  return { el, set(text, kind = 'info') { el.textContent = text; el.className = 'formStatus ' + kind; } };
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t = 0;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

export const AVATARS = ['🙂', '😎', '🤠', '🥸', '😺', '🐉', '🦊', '🐼', '🦁', '🐸', '👻', '🤖', '👽', '🧞', '🦄', '🔥', '🌙', '⭐', '🍉', '🍑'];

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 120) return 'online';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
