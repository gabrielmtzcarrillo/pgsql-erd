// The Import tabs: the Excel -> PostgreSQL import designer. Three panels:
// the database explorer (left, shared with the other tabs), the mapping canvas
// (centre) and a read-only preview of the example workbook (right).
//
// On the canvas, Excel source nodes (one per worksheet and header range) and
// PostgreSQL INSERT task nodes are connected column by column; the numbered
// tasks run in order. The tab exports a portable, versioned template (see
// shared/import-template.js and docs/import-template-spec.md); nothing here
// writes to the database.
// Each Import tab has its own design; they share the page, which shows the
// design of the tab in front.

import { TABLE_DRAG_TYPE } from './dbtree.js';
import { tableKey } from './lib/catalog.js';
import { readSpreadsheet } from './lib/spreadsheet.js';
import { schemaFromErd, findTable } from '../shared/schema-model.js';
import {
  colLetter, colIndex, normHeader, newDesign, newSource, newTask, newId, designToTemplate, templateToDesign,
  designDiagnostics, hasErrors, suggestOrder, resolveSource, extractRows, checkValue, inferHint, validateTemplate,
} from '../shared/import-template.js';
import { iconElement, decorateButtons } from './icons.js';
import { tr, trn } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);
const TABS_KEY = 'pgsql-erd.import-tabs';
const SPLIT_KEY = 'pgsql-erd.import-dock';
const RIGHT_KEY = 'pgsql-erd.import-right';
const ROW_H = 22;
const COL_W = 110;
const NUM_W = 48;
const MAX_COLS = 200;
const MARGIN = 30;
const GAP = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function setupImportDesigner(ctx) {
  const { host, h, status, db, tabs, events, dbTree } = ctx;
  const page = $('#import-page');
  const canvas = $('#imp-canvas');
  const sizer = $('#imp-sizer');
  const area = $('#imp-area');
  const lines = $('#imp-lines');
  const gridEl = $('#imp-grid');

  const records = new Map(); // tab id -> record
  let tabId = null; // the tab shown
  let T = null; // its record: { design, title, filePath, wb, sheet, sel, undo, redo, resolved, diag, dock, zoom, pick, dirty }
  let tabSeq = 0;
  const isShown = () => tabs.kind(tabs.current()) === 'import';

  const makeRecord = (design, title, filePath = null) => ({
    design, title, filePath, wb: null, sheet: null, sel: null, undo: [], redo: [], resolved: {}, diag: [],
    dock: 'inspector', zoom: 1, pick: 'header', dirty: false, order: null, loading: false,
  });

  // ------------------------------------------------------------ persistence

  function loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null');
    } catch {
      return null;
    }
  }
  function save() {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs.ofKind('import').map((id) => records.get(id)).filter(Boolean)
        .map((r) => ({ design: r.design, title: r.title, filePath: r.filePath }))));
    } catch {
      // not remembered
    }
  }

  // ------------------------------------------------------------ database

  let schemaCache = { model: null, value: null };
  // The connected database as a schema model; null without a connection.
  function schema() {
    const model = db.connected() ? dbTree.model() : null;
    if (!model) return null;
    if (schemaCache.model !== model) schemaCache = { model, value: schemaFromErd(model) };
    return schemaCache.value;
  }
  const dbTable = (t) => {
    const s = schema();
    return s ? findTable(s, `${t.schema}.${t.table}`) : null;
  };

  // ------------------------------------------------------------ editing

  const sourceOf = (id) => T.design.sources.find((s) => s.id === id);
  const taskOf = (id) => T.design.tasks.find((t) => t.id === id);
  const template = () => designToTemplate(T.design, { editor: false });
  const selectedSource = () => (T.sel?.type === 'source' ? sourceOf(T.sel.id) : null);

  function snapshot() {
    T.undo.push(JSON.stringify(T.design));
    if (T.undo.length > 100) T.undo.shift();
    T.redo = [];
  }
  // Changes the design with an undo step.
  function edit(fn) {
    snapshot();
    fn(T.design);
    changed();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(T.design));
    T.design = JSON.parse(from.pop());
    if (T.sel && !(T.sel.type === 'source' ? sourceOf(T.sel.id) : taskOf(T.sel.type === 'map' ? T.sel.task : T.sel.id))) T.sel = null;
    changed();
  }
  const undo = () => restore(T.undo, T.redo);
  const redo = () => restore(T.redo, T.undo);

  function changed() {
    T.dirty = true;
    syncColumns();
    save();
    render();
    scheduleDiagnostics();
  }

  // Reads the example workbook through the sources' rules: the node columns
  // follow the file, and mappings follow their columns.
  function syncColumns() {
    T.resolved = {};
    if (!T.wb) return;
    const tpl = template();
    for (const ts of tpl.sources) {
      const src = sourceOf(ts.id);
      const res = resolveSource(tpl, ts, T.wb.sheets);
      T.resolved[ts.id] = res;
      if (!res.ok) continue;
      src.columns = res.columns.map((c) => ({ letter: c.letter, label: c.label }));
      const match = { caseSensitive: src.header.caseSensitive };
      for (const task of T.design.tasks) {
        if (task.sourceId !== src.id) continue;
        for (const m of task.mappings) {
          const c = src.header.mode === 'detect'
            ? res.columns.find((x) => normHeader(x.label, match) === normHeader(m.label, match))
            : res.columns.find((x) => x.letter === m.letter);
          if (!c) continue;
          m.letter = c.letter;
          m.label = c.label;
        }
      }
    }
  }

  let diagTimer = 0;
  function scheduleDiagnostics() {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => {
      if (!T) return;
      T.diag = designDiagnostics(T.design, schema(), T.wb?.sheets ?? null);
      if (isShown()) {
        renderDock();
        markNodes();
      }
    }, 120);
  }

  // ------------------------------------------------------------ nodes and mappings

  function nextSpot(kind) {
    const nodes = [...area.querySelectorAll(`.imp-node.${kind}`)];
    const x = kind === 'source' ? MARGIN : 540;
    if (!nodes.length) return { x, y: MARGIN };
    return { x, y: Math.max(...nodes.map((n) => n.offsetTop + n.offsetHeight)) + GAP };
  }

  function addSource(sheetName) {
    const sheet = T.wb?.sheets.find((s) => s.name === sheetName);
    // The first row with at least two filled cells is taken for the header.
    let row = 1;
    let col = 0;
    if (sheet) {
      const at = sheet.rows.slice(0, 40).findIndex((r) => (r ?? []).filter((c) => String(c ?? '').trim()).length >= 2);
      row = at === -1 ? 1 : at + 1;
      col = Math.max(0, (sheet.rows[row - 1] ?? []).findIndex((c) => String(c ?? '').trim()));
    }
    const s = newSource({ sheet: { mode: 'name', value: sheetName ?? '', headers: null }, ...nextSpot('source') });
    s.header.row = row;
    s.header.startColumn = colLetter(col);
    edit((d) => d.sources.push(s));
    select({ type: 'source', id: s.id });
  }

  async function addTask(key, at) {
    if (!dbTree.model()) await dbTree.load();
    const src = dbTree.model()?.tables.find((t) => tableKey(t) === key);
    if (!src) return;
    const pos = at ?? nextSpot('task');
    const t = newTask(src.schema || 'public', src.name, { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) });
    edit((d) => d.tasks.push(t));
    select({ type: 'task', id: t.id });
    status(tr('Added {name}', { name: key }));
  }

  function removeSource(id) {
    edit((d) => {
      d.sources = d.sources.filter((s) => s.id !== id);
      for (const t of d.tasks) if (t.sourceId === id) {
        t.sourceId = null;
        t.mappings = [];
      }
    });
    if (T.sel?.id === id) T.sel = null;
  }
  function removeTask(id) {
    edit((d) => (d.tasks = d.tasks.filter((t) => t.id !== id)));
    if (T.sel?.id === id || T.sel?.task === id) T.sel = null;
  }
  function removeMapping(taskId, mapId) {
    edit((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      t.mappings = t.mappings.filter((m) => m.id !== mapId);
    });
    T.sel = { type: 'task', id: taskId };
  }

  // One Excel column feeds one column of a task; a task reads one source.
  function connect(sourceId, key, taskId, targetColumn) {
    const src = sourceOf(sourceId);
    const task = taskOf(taskId);
    const col = src?.columns.find((c) => (src.header.mode === 'detect' ? c.label : c.letter) === key);
    if (!col || !task) return;
    if (task.sourceId && task.sourceId !== sourceId && task.mappings.length) {
      return status(tr('{table} already reads from another worksheet; a task has one source.', { table: `${task.schema}.${task.table}` }));
    }
    if (src.header.mode === 'detect' && (!col.label || src.columns.filter((c) => normHeader(c.label) === normHeader(col.label)).length > 1)) {
      return status(tr('That header is blank or repeated, so it cannot be found by name.'));
    }
    const id = newId('map');
    edit((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      t.sourceId = sourceId;
      t.mappings = t.mappings.filter((m) => m.targetColumn !== targetColumn);
      t.mappings.push({ id, letter: col.letter, label: col.label, targetColumn, blank: 'null', trim: false });
    });
    select({ type: 'map', task: taskId, id });
  }

  const nameKey = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Connects the columns of a task to the columns of its source with the same name.
  function autoMap(taskId) {
    const task = taskOf(taskId);
    const tb = dbTable(task);
    const src = sourceOf(task.sourceId) ?? selectedSource() ?? (T.design.sources.length === 1 ? T.design.sources[0] : null);
    if (!tb || !src) return status(tr('Connect to the database and select an Excel source to map by name.'));
    const free = tb.columns.filter((c) => !c.generated && !task.mappings.some((m) => m.targetColumn === c.name));
    const hits = [];
    for (const c of free) {
      const from = src.columns.find((x) => nameKey(x.label) === nameKey(c.name) && x.label && !task.mappings.some((m) => m.letter === x.letter && m.targetColumn === c.name));
      if (from) hits.push([c.name, from]);
    }
    if (!hits.length) return status(tr('No column names match.'));
    edit((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      t.sourceId = src.id;
      for (const [name, from] of hits) t.mappings.push({ id: newId('map'), letter: from.letter, label: from.label, targetColumn: name, blank: 'null', trim: false });
    });
    status(trn(hits.length, 'Mapped {n} column by name', 'Mapped {n} columns by name'));
  }

  function select(sel) {
    pick(sel);
    render();
  }

  // The selection, without rebuilding the nodes: used on pointerdown, where the
  // node under the pointer must survive for a drag.
  function pick(sel) {
    T.sel = sel;
    const src = sel?.type === 'source' ? sourceOf(sel.id) : null;
    const resolved = src && T.resolved[src.id];
    if (resolved?.ok) T.sheet = resolved.sheetName;
    else if (src?.sheet.mode === 'name' && T.wb?.sheets.some((s) => s.name === src.sheet.value)) T.sheet = src.sheet.value;
    if (sel?.type === 'map') T.dock = 'inspector';
  }
  function selectLight(sel) {
    pick(sel);
    for (const n of area.querySelectorAll('.imp-node')) {
      n.classList.toggle('selected', sel?.id === n.dataset.id || sel?.task === n.dataset.id);
    }
    drawEdges();
    renderRight();
    renderDock();
  }

  // ------------------------------------------------------------ canvas rendering

  function sheetLabel(s) {
    if (s.sheet.mode === 'name') return s.sheet.value || tr('(no worksheet)');
    if (s.sheet.mode === 'index') return tr('Worksheet {n}', { n: s.sheet.value });
    return tr('Worksheet found by headers');
  }
  const headerLabel = (s) => (s.header.mode === 'fixed'
    ? tr('headers at {cell}', { cell: `${s.header.startColumn}${s.header.row}` })
    : tr('headers in rows {from}-{to}', { from: s.header.scanFrom, to: s.header.scanTo }));

  function render() {
    if (!T) return;
    const scroll = new Map([...area.querySelectorAll('.imp-node')].map((n) => [n.dataset.id, n.querySelector('.imp-cols')?.scrollTop ?? 0]));
    $('#imp-empty').hidden = T.design.sources.length > 0 || T.design.tasks.length > 0;
    area.replaceChildren(lines, ...T.design.sources.map(sourceNode), ...T.design.tasks.map(taskNode));
    for (const n of area.querySelectorAll('.imp-node')) {
      const body = n.querySelector('.imp-cols');
      if (body) body.scrollTop = scroll.get(n.dataset.id) ?? 0;
    }
    const nameInput = $('#imp-name');
    if (document.activeElement !== nameInput) nameInput.value = T.design.name;
    if (document.activeElement !== $('#imp-id')) $('#imp-id').value = T.design.templateId;
    $('#imp-tx').value = T.design.transaction;
    $('#imp-undo').disabled = !T.undo.length;
    $('#imp-redo').disabled = !T.redo.length;
    $('#imp-zoom').textContent = `${Math.round(T.zoom * 100)}%`;
    area.style.transform = `scale(${T.zoom})`;
    drawEdges();
    markNodes();
    renderRight();
    renderDock();
  }

  const diagOf = (key, id) => T.diag.filter((d) => d[key] === id);

  // Red / amber outlines on nodes with problems.
  function markNodes() {
    for (const n of area.querySelectorAll('.imp-node')) {
      const list = diagOf(n.classList.contains('source') ? 'sourceId' : 'taskId', n.dataset.id);
      n.classList.toggle('has-error', list.some((d) => d.level === 'error'));
      n.classList.toggle('has-warning', !list.some((d) => d.level === 'error') && list.some((d) => d.level === 'warning'));
    }
  }

  function nodeHead(node, icon, title, onRemove, ...extra) {
    const head = h('div', { class: 'imp-head', title: tr('Drag to move') }, [
      ...extra,
      iconElement(icon, 'tree-icon'),
      h('span', { class: 'imp-title' }, title),
      h('button', { type: 'button', class: 'imp-remove', icon: 'close', title: tr('Remove from the template'), onclick: (e) => { e.stopPropagation(); onRemove(); } }),
    ]);
    head.addEventListener('pointerdown', (e) => startMove(e, node, head));
    return head;
  }

  function sourceNode(s) {
    const sel = T.sel?.type === 'source' && T.sel.id === s.id;
    const res = T.resolved[s.id];
    const match = { caseSensitive: s.header.caseSensitive };
    const rows = s.columns.map((c) => {
      const key = s.header.mode === 'detect' ? c.label : c.letter;
      const dup = s.header.mode === 'detect' && (!c.label || s.columns.filter((x) => normHeader(x.label, match) === normHeader(c.label, match)).length > 1);
      const port = h('span', { class: 'imp-port out', title: dup ? tr('This header is blank or repeated: it cannot be found by name.') : tr('Drag to a table column to map it') });
      if (!dup || s.header.mode !== 'detect') port.addEventListener('pointerdown', (e) => startConnect(e, s.id, key));
      return h('div', { class: `imp-col${dup ? ' dup' : ''}`, 'data-key': key, title: `${c.letter} ${c.label}`.trim() }, [
        h('span', { class: 'imp-letter' }, c.letter || '·'),
        h('span', { class: 'imp-label' }, c.label || '—'),
        port,
      ]);
    });
    const node = h('div', { class: `imp-node source${sel ? ' selected' : ''}`, 'data-id': s.id, style: `left:${s.x}px;top:${s.y}px` });
    node.addEventListener('pointerdown', () => !sel && selectLight({ type: 'source', id: s.id }));
    node.append(
      nodeHead(s, 'import-spreadsheet', sheetLabel(s), () => removeSource(s.id)),
      h('div', { class: `imp-sub${res && !res.ok ? ' error' : ''}`, title: res?.errors?.[0]?.message ?? '' }, `${headerLabel(s)}${res?.ok ? ` · ${trn(res.columns.length, '{n} column', '{n} columns')}` : ''}`),
    );
    const body = h('div', { class: 'imp-cols' }, rows.length ? rows : [h('div', { class: 'imp-note' }, T.wb ? tr('The columns appear when the worksheet is found.') : tr('Open the example workbook to list its columns.'))]);
    body.addEventListener('scroll', drawEdges);
    node.append(body);
    return node;
  }

  function taskNode(t) {
    const index = T.design.tasks.indexOf(t);
    const sel = (T.sel?.type === 'task' && T.sel.id === t.id) || (T.sel?.type === 'map' && T.sel.task === t.id);
    const tb = dbTable(t);
    const mapped = new Set(t.mappings.map((m) => m.targetColumn));
    const cols = tb ? tb.columns : [...mapped].map((name) => ({ name, databaseType: '' }));
    const pk = new Set(tb?.primaryKey?.columns ?? []);
    const rows = cols.map((c) => {
      const required = tb && !c.nullable && !c.defaultValue && !c.identity && !c.generated && !c.serial;
      const port = h('span', { class: 'imp-port in', title: c.generated ? tr('Generated column: it cannot be inserted.') : tr('Drop an Excel column here') });
      return h('div', { class: `imp-col${mapped.has(c.name) ? ' mapped' : ''}${required && !mapped.has(c.name) ? ' required' : ''}${c.generated ? ' disabled' : ''}`, 'data-col': c.name }, [
        port,
        pk.has(c.name) ? iconElement('pk', 'tree-icon') : h('span', { class: 'tree-icon' }),
        h('span', { class: `imp-label${required ? ' nn' : ''}` }, c.name),
        h('span', { class: 'tree-type' }, c.databaseType),
      ]);
    });
    const node = h('div', { class: `imp-node task${sel ? ' selected' : ''}`, 'data-id': t.id, style: `left:${t.x}px;top:${t.y}px` });
    node.addEventListener('pointerdown', () => !sel && selectLight({ type: 'task', id: t.id }));
    node.append(
      nodeHead(t, 'toggle-tables', `${t.schema}.${t.table}`, () => removeTask(t.id), h('span', { class: 'imp-order', title: tr('Position in the insertion order') }, String(index + 1))),
    );
    const body = h('div', { class: 'imp-cols' }, rows.length ? rows : [h('div', { class: 'imp-note' }, db.connected() ? tr('Not in the database.') : tr('Connect to see the columns.'))]);
    body.addEventListener('scroll', drawEdges);
    node.append(
      body,
      h('div', { class: 'imp-foot' }, [
        h('button', { type: 'button', title: tr('Connect the columns that have the same name'), onclick: () => autoMap(t.id) }, tr('Map by name')),
        h('span', { class: 'muted small' }, trn(t.mappings.length, '{n} mapped', '{n} mapped')),
      ]),
    );
    return node;
  }

  // ------------------------------------------------------------ edges

  const scale = () => T?.zoom ?? 1;
  const toArea = (cx, cy) => {
    const r = area.getBoundingClientRect();
    return { x: (cx - r.left) / scale(), y: (cy - r.top) / scale() };
  };
  function portPoint(el) {
    const r = el.getBoundingClientRect();
    const b = el.closest('.imp-cols').getBoundingClientRect();
    const y = Math.min(Math.max(r.top + r.height / 2, b.top + 4), b.bottom - 4);
    return toArea(r.left + r.width / 2, y);
  }
  const curve = (p, q) => {
    const d = Math.max(40, Math.abs(q.x - p.x) / 2);
    return `M${p.x},${p.y} C${p.x + d},${p.y} ${q.x - d},${q.y} ${q.x},${q.y}`;
  };

  function drawEdges() {
    if (!T) return;
    let w = canvas.clientWidth / scale();
    let hgt = canvas.clientHeight / scale();
    for (const n of area.querySelectorAll('.imp-node')) {
      w = Math.max(w, n.offsetLeft + n.offsetWidth + MARGIN);
      hgt = Math.max(hgt, n.offsetTop + n.offsetHeight + MARGIN);
    }
    area.style.width = `${w}px`;
    area.style.height = `${hgt}px`;
    sizer.style.width = `${w * scale()}px`;
    sizer.style.height = `${hgt * scale()}px`;
    lines.setAttribute('width', w);
    lines.setAttribute('height', hgt);
    const outs = new Map();
    for (const el of area.querySelectorAll('.imp-node.source .imp-col')) outs.set(`${el.closest('.imp-node').dataset.id}\0${el.dataset.key}`, el.querySelector('.imp-port'));
    const ins = new Map();
    for (const el of area.querySelectorAll('.imp-node.task .imp-col')) ins.set(`${el.closest('.imp-node').dataset.id}\0${el.dataset.col}`, el.querySelector('.imp-port'));
    const out = [];
    for (const t of T.design.tasks) {
      const src = sourceOf(t.sourceId);
      for (const m of t.mappings) {
        const a = src && outs.get(`${src.id}\0${src.header.mode === 'detect' ? m.label : m.letter}`);
        const b = ins.get(`${t.id}\0${m.targetColumn}`);
        if (!a || !b) continue;
        const d = curve(portPoint(a), portPoint(b));
        const sel = T.sel?.type === 'map' && T.sel.id === m.id;
        out.push(`<g data-task="${t.id}" data-map="${m.id}"><path class="imp-hit" d="${d}"/><path class="imp-edge${sel ? ' selected' : ''}" d="${d}"/></g>`);
      }
    }
    lines.innerHTML = out.join('');
  }

  lines.addEventListener('click', (e) => {
    const g = e.target.closest('[data-map]');
    if (g) select({ type: 'map', task: g.dataset.task, id: g.dataset.map });
  });

  // Drag from an Excel column's port to a table column to map it.
  function startConnect(e, sourceId, key) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const port = e.currentTarget;
    port.setPointerCapture(e.pointerId);
    const from = portPoint(port);
    const temp = document.createElementNS(SVG_NS, 'path');
    temp.setAttribute('class', 'imp-edge temp');
    lines.append(temp);
    area.classList.add('connecting');
    const target = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.imp-node.task .imp-col:not(.disabled)');
    let hot = null;
    const move = (ev) => {
      temp.setAttribute('d', curve(from, toArea(ev.clientX, ev.clientY)));
      const t = target(ev);
      if (t !== hot) {
        hot?.classList.remove('drop');
        hot = t;
        hot?.classList.add('drop');
      }
    };
    const end = (ev) => {
      port.removeEventListener('pointermove', move);
      port.removeEventListener('pointerup', end);
      port.removeEventListener('pointercancel', end);
      temp.remove();
      hot?.classList.remove('drop');
      area.classList.remove('connecting');
      const t = ev.type === 'pointerup' ? target(ev) : null;
      if (t) connect(sourceId, key, t.closest('.imp-node').dataset.id, t.dataset.col);
    };
    port.addEventListener('pointermove', move);
    port.addEventListener('pointerup', end);
    port.addEventListener('pointercancel', end);
    move(e);
  }

  // Drag a node by its header. Moves are undoable, in one step per drag.
  function startMove(e, node, head) {
    if (e.button !== 0 || e.target.closest('input, button, select')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const el = head.parentElement;
    const before = JSON.stringify(T.design);
    const sx = e.clientX / scale() - node.x;
    const sy = e.clientY / scale() - node.y;
    let moved = false;
    el.classList.add('moving');
    const move = (ev) => {
      moved = true;
      node.x = Math.max(0, Math.round(ev.clientX / scale() - sx));
      node.y = Math.max(0, Math.round(ev.clientY / scale() - sy));
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
      drawEdges();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      el.classList.remove('moving');
      if (moved) {
        T.undo.push(before);
        T.redo = [];
        T.dirty = true;
        save();
      }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.target === canvas || e.target === sizer || e.target === area) {
      if (T.sel) select(null);
    }
  });

  // Tables dragged from the explorer.
  canvas.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(TABLE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('drop-target');
  });
  canvas.addEventListener('dragleave', (e) => {
    if (!canvas.contains(e.relatedTarget)) canvas.classList.remove('drop-target');
  });
  canvas.addEventListener('drop', (e) => {
    canvas.classList.remove('drop-target');
    const key = e.dataTransfer.getData(TABLE_DRAG_TYPE);
    if (!key) return;
    e.preventDefault();
    const p = toArea(e.clientX, e.clientY);
    addTask(key, { x: p.x - 20, y: p.y - 12 });
  });

  function setZoom(z) {
    T.zoom = Math.min(1.6, Math.max(0.4, Math.round(z * 10) / 10));
    render();
  }
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(T.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  // ------------------------------------------------------------ right panel: the example workbook

  async function parseWorkbook(name, bytes) {
    try {
      const sheets = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./lib/xlsx-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          worker.terminate();
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.sheets);
        };
        worker.onerror = () => {
          worker.terminate();
          resolve(null);
        };
        worker.postMessage({ name, bytes });
      });
      if (sheets) return sheets;
    } catch (err) {
      if (!/Worker|Security/i.test(String(err?.name ?? err))) throw err;
    }
    return readSpreadsheet(name, bytes);
  }

  async function loadWorkbook(name, bytes) {
    const rec = T;
    rec.loading = true;
    renderRight();
    try {
      const sheets = await parseWorkbook(name, bytes);
      rec.wb = { name, sheets, meta: new Map() };
      rec.sheet = sheets.find((s) => !s.hidden)?.name ?? sheets[0]?.name ?? null;
    } catch (err) {
      status(tr('Could not read {file}: {message}', { file: name, message: err.message }));
    }
    rec.loading = false;
    if (rec === T) {
      syncColumns();
      render();
      scheduleDiagnostics();
    }
  }

  async function chooseWorkbook() {
    const res = await host.openSpreadsheet();
    if (res) await loadWorkbook(res.filePath.split(/[\\/]/).pop(), res.data);
  }

  const activeSheet = () => T.wb?.sheets.find((s) => s.name === T.sheet) ?? null;

  // Width and merged cells of a sheet, worked out once.
  function sheetMeta(sheet) {
    let m = T.wb.meta.get(sheet.name);
    if (m) return m;
    let width = 0;
    for (const r of sheet.rows) width = Math.max(width, r?.length ?? 0);
    const covered = new Set();
    const anchors = new Map();
    for (const ref of sheet.merges ?? []) {
      const [a, b = a] = ref.split(':');
      const r1 = Number(a.replace(/\D/g, ''));
      const c1 = colIndex(a.replace(/\d/g, ''));
      const r2 = Number(b.replace(/\D/g, ''));
      const c2 = colIndex(b.replace(/\d/g, ''));
      if (!(r1 > 0 && c1 >= 0 && r2 >= r1 && c2 >= c1) || (r2 - r1 + 1) * (c2 - c1 + 1) > 10000) continue;
      anchors.set(`${r1},${c1}`, ref);
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r},${c}`);
      width = Math.max(width, c2 + 1);
    }
    m = { width: Math.min(MAX_COLS, Math.max(width, 1)), covered, anchors };
    T.wb.meta.set(sheet.name, m);
    return m;
  }

  function renderRight() {
    $('#imp-wb-name').textContent = T.loading ? tr('Reading…') : T.wb?.name ?? tr('No example workbook');
    $('#imp-wb-name').title = T.wb?.name ?? '';
    const tabsEl = $('#imp-sheets');
    tabsEl.replaceChildren(...(T.wb?.sheets ?? []).map((s) => h('button', {
      type: 'button',
      class: `imp-sheet${s.name === T.sheet ? ' active' : ''}`,
      title: s.hidden ? tr('{name} (hidden)', { name: s.name }) : s.name,
      onclick: () => {
        T.sheet = s.name;
        renderRight();
      },
    }, s.name)));
    $('#imp-add-source').disabled = !activeSheet();
    renderSettings();
    renderGrid();
  }

  // The selected source's rules, and what they find in the example workbook.
  function renderSettings() {
    const box = $('#imp-settings');
    const s = selectedSource();
    if (!s) {
      box.replaceChildren(h('p', { class: 'imp-help' }, T.wb
        ? tr('Add the worksheet shown below as an Excel source, or select a source on the canvas to edit how its header and data are found.')
        : tr('Open an example workbook to see its worksheets. The template does not keep the workbook: any file with the same structure can be imported later.')));
      return;
    }
    const res = T.resolved[s.id];
    const field = (label, input, title) => h('label', { class: 'imp-field', title }, [h('span', {}, label), input]);
    const num = (value, min, on, width = 64) => h('input', { type: 'number', min, step: 1, value, style: `width:${width}px`, onchange: (e) => on(Math.max(min, Math.round(Number(e.target.value)) || min)) });
    const opt = (value, label, current) => h('option', { value, selected: value === current }, label);
    const set = (fn) => edit((d) => fn(d.sources.find((x) => x.id === s.id)));
    const sheetNames = h('datalist', { id: 'imp-sheet-names' }, (T.wb?.sheets ?? []).map((x) => h('option', { value: x.name })));

    const sheetMode = h('select', {
      onchange: (e) => set((x) => {
        x.sheet = { mode: e.target.value, value: e.target.value === 'index' ? 1 : x.sheet.mode === 'name' ? x.sheet.value : T.sheet ?? '', headers: null };
      }),
    }, [opt('name', tr('By name'), s.sheet.mode), opt('index', tr('By position'), s.sheet.mode), opt('requiredHeaders', tr('By its headers'), s.sheet.mode)]);
    const sheetValue = s.sheet.mode === 'name'
      ? h('input', { value: s.sheet.value, list: 'imp-sheet-names', spellcheck: 'false', style: 'width:130px', onchange: (e) => set((x) => (x.sheet.value = e.target.value.trim())) })
      : s.sheet.mode === 'index'
        ? num(s.sheet.value, 1, (v) => set((x) => (x.sheet.value = v)))
        : h('span', { class: 'muted small' }, tr('the one with all the mapped headers'));
    const headerMode = h('select', { onchange: (e) => set((x) => { x.header.mode = e.target.value; x.header.expected = null; }) }, [
      opt('fixed', tr('Fixed position'), s.header.mode), opt('detect', tr('Find by header names'), s.header.mode),
    ]);
    const fixed = s.header.mode === 'fixed';
    const headerFields = fixed
      ? [
        field(tr('Header row'), num(s.header.row, 1, (v) => set((x) => { x.header.row = v; x.header.expected = null; }))),
        field(tr('Starts at column'), h('input', {
          value: s.header.startColumn, style: 'width:56px', spellcheck: 'false',
          onchange: (e) => (colIndex(e.target.value) >= 0 ? set((x) => { x.header.startColumn = e.target.value.toUpperCase(); x.header.expected = null; }) : render()),
        })),
      ]
      : [
        field(tr('Look in rows'), h('span', { class: 'imp-pair' }, [num(s.header.scanFrom, 1, (v) => set((x) => (x.header.scanFrom = v)), 56), '–', num(s.header.scanTo, 1, (v) => set((x) => (x.header.scanTo = v)), 56)]),
          tr('Rows searched for the header row; it must be found exactly once.')),
        field(tr('Match case'), h('input', { type: 'checkbox', checked: s.header.caseSensitive, onchange: (e) => set((x) => (x.header.caseSensitive = e.target.checked)) })),
      ];
    const status1 = !T.wb ? h('p', { class: 'muted small' }, tr('Not checked: no example workbook is open.'))
      : res?.ok
        ? h('p', { class: 'small ok' }, tr('Worksheet "{sheet}", header row {row}, {columns}, data from row {data}.', {
          sheet: res.sheetName, row: res.headerRow, columns: trn(res.columns.length, '{n} column', '{n} columns'), data: res.firstDataRow,
        }))
        : h('ul', { class: 'small error imp-errors' }, (res?.errors ?? []).map((er) => h('li', {}, er.message)));
    box.replaceChildren(
      sheetNames,
      h('div', { class: 'imp-form' }, [
        field(tr('Worksheet'), h('span', { class: 'imp-pair' }, [sheetMode, sheetValue])),
        field(tr('Header'), headerMode),
        ...headerFields,
        field(tr('First data row'), h('span', { class: 'imp-pair' }, [num(s.dataOffset, 1, (v) => set((x) => (x.dataOffset = v)), 56), h('span', { class: 'muted small' }, tr('rows after the header'))])),
        field(tr('Skip empty rows'), h('input', { type: 'checkbox', checked: s.skipEmptyRows, onchange: (e) => set((x) => (x.skipEmptyRows = e.target.checked)) }),
          tr('Rows where every mapped cell is empty are not inserted. The data ends at the last row with a mapped value.')),
      ]),
      status1,
      res?.ok ? columnTable(s, res) : null,
    );
  }

  // Detected headers with a sample and a type hint; blank and repeated headers are flagged.
  function columnTable(s, res) {
    const rows = res.columns.slice(0, 60).map((c) => {
      const samples = [];
      for (let r = res.firstDataRow; r < res.firstDataRow + 40 && samples.length < 12; r++) {
        const v = res.sheet.rows[r - 1]?.[c.index];
        if (String(v ?? '').trim()) samples.push(v);
      }
      const flag = !c.label ? tr('blank header') : c.duplicate ? tr('repeated header') : '';
      return h('tr', { class: flag ? 'warn' : '' }, [
        h('td', {}, c.letter),
        h('td', { title: c.label }, c.label || '—'),
        h('td', { class: 'muted' }, inferHint(samples)),
        h('td', { class: 'imp-sample', title: samples.slice(0, 5).join('\n') }, String(samples[0] ?? '')),
        h('td', { class: 'error' }, flag),
      ]);
    });
    return h('details', { class: 'imp-columns' }, [
      h('summary', {}, tr('Detected columns ({n})', { n: res.columns.length })),
      h('table', {}, [h('tbody', {}, rows)]),
    ]);
  }

  // The read-only grid: only the rows and columns in view are built.
  function renderGrid() {
    const sheet = activeSheet();
    gridEl.replaceChildren();
    if (!sheet) {
      gridEl.append(h('div', { class: 'imp-grid-empty' }, T.loading ? tr('Reading…') : tr('No worksheet to show.')));
      return;
    }
    const meta = sheetMeta(sheet);
    const spacer = h('div', { class: 'imp-grid-spacer', style: `width:${NUM_W + meta.width * COL_W}px;height:${(sheet.rows.length + 1) * ROW_H}px` });
    gridEl.append(spacer);
    drawGrid();
  }

  let gridFrame = 0;
  gridEl.addEventListener('scroll', () => {
    cancelAnimationFrame(gridFrame);
    gridFrame = requestAnimationFrame(drawGrid);
  });

  function drawGrid() {
    const sheet = activeSheet();
    const spacer = gridEl.querySelector('.imp-grid-spacer');
    if (!sheet || !spacer) return;
    const meta = sheetMeta(sheet);
    const src = selectedSource();
    const res = src && T.resolved[src.id]?.ok && T.resolved[src.id].sheetName === sheet.name ? T.resolved[src.id] : null;
    const headerRow = res?.headerRow ?? 0;
    const dataFrom = res?.firstDataRow ?? 0;
    const cols = new Map(res?.columns.map((c) => [c.index, c]) ?? []);
    const mappedIdx = new Set();
    if (src) for (const m of T.design.tasks.filter((t) => t.sourceId === src.id).flatMap((t) => t.mappings)) {
      const c = res?.columns.find((x) => (src.header.mode === 'detect' ? normHeader(x.label) === normHeader(m.label) : x.letter === m.letter));
      if (c) mappedIdx.add(c.index);
    }
    const firstRow = Math.max(0, Math.floor(gridEl.scrollTop / ROW_H) - 4);
    const lastRow = Math.min(sheet.rows.length - 1, Math.ceil((gridEl.scrollTop + gridEl.clientHeight) / ROW_H) + 4);
    const firstCol = Math.max(0, Math.floor(gridEl.scrollLeft / COL_W) - 2);
    const lastCol = Math.min(meta.width - 1, Math.ceil((gridEl.scrollLeft + gridEl.clientWidth) / COL_W) + 2);

    const letters = h('div', { class: 'imp-grid-row imp-grid-letters', style: `top:0` }, [
      h('div', { class: 'imp-cell num' }, ''),
      h('div', { style: `width:${firstCol * COL_W}px;flex:none` }),
      ...Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => h('div', { class: `imp-cell letter${mappedIdx.has(firstCol + i) ? ' mapped' : ''}` }, colLetter(firstCol + i))),
    ]);
    const body = [];
    for (let r = firstRow; r <= lastRow; r++) {
      const line = sheet.rows[r] ?? [];
      const role = r + 1 === headerRow ? ' header' : dataFrom && r + 1 >= dataFrom ? ' data' : '';
      const cells = [];
      for (let c = firstCol; c <= lastCol; c++) {
        const v = line[c] ?? '';
        const covered = meta.covered.has(`${r + 1},${c}`);
        const flag = role === ' header' && cols.has(c) && (!cols.get(c).label || cols.get(c).duplicate) ? ' warn' : '';
        const cell = h('div', {
          class: `imp-cell${covered ? ' merged' : ''}${meta.anchors.has(`${r + 1},${c}`) ? ' anchor' : ''}${mappedIdx.has(c) ? ' mapped' : ''}${flag}`,
          title: v ? `${colLetter(c)}${r + 1}: ${v}${meta.anchors.has(`${r + 1},${c}`) ? `\n${tr('Merged cells {range}', { range: meta.anchors.get(`${r + 1},${c}`) })}` : ''}` : `${colLetter(c)}${r + 1}`,
          'data-r': r + 1,
          'data-c': c,
        }, v);
        cells.push(cell);
      }
      body.push(h('div', { class: `imp-grid-row${role}`, style: `top:${(r + 1) * ROW_H}px` }, [
        h('div', { class: 'imp-cell num' }, String(r + 1)),
        h('div', { style: `width:${firstCol * COL_W}px;flex:none` }),
        ...cells,
      ]));
    }
    spacer.replaceChildren(letters, ...body);
  }

  // Clicking a cell sets the header start or the first data row of the selected source.
  gridEl.addEventListener('click', (e) => {
    const cell = e.target.closest('.imp-cell[data-r]');
    if (!cell) return;
    const s = selectedSource();
    if (!s) return status(tr('Select an Excel source on the canvas first.'));
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    edit((d) => {
      const x = d.sources.find((y) => y.id === s.id);
      if (T.pick === 'header') {
        x.header.expected = null;
        if (x.header.mode === 'fixed') {
          x.header.row = r;
          x.header.startColumn = colLetter(c);
        } else {
          x.header.scanFrom = Math.max(1, r - 10);
          x.header.scanTo = r + 10;
        }
        if (x.sheet.mode === 'name') x.sheet.value = T.sheet;
      } else {
        const hr = T.resolved[x.id]?.headerRow ?? x.header.row;
        if (r > hr) x.dataOffset = r - hr;
      }
    });
  });

  // ------------------------------------------------------------ dock

  const DOCK_TABS = () => [
    ['inspector', tr('Details')],
    ['order', tr('Insertion order')],
    ['problems', T.diag.length ? `${tr('Problems')} (${T.diag.filter((d) => d.level !== 'info').length})` : tr('Problems')],
    ['preview', tr('Preview')],
  ];

  function renderDock() {
    if (!T) return;
    $('#imp-dock-tabs').replaceChildren(...DOCK_TABS().map(([id, label]) => h('button', {
      type: 'button',
      class: `${T.dock === id ? 'active' : ''}${id === 'problems' && hasErrors(T.diag) ? ' has-error' : ''}`,
      onclick: () => {
        T.dock = id;
        renderDock();
      },
    }, label)));
    const body = $('#imp-dock-body');
    const view = { inspector: dockInspector, order: dockOrder, problems: dockProblems, preview: dockPreview }[T.dock];
    body.replaceChildren(...[].concat(view()).filter(Boolean));
  }

  const taskName = (t) => `${t.schema}.${t.table}`;

  function dockInspector() {
    const sel = T.sel;
    if (sel?.type === 'map') {
      const task = taskOf(sel.task);
      const m = task?.mappings.find((x) => x.id === sel.id);
      if (!m) return h('p', { class: 'imp-help' }, '');
      const src = sourceOf(task.sourceId);
      const tb = dbTable(task);
      const col = tb?.columns.find((c) => c.name === m.targetColumn);
      const run = T.wb ? extractRows(template(), T.wb.sheets, { limit: 8 }) : null;
      const samples = run?.tasks.find((x) => x.id === task.id)?.rows.map((r) => r.values[m.targetColumn]).filter((v) => v !== null && v !== undefined) ?? [];
      const bad = col ? samples.map((v) => checkValue(col, v)).find(Boolean) : null;
      const set = (fn) => edit((d) => fn(d.tasks.find((x) => x.id === task.id).mappings.find((y) => y.id === m.id)));
      return [
        h('div', { class: 'imp-detail' }, [
          h('div', { class: 'imp-detail-title' }, [
            h('strong', {}, `${src?.header.mode === 'detect' ? `"${m.label}"` : `${m.letter} ${m.label}`.trim()} → ${taskName(task)}.${m.targetColumn}`),
            h('button', { type: 'button', class: 'danger', icon: 'delete', onclick: () => removeMapping(task.id, m.id) }, tr('Remove mapping')),
          ]),
          h('div', { class: 'imp-form wide' }, [
            h('label', { class: 'imp-field' }, [h('span', {}, tr('Blank cell')), h('select', { onchange: (e) => set((x) => (x.blank = e.target.value)) }, [
              h('option', { value: 'null', selected: m.blank === 'null' }, tr('Insert NULL')),
              h('option', { value: 'emptyString', selected: m.blank === 'emptyString' }, tr('Insert an empty string')),
              h('option', { value: 'error', selected: m.blank === 'error' }, tr('Report an error')),
            ])]),
            h('label', { class: 'imp-field' }, [h('span', {}, tr('Trim spaces')), h('input', { type: 'checkbox', checked: !!m.trim, onchange: (e) => set((x) => (x.trim = e.target.checked)) })]),
            h('div', { class: 'imp-field' }, [h('span', {}, tr('Column type')), h('span', {}, col?.databaseType ?? tr('unknown'))]),
          ]),
          h('p', { class: `small ${bad ? 'warn-text' : 'muted'}` }, bad
            ? tr('Check: {message}', { message: bad })
            : samples.length ? tr('Examples: {values}', { values: samples.slice(0, 5).map((v) => `"${v}"`).join(', ') }) : tr('Open the example workbook to see sample values.')),
          h('p', { class: 'muted small' }, tr('Cells are read as text: numbers keep their written form (a leading zero stays) and dates become ISO text. PostgreSQL converts the text to the column type.')),
        ]),
      ];
    }
    if (sel?.type === 'task') {
      const task = taskOf(sel.id);
      if (!task) return [];
      const tb = dbTable(task);
      const missing = tb ? tb.columns.filter((c) => !c.nullable && !c.defaultValue && !c.identity && !c.generated && !c.serial && !task.mappings.some((m) => m.targetColumn === c.name)) : [];
      return h('div', { class: 'imp-detail' }, [
        h('div', { class: 'imp-detail-title' }, [
          h('strong', {}, `#${T.design.tasks.indexOf(task) + 1} INSERT INTO ${taskName(task)}`),
          h('button', { type: 'button', onclick: () => autoMap(task.id) }, tr('Map by name')),
          h('button', { type: 'button', class: 'danger', icon: 'delete', onclick: () => removeTask(task.id) }, tr('Remove')),
        ]),
        h('p', { class: 'small' }, task.sourceId ? tr('Reads {sheet}. {n} columns mapped.', { sheet: sheetLabel(sourceOf(task.sourceId)), n: task.mappings.length }) : tr('Drag an Excel column onto a column of the table to map it.')),
        missing.length ? h('p', { class: 'small error' }, tr('Required and not mapped: {names}', { names: missing.map((c) => c.name).join(', ') })) : null,
      ]);
    }
    if (sel?.type === 'source') {
      const s = sourceOf(sel.id);
      return h('div', { class: 'imp-detail' }, [
        h('strong', {}, sheetLabel(s)),
        h('p', { class: 'small' }, tr('Drag from the dot of an Excel column to a column of a table. Click a cell of the workbook on the right to move the header or the first data row.')),
      ]);
    }
    return h('div', { class: 'imp-detail' }, [
      h('p', { class: 'small' }, tr('Each task is a plain INSERT of the rows of one worksheet: values are copied as they are, with no lookups, no generated keys and no transformations. Child tables need their parent rows to exist (insert the parent first, or already have them).')),
      h('p', { class: 'small' }, tr('Importing the same workbook twice inserts its rows twice unless the table has unique constraints. The designer never writes to the database; a separate runner applies the exported template.')),
    ]);
  }

  function dockOrder() {
    const tasks = T.design.tasks;
    const sch = schema();
    const list = h('ol', { class: 'imp-order-list' }, tasks.map((t, i) => {
      const li = h('li', { draggable: 'true', 'data-id': t.id, class: T.sel?.id === t.id ? 'selected' : '' }, [
        h('span', { class: 'imp-order' }, String(i + 1)),
        h('span', { class: 'grow' }, taskName(t)),
        h('span', { class: 'muted small' }, t.sourceId ? sheetLabel(sourceOf(t.sourceId)) : tr('no source')),
        h('button', { type: 'button', title: tr('Run earlier'), disabled: i === 0, onclick: () => moveTask(i, i - 1) }, '▲'),
        h('button', { type: 'button', title: tr('Run later'), disabled: i === tasks.length - 1, onclick: () => moveTask(i, i + 1) }, '▼'),
      ]);
      li.addEventListener('click', (e) => !e.target.closest('button') && select({ type: 'task', id: t.id }));
      li.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-pgsql-erd-import-task', String(i)));
      li.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-pgsql-erd-import-task')) return;
        e.preventDefault();
        li.classList.add('drop');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drop');
        const from = Number(e.dataTransfer.getData('application/x-pgsql-erd-import-task'));
        if (Number.isInteger(from)) moveTask(from, i);
      });
      return li;
    }));
    const notes = T.diag.filter((d) => d.code === 'FK_ORDER' || d.code === 'FK_CYCLE');
    return [
      h('div', { class: 'imp-order-bar' }, [
        h('button', { type: 'button', disabled: !sch || tasks.length < 2, title: sch ? tr('Order the tasks so that referenced tables come first') : tr('Connect to the database to read its foreign keys'), onclick: suggest }, tr('Suggest order')),
        h('span', { class: 'muted small' }, tr('Task 1 inserts all its rows, then task 2, and so on. The position on the canvas does not matter.')),
      ]),
      tasks.length ? list : h('p', { class: 'imp-help' }, tr('Add tables to the canvas to order them.')),
      T.order ? h('p', { class: 'small warn-text' }, T.order) : null,
      ...notes.map((d) => h('p', { class: 'small warn-text' }, d.message)),
    ];
  }

  function moveTask(from, to) {
    if (from === to || to < 0 || to >= T.design.tasks.length) return;
    T.order = null;
    edit((d) => d.tasks.splice(to, 0, d.tasks.splice(from, 1)[0]));
  }

  function suggest() {
    const plan = suggestOrder(T.design, schema());
    if (!plan.order) {
      T.order = tr('Foreign keys form a cycle between {tables}; no order satisfies them all, so the order was not changed.', { tables: plan.cycles.map((c) => c.join(', ')).join(' / ') });
      renderDock();
      return;
    }
    T.order = plan.selfReferences.length ? tr('{tables} reference themselves: their rows must be in a valid order inside the worksheet.', { tables: plan.selfReferences.join(', ') }) : null;
    const same = plan.order.every((id, i) => T.design.tasks[i].id === id);
    if (same) status(tr('The order already respects the foreign keys.'));
    else edit((d) => (d.tasks = plan.order.map((id) => d.tasks.find((t) => t.id === id))));
  }

  function dockProblems() {
    const list = T.diag;
    if (!list.length) return h('p', { class: 'imp-help' }, tr('Nothing to report.'));
    return h('ul', { class: 'imp-problems' }, list.map((d) => {
      const li = h('li', { class: d.level }, [h('span', { class: 'imp-level' }, d.level === 'error' ? tr('Error') : d.level === 'warning' ? tr('Warning') : tr('Note')), h('span', {}, d.message)]);
      li.addEventListener('click', () => {
        if (d.taskId && taskOf(d.taskId)) select({ type: 'task', id: d.taskId });
        else if (d.sourceId && sourceOf(d.sourceId)) select({ type: 'source', id: d.sourceId });
      });
      return li;
    }));
  }

  let previewTask = null;
  function dockPreview() {
    if (!T.wb) return h('p', { class: 'imp-help' }, tr('Open an example workbook to preview the rows each task would insert.'));
    const run = extractRows(template(), T.wb.sheets, { limit: 20 });
    const tasks = run.tasks;
    if (!tasks.length) return [h('p', { class: 'imp-help' }, tr('Nothing to preview yet.')), ...run.errors.map((e) => h('p', { class: 'small error' }, e.message))];
    const pick = tasks.find((t) => t.id === (T.sel?.task ?? T.sel?.id)) ?? tasks.find((t) => t.id === previewTask) ?? tasks[0];
    previewTask = pick.id;
    const select1 = h('select', { onchange: (e) => {
      previewTask = e.target.value;
      T.sel = { type: 'task', id: previewTask };
      render();
    } }, tasks.map((t) => h('option', { value: t.id, selected: t.id === pick.id }, `#${t.order} ${t.target.schema}.${t.target.table}`)));
    const errors = run.errors.filter((e) => !e.taskId || e.taskId === pick.id);
    return [
      h('div', { class: 'imp-order-bar' }, [
        select1,
        h('span', { class: 'muted small' }, pick.sheetName ? tr('{rows} from "{sheet}"; first {n} shown. Nothing is written to the database.', { rows: trn(pick.total, '{n} row', '{n} rows'), sheet: pick.sheetName, n: pick.rows.length }) : ''),
      ]),
      ...errors.slice(0, 5).map((e) => h('p', { class: 'small error' }, e.message)),
      pick.rows.length
        ? h('div', { class: 'imp-preview' }, h('table', {}, [
          h('thead', {}, h('tr', {}, [h('th', {}, tr('Row')), ...pick.columns.map((c) => h('th', {}, c))])),
          h('tbody', {}, pick.rows.map((r) => h('tr', {}, [h('td', { class: 'muted' }, String(r.row)), ...pick.columns.map((c) => h('td', { class: r.values[c] === null ? 'null' : '' }, r.values[c] === null ? 'NULL' : r.values[c]))]))),
        ]))
        : null,
    ];
  }

  // ------------------------------------------------------------ toolbar

  $('#imp-name').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (!name) return render();
    edit((d) => (d.name = name));
    T.title = name;
    tabs.rename(tabId, name, T.filePath ?? name);
    save();
  });
  $('#imp-id').addEventListener('change', (e) => edit((d) => (d.templateId = e.target.value.trim())));
  $('#imp-tx').addEventListener('change', (e) => edit((d) => (d.transaction = e.target.value)));
  $('#imp-undo').addEventListener('click', undo);
  $('#imp-redo').addEventListener('click', redo);
  $('#imp-zoom-out').addEventListener('click', () => setZoom(T.zoom - 0.1));
  $('#imp-zoom-in').addEventListener('click', () => setZoom(T.zoom + 0.1));
  $('#imp-zoom').addEventListener('click', () => setZoom(1));
  $('#imp-wb-open').addEventListener('click', chooseWorkbook);
  $('#imp-add-source').addEventListener('click', () => T.sheet && addSource(T.sheet));
  $('#imp-open').addEventListener('click', openTemplate);
  $('#imp-export').addEventListener('click', () => exportTemplate(tabId, false));
  for (const r of page.querySelectorAll('input[name="imp-pick"]')) {
    r.addEventListener('change', () => r.checked && (T.pick = r.value));
  }

  document.addEventListener('keydown', (e) => {
    if (!isShown() || e.target.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && T.sel) {
      e.preventDefault();
      if (T.sel.type === 'map') removeMapping(T.sel.task, T.sel.id);
      else if (T.sel.type === 'task') removeTask(T.sel.id);
      else if (T.sel.type === 'source') removeSource(T.sel.id);
    } else if (e.key === 'Escape' && T.sel) {
      select(null);
    }
  });

  // A workbook dropped on the preview panel.
  const right = $('#imp-right');
  right.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    right.classList.add('drop-target');
  });
  right.addEventListener('dragleave', (e) => !right.contains(e.relatedTarget) && right.classList.remove('drop-target'));
  right.addEventListener('drop', async (e) => {
    right.classList.remove('drop-target');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    await loadWorkbook(file.name, new Uint8Array(await file.arrayBuffer()));
  });

  // Panel sizes.
  function resizer(handle, apply, key, axis) {
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved) apply(saved);
    } catch { /* storage unavailable */ }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => apply(axis === 'y' ? window.innerHeight - ev.clientY - 30 : window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        drawEdges();
        try {
          localStorage.setItem(key, String(Math.round(axis === 'y' ? $('#imp-dock').getBoundingClientRect().height : right.getBoundingClientRect().width)));
        } catch { /* storage unavailable */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  resizer($('#imp-dock-resize'), (v) => ($('#imp-dock').style.height = `${Math.max(90, Math.min(window.innerHeight - 260, v))}px`), SPLIT_KEY, 'y');
  resizer($('#imp-right-resize'), (v) => (right.style.width = `${Math.max(280, Math.min(window.innerWidth - 700, v))}px`), RIGHT_KEY, 'x');
  window.addEventListener('resize', () => isShown() && (drawEdges(), drawGrid()));

  // ------------------------------------------------------------ export and import

  async function exportTemplate(id, saveAs) {
    const rec = records.get(id);
    if (!rec) return false;
    if (id !== tabId) tabs.show(id);
    T.diag = designDiagnostics(T.design, schema(), T.wb?.sheets ?? null);
    renderDock();
    markNodes();
    if (hasErrors(T.diag)) {
      T.dock = 'problems';
      renderDock();
      status(tr('Fix the errors in Problems before exporting.'));
      return false;
    }
    const warnings = T.diag.filter((d) => d.level === 'warning');
    if (warnings.length) {
      const choice = await host.confirm({
        message: trn(warnings.length, 'Export with {n} warning?', 'Export with {n} warnings?'),
        detail: warnings.slice(0, 6).map((d) => `• ${d.message}`).join('\n'),
        buttons: [tr('Export'), tr('Cancel')],
      });
      if (choice !== 0) return false;
    }
    const out = designToTemplate(T.design);
    const problems = validateTemplate(out);
    if (problems.length) {
      status(tr('The template is not valid: {message}', { message: problems[0] }));
      return false;
    }
    const target = await host.saveFile({
      filePath: T.filePath, text: `${JSON.stringify(out, null, 2)}\n`, saveAs: saveAs || !T.filePath, defaultName: T.filePath ?? `${T.design.templateId}.import.json`, kind: 'import',
    });
    if (!target) return false;
    T.filePath = target;
    T.dirty = false;
    tabs.rename(id, T.title, target);
    save();
    status(tr('Exported {file}', { file: target.split(/[\\/]/).pop() }));
    return true;
  }

  async function openTemplate() {
    const res = await host.openImportTemplate();
    if (!res) return;
    try {
      const design = templateToDesign(JSON.parse(res.text));
      newTab({ design, title: design.name, filePath: res.filePath });
      status(tr('Opened {file}', { file: res.filePath.split(/[\\/]/).pop() }));
    } catch (err) {
      host.confirm({ message: tr('Could not open the template'), detail: err.message, buttons: [tr('OK')] });
    }
  }

  // ------------------------------------------------------------ explorer and schema

  const explorerTarget = {
    present: () => new Set(T ? T.design.tasks.map((t) => `${t.schema}.${t.table}`) : []),
    add: (key) => addTask(key),
    title: (key, present) => present
      ? tr('{name} is in the template. Double-click to add another task for it.', { name: key })
      : tr('Drag {name} into the template, or double-click.', { name: key }),
    tag: () => tr('In the template'),
    hint: () => tr('Drag tables onto the canvas: each one becomes an INSERT task.'),
  };
  tabs.onShow((name) => {
    const kind = tabs.kind(name);
    if (kind === 'import') {
      tabId = name;
      T = records.get(name);
      dbTree.attach(page, explorerTarget);
      if (!dbTree.model() && db.connected()) dbTree.load();
      syncColumns();
      T.diag = designDiagnostics(T.design, schema(), T.wb?.sheets ?? null);
      render();
    } else if (kind === 'erd') {
      dbTree.attach($('main.workspace'));
    }
  });
  events.addEventListener('schema', () => {
    if (!isShown()) return;
    T.diag = designDiagnostics(T.design, schema(), T.wb?.sheets ?? null);
    render();
  });
  events.addEventListener('connection', () => isShown() && scheduleDiagnostics());
  events.addEventListener('database-switch', () => isShown() && (scheduleDiagnostics(), render()));

  // ------------------------------------------------------------ tabs

  function newTab({ design = null, title = null, filePath = null, background = false } = {}) {
    const id = `import:${++tabSeq}`;
    const used = new Set([...records.values()].map((r) => r.title));
    let n = 1;
    while (used.has(tr('Import {n}', { n }))) n++;
    const d = design ?? Object.assign(newDesign(), { name: tr('Import {n}', { n }), templateId: `import-${n}` });
    records.set(id, makeRecord(d, title ?? d.name, filePath));
    tabs.add({
      id,
      kind: 'import',
      title: records.get(id).title,
      tooltip: filePath ?? records.get(id).title,
      icon: 'import-spreadsheet',
      element: page,
      shared: true,
      canClose: async () => {
        const r = records.get(id);
        if (!r?.dirty || (!r.design.tasks.length && !r.design.sources.length)) return true;
        const choice = await host.confirm({
          message: tr('Close this import design?'),
          detail: tr('It has not been exported as a template. Your changes will be lost if you close it.'),
          buttons: [tr('Close'), tr('Cancel')],
        });
        return choice === 0;
      },
      onClose: () => {
        if (tabId === id) {
          tabId = null;
          T = null;
          dbTree.attach($('main.workspace'));
        }
        records.delete(id);
        save();
      },
    });
    save();
    if (!background) tabs.show(id);
    return id;
  }

  function restoreTabs() {
    for (const t of loadSaved() ?? []) {
      if (!t?.design || !Array.isArray(t.design.sources) || !Array.isArray(t.design.tasks)) continue;
      const rec = newTab({ design: { ...newDesign(), ...t.design }, title: t.title, filePath: t.filePath, background: true });
      records.get(rec).dirty = false;
    }
  }

  decorateButtons(page);

  return {
    commands: {
      'import-designer': () => tabs.show(tabs.ofKind('import')[0] ?? newTab()),
      'import-new': () => newTab(),
      'import-open': openTemplate,
    },
    saveTab: (id, saveAs) => exportTemplate(id, saveAs),
    restoreTabs,
  };
}
