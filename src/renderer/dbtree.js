// Database explorer: a tree of the connected instance's schemas, tables and
// columns beside the diagram. Tables are dragged from the tree onto the
// canvas to add them; their foreign keys to tables already in the diagram
// come along as relationships. The query builder and the SQL editor borrow
// the pane while their tab is shown (attach), and tables then go there instead.

import { tableKey } from './lib/catalog.js';
import { mergeFromDb } from './lib/sync.js';
import { formatType, qualifiedName } from './lib/sql.js';
import { iconElement } from './icons.js';
import { tr, trn } from '../shared/i18n.js';

// dataTransfer type of a table dragged from the tree; the value is its key.
export const TABLE_DRAG_TYPE = 'application/x-pgsql-erd-table';

const SHOWN_KEY = 'pgsql-erd.db-tree';
const WIDTH_KEY = 'pgsql-erd.db-tree-width';
const $ = (sel) => document.querySelector(sel);

export function setupDbTree(ctx) {
  const { state, h, commit, computeSizes, status, events, db, toDiagram, snap, select, centerOn, showContextMenu } = ctx;
  const pane = $('#db-tree');
  const list = $('#db-tree-list');
  const filter = $('#db-tree-filter');
  const info = $('#db-tree-info');

  let dbModel = null; // catalog of the connected instance, from catalog.js
  let loading = false;
  let error = null;
  const expanded = new Set(); // 'schema:<name>' and table keys
  const collapsedSchemas = new Set(); // schemas start expanded

  let shown = true;
  try {
    shown = localStorage.getItem(SHOWN_KEY) !== 'false';
  } catch { /* storage unavailable */ }

  function setShown(v) {
    shown = v;
    try {
      localStorage.setItem(SHOWN_KEY, String(v));
    } catch { /* storage unavailable */ }
    update();
    if (v && !dbModel && db.connected()) load();
  }

  async function load() {
    if (!db.connected() || loading) return;
    loading = true;
    error = null;
    render();
    try {
      await db.catalog(); // sets dbModel through the 'schema' event
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      render();
    }
  }

  const inDiagram = () => new Set(state.model.tables.map(tableKey));

  // Where tables from the tree go: the diagram, or whatever attach() set.
  const hint = pane.querySelector('.tree-hint');
  const diagramTarget = {
    present: inDiagram,
    add: (key) => addTable(key),
    title: (key, present) => present
      ? tr('{name} is in the diagram. Double-click to show it.', { name: key })
      : tr('Drag {name} onto the diagram to add it, or double-click.', { name: key }),
    tag: () => tr('In the diagram'),
    hint: () => tr('Drag a table onto the diagram to add it.'),
  };
  let target = diagramTarget;

  // Moves the pane to the start of `parent` and sends tables to `to`
  // ({ present, add, title, tag, hint }); without `to`, back to the diagram.
  function attach(parent, to = null) {
    if (pane.parentElement !== parent) parent.prepend(pane);
    target = to ?? diagramTarget;
    hint.textContent = target.hint();
    render();
  }

  function render() {
    if (!shown) return;
    const connected = db.connected();
    $('#db-tree-refresh').disabled = !connected || loading;
    if (!connected) {
      info.textContent = tr('Not connected');
      list.replaceChildren(h('div', { class: 'tree-empty' }, [
        h('p', {}, tr('Connect to a database to list its tables.')),
        h('button', { type: 'button', icon: 'db-connect', onclick: () => db.openConnect() }, tr('Connect')),
      ]));
      return;
    }
    info.textContent = db.info()?.description ?? '';
    info.title = info.textContent;
    if (error) return list.replaceChildren(h('div', { class: 'tree-empty error' }, error));
    if (!dbModel) return list.replaceChildren(h('div', { class: 'tree-empty' }, tr('Reading database…')));

    const q = filter.value.trim().toLowerCase();
    const present = target.present();
    const bySchema = new Map((dbModel.schemas ?? []).map((s) => [s, []]));
    for (const t of dbModel.tables) {
      if (q && !tableKey(t).toLowerCase().includes(q)) continue;
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, []);
      bySchema.get(t.schema).push(t);
    }
    const items = [];
    for (const [schema, tables] of [...bySchema].sort(([a], [b]) => a.localeCompare(b))) {
      if (q && !tables.length) continue;
      tables.sort((a, b) => a.name.localeCompare(b.name));
      const open = q ? true : !collapsedSchemas.has(schema);
      items.push(schemaNode(schema, tables, open, present));
    }
    list.replaceChildren(...(items.length ? items : [h('div', { class: 'tree-empty' }, q ? tr('No matching tables.') : tr('No tables found.'))]));
  }

  function twisty(open, onToggle) {
    return h('span', {
      class: `tree-twisty${open ? ' open' : ''}`,
      onclick: (e) => { e.stopPropagation(); onToggle(); },
    }, '▸');
  }

  function schemaNode(schema, tables, open, present) {
    const toggle = () => {
      if (collapsedSchemas.has(schema)) collapsedSchemas.delete(schema);
      else collapsedSchemas.add(schema);
      render();
    };
    const row = h('div', {
      class: 'tree-row schema',
      role: 'treeitem',
      'aria-expanded': String(open),
      onclick: toggle,
      oncontextmenu: (e) => openMenu(e, [
        { label: tr('Copy table names'), icon: 'copy', run: () => copyNames(tables.map((t) => t.name)) },
        { label: tr('Copy qualified table names'), icon: 'copy', run: () => copyNames(tables.map(tableKey)) },
      ]),
    }, [
      twisty(open, toggle),
      iconElement('db-connect', 'tree-icon'),
      h('span', { class: 'grow' }, schema),
      h('span', { class: 'tree-count' }, String(tables.length)),
    ]);
    const children = open ? tables.map((t) => tableNode(t, present.has(tableKey(t)))) : [];
    return h('div', { class: 'tree-node', role: 'group' }, [row, ...children]);
  }

  function tableNode(t, present) {
    const key = tableKey(t);
    const open = expanded.has(key);
    const toggle = () => {
      if (open) expanded.delete(key);
      else expanded.add(key);
      render();
    };
    const row = h('div', {
      class: `tree-row table${present ? ' present' : ''}`,
      role: 'treeitem',
      'aria-expanded': String(open),
      draggable: 'true',
      title: target.title(key, present),
      ondragstart: (e) => {
        e.dataTransfer.setData(TABLE_DRAG_TYPE, key);
        // what a text target (the SQL editor) receives
        e.dataTransfer.setData('text/plain', qualifiedName(t));
        e.dataTransfer.effectAllowed = 'copy';
      },
      ondblclick: () => target.add(key),
      oncontextmenu: (e) => openMenu(e, [
        { label: tr('Copy name'), icon: 'copy', run: () => copyNames([t.name]) },
        { label: tr('Copy qualified name'), icon: 'copy', run: () => copyNames([key]) },
      ]),
    }, [
      twisty(open, toggle),
      iconElement('toggle-tables', 'tree-icon'),
      h('span', { class: 'grow' }, t.name),
      present ? h('span', { class: 'tree-tag', title: target.tag() }, '✓') : null,
    ]);
    if (t.description) row.title += `\n${t.description}`;
    const node = h('div', { class: 'tree-node' }, row);
    if (open) node.append(...t.columns.map((c) => columnNode(t, c)));
    return node;
  }

  function columnNode(t, c) {
    const fk = dbModel.links.some((l) => l.localTable === t.id && l.localCol === c.attnum);
    const icon = c.pk ? iconElement('pk', 'tree-icon') : fk ? iconElement('fk', 'tree-icon') : h('span', { class: 'tree-icon' });
    return h('div', { class: 'tree-row column', title: `${c.name} ${formatType(c)}${c.notNull ? ' NOT NULL' : ''}` }, [
      icon,
      h('span', { class: `grow${c.notNull || c.pk ? ' nn' : ''}` }, c.name),
      h('span', { class: 'tree-type' }, formatType(c)),
    ]);
  }

  function openMenu(e, items) {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, items);
  }

  // One name per line, so a schema's tables paste as a list.
  async function copyNames(names) {
    await navigator.clipboard.writeText(names.join('\n'));
    status(names.length === 1
      ? tr('Copied {name}', { name: names[0] })
      : trn(names.length, 'Copied {n} table name', 'Copied {n} table names'));
  }

  // Adds the table with its top-left corner at `at` (diagram coordinates),
  // or centered in the view. A table already in the diagram is shown instead.
  function addTable(key, at) {
    if (!dbModel) return;
    const existing = state.model.tables.find((t) => tableKey(t) === key);
    if (existing) {
      select({ type: 'table', id: existing.id });
      centerOn(existing);
      return;
    }
    let result;
    const before = state.model.links.length;
    commit(() => {
      result = mergeFromDb(state.model, dbModel, [key]);
      computeSizes();
      const t = state.model.tables.find((x) => x.id === result.added[0]);
      if (!t) return;
      const s = state.sizes.get(t.id);
      const p = at ?? ctx.viewCenter();
      t.x = snap(at ? p.x : p.x - s.width / 2);
      t.y = snap(at ? p.y : p.y - s.height / 2);
    }, { panel: false });
    const id = result?.added[0];
    if (!id) return;
    select({ type: 'table', id });
    const links = state.model.links.length - before;
    status(links
      ? trn(links, 'Added {name} with {n} relationship', 'Added {name} with {n} relationships', { name: key })
      : tr('Added {name}', { name: key }));
  }

  // Drops on the canvas. The document-level handler (diagram files) ignores
  // drags that carry a table.
  const canvasWrap = $('.canvas-wrap');
  canvasWrap.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(TABLE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  canvasWrap.addEventListener('drop', (e) => {
    const key = e.dataTransfer.getData(TABLE_DRAG_TYPE);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    addTable(key, toDiagram(e.clientX, e.clientY));
  });

  function update() {
    pane.hidden = !shown;
    for (const b of document.querySelectorAll('[data-cmd="toggle-db-tree"]')) b.classList.toggle('active', shown);
    render();
  }

  // Drag the pane's right edge to resize it; the width is remembered.
  (function setupResize() {
    const handle = $('#db-tree-resize');
    const apply = (w) => pane.style.setProperty('--db-tree-w', `${Math.round(w)}px`);
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (saved) apply(saved);
    } catch { /* storage unavailable */ }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      const move = (ev) => apply(Math.min(Math.max(180, startW + ev.clientX - startX), window.innerWidth * 0.4));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(pane.getBoundingClientRect().width)));
        } catch { /* storage unavailable */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  })();

  filter.addEventListener('input', render);
  $('#db-tree-refresh').addEventListener('click', load);
  $('#db-tree-close').addEventListener('click', () => setShown(false));
  // A new connection reads its schema, which arrives as a 'schema' event.
  events.addEventListener('connection', () => {
    dbModel = null;
    error = null;
    render();
  });
  // The schema was read (connect, refresh, import, compare): use that catalog.
  events.addEventListener('schema', (e) => {
    if (e.model) {
      dbModel = e.model;
      error = null;
    }
    render();
  });
  // Marks which tables are in the diagram.
  events.addEventListener('model', render);
  events.addEventListener('file', render);

  update();

  return {
    attach,
    render,
    pane,
    shown: () => shown,
    load,
    model: () => dbModel,
    commands: {
      'toggle-db-tree': () => setShown(!shown),
    },
  };
}
