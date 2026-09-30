import {
  emptyModel, newTable, newColumn, nextAttnum, parsePgerd, stringifyPgerd, uuid, foreignKeysOf,
} from './lib/pgerd.js';
import { generateSQL, formatType } from './lib/sql.js';
import {
  HEADER_H, ROW_H, PAD_X, BADGE_W, tableSize, routeLink, crowFoot, oneMarker, autoLayout,
  contentBounds,
} from './lib/layout.js';
import { DIAGRAM_CSS, LIGHT_VARS, DARK_VARS, FONT, FONT_BOLD } from './lib/svgstyle.js';
import { setupDatabase } from './dbui.js';

const host = window.erdHost;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PG_TYPES = [
  'bigint', 'bigserial', 'bit', 'bit varying', 'boolean', 'box', 'bytea', 'character',
  'character varying', 'cidr', 'circle', 'date', 'double precision', 'inet', 'integer',
  'interval', 'json', 'jsonb', 'line', 'lseg', 'macaddr', 'money', 'numeric', 'path', 'point',
  'polygon', 'real', 'smallint', 'smallserial', 'serial', 'text', 'time without time zone',
  'time with time zone', 'timestamp without time zone', 'timestamp with time zone', 'tsquery',
  'tsvector', 'uuid', 'xml', 'integer[]', 'text[]', 'character varying[]', 'uuid[]',
];

const $ = (sel) => document.querySelector(sel);
const svg = $('#canvas');
const viewport = $('#viewport');
const tablesLayer = $('#tables-layer');
const linksLayer = $('#links-layer');
const panel = $('#panel');

const state = {
  model: emptyModel(),
  filePath: null,
  dirty: false,
  selection: null, // { type: 'table' | 'link', id }
  sizes: new Map(),
  undo: [],
  redo: [],
  showSql: false,
};

// ---------------------------------------------------------------- helpers

const measureCtx = document.createElement('canvas').getContext('2d');
function measure(text, bold = false) {
  measureCtx.font = bold ? FONT_BOLD : FONT;
  return measureCtx.measureText(String(text ?? '')).width;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const tableById = (id) => state.model.tables.find((t) => t.id === id);
const linkById = (id) => state.model.links.find((l) => l.id === id);
const colOf = (table, attnum) => table?.columns.find((c) => c.attnum === attnum);
const fullName = (t) => (t.schema && t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name);
const basename = (p) => p.split(/[\\/]/).pop();

function status(msg) {
  $('#status-msg').textContent = msg ?? '';
  clearTimeout(status.timer);
  if (msg) status.timer = setTimeout(() => ($('#status-msg').textContent = ''), 4000);
}

function updateTitle() {
  const name = state.filePath ? basename(state.filePath) : 'Untitled';
  $('#status-file').textContent = (state.filePath ?? 'Untitled') + (state.dirty ? ' (modified)' : '');
  host?.setState({ dirty: state.dirty, title: `${name}${state.dirty ? ' •' : ''} — pgsql-erd` });
}

function setDirty(dirty) {
  state.dirty = dirty;
  updateTitle();
}

// ---------------------------------------------------------------- undo

const snapshot = () => structuredClone({ tables: state.model.tables, links: state.model.links });

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}

// Apply a change to the model with undo support and re-render.
function commit(fn, { panel: rerenderPanel = true } = {}) {
  pushUndo();
  fn();
  setDirty(true);
  render();
  if (rerenderPanel) renderPanel();
}

function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  const snap = from.pop();
  state.model.tables = snap.tables;
  state.model.links = snap.links;
  if (state.selection?.type === 'table' && !tableById(state.selection.id)) state.selection = null;
  if (state.selection?.type === 'link' && !linkById(state.selection.id)) state.selection = null;
  setDirty(true);
  render();
  renderPanel();
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function applyView() {
  const { offsetX, offsetY, zoom, gridSize } = state.model.view;
  viewport.setAttribute('transform', `translate(${offsetX},${offsetY}) scale(${zoom})`);
  const pattern = $('#grid');
  pattern.setAttribute('width', gridSize);
  pattern.setAttribute('height', gridSize);
  pattern.setAttribute('patternTransform', `translate(${offsetX},${offsetY}) scale(${zoom})`);
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
}

function computeSizes() {
  state.sizes = new Map(state.model.tables.map((t) => [t.id, tableSize(t, measure)]));
}

function fkColumns(table) {
  return new Set(state.model.links.filter((l) => l.localTable === table.id).map((l) => l.localCol));
}

function renderTable(t) {
  const { width, height } = state.sizes.get(t.id);
  const sel = state.selection?.type === 'table' && state.selection.id === t.id;
  const g = el('g', {
    class: `erd-table${sel ? ' selected' : ''}`,
    'data-id': t.id,
    transform: `translate(${t.x},${t.y})`,
  });
  g.append(el('rect', { class: 't-body', width, height, rx: 6 }));
  const header = el('path', {
    class: 't-header',
    d: `M0,6 a6,6 0 0 1 6,-6 h${width - 12} a6,6 0 0 1 6,6 v${HEADER_H - 6} h${-width} z`,
  });
  if (t.color) header.style.fill = t.color;
  g.append(header);

  const title = el('text', { class: 't-title', x: PAD_X, y: 20 });
  if (t.schema && t.schema !== 'public') title.append(el('tspan', { class: 't-schema' }, `${t.schema}.`));
  title.append(el('tspan', {}, t.name));
  g.append(title);
  if (t.note) {
    g.append(el('text', { class: 't-note', x: width - PAD_X, y: 20, 'text-anchor': 'end' }, [
      '✎', el('title', {}, t.note),
    ]));
  }
  if (t.description) g.append(el('title', {}, t.description));

  const fks = fkColumns(t);
  if (!t.columns.length) {
    g.append(el('text', { class: 't-empty', x: PAD_X, y: HEADER_H + 15 }, 'no columns'));
  }
  t.columns.forEach((c, i) => {
    const y = HEADER_H + i * ROW_H;
    const row = el('g', { class: 't-row', 'data-attnum': c.attnum });
    row.append(el('rect', { class: 't-row-bg', x: 1, y, width: width - 2, height: ROW_H }));
    const badge = c.pk ? 'PK' : fks.has(c.attnum) ? 'FK' : '';
    if (badge) {
      row.append(el('text', { class: `t-badge ${badge.toLowerCase()}`, x: PAD_X, y: y + 15 }, badge));
    }
    row.append(el('text', { class: `t-col${c.notNull || c.pk ? ' nn' : ''}`, x: PAD_X + BADGE_W, y: y + 15 }, c.name));
    row.append(el('text', { class: 't-type', x: width - PAD_X, y: y + 15, 'text-anchor': 'end' }, formatType(c)));
    const tip = [`${c.name} ${formatType(c)}`, c.notNull || c.pk ? 'NOT NULL' : 'NULL'];
    if (c.default) tip.push(`DEFAULT ${c.default}`);
    row.append(el('title', {}, tip.join(' ')));
    g.append(row);
  });
  return g;
}

function renderLink(l) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  if (!local || !ref || !colOf(local, l.localCol) || !colOf(ref, l.refCol)) return null;
  const r = routeLink(l, local, ref, state.sizes);
  const sel = state.selection?.type === 'link' && state.selection.id === l.id;
  const related =
    state.selection?.type === 'table' &&
    (state.selection.id === l.localTable || state.selection.id === l.refTable);
  const g = el('g', {
    class: `erd-link${sel ? ' selected' : ''}${related ? ' related' : ''}`,
    'data-id': l.id,
  });
  const localCol = colOf(local, l.localCol);
  const refCol = colOf(ref, l.refCol);
  g.append(el('title', {}, `${fullName(local)}.${localCol.name} → ${fullName(ref)}.${refCol.name}`));
  g.append(el('path', { class: 'l-hit', d: r.path }));
  g.append(el('path', { class: 'l-line', d: r.path }));
  g.append(el('path', { class: 'l-marker', d: l.type === 'onetoone' ? oneMarker(r.local) : crowFoot(r.local) }));
  g.append(el('path', { class: 'l-marker', d: oneMarker(r.ref) }));
  return g;
}

function render() {
  computeSizes();
  applyView();
  tablesLayer.replaceChildren(...state.model.tables.map(renderTable));
  linksLayer.replaceChildren(...state.model.links.map(renderLink).filter(Boolean));
  $('#empty-hint').hidden = state.model.tables.length > 0;
  $('#status-count').textContent =
    `${state.model.tables.length} tables · ${state.model.links.length} relationships`;
  $('[data-cmd="undo"]').disabled = !state.undo.length;
  $('[data-cmd="redo"]').disabled = !state.redo.length;
  $('[data-cmd="delete"]').disabled = !state.selection;
  if (state.showSql) $('#sql-text').textContent = generateSQL(state.model);
}

// ---------------------------------------------------------------- properties panel

function field(label, input) {
  return h('label', { class: 'field' }, [h('span', {}, label), input]);
}

// Text input bound to an object property; commits on change.
function bound(obj, key, { type = 'text', placeholder = '', onCommit, rerender = false } = {}) {
  const input = h('input', { type, placeholder, value: obj[key] ?? '' });
  input.addEventListener('change', () => {
    let v = input.value;
    if (type === 'number') v = v === '' ? null : Number(v);
    commit(() => {
      obj[key] = v;
      onCommit?.(v);
    }, { panel: rerender });
  });
  return input;
}

function renderPanel() {
  const sel = state.selection;
  if (sel?.type === 'table' && tableById(sel.id)) return renderTablePanel(tableById(sel.id));
  if (sel?.type === 'link' && linkById(sel.id)) return renderLinkPanel(linkById(sel.id));
  renderDiagramPanel();
}

function renderDiagramPanel() {
  const m = state.model;
  const tables = [...m.tables].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  panel.replaceChildren(
    h('h3', {}, 'Diagram'),
    h('p', { class: 'muted' },
      `${m.tables.length} tables, ${m.links.length} relationships. Click a table or relationship to edit it. ` +
      'Drag tables to move them, drag the background to pan, and scroll to zoom.'),
    h('h4', {}, 'Tables'),
    tables.length
      ? h('ul', { class: 'list' }, tables.map((t) =>
          h('li', { class: 'clickable', onclick: () => { select({ type: 'table', id: t.id }); centerOn(t); } }, [
            h('span', {}, fullName(t)),
            h('span', { class: 'muted' }, `${t.columns.length} cols`),
          ])))
      : h('p', { class: 'muted' }, 'No tables.'),
  );
}

function renderTablePanel(t) {
  const colsTable = h('table', { class: 'cols' }, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', { title: 'Length / precision' }, 'Len'),
      h('th', { title: 'Scale' }, 'Sc'), h('th', { title: 'Not null' }, 'NN'),
      h('th', { title: 'Primary key' }, 'PK'), h('th', {}, ''),
    ])),
    h('tbody', {}, t.columns.map((c, i) => columnRow(t, c, i))),
  ]);

  const outgoing = foreignKeysOf(state.model, t);
  const incoming = state.model.links.filter((l) => l.refTable === t.id && l.localTable !== t.id);

  const colorInput = h('input', { type: 'color', value: t.color ?? '#2f6fb3' });
  colorInput.addEventListener('change', () => commit(() => (t.color = colorInput.value), { panel: false }));

  const descr = h('textarea', { rows: 2 }, []);
  descr.value = t.description ?? '';
  descr.addEventListener('change', () => commit(() => (t.description = descr.value), { panel: false }));
  const note = h('textarea', { rows: 2 });
  note.value = t.note ?? '';
  note.addEventListener('change', () => commit(() => (t.note = note.value), { panel: false }));

  panel.replaceChildren(
    h('h3', {}, 'Table'),
    h('div', { class: 'row' }, [
      field('Schema', bound(t, 'schema')),
      field('Name', Object.assign(bound(t, 'name'), { id: 'table-name' })),
    ]),
    h('div', { class: 'row' }, [
      field('Header color', colorInput),
      h('button', { onclick: () => commit(() => (t.color = null)) }, 'Default color'),
    ]),
    field('Comment', descr),
    field('Note', note),
    h('h4', {}, 'Columns'),
    colsTable,
    h('div', { class: 'actions' }, [
      h('button', { onclick: () => addColumn(t) }, '+ Column'),
    ]),
    h('h4', {}, 'Foreign keys'),
    outgoing.length
      ? h('ul', { class: 'list' }, outgoing.flatMap((links) => links.map((l) => linkItem(l, 'out'))))
      : h('p', { class: 'muted' }, 'None.'),
    h('div', { class: 'actions' }, [
      h('button', { onclick: () => openLinkDialog({ localTable: t.id }) }, '+ Foreign key'),
    ]),
    h('h4', {}, 'Referenced by'),
    incoming.length
      ? h('ul', { class: 'list' }, incoming.map((l) => linkItem(l, 'in')))
      : h('p', { class: 'muted' }, 'None.'),
    h('div', { class: 'actions' }, [
      h('button', { class: 'danger', onclick: deleteSelection }, 'Delete table'),
    ]),
  );
}

function columnRow(t, c, i) {
  const check = (key) => {
    const cb = h('input', { type: 'checkbox', checked: !!c[key] });
    cb.addEventListener('change', () => commit(() => {
      c[key] = cb.checked;
      if (key === 'pk' && cb.checked) c.notNull = true;
    }));
    return cb;
  };
  const name = bound(c, 'name');
  name.className = 'c-name';
  const type = bound(c, 'type', { rerender: false });
  type.setAttribute('list', 'pg-types');
  const len = bound(c, 'length', { type: 'number' });
  len.className = 'c-len';
  const prec = bound(c, 'precision', { type: 'number' });
  prec.className = 'c-len';
  const def = bound(c, 'default', { placeholder: 'default' });

  const move = (d) => commit(() => {
    const j = i + d;
    [t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
  });

  return [
    h('tr', {}, [
      h('td', {}, name),
      h('td', {}, type),
      h('td', {}, len),
      h('td', {}, prec),
      h('td', { class: 'chk' }, check('notNull')),
      h('td', { class: 'chk' }, check('pk')),
      h('td', { class: 'btns' }, [
        h('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
        h('button', { class: 'icon', title: 'Move down', disabled: i === t.columns.length - 1, onclick: () => move(1) }, '↓'),
        h('button', { class: 'icon danger', title: 'Delete column', onclick: () => deleteColumn(t, c) }, '×'),
      ]),
    ]),
    h('tr', {}, [h('td', { colspan: 7 }, def)]),
  ].reduce((frag, tr) => (frag.append(tr), frag), document.createDocumentFragment());
}

function linkItem(l, dir) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const text = dir === 'out'
    ? `${colOf(local, l.localCol)?.name} → ${fullName(ref)}.${colOf(ref, l.refCol)?.name}`
    : `${fullName(local)}.${colOf(local, l.localCol)?.name} → ${colOf(ref, l.refCol)?.name}`;
  return h('li', { class: 'clickable', onclick: () => select({ type: 'link', id: l.id }) }, [
    h('code', {}, text),
    h('button', {
      class: 'icon danger',
      title: 'Delete relationship',
      onclick: (e) => { e.stopPropagation(); commit(() => removeLinks((x) => x.id === l.id)); },
    }, '×'),
  ]);
}

function renderLinkPanel(l) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const typeSel = h('select', {}, [
    h('option', { value: 'onetomany' }, 'One to many'),
    h('option', { value: 'onetoone' }, 'One to one'),
  ]);
  typeSel.value = l.type === 'onetoone' ? 'onetoone' : 'onetomany';
  typeSel.addEventListener('change', () => commit(() => {
    for (const x of state.model.links) if (x.group === l.group) x.type = typeSel.value;
  }, { panel: false }));

  const fkName = h('input', { value: l.fkName ?? '', placeholder: '(unnamed)' });
  fkName.addEventListener('change', () => commit(() => {
    for (const x of state.model.links) if (x.group === l.group) x.fkName = fkName.value;
  }, { panel: false }));

  panel.replaceChildren(
    h('h3', {}, 'Relationship'),
    h('p', {}, [
      h('code', {}, `${fullName(local)}.${colOf(local, l.localCol)?.name}`),
      ' references ',
      h('code', {}, `${fullName(ref)}.${colOf(ref, l.refCol)?.name}`),
    ]),
    field('Constraint name', fkName),
    field('Cardinality', typeSel),
    h('div', { class: 'actions' }, [
      h('button', { onclick: () => select({ type: 'table', id: local.id }) }, `Go to ${local.name}`),
      h('button', { onclick: () => select({ type: 'table', id: ref.id }) }, `Go to ${ref.name}`),
      h('button', { class: 'danger', onclick: deleteSelection }, 'Delete relationship'),
    ]),
  );
}

// ---------------------------------------------------------------- model edits

function select(sel) {
  state.selection = sel;
  render();
  renderPanel();
}

function removeLinks(pred) {
  state.model.links = state.model.links.filter((l) => !pred(l));
}

function addColumn(t) {
  commit(() => {
    const attnum = nextAttnum(t);
    t.columns.push(newColumn({ name: `column_${t.columns.length + 1}`, attnum }));
  });
  const inputs = panel.querySelectorAll('.cols input.c-name');
  inputs[inputs.length - 1]?.select();
}

function deleteColumn(t, c) {
  commit(() => {
    t.columns = t.columns.filter((x) => x !== c);
    removeLinks(
      (l) => (l.localTable === t.id && l.localCol === c.attnum) || (l.refTable === t.id && l.refCol === c.attnum)
    );
  });
}

function viewCenter() {
  const r = svg.getBoundingClientRect();
  const { offsetX, offsetY, zoom } = state.model.view;
  return { x: (r.width / 2 - offsetX) / zoom, y: (r.height / 2 - offsetY) / zoom };
}

function snap(v) {
  const g = state.model.view.gridSize || 15;
  return Math.round(v / g) * g;
}

function addTable() {
  const c = viewCenter();
  const existing = new Set(state.model.tables.map((t) => t.name));
  let n = 1;
  while (existing.has(`table_${n}`)) n++;
  const t = newTable({
    name: `table_${n}`,
    x: snap(c.x - 100),
    y: snap(c.y - 50),
    columns: [newColumn({ name: 'id', type: 'bigserial', pk: true, notNull: true, attnum: 0 })],
  });
  commit(() => state.model.tables.push(t), { panel: false });
  select({ type: 'table', id: t.id });
  $('#table-name')?.select();
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel) return;
  if (sel.type === 'table') {
    commit(() => {
      state.model.tables = state.model.tables.filter((t) => t.id !== sel.id);
      removeLinks((l) => l.localTable === sel.id || l.refTable === sel.id);
      state.selection = null;
    });
  } else {
    const l = linkById(sel.id);
    commit(() => {
      removeLinks((x) => x.id === l.id);
      state.selection = null;
    });
  }
}

// ---------------------------------------------------------------- relationship dialog

const linkDialog = $('#link-dialog');
const linkForm = $('#link-form');

function fillSelect(sel, options, value) {
  sel.replaceChildren(...options.map(([v, label]) => h('option', { value: v }, label)));
  if (value !== undefined && options.some(([v]) => v === value)) sel.value = value;
}

function refreshLinkDialogColumns() {
  const f = linkForm.elements;
  const local = tableById(f.localTable.value);
  const ref = tableById(f.refTable.value);
  const refCols = ref?.columns ?? [];
  const pkFirst = [...refCols].sort((a, b) => Number(b.pk) - Number(a.pk));
  fillSelect(f.refCol, pkFirst.map((c) => [String(c.attnum), `${c.name} (${formatType(c)})`]), f.refCol.value);
  const refCol = colOf(ref, Number(f.refCol.value));
  const suggested = ref && refCol ? `${ref.name}_${refCol.name}` : '';
  const localOpts = (local?.columns ?? []).map((c) => [String(c.attnum), `${c.name} (${formatType(c)})`]);
  localOpts.unshift(['new', suggested ? `+ new column "${suggested}"` : '+ new column']);
  const match = local?.columns.find((c) => c.name === suggested);
  fillSelect(f.localCol, localOpts, match ? String(match.attnum) : f.localCol.value || 'new');
}

function openLinkDialog({ localTable } = {}) {
  if (!state.model.tables.length) return status('Add a table first.');
  const f = linkForm.elements;
  const opts = [...state.model.tables]
    .sort((a, b) => fullName(a).localeCompare(fullName(b)))
    .map((t) => [t.id, fullName(t)]);
  const selTable = state.selection?.type === 'table' ? state.selection.id : undefined;
  fillSelect(f.localTable, opts, localTable ?? selTable);
  const other = opts.find(([id]) => id !== f.localTable.value)?.[0];
  fillSelect(f.refTable, opts, other ?? f.localTable.value);
  f.localCol.value = '';
  f.refCol.value = '';
  f.fkName.value = '';
  f.type.value = 'onetomany';
  refreshLinkDialogColumns();
  linkDialog.returnValue = '';
  linkDialog.showModal();
}

['localTable', 'refTable', 'refCol'].forEach((name) =>
  linkForm.elements[name].addEventListener('change', refreshLinkDialogColumns)
);

linkDialog.addEventListener('close', () => {
  if (linkDialog.returnValue !== 'ok') return;
  const f = linkForm.elements;
  const local = tableById(f.localTable.value);
  const ref = tableById(f.refTable.value);
  const refCol = colOf(ref, Number(f.refCol.value));
  if (!local || !ref || !refCol) return;
  commit(() => {
    let localCol;
    if (f.localCol.value === 'new') {
      const baseType = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }[refCol.type] ?? refCol.type;
      localCol = newColumn({
        name: `${ref.name}_${refCol.name}`,
        type: baseType,
        length: refCol.length,
        precision: refCol.precision,
        attnum: nextAttnum(local),
      });
      local.columns.push(localCol);
    } else {
      localCol = colOf(local, Number(f.localCol.value));
    }
    const l = {
      id: uuid(),
      type: f.type.value,
      localTable: local.id,
      localCol: localCol.attnum,
      refTable: ref.id,
      refCol: refCol.attnum,
      group: uuid(),
      fkName: f.fkName.value.trim(),
      rawFk: null,
      raw: null,
    };
    state.model.links.push(l);
    state.selection = { type: 'link', id: l.id };
  });
});

// ---------------------------------------------------------------- view

function setZoom(zoom, cx, cy) {
  const v = state.model.view;
  const r = svg.getBoundingClientRect();
  cx ??= r.width / 2;
  cy ??= r.height / 2;
  const z = Math.min(3, Math.max(0.1, zoom));
  v.offsetX = cx - ((cx - v.offsetX) * z) / v.zoom;
  v.offsetY = cy - ((cy - v.offsetY) * z) / v.zoom;
  v.zoom = z;
  applyView();
}

function fit() {
  computeSizes();
  if (!state.model.tables.length) return;
  const b = contentBounds(state.model, state.sizes);
  const r = svg.getBoundingClientRect();
  const z = Math.min(1.5, Math.max(0.1, Math.min(r.width / b.width, r.height / b.height)));
  const v = state.model.view;
  v.zoom = z;
  v.offsetX = (r.width - b.width * z) / 2 - b.x * z;
  v.offsetY = (r.height - b.height * z) / 2 - b.y * z;
  applyView();
}

function centerOn(t) {
  const s = state.sizes.get(t.id);
  const r = svg.getBoundingClientRect();
  const v = state.model.view;
  v.offsetX = r.width / 2 - (t.x + s.width / 2) * v.zoom;
  v.offsetY = r.height / 2 - (t.y + s.height / 2) * v.zoom;
  applyView();
}

// ---------------------------------------------------------------- pointer interaction

let drag = null;

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  const tableEl = e.target.closest('.erd-table');
  const linkEl = e.target.closest('.erd-link');
  svg.setPointerCapture(e.pointerId);
  if (tableEl && e.button === 0) {
    const t = tableById(tableEl.dataset.id);
    if (state.selection?.id !== t.id) select({ type: 'table', id: t.id });
    // Bring to front.
    state.model.tables = [...state.model.tables.filter((x) => x !== t), t];
    drag = { kind: 'table', t, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
  } else if (linkEl && e.button === 0) {
    select({ type: 'link', id: linkEl.dataset.id });
  } else {
    if (state.selection && e.button === 0) select(null);
    const v = state.model.view;
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: v.offsetX, oy: v.offsetY };
    svg.classList.add('panning');
  }
});

svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (drag.kind === 'pan') {
    state.model.view.offsetX = drag.ox + dx;
    state.model.view.offsetY = drag.oy + dy;
    applyView();
    return;
  }
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  if (!drag.moved) {
    pushUndo();
    drag.moved = true;
  }
  const z = state.model.view.zoom;
  const nx = drag.ox + dx / z;
  const ny = drag.oy + dy / z;
  drag.t.x = e.altKey ? nx : snap(nx);
  drag.t.y = e.altKey ? ny : snap(ny);
  scheduleRender();
});

function endDrag() {
  if (drag?.kind === 'table' && drag.moved) setDirty(true);
  if (drag?.kind === 'pan') svg.classList.remove('panning');
  drag = null;
  render();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

// With pointer capture the dblclick target is the svg itself, so use the selection.
svg.addEventListener('dblclick', () => {
  if (state.selection?.type === 'table') {
    $('#table-name')?.focus();
    $('#table-name')?.select();
  }
});

svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = svg.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setZoom(state.model.view.zoom * factor, e.clientX - r.left, e.clientY - r.top);
  } else {
    state.model.view.offsetX -= e.deltaY || e.deltaX;
    applyView();
  }
}, { passive: false });

window.addEventListener('resize', applyView);

// ---------------------------------------------------------------- files

async function confirmDiscard() {
  if (!state.dirty) return true;
  const choice = await host.confirm({
    message: 'Do you want to save the changes to this diagram?',
    detail: "Your changes will be lost if you don't save them.",
    buttons: ['Save', "Don't Save", 'Cancel'],
  });
  if (choice === 2) return false;
  if (choice === 0) return save();
  return true;
}

function loadModel(model, filePath) {
  state.model = model;
  state.filePath = filePath;
  state.selection = null;
  state.undo = [];
  state.redo = [];
  setDirty(false);
  render();
  renderPanel();
  // Files saved before any pan/zoom have a default view; fit those to the window.
  const v = model.view;
  if (model.tables.length && v.offsetX === 0 && v.offsetY === 0 && v.zoom === 1) fit();
}

function openText(text, filePath) {
  try {
    const model = parsePgerd(text);
    loadModel(model, filePath);
    status(`Opened ${model.tables.length} tables from ${filePath ? basename(filePath) : 'file'}`);
  } catch (err) {
    host.confirm({ message: 'Could not open file', detail: err.message, buttons: ['OK'] });
  }
}

async function save(saveAs = false) {
  document.activeElement?.blur?.(); // flush a pending input 'change'
  const defaultName = state.filePath ?? 'diagram.pgerd';
  const target = await host.saveFile({
    filePath: state.filePath,
    text: stringifyPgerd(state.model),
    saveAs,
    defaultName,
    kind: 'pgerd',
  });
  if (!target) return false;
  state.filePath = target;
  setDirty(false);
  status(`Saved ${basename(target)}`);
  return true;
}

const exportBase = () => (state.filePath ? basename(state.filePath).replace(/\.pgerd$/i, '') : 'diagram');

async function exportSQL() {
  const target = await host.saveFile({
    text: generateSQL(state.model),
    saveAs: true,
    defaultName: `${exportBase()}.sql`,
    kind: 'sql',
  });
  if (target) status(`Exported ${basename(target)}`);
}

function buildExportSVG() {
  computeSizes();
  const b = contentBounds(state.model, state.sizes);
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const clone = viewport.cloneNode(true);
  clone.removeAttribute('transform');
  clone.querySelectorAll('.selected, .related').forEach((n) => n.classList.remove('selected', 'related'));
  clone.querySelectorAll('title').forEach((n) => n.remove());
  const bg = dark ? '#1b1e24' : '#ffffff';
  const out =
    `<svg xmlns="${SVG_NS}" width="${Math.ceil(b.width)}" height="${Math.ceil(b.height)}" ` +
    `viewBox="${b.x} ${b.y} ${b.width} ${b.height}">` +
    `<style>svg{${dark ? DARK_VARS : LIGHT_VARS}}${DIAGRAM_CSS}</style>` +
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${bg}"/>` +
    new XMLSerializer().serializeToString(clone) +
    '</svg>';
  return { text: out, width: b.width, height: b.height };
}

async function exportSVG() {
  if (!state.model.tables.length) return status('Nothing to export.');
  const { text } = buildExportSVG();
  const target = await host.saveFile({ text, saveAs: true, defaultName: `${exportBase()}.svg`, kind: 'svg' });
  if (target) status(`Exported ${basename(target)}`);
}

async function exportPNG() {
  if (!state.model.tables.length) return status('Nothing to export.');
  const { text, width, height } = buildExportSVG();
  const scale = Math.min(2, 16000 / Math.max(width, height));
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const data = new Uint8Array(await blob.arrayBuffer());
  const target = await host.saveBinary({ defaultName: `${exportBase()}.png`, data, name: 'PNG Image', extensions: ['png'] });
  if (target) status(`Exported ${basename(target)}`);
}

// ---------------------------------------------------------------- commands

const commands = {
  async new() {
    if (!(await confirmDiscard())) return;
    loadModel(emptyModel(), null);
  },
  async open() {
    await host.openDialog();
  },
  save: () => save(false),
  'save-as': () => save(true),
  async 'save-and-close'() {
    if (await save(false)) host.closeWindow();
  },
  'export-sql': exportSQL,
  'export-svg': exportSVG,
  'export-png': exportPNG,
  'add-table': addTable,
  'add-link': () => openLinkDialog(),
  delete: deleteSelection,
  undo: () => restore(state.undo, state.redo),
  redo: () => restore(state.redo, state.undo),
  'zoom-in': () => setZoom(state.model.view.zoom * 1.2),
  'zoom-out': () => setZoom(state.model.view.zoom / 1.2),
  fit,
  'auto-layout'() {
    if (!state.model.tables.length) return;
    commit(() => {
      computeSizes();
      autoLayout(state.model, state.sizes);
    }, { panel: false });
    fit();
  },
  'toggle-sql'() {
    state.showSql = !state.showSql;
    $('#sql-panel').hidden = !state.showSql;
    render();
  },
};

Object.assign(
  commands,
  setupDatabase({ host, state, h, commit, computeSizes, fit, status })
);

function runCommand(name) {
  const fn = commands[name];
  if (fn) Promise.resolve(fn()).catch((err) => status(`Error: ${err.message}`));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) runCommand(btn.dataset.cmd);
});

$('#sql-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#sql-text').textContent);
  status('SQL copied to clipboard');
});

const isEditing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

document.addEventListener('keydown', (e) => {
  if (isEditing(e) || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === 'Escape') {
    select(null);
  } else if (mod && e.key.toLowerCase() === 'z') {
    // Handled here too so undo works even when menus are hidden.
    e.preventDefault();
    runCommand(e.shiftKey ? 'redo' : 'undo');
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    runCommand('redo');
  } else if (state.selection?.type === 'table' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const t = tableById(state.selection.id);
    const step = e.shiftKey ? 1 : state.model.view.gridSize || 15;
    commit(() => {
      if (e.key === 'ArrowLeft') t.x -= step;
      if (e.key === 'ArrowRight') t.x += step;
      if (e.key === 'ArrowUp') t.y -= step;
      if (e.key === 'ArrowDown') t.y += step;
    }, { panel: false });
  }
});

// Drag and drop .pgerd files onto the window.
const wrap = $('.canvas-wrap');
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  wrap.classList.add('drop-target');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) wrap.classList.remove('drop-target');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  wrap.classList.remove('drop-target');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!(await confirmDiscard())) return;
  openText(await file.text(), host.pathForFile(file) || null);
});

// ---------------------------------------------------------------- startup

(function init() {
  const style = document.createElement('style');
  style.textContent =
    `:root{${LIGHT_VARS}}@media (prefers-color-scheme: dark){:root{${DARK_VARS}}}${DIAGRAM_CSS}`;
  document.head.append(style);
  $('#pg-types').replaceChildren(...PG_TYPES.map((t) => h('option', { value: t })));

  host.onFileOpened(async ({ filePath, text }) => {
    if (!(await confirmDiscard())) return;
    openText(text, filePath);
  });
  host.onMenu(runCommand);
  window.erdIsPristine = () => !state.dirty && !state.filePath && !state.model.tables.length;

  updateTitle();
  render();
  renderPanel();
})();
