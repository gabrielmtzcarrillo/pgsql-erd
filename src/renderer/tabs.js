// Main tabs: Diagram, Scripts, Query and Assistant are fixed; data browser
// tabs (one per table) are added and closed as needed.

import { iconElement } from './icons.js';

const $ = (sel) => document.querySelector(sel);

export function setupTabs({ h }) {
  const bar = $('#main-tabs');
  const listeners = new Set();
  const closers = new Map(); // page id -> onClose
  let current = 'erd';

  const pages = () => document.querySelectorAll('.tab-page');
  const buttons = () => bar.querySelectorAll('[data-main-tab]');

  function show(name) {
    if (!document.querySelector(`.tab-page[data-page="${CSS.escape(name)}"]`)) return;
    current = name;
    for (const p of pages()) p.hidden = p.dataset.page !== name;
    for (const b of buttons()) b.classList.toggle('active', b.dataset.mainTab === name);
    bar.querySelector(`[data-main-tab="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    listeners.forEach((l) => l(name));
  }

  bar.addEventListener('click', (e) => {
    const close = e.target.closest('.tab-close');
    if (close) {
      e.stopPropagation();
      remove(close.closest('[data-main-tab]').dataset.mainTab);
      return;
    }
    const b = e.target.closest('[data-main-tab]');
    if (b) show(b.dataset.mainTab);
  });
  // Middle click closes a data tab.
  bar.addEventListener('auxclick', (e) => {
    const b = e.target.closest('[data-main-tab].closable');
    if (e.button === 1 && b) remove(b.dataset.mainTab);
  });

  // A closable tab with its page element. Returns the page id.
  function add({ id, title, tooltip, icon, element, onClose }) {
    element.classList.add('tab-page');
    element.dataset.page = id;
    element.hidden = true;
    $('#data-pages').append(element);
    const btn = h('button', { type: 'button', class: 'closable', 'data-main-tab': id, title: tooltip ?? title }, [
      icon ? iconElement(icon, 'btn-icon') : null,
      h('span', { class: 'tab-title' }, title),
      h('span', { class: 'tab-close', title: 'Close' }, '×'),
    ]);
    $('#data-tabs').append(btn);
    closers.set(id, onClose);
    return id;
  }

  function remove(id) {
    const page = document.querySelector(`.tab-page[data-page="${CSS.escape(id)}"]`);
    if (!page || !closers.has(id)) return;
    const btn = bar.querySelector(`[data-main-tab="${CSS.escape(id)}"]`);
    const next = btn?.previousElementSibling?.dataset.mainTab ?? btn?.nextElementSibling?.dataset.mainTab ?? 'erd';
    closers.get(id)?.();
    closers.delete(id);
    page.remove();
    btn?.remove();
    if (current === id) show(next || 'erd');
  }

  return {
    show,
    remove,
    add,
    current: () => current,
    has: (id) => !!document.querySelector(`.tab-page[data-page="${CSS.escape(id)}"]`),
    onShow: (fn) => listeners.add(fn),
  };
}
