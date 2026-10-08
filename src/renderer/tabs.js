// Main tabs. The Assistant is fixed; every other tab is added and closed as
// needed: diagrams, scripts, queries, builders, graphs and data browsers.
// Tabs of one kind can share a page (diagrams, scripts, builders, graphs):
// the module swaps that tab's state in when it is shown.

import { iconElement } from './icons.js';
import { tr } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);

export function setupTabs({ h }) {
  const bar = $('#main-tabs');
  const listeners = new Set();
  const tabs = new Map(); // tab id -> { kind, page, onClose, canClose }
  let current = null;

  // The fixed tabs written in the page (the Assistant).
  for (const b of bar.querySelectorAll('[data-main-tab]')) {
    const id = b.dataset.mainTab;
    tabs.set(id, { kind: id, page: document.querySelector(`.tab-page[data-page="${CSS.escape(id)}"]`), fixed: true });
  }

  const buttonOf = (id) => bar.querySelector(`[data-main-tab="${CSS.escape(id)}"]`);

  function show(id) {
    const tab = tabs.get(id);
    if (!tab?.page) return;
    current = id;
    for (const p of document.querySelectorAll('.tab-page')) p.hidden = p !== tab.page;
    for (const b of bar.querySelectorAll('[data-main-tab]')) b.classList.toggle('active', b.dataset.mainTab === id);
    buttonOf(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    listeners.forEach((l) => l(id));
  }

  bar.addEventListener('click', (e) => {
    const close = e.target.closest('.tab-close');
    if (close) {
      e.stopPropagation();
      userClose(close.closest('[data-main-tab]').dataset.mainTab);
      return;
    }
    const b = e.target.closest('[data-main-tab]');
    if (b) show(b.dataset.mainTab);
  });
  // The wheel scrolls the open tabs sideways.
  $('#data-tabs').addEventListener('wheel', (e) => {
    if (!e.deltaY) return;
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
  }, { passive: false });
  // Middle click closes a tab.
  bar.addEventListener('auxclick', (e) => {
    const b = e.target.closest('[data-main-tab].closable');
    if (e.button === 1 && b) userClose(b.dataset.mainTab);
  });

  // A closable tab. `element` is a page of its own, added to the window, or
  // with `shared` an existing page that other tabs of the kind show too.
  // canClose() can keep the tab open when the user closes it (unsaved changes).
  function add({ id, kind, title, tooltip, icon, element, shared = false, onClose, canClose }) {
    if (!shared) {
      element.classList.add('tab-page');
      element.dataset.page = id;
      element.hidden = true;
      $('#data-pages').append(element);
    }
    const btn = h('button', { type: 'button', class: 'closable', 'data-main-tab': id, title: tooltip ?? title }, [
      icon ? iconElement(icon, 'btn-icon') : null,
      h('span', { class: 'tab-title' }, title),
      h('span', { class: 'tab-close', title: tr('Close') }, '×'),
    ]);
    $('#data-tabs').append(btn);
    tabs.set(id, { kind: kind ?? id, page: element, shared, onClose, canClose });
    return id;
  }

  function remove(id) {
    const tab = tabs.get(id);
    if (!tab || tab.fixed) return;
    const btn = buttonOf(id);
    const next = btn?.previousElementSibling?.dataset.mainTab ?? btn?.nextElementSibling?.dataset.mainTab ?? $('#main-tabs [data-main-tab]')?.dataset.mainTab;
    tabs.delete(id);
    tab.onClose?.();
    if (!tab.shared) tab.page.remove();
    btn?.remove();
    if (current === id) {
      current = null;
      if (next && tabs.has(next)) show(next);
    }
  }

  function rename(id, title, tooltip = title) {
    const btn = buttonOf(id);
    if (!btn) return;
    btn.querySelector('.tab-title').textContent = title;
    btn.title = tooltip;
  }

  // A tab that can't be closed hides its ×, e.g. the only diagram.
  function setClosable(id, closable) {
    buttonOf(id)?.classList.toggle('closable', closable);
  }

  async function userClose(id) {
    if (!buttonOf(id)?.classList.contains('closable')) return;
    if (await (tabs.get(id)?.canClose?.() ?? true)) remove(id);
  }

  return {
    show,
    remove,
    add,
    rename,
    setClosable,
    current: () => current,
    // The kind of a tab: 'erd', 'scripts', 'query', 'builder', 'graph', 'data' or 'assistant'.
    kind: (id) => tabs.get(id)?.kind ?? null,
    // The open tabs of a kind, in tab order.
    ofKind: (kind) => [...bar.querySelectorAll('[data-main-tab]')].map((b) => b.dataset.mainTab).filter((id) => tabs.get(id)?.kind === kind),
    has: (id) => tabs.has(id),
    onShow: (fn) => listeners.add(fn),
  };
}
