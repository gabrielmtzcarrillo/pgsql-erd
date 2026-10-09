import {
  emptyModel, newTable, newColumn, nextAttnum, parsePgerd, stringifyPgerd, uuid, foreignKeysOf,
  cleanPalette,
} from './lib/pgerd.js';
import { generateSQL, formatType, uniqueConstraints } from './lib/sql.js';
import { fkTypesCompatible } from './lib/diff.js';
import {
  HEADER_H, ROW_H, PAD_X, BADGE_W, tableSize, routeLink, crowFoot, oneMarker, autoLayout,
  contentBounds,
} from './lib/layout.js';
import { DIAGRAM_CSS, THEME_DIAGRAM, FONT, FONT_BOLD } from './lib/svgstyle.js';
import { initTheme, diagramTheme } from './theme.js';
import { setupDatabase } from './dbui.js';
import { setupDbTree } from './dbtree.js';
import { setupWorkbench } from './workbench.js';
import { setupAssistant } from './assistant.js';
import { setupTabs } from './tabs.js';
import { setupDataBrowser } from './databrowser.js';
import { setupQuery } from './query.js';
import { setupQueryBuilder } from './querybuilder.js';
import { setupGraph } from './graph.js';
import { setupErdScripts } from './erdscripts.js';
import { tableKey } from './lib/catalog.js';
import { setupSpreadsheetImport, SPREADSHEET_EXT } from './xlui.js';
import { highlightSQL } from './lib/highlight.js';
import { vectorKind, vectorIndexSQL } from '../shared/pgvector.js';
import { ICONS, decorateButton, decorateButtons, iconElement } from './icons.js';
import { tr, trn, getLocale, translateDom } from '../shared/i18n.js';

const host = window.erdHost;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PG_TYPES = [
  'bigint', 'bigserial', 'bit', 'bit varying', 'boolean', 'box', 'bytea', 'character',
  'character varying', 'cidr', 'circle', 'date', 'double precision', 'inet', 'integer',
  'interval', 'json', 'jsonb', 'line', 'lseg', 'macaddr', 'money', 'numeric', 'path', 'point',
  'polygon', 'real', 'smallint', 'smallserial', 'serial', 'text', 'time without time zone',
  'time with time zone', 'timestamp without time zone', 'timestamp with time zone', 'tsquery',
  'tsvector', 'uuid', 'xml', 'integer[]', 'text[]', 'character varying[]', 'uuid[]',
  // pgvector; the length is the number of dimensions.
  'vector', 'halfvec', 'sparsevec',
];

const $ = (sel) => document.querySelector(sel);
const svg = $('#canvas');
const viewport = $('#viewport');
const tablesLayer = $('#tables-layer');
const linksLayer = $('#links-layer');
const scriptLinksLayer = $('#script-links-layer');
const scriptsLayer = $('#scripts-layer');
let erdScripts = null; // scripts drawn in the diagram, set up after the workbench
const panel = $('#panel');

document.documentElement.lang = getLocale();
translateDom(document.body);
decorateButtons(document.body);

// Notifies the workbench and assistant: 'model' (diagram edited), 'file'
// (diagram opened or saved under a new path), 'connection', 'schema',
// 'database-switch' (connecting to another database; the user agreed to
// close what belongs to the old one).
const events = new EventTarget();
const emit = (name) => events.dispatchEvent(new Event(name));

const state = {
  model: emptyModel(),
  filePath: null,
  dirty: false,
  selection: null, // { type: 'table' | 'link' | 'script', id } or { type: 'tables', ids }
  sizes: new Map(),
  undo: [],
  redo: [],
  showSql: false,
  showTables: false, // table list in the sidebar when nothing is selected
  tableFilter: '',
  expandedCol: null, // attnum of the column open in the sidebar editor
  showGrid: loadPref('pgsql-erd.show-grid', true),
  snap: loadPref('pgsql-erd.snap', true),
};

// ---------------------------------------------------------------- helpers

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}

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
    if (k === 'icon') continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  if (attrs.icon) decorateButton(node, attrs.icon);
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
  const name = state.filePath ? basename(state.filePath) : untitledNames.get(diagramId) ?? tr('Untitled');
  $('#status-file').textContent = (state.filePath ?? name) + (state.dirty ? ` ${tr('(modified)')}` : '');
  if (diagramId) tabs.rename(diagramId, `${name}${state.dirty ? ' •' : ''}`, state.filePath ?? name);
  host?.setState({ dirty: anyDiagramDirty(), title: `${name}${state.dirty ? ' •' : ''} — pgsql-erd` });
}

function setDirty(dirty) {
  state.dirty = dirty;
  updateTitle();
}

// ---------------------------------------------------------------- diagram tabs

// Each diagram tab has a document of its own. The one shown lives in `state`;
// the others wait here with these fields.
const DOC_FIELDS = ['model', 'filePath', 'dirty', 'selection', 'undo', 'redo', 'showTables', 'tableFilter', 'expandedCol'];
const diagrams = new Map(); // tab id -> document (out of date for the one in `state`)
const untitledNames = new Map(); // tab id -> "Diagram 2", shown until it is saved
let diagramId = null; // the diagram in `state`
let diagramSeq = 0;

const freshDoc = () => ({ model: emptyModel(), filePath: null, dirty: false, selection: null, undo: [], redo: [], showTables: false, tableFilter: '', expandedCol: null });
const docOf = (id) => (id === diagramId ? state : diagrams.get(id));
const anyDiagramDirty = () => [...diagrams.keys()].some((id) => docOf(id)?.dirty);
const isPristine = () => !state.dirty && !state.filePath && !state.model.tables.length;

// Put a diagram tab's document in `state`; the rest of the page follows.
function useDiagram(id) {
  if (id === diagramId || !diagrams.has(id)) return;
  if (diagramId && diagrams.has(diagramId)) diagrams.set(diagramId, Object.fromEntries(DOC_FIELDS.map((k) => [k, state[k]])));
  diagramId = id;
  Object.assign(state, diagrams.get(id));
  emit('model');
  emit('file');
  updateTitle();
  render();
  renderPanel();
}

// A new, empty diagram in a tab of its own, shown.
function newDiagram() {
  const id = `erd:${++diagramSeq}`;
  diagrams.set(id, freshDoc());
  let n = 1;
  while ([...untitledNames.values()].includes(tr('Diagram {n}', { n }))) n++;
  untitledNames.set(id, tr('Diagram {n}', { n }));
  tabs.add({
    id,
    kind: 'erd',
    title: untitledNames.get(id),
    icon: 'toggle-tables',
    element: $('main.workspace'),
    shared: true,
    onClose: () => diagramClosed(id),
    canClose: async () => {
      tabs.show(id);
      return confirmDiscard();
    },
  });
  updateClosable();
  tabs.show(id);
  return id;
}

function diagramClosed(id) {
  diagrams.delete(id);
  untitledNames.delete(id);
  if (diagramId === id) {
    diagramId = null;
    useDiagram(tabs.ofKind('erd').at(-1));
  }
  updateClosable();
}

// The last diagram tab stays open.
function updateClosable() {
  const ids = tabs.ofKind('erd');
  for (const id of ids) tabs.setClosable(id, ids.length > 1);
}

const showDiagram = () => tabs.show(diagramId);

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
  emit('model');
  render();
  if (rerenderPanel) renderPanel();
}

function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  const snap = from.pop();
  state.model.tables = snap.tables;
  state.model.links = snap.links;
  emit('model');
  if (state.selection?.type === 'table' && !tableById(state.selection.id)) state.selection = null;
  if (state.selection?.type === 'link' && !linkById(state.selection.id)) state.selection = null;
  if (state.selection?.type === 'tables') state.selection = tablesSelection(state.selection.ids.filter(tableById));
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
  renderGrid(offsetX, offsetY, zoom, gridSize || 15);
  $('#zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  $('#zoom-slider').value = zoomToSlider(zoom);
}

// The grid is drawn in screen space so lines stay 1px at every zoom level.
// Minor lines mark every grid cell and major lines every fifth; when zoomed
// out far enough that cells get cramped, both step up by a factor of 5.
function renderGrid(offsetX, offsetY, zoom, gridSize) {
  $('#grid-bg').classList.toggle('hidden', !state.showGrid);
  $('[data-cmd="toggle-grid"]').classList.toggle('active', state.showGrid);
  $('[data-cmd="toggle-snap"]').classList.toggle('active', state.snap);
  syncGridSizeSelect(gridSize);
  if (!state.showGrid) return;
  let minor = gridSize * zoom;
  while (minor < 8) minor *= 5;
  const major = minor * 5;
  const pattern = $('#grid');
  pattern.setAttribute('width', major);
  pattern.setAttribute('height', major);
  pattern.setAttribute('patternTransform', `translate(${offsetX},${offsetY})`);
  let d = '';
  for (let i = 1; i < 5; i++) {
    const p = i * minor;
    d += `M${p} 0V${major}M0 ${p}H${major}`;
  }
  $('#grid-minor').setAttribute('d', d);
  $('#grid-major').setAttribute('d', `M0 0V${major}M0 0H${major}`);
}

function syncGridSizeSelect(gridSize) {
  const select = $('#grid-size');
  const value = String(gridSize);
  if (select.value === value) return;
  if (![...select.options].some((o) => o.value === value)) {
    const opts = [...select.options, h('option', { value }, value)];
    opts.sort((a, b) => Number(a.value) - Number(b.value));
    select.replaceChildren(...opts);
  }
  select.value = value;
}

function computeSizes() {
  state.sizes = new Map(state.model.tables.map((t) => [t.id, tableSize(t, measure)]));
}

function fkColumns(table) {
  return new Set(state.model.links.filter((l) => l.localTable === table.id).map((l) => l.localCol));
}

function renderTable(t) {
  const { width, height } = state.sizes.get(t.id);
  const sel = selectedTables().includes(t.id);
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
  // Drag from this handle onto another table to add a relationship.
  g.append(el('circle', { class: 't-link-handle', cx: width, cy: HEADER_H / 2, r: 8 }, [
    el('title', {}, tr('Drag to another table to add a relationship')),
  ]));

  const fks = fkColumns(t);
  if (!t.columns.length) {
    g.append(el('text', { class: 't-empty', x: PAD_X, y: HEADER_H + 15 }, tr('no columns')));
  }
  t.columns.forEach((c, i) => {
    const y = HEADER_H + i * ROW_H;
    const focused = sel && state.expandedCol === c.attnum;
    const row = el('g', { class: `t-row${focused ? ' focused' : ''}`, 'data-attnum': c.attnum });
    row.append(el('rect', { class: 't-row-bg', x: 1, y, width: width - 2, height: ROW_H }));
    const keys = [c.pk && 'pk', fks.has(c.attnum) && 'fk'].filter(Boolean);
    keys.forEach((k, j) => row.append(keyIcon(k, PAD_X + j * (KEY_ICON + 2), y + (ROW_H - KEY_ICON) / 2)));
    row.append(el('text', { class: `t-col${c.notNull || c.pk ? ' nn' : ''}`, x: PAD_X + BADGE_W, y: y + 15 }, c.name));
    row.append(el('text', { class: 't-type', x: width - PAD_X, y: y + 15, 'text-anchor': 'end' }, formatType(c)));
    const tip = [`${c.name} ${formatType(c)}`, c.notNull || c.pk ? 'NOT NULL' : 'NULL'];
    if (c.pk) tip.push('PRIMARY KEY');
    if (fks.has(c.attnum)) tip.push('FOREIGN KEY');
    if (c.default) tip.push(`DEFAULT ${c.default}`);
    row.append(el('title', {}, tip.join(' ')));
    // Drag from a column's handle (the foreign key) onto another table's
    // column (the referenced one) to add a relationship between them.
    for (const cx of [0, width]) {
      row.append(el('circle', { class: 't-col-handle', cx, cy: y + ROW_H / 2, r: 6 }, [
        el('title', {}, tr('Drag to the referenced column to add a foreign key')),
      ]));
    }
    g.append(row);
  });
  return g;
}

// Key icon for a column row: 'pk' (key) or 'fk' (link).
const KEY_ICON = 11;
function keyIcon(kind, x, y) {
  const icon = el('svg', { class: `t-key ${kind}`, x, y, width: KEY_ICON, height: KEY_ICON, viewBox: '0 0 24 24' });
  icon.innerHTML = ICONS[kind];
  return icon;
}

function renderLink(l) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  if (!local || !ref || !colOf(local, l.localCol) || !colOf(ref, l.refCol)) return null;
  const r = routeLink(l, local, ref, state.sizes);
  const sel = state.selection?.type === 'link' && state.selection.id === l.id;
  const tables = selectedTables();
  const related = tables.includes(l.localTable) || tables.includes(l.refTable);
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

const countsText = () =>
  `${trn(state.model.tables.length, '{n} table', '{n} tables')} · ${trn(state.model.links.length, '{n} relationship', '{n} relationships')}`;

function render() {
  computeSizes();
  applyView();
  tablesLayer.replaceChildren(...state.model.tables.map(renderTable));
  linksLayer.replaceChildren(...state.model.links.map(renderLink).filter(Boolean));
  erdScripts?.render(scriptLinksLayer, scriptsLayer);
  $('#empty-hint').hidden = state.model.tables.length > 0;
  $('#status-count').textContent = countsText();
  $('[data-cmd="undo"]').disabled = !state.undo.length;
  $('[data-cmd="redo"]').disabled = !state.redo.length;
  $('[data-cmd="delete"]').disabled = !state.selection || state.selection.type === 'script';
  if (state.showSql) highlightSQL($('#sql-text'), generateSQL(state.model));
}

// ---------------------------------------------------------------- sidebar

// The sidebar shows the selected table or relationship; with nothing selected
// it is hidden unless the table list was opened from the toolbar.
const sidebar = $('#sidebar');
const openSections = new Map([['props', true], ['columns', true], ['relations', true]]);

function field(label, input, cls = '') {
  return h('label', { class: `field ${cls}` }, [h('span', {}, label), input]);
}

// A field edit commits on 'change', which fires while focus is moving (Tab,
// click elsewhere). Re-render the sidebar once focus has landed so the newly
// focused field can be restored by its data-key.
let panelTimer = null;
function commitField(fn) {
  commit(fn, { panel: false });
  clearTimeout(panelTimer);
  panelTimer = setTimeout(renderPanel);
}

// Input bound to an object property. `key` identifies the input so focus
// survives the sidebar being re-rendered.
function bound(obj, prop, key, { type = 'text', placeholder = '', list, after } = {}) {
  const input = h('input', { type, placeholder, value: obj[prop] ?? '', 'data-key': key });
  if (list) input.setAttribute('list', list);
  input.addEventListener('change', () => {
    let v = input.value;
    if (type === 'number') v = v === '' ? null : Number(v);
    commitField(() => {
      obj[prop] = v;
      after?.(v);
    });
  });
  return input;
}

function boundText(obj, prop, key, rows = 2) {
  const ta = h('textarea', { rows, 'data-key': key });
  ta.value = obj[prop] ?? '';
  ta.addEventListener('change', () => commitField(() => (obj[prop] = ta.value)));
  return ta;
}

// Types that take a length/precision modifier, e.g. varchar(20), numeric(10,2),
// vector(1536) (pgvector dimensions).
const SIZED_TYPE = /^(character varying|varchar|character|char|bpchar|bit|bit varying|varbit|numeric|decimal|time|timestamp|timetz|timestamptz|interval|(?:[\w"]+\.)?(?:vector|halfvec|sparsevec))\b/i;

// pgvector column: what the length means and the index for similarity search.
function vectorHint(t, c) {
  const kind = vectorKind(c.type);
  if (!kind) return null;
  const idx = vectorIndexSQL(t, c, { metric: 'cosine' });
  const sql = idx?.sql;
  return h('div', { class: 'sb-vector muted small' }, [
    h('p', {}, c.length
      ? tr('pgvector {kind}: the length is the number of dimensions. Exporting SQL adds CREATE EXTENSION vector.', { kind })
      : tr('pgvector {kind}: the length is the number of dimensions (set it to match your embedding model). Exporting SQL adds CREATE EXTENSION vector.', { kind })),
    sql ? h('p', {}, [tr('Index for cosine (<=>) nearest-neighbour search:')]) : null,
    sql ? h('code', { class: 'sb-vector-sql', title: tr('Click to copy'), onclick: async () => {
      await navigator.clipboard.writeText(sql);
      status(tr('Index SQL copied to clipboard'));
    } }, sql) : null,
    idx?.note ? h('p', {}, idx.note) : null,
  ]);
}

function section(id, title, count, body, action) {
  const d = h('details', { class: 'sb-section', open: openSections.get(id) !== false });
  d.addEventListener('toggle', () => openSections.set(id, d.open));
  d.append(
    h('summary', {}, [
      h('span', { class: 'sb-title' }, title),
      count !== null && count !== undefined ? h('span', { class: 'sb-count' }, String(count)) : null,
      action ?? null,
    ]),
    h('div', { class: 'sb-body' }, body)
  );
  return d;
}

function sidebarHeader(title, subtitle, color) {
  return h('header', { class: 'sb-header' }, [
    color !== undefined ? h('span', { class: 'sb-swatch', style: `background:${color || 'var(--erd-header-bg)'}` }) : null,
    h('div', { class: 'sb-heading' }, [h('h3', {}, title), h('div', { class: 'muted' }, subtitle)]),
    h('button', { class: 'sb-close', icon: 'close', title: tr('Close (Esc)'), onclick: () => closeSidebar() }),
  ]);
}

function closeSidebar() {
  state.showTables = false;
  select(null);
}

function renderPanel() {
  // Keep focus and caret position across re-renders.
  const active = document.activeElement;
  const key = panel.contains(active) ? active.dataset.key : null;
  const caret = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = panel.scrollTop;

  const sel = state.selection;
  let visible = true;
  if (sel?.type === 'table' && tableById(sel.id)) renderTablePanel(tableById(sel.id));
  else if (sel?.type === 'tables') renderTablesPanel(sel.ids.map(tableById).filter(Boolean));
  else if (sel?.type === 'link' && linkById(sel.id)) renderLinkPanel(linkById(sel.id));
  else if (sel?.type === 'script' && erdScripts?.exists(sel.id))
    panel.replaceChildren(sidebarHeader(erdScripts.title(sel.id), tr('Script')), ...erdScripts.panel(sel.id));
  else if (state.showTables) renderDiagramPanel();
  else visible = false;
  sidebar.hidden = !visible;
  $('[data-cmd="toggle-tables"]').classList.toggle('active', !sel && state.showTables);

  panel.scrollTop = scroll;
  if (key) {
    const again = panel.querySelector(`[data-key="${key}"]`);
    if (again) {
      again.focus();
      if (caret) try { again.setSelectionRange(...caret); } catch { /* not a text input */ }
    }
  }
}

function renderDiagramPanel() {
  const m = state.model;
  const filter = h('input', { type: 'search', placeholder: tr('Filter tables…'), 'data-key': 'table-filter', value: state.tableFilter ?? '' });
  const list = h('ul', { class: 'list' });
  const fill = () => {
    const q = filter.value.trim().toLowerCase();
    state.tableFilter = filter.value;
    const tables = [...m.tables]
      .filter((t) => fullName(t).toLowerCase().includes(q))
      .sort((a, b) => fullName(a).localeCompare(fullName(b)));
    list.replaceChildren(...(tables.length
      ? tables.map((t) =>
          h('li', { class: 'clickable', onclick: () => { select({ type: 'table', id: t.id }); centerOn(t); } }, [
            h('span', { class: 'sb-swatch small', style: `background:${t.color || 'var(--erd-header-bg)'}` }),
            h('span', { class: 'grow' }, fullName(t)),
            h('span', { class: 'muted' }, trn(t.columns.length, '{n} col', '{n} cols')),
          ]))
      : [h('li', { class: 'muted' }, m.tables.length ? tr('No matching tables.') : tr('No tables yet.'))]));
  };
  filter.addEventListener('input', fill);
  fill();
  panel.replaceChildren(
    sidebarHeader(tr('Tables'), countsText()),
    h('div', { class: 'sb-pad' }, [filter, list]),
  );
}

// Several tables picked with Ctrl+click or a Shift+drag rectangle. The
// schema and header color fields are applied to all of them at once.
function renderTablesPanel(tables) {
  const sorted = [...tables].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const common = (get) => (new Set(tables.map(get)).size === 1 ? get(tables[0]) : undefined);

  const schemas = [...new Set(state.model.tables.map((t) => t.schema || 'public'))].sort();
  const schemaInput = h('input', {
    type: 'text', list: 'multi-schemas', 'data-key': 'multi-schema',
    value: common((t) => t.schema || 'public') ?? '', placeholder: tr('(mixed)'),
  });
  // undefined: leave each table's color as it is; null: the default color.
  let color;
  const colorInput = h('input', { type: 'color', value: common((t) => t.color) ?? '#2f6fb3', 'data-key': 'multi-color' });
  const colorNote = h('span', { class: 'muted small' });
  const setColor = (c) => {
    color = c;
    if (c) colorInput.value = c;
    colorNote.textContent = c === null ? tr('default') : '';
  };
  colorInput.addEventListener('input', () => setColor(colorInput.value));
  if (common((t) => t.color) === undefined) colorNote.textContent = tr('(mixed)');

  const apply = () => {
    const schema = schemaInput.value.trim();
    commit(() => {
      for (const t of tables) {
        if (schema) t.schema = schema;
        if (color !== undefined) t.color = color;
      }
    });
    status(trn(tables.length, 'Updated {n} table', 'Updated {n} tables'));
  };

  panel.replaceChildren(
    sidebarHeader(trn(tables.length, '{n} table selected', '{n} tables selected'), tr('Drag any of them to move them together')),
    h('div', { class: 'sb-pad' }, [
      field(tr('Schema'), schemaInput),
      h('datalist', { id: 'multi-schemas' }, schemas.map((v) => h('option', { value: v }))),
      h('div', { class: 'sb-inline' }, [
        h('span', { class: 'muted' }, tr('Header color')),
        colorInput,
        colorNote,
        h('button', { icon: 'reset', onclick: () => setColor(null) }, tr('Reset')),
      ]),
      palette().length
        ? h('div', { class: 'sb-palette', role: 'list', 'aria-label': tr('Custom palette') }, palette().map((c) =>
            h('button', { class: 'sb-palette-swatch', role: 'listitem', style: `background:${c}`, title: c, onclick: () => setColor(c) })))
        : null,
      h('div', {}, [h('button', { class: 'primary', icon: 'ok', onclick: apply }, tr('Apply'))]),
      h('ul', { class: 'list' }, sorted.map((t) =>
        h('li', { class: 'clickable', onclick: () => { select({ type: 'table', id: t.id }); centerOn(t); } }, [
          h('span', { class: 'sb-swatch small', style: `background:${t.color || 'var(--erd-header-bg)'}` }),
          h('span', { class: 'grow' }, fullName(t)),
          h('span', { class: 'muted' }, trn(t.columns.length, '{n} col', '{n} cols')),
        ]))),
    ]),
    h('div', { class: 'sb-footer' }, [
      h('button', { class: 'danger', icon: 'delete', onclick: deleteSelection }, trn(tables.length, 'Delete {n} table', 'Delete {n} tables')),
    ]),
  );
}

// Custom header colors saved with the diagram (see pgerd.js). Not part of
// undo: the palette is a tool, not part of the schema.
function palette() {
  return state.model.palette ?? [];
}

function setPalette(colors) {
  state.model.palette = cleanPalette(colors);
  setDirty(true);
  renderPanel();
}

function renderTablePanel(t) {
  const fks = fkColumns(t);
  const outgoing = state.model.links.filter((l) => l.localTable === t.id);
  const incoming = state.model.links.filter((l) => l.refTable === t.id && l.localTable !== t.id);
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);

  const colorInput = h('input', { type: 'color', value: t.color ?? '#2f6fb3', 'data-key': 'table-color' });
  colorInput.addEventListener('change', () => commitField(() => (t.color = colorInput.value)));

  const props = [
    h('div', { class: 'sb-grid' }, [
      field(tr('Name'), Object.assign(bound(t, 'name', 'table-name'), { id: 'table-name' })),
      field(tr('Schema'), bound(t, 'schema', 'table-schema')),
    ]),
    field(tr('Comment'), boundText(t, 'description', 'table-comment')),
    field(tr('Note'), boundText(t, 'note', 'table-note')),
    h('div', { class: 'sb-inline' }, [
      h('span', { class: 'muted' }, tr('Header color')),
      colorInput,
      t.color ? h('button', { icon: 'reset', onclick: () => commit(() => (t.color = null)) }, tr('Reset')) : null,
      t.color && !palette().includes(t.color.toLowerCase())
        ? h('button', { icon: 'plus', title: tr('Save this color to the diagram palette'), onclick: () => setPalette([...palette(), t.color]) }, tr('Save to palette'))
        : null,
    ]),
    palette().length
      ? h('div', { class: 'sb-palette', role: 'list', 'aria-label': tr('Custom palette') }, palette().map((c) =>
          h('button', {
            class: `sb-palette-swatch${t.color?.toLowerCase() === c ? ' current' : ''}`,
            role: 'listitem',
            style: `background:${c}`,
            title: tr('{color} · Click to use, right-click to remove', { color: c }),
            onclick: () => commit(() => (t.color = c)),
            oncontextmenu: (e) => { e.preventDefault(); setPalette(palette().filter((x) => x !== c)); },
          })))
      : null,
  ];

  const columns = h('ul', { class: 'sb-cols' }, t.columns.map((c, i) => columnItem(t, c, i, fks)));
  const relations = [
    h('div', { class: 'sb-sub' }, tr('References')),
    outgoing.length
      ? h('ul', { class: 'list' }, outgoing.map((l) => linkItem(l, 'out')))
      : h('p', { class: 'muted small' }, tr('No foreign keys.')),
    h('div', { class: 'sb-sub' }, tr('Referenced by')),
    incoming.length
      ? h('ul', { class: 'list' }, incoming.map((l) => linkItem(l, 'in')))
      : h('p', { class: 'muted small' }, tr('Not referenced.')),
    h('div', { class: 'actions' }, [
      h('button', { icon: 'plus', onclick: () => openLinkDialog({ localTable: t.id }) }, tr('Foreign key')),
    ]),
  ];

  const subtitle = [
    t.schema || 'public',
    trn(t.columns.length, '{n} column', '{n} columns'),
    outgoing.length ? `${outgoing.length} FK` : null,
  ].filter(Boolean).join(' · ');

  panel.replaceChildren(
    sidebarHeader(t.name, subtitle, t.color),
    section('props', tr('Properties'), null, props),
    section('columns', tr('Columns'), t.columns.length, [
      t.columns.length ? columns : h('p', { class: 'muted small' }, tr('No columns yet.')),
    ], h('button', {
      class: 'sb-add', icon: 'plus', title: tr('Add column'),
      onclick: (e) => { e.preventDefault(); addColumn(t); },
    }, tr('Add'))),
    constraintsSection(t, pk),
    section('relations', tr('Relationships'), outgoing.length + incoming.length, relations),
    ...[tableScriptsSection(t)].filter(Boolean),
    h('div', { class: 'sb-footer' }, [
      h('button', { icon: 'toggle-tables', onclick: () => dataBrowser.open(tableKey(t)), title: tr('Open the rows of this table in a data tab') }, tr('Browse data')),
      h('button', { class: 'danger', icon: 'delete', onclick: deleteSelection }, tr('Delete table')),
    ]),
  );
}

// Primary key and unique constraints, with their names (the primary key's
// columns are chosen on the columns themselves).
function constraintsSection(t, pk) {
  const uniques = uniqueConstraints(t);
  const nameInput = (con, placeholder, key) => {
    const input = h('input', { value: con.name ?? '', placeholder, 'data-key': key, title: tr('Constraint name') });
    input.addEventListener('change', () => commitField(() => (con.name = input.value.trim())));
    return input;
  };
  const rows = [];
  if (pk.length) {
    t.rawData ??= {};
    if (!t.rawData.primary_key?.length) t.rawData.primary_key = [{ name: '', columns: [] }];
    rows.push(h('li', {}, [
      h('span', { class: 'badge pk', title: tr('Primary key') }, iconElement('pk')),
      nameInput(t.rawData.primary_key[0], `${t.name}_pkey`, 'pk-name'),
      h('code', { class: 'grow' }, `(${pk.join(', ')})`),
    ]));
  }
  for (const u of uniques) {
    const con = t.rawData.unique_constraint.find((x) => (x.name ?? '') === u.name && x.columns?.every((c, i) => c.column === u.columns[i]));
    rows.push(h('li', {}, [
      h('span', { class: 'badge uq', title: tr('Unique constraint') }, 'UQ'),
      nameInput(con, `${t.name}_${u.columns.join('_')}_key`, 'unique-name'),
      h('code', { class: 'grow' }, `(${u.columns.join(', ')})`),
      h('button', {
        class: 'danger', icon: 'close', title: tr('Delete unique constraint'),
        onclick: () => commit(() => (t.rawData.unique_constraint = t.rawData.unique_constraint.filter((x) => x !== con))),
      }),
    ]));
  }
  return section('constraints', tr('Constraints'), rows.length, [
    rows.length
      ? h('ul', { class: 'list sb-constraints' }, rows)
      : h('p', { class: 'muted small' }, tr('No primary key or unique constraints.')),
  ]);
}

// A renamed column keeps its place in the table's constraints, and remembers
// its first name so comparing with the database renames it there too.
function renameColumn(t, c, from, to) {
  if (from === to) return;
  c.renamedFrom ??= from;
  if (c.renamedFrom === to) delete c.renamedFrom;
  for (const con of [...(t.rawData?.primary_key ?? []), ...(t.rawData?.unique_constraint ?? [])]) {
    for (const c of con.columns ?? []) if (c.column === from) c.column = to;
  }
}

// Project scripts that use the table (validators, generators, …).
function tableScriptsSection(t) {
  const list = erdScripts?.forTable(t) ?? [];
  if (!list.length) return null;
  const badge = (run) => {
    if (!run) return h('span', { class: 'flag' }, tr('not run'));
    const fail = run.status === 'error' || (run.validations && run.passed < run.validations);
    return h('span', { class: `flag ${fail ? 'fail' : 'pass'}` }, fail ? tr('FAIL') : tr('PASS'));
  };
  return section('scripts', tr('Scripts'), list.length, [
    h('ul', { class: 'list' }, list.map(({ script, run, relation }) =>
      h('li', { class: 'clickable', title: `${script.path}\n${tr('Click to open')}`, onclick: () => erdScripts.open(script.path) }, [
        h('span', { class: 'grow' }, [h('span', { class: 'muted' }, `${relation} · `), script.name]),
        badge(run),
      ]))),
  ]);
}

// One column: a summary line, plus an editor when it's the expanded column.
function columnItem(t, c, i, fks) {
  const open = state.expandedCol === c.attnum;
  const badges = [];
  if (c.pk) badges.push(h('span', { class: 'badge pk', title: tr('Primary key') }, iconElement('pk')));
  if (fks.has(c.attnum)) badges.push(h('span', { class: 'badge fk', title: tr('Foreign key') }, iconElement('fk')));
  const flags = [];
  if (c.notNull || c.pk) flags.push(h('span', { class: 'flag', title: 'NOT NULL' }, 'NN'));
  if (c.default) flags.push(h('span', { class: 'flag def', title: `DEFAULT ${c.default}` }, `= ${c.default}`));

  const summary = h('div', {
    class: 'sb-col-row',
    role: 'button',
    tabindex: 0,
    title: open ? tr('Collapse') : tr('Edit column'),
    onclick: () => toggleColumn(c.attnum),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleColumn(c.attnum); }
    },
  }, [
    h('span', { class: 'sb-badges' }, badges),
    h('span', { class: 'sb-col-name' }, c.name),
    h('span', { class: 'sb-col-type' }, formatType(c)),
    h('span', { class: 'sb-flags' }, flags),
    h('span', { class: 'sb-chevron' }, open ? '▾' : '▸'),
  ]);
  const item = h('li', { class: `sb-col${open ? ' open' : ''}`, 'data-attnum': c.attnum }, summary);
  if (open) item.append(columnEditor(t, c, i));
  return item;
}

function toggleColumn(attnum) {
  state.expandedCol = state.expandedCol === attnum ? null : attnum;
  render();
  renderPanel();
}

// The default a column of this type usually gets, or null when there is none
// worth suggesting (serial types already default to their sequence).
function usualDefault(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t.endsWith('[]')) return "'{}'";
  if (t === 'uuid') return 'gen_random_uuid()';
  if (/^(timestamp|timestamptz)\b/.test(t)) return 'now()';
  if (t === 'date') return 'current_date';
  if (/^(timetz|time with time zone)\b/.test(t)) return 'current_time';
  if (/^time\b/.test(t)) return 'localtime';
  if (t === 'boolean' || t === 'bool') return 'false';
  if (t === 'json' || t === 'jsonb') return "'{}'";
  if (/^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float4|float8|money)\b/.test(t)) return '0';
  if (/^(text|character varying|varchar|character|char|bpchar|citext)\b/.test(t)) return "''";
  return null;
}

// A uuid primary key gets gen_random_uuid() as its default unless it has one.
function uuidPkDefault(c) {
  if (c.pk && !c.default && /^uuid$/i.test(String(c.type ?? '').trim())) c.default = 'gen_random_uuid()';
}

// Default input with a button that fills in the type's usual default.
function defaultInput(c) {
  const usual = usualDefault(c.type);
  const input = bound(c, 'default', 'col-default', { placeholder: tr('e.g. now() or \'text\'') });
  if (!usual) return input;
  return h('div', { class: 'sb-default' }, [
    input,
    h('button', {
      icon: 'suggest',
      title: tr('Use the usual default: {value}', { value: usual }),
      disabled: c.default === usual,
      onclick: (e) => { e.preventDefault(); commitField(() => (c.default = usual)); },
    }),
  ]);
}

function columnEditor(t, c, i) {
  const check = (prop, label, key) => {
    const cb = h('input', { type: 'checkbox', checked: !!c[prop], 'data-key': key });
    cb.addEventListener('change', () => commitField(() => {
      c[prop] = cb.checked;
      if (prop === 'pk' && cb.checked) c.notNull = true;
      uuidPkDefault(c);
    }));
    return h('label', { class: 'check' }, [cb, label]);
  };
  const oldName = c.name;
  const move = (d) => commit(() => {
    const j = i + d;
    [t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
  });
  return h('div', { class: 'sb-col-editor' }, [
    h('div', { class: 'sb-grid' }, [
      field(tr('Name'), bound(c, 'name', 'col-name', { after: (v) => renameColumn(t, c, oldName, v) })),
      field(tr('Type'), bound(c, 'type', 'col-type', {
        list: 'pg-types',
        after: (v) => {
          if (!SIZED_TYPE.test(String(v).trim())) c.length = c.precision = null;
          uuidPkDefault(c);
        },
      })),
    ]),
    h('div', { class: 'sb-grid' }, [
      field(vectorKind(c.type) ? tr('Dimensions') : tr('Length / precision'), bound(c, 'length', 'col-length', { type: 'number' })),
      field(tr('Scale'), bound(c, 'precision', 'col-scale', { type: 'number' })),
    ]),
    vectorHint(t, c),
    field(tr('Default'), defaultInput(c)),
    h('div', { class: 'sb-inline' }, [
      check('notNull', 'NOT NULL', 'col-nn'),
      check('pk', tr('Primary key'), 'col-pk'),
    ]),
    h('div', { class: 'sb-inline end' }, [
      h('button', { icon: 'up', title: tr('Move up'), disabled: i === 0, onclick: () => move(-1) }),
      h('button', { icon: 'down', title: tr('Move down'), disabled: i === t.columns.length - 1, onclick: () => move(1) }),
      h('span', { class: 'grow' }),
      h('button', { class: 'danger', icon: 'delete', onclick: () => deleteColumn(t, c) }, tr('Delete column')),
    ]),
  ]);
}

function linkItem(l, dir) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const text = dir === 'out'
    ? `${colOf(local, l.localCol)?.name} → ${fullName(ref)}.${colOf(ref, l.refCol)?.name}`
    : `${fullName(local)}.${colOf(local, l.localCol)?.name} → ${colOf(ref, l.refCol)?.name}`;
  return h('li', { class: 'clickable', title: tr('Show relationship'), onclick: () => select({ type: 'link', id: l.id }) }, [
    h('code', { class: 'grow' }, text),
    h('button', {
      class: 'danger',
      icon: 'close',
      title: tr('Delete relationship'),
      onclick: (e) => { e.stopPropagation(); commit(() => removeLinks((x) => x.id === l.id)); },
    }),
  ]);
}

// Warning, with a fix, for a relationship whose column types do not match.
function linkTypeWarning(localCol, refCol) {
  if (!localCol || !refCol || fkTypesCompatible(localCol, refCol)) return null;
  const target = refColumnType(refCol);
  return h('div', { class: 'sb-warning small' }, [
    h('p', {}, tr('{local} is {localType} but {ref} is {refType}: PostgreSQL cannot create this foreign key.', {
      local: localCol.name, localType: formatType(localCol), ref: refCol.name, refType: formatType(refCol),
    })),
    h('button', { icon: 'suggest', onclick: () => commit(() => Object.assign(localCol, target)) },
      tr('Change {name} to {type}', { name: localCol.name, type: formatType({ ...localCol, ...target }) })),
  ]);
}

function renderLinkPanel(l) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const typeSel = h('select', { 'data-key': 'link-type' }, [
    h('option', { value: 'onetomany' }, tr('One to many')),
    h('option', { value: 'onetoone' }, tr('One to one')),
  ]);
  typeSel.value = l.type === 'onetoone' ? 'onetoone' : 'onetomany';
  typeSel.addEventListener('change', () => commitField(() => {
    for (const x of state.model.links) if (x.group === l.group) x.type = typeSel.value;
  }));

  const fkName = h('input', { value: l.fkName ?? '', placeholder: tr('(unnamed)'), 'data-key': 'link-name' });
  fkName.addEventListener('change', () => commitField(() => {
    for (const x of state.model.links) if (x.group === l.group) x.fkName = fkName.value;
  }));

  panel.replaceChildren(
    sidebarHeader(tr('Relationship'), l.fkName || tr('Foreign key')),
    section('link', tr('Properties'), null, [
      h('p', {}, [
        h('code', {}, `${fullName(local)}.${colOf(local, l.localCol)?.name}`),
        ` ${tr('references')} `,
        h('code', {}, `${fullName(ref)}.${colOf(ref, l.refCol)?.name}`),
      ]),
      linkTypeWarning(colOf(local, l.localCol), colOf(ref, l.refCol)),
      field(tr('Constraint name'), fkName),
      field(tr('Cardinality'), typeSel),
      h('div', { class: 'actions' }, [
        h('button', { icon: 'go', onclick: () => select({ type: 'table', id: local.id }) }, tr('Go to {name}', { name: local.name })),
        h('button', { icon: 'go', onclick: () => select({ type: 'table', id: ref.id }) }, tr('Go to {name}', { name: ref.name })),
      ]),
    ]),
    h('div', { class: 'sb-footer' }, [
      h('button', { class: 'danger', icon: 'delete', onclick: deleteSelection }, tr('Delete relationship')),
    ]),
  );
}

// Drag the sidebar's left edge to resize it; the width is remembered.
(function setupSidebarResize() {
  const handle = $('#sidebar-resize');
  const apply = (w) => sidebar.style.setProperty('--sidebar-w', `${Math.round(w)}px`);
  try {
    const saved = Number(localStorage.getItem('pgsql-erd.sidebar-width'));
    if (saved) apply(saved);
  } catch { /* storage unavailable */ }
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    const move = (ev) => apply(Math.min(Math.max(300, startW + startX - ev.clientX), window.innerWidth * 0.6));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('pgsql-erd.sidebar-width', String(Math.round(sidebar.getBoundingClientRect().width)));
      } catch { /* storage unavailable */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
})();

// ---------------------------------------------------------------- model edits

// Ids of the selected tables: the selected table, or several picked with
// Ctrl+click or a Shift+drag rectangle.
function selectedTables() {
  const sel = state.selection;
  if (sel?.type === 'table') return [sel.id];
  if (sel?.type === 'tables') return sel.ids;
  return [];
}

// The selection for a set of table ids: nothing, one table or several.
function tablesSelection(ids) {
  if (!ids.length) return null;
  return ids.length === 1 ? { type: 'table', id: ids[0] } : { type: 'tables', ids };
}

// `col` expands that column's editor in the sidebar.
function select(sel, { col } = {}) {
  if (sel?.id !== state.selection?.id || sel?.type !== state.selection?.type) state.expandedCol = null;
  if (col !== undefined) state.expandedCol = col;
  state.selection = sel;
  render();
  renderPanel();
  if (col !== undefined) {
    panel.querySelector(`.sb-col[data-attnum="${col}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

function removeLinks(pred) {
  state.model.links = state.model.links.filter((l) => !pred(l));
}

function addColumn(t) {
  const attnum = nextAttnum(t);
  openSections.set('columns', true);
  state.expandedCol = attnum;
  commit(() => t.columns.push(newColumn({ name: `column_${t.columns.length + 1}`, attnum })));
  const name = panel.querySelector('[data-key="col-name"]');
  name?.scrollIntoView({ block: 'nearest' });
  name?.select();
}

function deleteColumn(t, c) {
  if (state.expandedCol === c.attnum) state.expandedCol = null;
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

const gridSize = () => state.model.view.gridSize || 15;

// Round to the nearest grid line when snapping is on (`on` overrides it).
function snap(v, on = state.snap) {
  if (!on) return v;
  const g = gridSize();
  return Math.round(v / g) * g;
}

// Adds a table centered in the view, or with its top-left corner at `at`
// (diagram coordinates).
function addTable(at) {
  const c = viewCenter();
  const existing = new Set(state.model.tables.map((t) => t.name));
  let n = 1;
  while (existing.has(`table_${n}`)) n++;
  const t = newTable({
    name: `table_${n}`,
    x: snap(at ? at.x : c.x - 100),
    y: snap(at ? at.y : c.y - 50),
    columns: [newColumn({ name: 'id', type: 'bigserial', pk: true, notNull: true, attnum: 0 })],
  });
  commit(() => state.model.tables.push(t), { panel: false });
  select({ type: 'table', id: t.id });
  $('#table-name')?.select();
}

function deleteSelection() {
  const sel = state.selection;
  if (!sel || sel.type === 'script') return;
  if (sel.type === 'table' || sel.type === 'tables') {
    const ids = new Set(selectedTables());
    commit(() => {
      state.model.tables = state.model.tables.filter((t) => !ids.has(t.id));
      removeLinks((l) => ids.has(l.localTable) || ids.has(l.refTable));
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
  localOpts.unshift(['new', suggested ? tr('+ new column "{name}"', { name: suggested }) : tr('+ new column')]);
  const match = local?.columns.find((c) => c.name === suggested);
  fillSelect(f.localCol, localOpts, match ? String(match.attnum) : f.localCol.value || 'new');
  validateLinkTypes();
}

// The foreign key column has to have a type PostgreSQL can compare with the
// referenced column's (a new column copies it), or adding the constraint
// fails. Blocks Create and offers to change the column's type.
function validateLinkTypes() {
  const f = linkForm.elements;
  const local = tableById(f.localTable.value);
  const refCol = colOf(tableById(f.refTable.value), Number(f.refCol.value));
  const localCol = f.localCol.value === 'new' ? null : colOf(local, Number(f.localCol.value));
  const bad = !!(localCol && refCol && !fkTypesCompatible(localCol, refCol));
  $('#link-type-warning').hidden = !bad;
  $('#link-create').disabled = bad;
  if (!bad) return;
  const target = refColumnType(refCol);
  $('#link-type-warning-text').textContent = tr('{local} is {localType} but {ref} is {refType}: PostgreSQL cannot create this foreign key.', {
    local: localCol.name, localType: formatType(localCol), ref: refCol.name, refType: formatType(refCol),
  });
  const fix = $('#link-type-fix');
  (fix.querySelector('.label') ?? fix).textContent = tr('Change {name} to {type}', { name: localCol.name, type: formatType({ ...localCol, ...target }) });
  fix.onclick = () => {
    commit(() => Object.assign(localCol, target));
    refreshLinkDialogColumns();
  };
}

// Type, length and precision for a column that references refCol (serial
// key columns are referenced with their underlying integer type).
function refColumnType(refCol) {
  return {
    type: { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }[refCol.type] ?? refCol.type,
    length: refCol.length,
    precision: refCol.precision,
  };
}

function openLinkDialog({ localTable, localCol, refTable, refCol } = {}) {
  if (!state.model.tables.length) return status(tr('Add a table first.'));
  const f = linkForm.elements;
  const opts = [...state.model.tables]
    .sort((a, b) => fullName(a).localeCompare(fullName(b)))
    .map((t) => [t.id, fullName(t)]);
  const selTable = state.selection?.type === 'table' ? state.selection.id : undefined;
  fillSelect(f.localTable, opts, localTable ?? selTable);
  const other = opts.find(([id]) => id !== f.localTable.value)?.[0];
  fillSelect(f.refTable, opts, refTable ?? other ?? f.localTable.value);
  f.localCol.value = '';
  f.refCol.value = '';
  f.fkName.value = '';
  f.type.value = 'onetomany';
  refreshLinkDialogColumns();
  // The referenced column decides the suggested foreign key column, so pick
  // it first and refresh again before choosing the foreign key column.
  if (refCol !== undefined) {
    f.refCol.value = String(refCol);
    refreshLinkDialogColumns();
  }
  if (localCol !== undefined) f.localCol.value = String(localCol);
  validateLinkTypes();
  linkDialog.returnValue = '';
  linkDialog.showModal();
}

['localTable', 'refTable', 'refCol'].forEach((name) =>
  linkForm.elements[name].addEventListener('change', refreshLinkDialogColumns)
);
linkForm.elements.localCol.addEventListener('change', validateLinkTypes);

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
      localCol = newColumn({
        name: `${ref.name}_${refCol.name}`,
        ...refColumnType(refCol),
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

const ZOOM_MIN = 0.1, ZOOM_MAX = 3;

// The status bar zoom slider works like Word's: 100% sits in the middle,
// the left half runs linearly down to the minimum and the right half up to
// the maximum. The slider's range is 0..1000.
function zoomToSlider(z) {
  return z <= 1 ? 500 * (z - ZOOM_MIN) / (1 - ZOOM_MIN) : 500 + 500 * (z - 1) / (ZOOM_MAX - 1);
}

function sliderToZoom(n) {
  return n <= 500 ? ZOOM_MIN + (n / 500) * (1 - ZOOM_MIN) : 1 + ((n - 500) / 500) * (ZOOM_MAX - 1);
}

function setZoom(zoom, cx, cy) {
  const v = state.model.view;
  const r = svg.getBoundingClientRect();
  cx ??= r.width / 2;
  cy ??= r.height / 2;
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  v.offsetX = cx - ((cx - v.offsetX) * z) / v.zoom;
  v.offsetY = cy - ((cy - v.offsetY) * z) / v.zoom;
  v.zoom = z;
  applyView();
}

// Everything drawn: tables plus, when shown, script boxes.
function diagramBounds(margin = 40) {
  const b = contentBounds(state.model, state.sizes, margin);
  const extra = erdScripts?.boxes() ?? [];
  if (!extra.length || !state.model.tables.length) return b;
  const x0 = Math.min(b.x, ...extra.map((s) => s.x - margin));
  const y0 = Math.min(b.y, ...extra.map((s) => s.y - margin));
  const x1 = Math.max(b.x + b.width, ...extra.map((s) => s.x + s.width + margin));
  const y1 = Math.max(b.y + b.height, ...extra.map((s) => s.y + s.height + margin));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function fit() {
  computeSizes();
  if (!state.model.tables.length) return;
  const b = diagramBounds();
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

// Screen (client) coordinates to diagram coordinates.
function toDiagram(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  const { offsetX, offsetY, zoom } = state.model.view;
  return { x: (clientX - r.left - offsetX) / zoom, y: (clientY - r.top - offsetY) / zoom };
}

// The table under the pointer, if any. Works while the svg holds pointer capture.
function tableAt(clientX, clientY) {
  const g = document.elementFromPoint(clientX, clientY)?.closest?.('.erd-table');
  return g ? tableById(g.dataset.id) : null;
}

// Dragging from a table's link handle draws a line; dropping it on another
// table opens the relationship dialog with both tables filled in. Dragging
// from a column's handle does the same for that column (the foreign key),
// and dropping it on a column picks that one as the referenced column.
function startLinkDrag(t, handle) {
  const col = handle?.classList.contains('t-col-handle') ? Number(handle.closest('.t-row').dataset.attnum) : undefined;
  const s = state.sizes.get(t.id);
  const x = t.x + (col === undefined ? s.width : Number(handle.getAttribute('cx')));
  const y = t.y + (col === undefined ? HEADER_H / 2 : Number(handle.getAttribute('cy')));
  const line = el('line', { class: 'link-draft', x1: x, y1: y, x2: x, y2: y });
  viewport.append(line);
  svg.classList.add('linking');
  return { kind: 'link', t, col, line, target: null, targetCol: undefined, targetEl: null };
}

function moveLinkDrag(e) {
  const p = toDiagram(e.clientX, e.clientY);
  drag.line.setAttribute('x2', p.x);
  drag.line.setAttribute('y2', p.y);
  const hitEl = document.elementFromPoint(e.clientX, e.clientY);
  const hit = tableAt(e.clientX, e.clientY);
  const rowEl = drag.col !== undefined ? hitEl?.closest?.('.t-row') : null;
  const hitCol = rowEl ? Number(rowEl.dataset.attnum) : undefined;
  // A column may reference another column of its own table (a self
  // reference); a whole table may only be linked to another table.
  const target = hit && (hit !== drag.t || (hitCol !== undefined && hitCol !== drag.col)) ? hit : null;
  const targetCol = target ? hitCol : undefined;
  if (target === drag.target && targetCol === drag.targetCol) return;
  drag.targetEl?.classList.remove('link-target');
  drag.target = target;
  drag.targetCol = targetCol;
  drag.targetEl = !target ? null : targetCol !== undefined ? rowEl
    : tablesLayer.querySelector(`.erd-table[data-id="${CSS.escape(target.id)}"]`);
  drag.targetEl?.classList.add('link-target');
}

// Shift+drag draws a rectangle that selects the tables it touches; with Ctrl
// too they are added to the current selection.
function startMarquee(e, additive) {
  const p = toDiagram(e.clientX, e.clientY);
  const rect = el('rect', { class: 'marquee', x: p.x, y: p.y, width: 0, height: 0 });
  viewport.append(rect);
  return { kind: 'marquee', p, rect, base: additive ? selectedTables() : [], inside: [] };
}

function moveMarquee(e) {
  const { p, rect } = drag;
  const q = toDiagram(e.clientX, e.clientY);
  const x0 = Math.min(p.x, q.x), y0 = Math.min(p.y, q.y);
  const x1 = Math.max(p.x, q.x), y1 = Math.max(p.y, q.y);
  rect.setAttribute('x', x0);
  rect.setAttribute('y', y0);
  rect.setAttribute('width', x1 - x0);
  rect.setAttribute('height', y1 - y0);
  drag.inside = state.model.tables.filter((t) => {
    const s = state.sizes.get(t.id);
    return t.x <= x1 && t.y <= y1 && t.x + s.width >= x0 && t.y + s.height >= y0;
  }).map((t) => t.id);
  const picked = new Set([...drag.base, ...drag.inside]);
  for (const g of tablesLayer.querySelectorAll('.erd-table')) g.classList.toggle('selected', picked.has(g.dataset.id));
}

svg.addEventListener('pointerdown', (e) => {
  closeContextMenu();
  if (e.button !== 0 && e.button !== 1) return;
  const tableEl = e.target.closest('.erd-table');
  const linkEl = e.target.closest('.erd-link');
  const scriptEl = e.target.closest('.erd-script');
  svg.setPointerCapture(e.pointerId);
  const handle = e.target.closest('.t-link-handle, .t-col-handle');
  const additive = e.ctrlKey || e.metaKey;
  if (e.button === 0 && e.shiftKey) {
    drag = startMarquee(e, additive);
  } else if (tableEl && e.button === 0 && handle && !additive) {
    drag = startLinkDrag(tableById(tableEl.dataset.id), handle);
  } else if (scriptEl && e.button === 0) {
    if (state.selection?.id !== scriptEl.dataset.path) select({ type: 'script', id: scriptEl.dataset.path });
    drag = erdScripts.startDrag(scriptEl, e);
  } else if (tableEl && e.button === 0) {
    const t = tableById(tableEl.dataset.id);
    const rowEl = e.target.closest('.t-row');
    const col = rowEl ? Number(rowEl.dataset.attnum) : undefined;
    const ids = selectedTables();
    // Applied on release without moving: Ctrl+click takes a selected table
    // out of the selection, and a plain click in a group selects just it.
    let click = null;
    if (additive) {
      if (ids.includes(t.id)) click = 'remove';
      else select(tablesSelection([...ids, t.id]));
    } else if (ids.length > 1 && ids.includes(t.id)) {
      click = 'only';
    } else if (state.selection?.id !== t.id || (col !== undefined && col !== state.expandedCol)) {
      select({ type: 'table', id: t.id }, { col });
    }
    // Bring to front.
    state.model.tables = [...state.model.tables.filter((x) => x !== t), t];
    // The other selected tables move along with this one.
    const others = selectedTables().filter((id) => id !== t.id).map(tableById).filter(Boolean)
      .map((x) => ({ t: x, ox: x.x, oy: x.y }));
    drag = { kind: 'table', t, col, click, others, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false };
  } else if (linkEl && e.button === 0) {
    select({ type: 'link', id: linkEl.dataset.id });
  } else {
    if (state.selection && e.button === 0 && !additive) select(null);
    const v = state.model.view;
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: v.offsetX, oy: v.offsetY };
    svg.classList.add('panning');
  }
});

svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'link') return moveLinkDrag(e);
  if (drag.kind === 'marquee') return moveMarquee(e);
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (drag.kind === 'pan') {
    state.model.view.offsetX = drag.ox + dx;
    state.model.view.offsetY = drag.oy + dy;
    applyView();
    return;
  }
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  if (drag.kind === 'script') {
    // Script boxes aren't part of the diagram file, so no undo step.
    drag.moved = true;
    const z = state.model.view.zoom;
    const on = state.snap !== e.altKey;
    erdScripts.moveDrag(drag, snap(drag.ox + dx / z, on), snap(drag.oy + dy / z, on));
    scheduleRender();
    return;
  }
  if (!drag.moved) {
    pushUndo();
    drag.moved = true;
  }
  const z = state.model.view.zoom;
  const nx = drag.ox + dx / z;
  const ny = drag.oy + dy / z;
  // Alt inverts the snap setting for this move.
  const on = state.snap !== e.altKey;
  drag.t.x = snap(nx, on);
  drag.t.y = snap(ny, on);
  // The others keep their place relative to the dragged table.
  for (const o of drag.others) {
    o.t.x = o.ox + drag.t.x - drag.ox;
    o.t.y = o.oy + drag.t.y - drag.oy;
  }
  scheduleRender();
});

// Pan just enough to show the whole table (e.g. after the sidebar opened
// and narrowed the canvas).
function ensureVisible(t) {
  const s = state.sizes.get(t.id);
  const r = svg.getBoundingClientRect();
  const v = state.model.view;
  const m = 20;
  const x0 = t.x * v.zoom + v.offsetX, x1 = (t.x + s.width) * v.zoom + v.offsetX;
  const y0 = t.y * v.zoom + v.offsetY, y1 = (t.y + s.height) * v.zoom + v.offsetY;
  let dx = 0, dy = 0;
  if (x1 > r.width - m) dx = r.width - m - x1;
  if (x0 + dx < m) dx = m - x0;
  if (y1 > r.height - m) dy = r.height - m - y1;
  if (y0 + dy < m) dy = m - y0;
  if (!dx && !dy) return;
  v.offsetX += dx;
  v.offsetY += dy;
  applyView();
}

function endDrag(e) {
  if (drag?.kind === 'link') {
    const { t, col, target, targetCol, line } = drag;
    line.remove();
    svg.classList.remove('linking');
    drag = null;
    render();
    if (target && e.type === 'pointerup') {
      openLinkDialog({ localTable: t.id, localCol: col, refTable: target.id, refCol: targetCol });
    }
    return;
  }
  if (drag?.kind === 'marquee') {
    const { rect, base, inside } = drag;
    rect.remove();
    drag = null;
    select(tablesSelection([...new Set([...base, ...inside])]));
    return;
  }
  if (drag?.kind === 'script') erdScripts.endDrag(drag);
  if (drag?.kind === 'table' && drag.moved) setDirty(true);
  if (drag?.kind === 'table' && !drag.moved) {
    const { t, col, click } = drag;
    if (click === 'remove') select(tablesSelection(selectedTables().filter((id) => id !== t.id)));
    else if (click === 'only') select({ type: 'table', id: t.id }, { col });
    if (click !== 'remove') ensureVisible(t);
  }
  if (drag?.kind === 'pan') svg.classList.remove('panning');
  drag = null;
  render();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- copy and paste

// Tables copied with Ctrl+C or the context menu, with the relationships
// between them (foreign keys to tables left out are not copied). Kept across
// diagram tabs so they can be pasted in another one.
let tableClipboard = null;

const schemaOf = (t) => t.schema || 'public';
const nameTaken = (schema, name) => state.model.tables.some((t) => schemaOf(t) === schema && t.name === name);

// `name` when it is free in `schema` (and not in `taken`), else name_copy, name_copy2, …
function freeName(schema, name, taken = new Set()) {
  const free = (n) => !nameTaken(schema, n) && !taken.has(n);
  if (free(name)) return name;
  for (let i = 1; ; i++) {
    const n = `${name}_copy${i > 1 ? i : ''}`;
    if (free(n)) return n;
  }
}

function copyTables(ids = selectedTables()) {
  const set = new Set(ids);
  const tables = state.model.tables.filter((t) => set.has(t.id));
  if (!tables.length) return false;
  const links = state.model.links.filter((l) => set.has(l.localTable) && set.has(l.refTable));
  tableClipboard = structuredClone({ tables, links });
  status(trn(tables.length, 'Copied {n} table', 'Copied {n} tables'));
  return true;
}

// Asks for the pasted table's name and schema, or only the schema when
// several tables are pasted (those whose name is taken there get a _copy
// suffix). `at` puts the copies' top-left corner there (diagram coordinates);
// otherwise they land a little below and right of the originals.
function pasteTables(at) {
  const clip = tableClipboard;
  if (!clip) return;
  const multi = clip.tables.length > 1;
  const first = clip.tables[0];
  const schemas = [...new Set([...state.model.tables.map(schemaOf), 'public'])].sort();
  const common = new Set(clip.tables.map(schemaOf)).size === 1 ? schemaOf(first) : 'public';

  const schemaInput = h('input', {
    name: 'schema', list: 'paste-schemas', placeholder: 'public', autocomplete: 'off',
    value: common === 'public' ? '' : common,
  });
  const nameInput = multi ? null : h('input', { name: 'name', autocomplete: 'off' });
  const message = h('div', { class: 'paste-msg' });
  const ok = h('button', { value: 'ok', class: 'primary', icon: 'paste' }, tr('Paste'));
  const target = () => schemaInput.value.trim() || 'public';
  let nameEdited = false;
  let names = [];

  const check = () => {
    const schema = target();
    if (!multi) {
      if (!nameEdited) nameInput.value = freeName(schema, first.name);
      const name = nameInput.value.trim();
      const error = !name ? tr('Enter a table name.')
        : nameTaken(schema, name) ? tr('A table named {name} already exists in {schema}.', { name, schema }) : '';
      names = [name];
      message.replaceChildren(error ? h('p', { class: 'error' }, error) : '');
      ok.disabled = !!error;
      return;
    }
    const taken = new Set();
    names = clip.tables.map((t) => {
      const n = freeName(schema, t.name, taken);
      taken.add(n);
      return n;
    });
    const renamed = clip.tables.map((t, i) => [t.name, names[i]]).filter(([a, b]) => a !== b);
    message.replaceChildren(...(renamed.length
      ? [
          h('p', { class: 'warn' }, trn(renamed.length,
            '{n} table already exists in {schema} and gets a new name:',
            '{n} tables already exist in {schema} and get a new name:', { schema })),
          h('ul', {}, renamed.map(([a, b]) => h('li', {}, `${a} → ${b}`))),
        ]
      : [h('p', { class: 'muted' }, tr('No name collisions in {schema}.', { schema }))]));
  };

  const dialog = h('dialog', {}, h('form', { method: 'dialog' }, [
    h('h3', {}, multi ? trn(clip.tables.length, 'Paste {n} table', 'Paste {n} tables') : tr('Paste table')),
    h('p', { class: 'muted' }, multi
      ? tr('Pick the schema for the pasted tables. Leave it empty for public.')
      : tr('Pick a name and schema for the pasted table. Leave the schema empty for public.')),
    h('div', { class: 'grid2' }, [
      nameInput ? h('label', {}, [tr('Name'), nameInput]) : null,
      h('label', {}, [tr('Schema'), schemaInput]),
    ]),
    h('datalist', { id: 'paste-schemas' }, schemas.map((v) => h('option', { value: v }))),
    message,
    h('menu', {}, [h('button', { value: 'cancel', formnovalidate: '', icon: 'close' }, tr('Cancel')), ok]),
  ]));
  schemaInput.addEventListener('input', check);
  nameInput?.addEventListener('input', () => { nameEdited = true; check(); });
  // Enter pastes (the form's first button is Cancel).
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      if (!ok.disabled) ok.click();
    }
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue === 'ok') placePasted(clip, names, target(), at);
  });
  check();
  document.body.append(dialog);
  dialog.showModal();
  (nameInput ?? schemaInput).select();
}

function placePasted(clip, names, schema, at) {
  const minX = Math.min(...clip.tables.map((t) => t.x));
  const minY = Math.min(...clip.tables.map((t) => t.y));
  const dx = at ? at.x - minX : 30;
  const dy = at ? at.y - minY : 30;
  const ids = new Map();
  const tables = clip.tables.map((t, i) => {
    const c = structuredClone(t);
    ids.set(t.id, uuid());
    // Ports and the catalog oid belong to the original table.
    const { oid, ...rest } = c;
    return {
      ...rest, id: ids.get(t.id), name: names[i], schema, x: snap(t.x + dx), y: snap(t.y + dy),
      raw: c.raw && { ...c.raw, ports: [] },
    };
  });
  const groups = new Map();
  const links = clip.links.map((l) => {
    if (!groups.has(l.group)) groups.set(l.group, uuid());
    // Constraint names are unique per schema, so the copies get generated ones.
    return {
      ...l, id: uuid(), localTable: ids.get(l.localTable), refTable: ids.get(l.refTable),
      group: groups.get(l.group), fkName: '', rawFk: null, raw: null,
    };
  });
  commit(() => {
    state.model.tables.push(...tables);
    state.model.links.push(...links);
    state.selection = tablesSelection(tables.map((t) => t.id));
  });
  status(trn(tables.length, 'Pasted {n} table', 'Pasted {n} tables'));
}

// Ctrl+C / Ctrl+V and the Edit menu's Copy and Paste, unless a field or a
// text selection takes them.
document.addEventListener('copy', (e) => {
  if (isEditing(e) || document.querySelector('dialog[open]') || String(window.getSelection())) return;
  if (copyTables()) e.preventDefault();
});
document.addEventListener('paste', (e) => {
  if (isEditing(e) || document.querySelector('dialog[open]') || !tableClipboard) return;
  e.preventDefault();
  pasteTables();
});

// ---------------------------------------------------------------- context menu

let contextMenu = null;

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  contextMenu = h('div', { class: 'ctx-menu', role: 'menu' }, items.map((it) =>
    it === '-'
      ? h('div', { class: 'ctx-sep' })
      : h('button', {
        class: `ctx-item${it.danger ? ' danger' : ''}`,
        role: 'menuitem',
        icon: it.icon,
        onclick: () => { closeContextMenu(); it.run(); },
      }, it.label)
  ));
  document.body.append(contextMenu);
  // Keep the menu inside the window.
  const r = contextMenu.getBoundingClientRect();
  contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  contextMenu.querySelector('button')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) closeContextMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (contextMenu && e.key === 'Escape') {
    e.stopPropagation();
    closeContextMenu();
  }
}, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);

svg.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (drag) return;
  if (e.target.closest('.erd-script')) return;
  const tableEl = e.target.closest('.erd-table');
  const linkEl = e.target.closest('.erd-link');
  let items;
  const tables = selectedTables();
  if (tableEl && tables.length > 1 && tables.includes(tableEl.dataset.id)) {
    items = [
      { label: trn(tables.length, 'Copy {n} table', 'Copy {n} tables'), icon: 'copy', run: () => copyTables() },
      '-',
      { label: trn(tables.length, 'Delete {n} table', 'Delete {n} tables'), icon: 'delete', danger: true, run: deleteSelection },
    ];
  } else if (tableEl) {
    const t = tableById(tableEl.dataset.id);
    select({ type: 'table', id: t.id });
    items = [
      { label: tr('New relationship'), icon: 'add-link', run: () => openLinkDialog({ localTable: t.id }) },
      { label: tr('Copy table'), icon: 'copy', run: () => copyTables([t.id]) },
      '-',
      { label: tr('Delete table'), icon: 'delete', danger: true, run: deleteSelection },
    ];
  } else if (linkEl) {
    select({ type: 'link', id: linkEl.dataset.id });
    items = [{ label: tr('Delete relationship'), icon: 'delete', danger: true, run: deleteSelection }];
  } else {
    const at = toDiagram(e.clientX, e.clientY);
    items = [
      { label: tr('Add table here'), icon: 'add-table', run: () => addTable(at) },
      { label: tr('New relationship'), icon: 'add-link', run: () => openLinkDialog() },
    ];
    if (tableClipboard) {
      const n = tableClipboard.tables.length;
      items.push('-', { label: n > 1 ? trn(n, 'Paste {n} table here', 'Paste {n} tables here') : tr('Paste table here'), icon: 'paste', run: () => pasteTables(at) });
    }
  }
  showContextMenu(e.clientX, e.clientY, items);
});

// With pointer capture the dblclick target is the svg itself, so use the selection.
svg.addEventListener('dblclick', () => {
  if (state.selection?.type === 'script') erdScripts.open(state.selection.id);
  else if (state.selection?.type === 'table') {
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
    message: tr('Do you want to save the changes to this diagram?'),
    detail: tr("Your changes will be lost if you don't save them."),
    buttons: [tr('Save'), tr("Don't Save"), tr('Cancel')],
  });
  if (choice === 2) return false;
  if (choice === 0) return save();
  return true;
}

function loadModel(model, filePath) {
  state.model = model;
  state.filePath = filePath;
  emit('model');
  emit('file');
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

// A diagram file opened from the menu, the recent list or a drop: shown in
// its tab when it is open already, otherwise in the current diagram when
// that is empty and untouched, or in a new diagram tab.
function openDiagramFile(text, filePath) {
  const open = filePath && [...diagrams.keys()].find((id) => docOf(id).filePath?.toLowerCase() === filePath.toLowerCase());
  if (open) return tabs.show(open);
  if (isPristine()) showDiagram();
  else newDiagram();
  openText(text, filePath);
}

function openText(text, filePath) {
  try {
    const model = parsePgerd(text);
    loadModel(model, filePath);
    status(trn(model.tables.length, 'Opened {n} table from {file}', 'Opened {n} tables from {file}', { file: filePath ? basename(filePath) : tr('file') }));
  } catch (err) {
    host.confirm({ message: tr('Could not open file'), detail: err.message, buttons: [tr('OK')] });
  }
}

async function save() {
  document.activeElement?.blur?.(); // flush a pending input 'change'
  const defaultName = state.filePath ?? 'diagram.pgerd';
  const target = await host.saveFile({
    filePath: state.filePath,
    text: stringifyPgerd(state.model),
    defaultName,
    kind: 'pgerd',
  });
  if (!target) return false;
  const moved = target !== state.filePath;
  state.filePath = target;
  setDirty(false);
  if (moved) emit('file');
  status(tr('Saved {file}', { file: basename(target) }));
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
  if (target) status(tr('Exported {file}', { file: basename(target) }));
}

function buildExportSVG() {
  computeSizes();
  const b = diagramBounds();
  const theme = diagramTheme();
  const clone = viewport.cloneNode(true);
  clone.removeAttribute('transform');
  clone.querySelectorAll('.selected, .related, .focused').forEach((n) => n.classList.remove('selected', 'related', 'focused'));
  clone.querySelectorAll('title, .t-link-handle, .t-col-handle, .link-draft').forEach((n) => n.remove());
  const out =
    `<svg xmlns="${SVG_NS}" width="${Math.ceil(b.width)}" height="${Math.ceil(b.height)}" ` +
    `viewBox="${b.x} ${b.y} ${b.width} ${b.height}">` +
    `<style>svg{${theme.vars}}${DIAGRAM_CSS}</style>` +
    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${theme.background}"/>` +
    new XMLSerializer().serializeToString(clone) +
    '</svg>';
  return { text: out, width: b.width, height: b.height };
}

async function exportSVG() {
  if (!state.model.tables.length) return status(tr('Nothing to export.'));
  const { text } = buildExportSVG();
  const target = await host.saveFile({ text, saveAs: true, defaultName: `${exportBase()}.svg`, kind: 'svg' });
  if (target) status(tr('Exported {file}', { file: basename(target) }));
}

async function buildExportPNG() {
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
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportPNG() {
  if (!state.model.tables.length) return status(tr('Nothing to export.'));
  const data = await buildExportPNG();
  const target = await host.saveBinary({ defaultName: `${exportBase()}.png`, data, name: tr('PNG Image'), extensions: ['png'] });
  if (target) status(tr('Exported {file}', { file: basename(target) }));
}

// Save As in any format; the file type picked in the dialog decides which.
// Only a .pgerd becomes the diagram's file; the others are exports.
async function saveAs() {
  document.activeElement?.blur?.(); // flush a pending input 'change'
  const picked = await host.saveAs.pick({
    defaultName: state.filePath ?? 'diagram.pgerd',
    images: state.model.tables.length > 0,
  });
  if (!picked) return false;
  const { filePath, format } = picked;
  const content = {
    pgerd: () => ({ text: stringifyPgerd(state.model) }),
    sql: () => ({ text: generateSQL(state.model) }),
    svg: () => ({ text: buildExportSVG().text }),
    png: async () => ({ data: await buildExportPNG() }),
  }[format];
  await host.saveAs.write({ filePath, format, ...(await content()) });
  if (format !== 'pgerd') {
    status(tr('Exported {file}', { file: basename(filePath) }));
    return false;
  }
  const moved = filePath !== state.filePath;
  state.filePath = filePath;
  setDirty(false);
  if (moved) emit('file');
  status(tr('Saved {file}', { file: basename(filePath) }));
  return true;
}

// Save and Save As work on the current tab: the diagram, or what the
// Scripts, Query, Builder and Graph tabs register here by kind.
const tabSavers = {
  erd: (id, as) => (as ? saveAs() : save()),
};

function saveTab(as) {
  const id = tabs.current();
  const saver = tabSavers[tabs.kind(id)];
  if (!saver) return status(tr('Nothing to save on this tab.'));
  return saver(id, as);
}

// ---------------------------------------------------------------- commands

const commands = {
  new: () => newDiagram(),
  async open() {
    await host.openDialog();
  },
  save: () => saveTab(false),
  'save-as': () => saveTab(true),
  // Closing the window with unsaved diagrams: save each, then close.
  async 'save-and-close'() {
    for (const id of tabs.ofKind('erd')) {
      if (!docOf(id)?.dirty) continue;
      tabs.show(id);
      if (!(await save())) return;
    }
    host.closeWindow();
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
      autoLayout(state.model, state.sizes, { grid: state.snap ? gridSize() : 0 });
    }, { panel: false });
    fit();
  },
  'toggle-tables'() {
    state.showTables = !(state.showTables && !state.selection);
    if (state.selection) {
      state.selection = null;
      render();
    }
    renderPanel();
  },
  'toggle-grid'() {
    state.showGrid = !state.showGrid;
    savePref('pgsql-erd.show-grid', state.showGrid);
    applyView();
  },
  'toggle-snap'() {
    state.snap = !state.snap;
    savePref('pgsql-erd.snap', state.snap);
    applyView();
    status(state.snap ? tr('Snap to grid on') : tr('Snap to grid off'));
  },
  'toggle-sql'() {
    state.showSql = !state.showSql;
    $('#sql-panel').hidden = !state.showSql;
    render();
  },
};


// Select a table of the diagram by its "schema.name" key and bring it into
// view. Returns false when the table isn't in the diagram.
function findDiagramTable(key) {
  const k = String(key ?? '');
  return (
    state.model.tables.find((x) => tableKey(x) === k) ??
    state.model.tables.find((x) => tableKey(x) === `public.${k}`) ??
    state.model.tables.find((x) => tableKey(x).toLowerCase() === k.toLowerCase())
  );
}

function focusTable(key) {
  const t = findDiagramTable(key);
  if (!t) return false;
  showDiagram();
  select({ type: 'table', id: t.id });
  centerOn(t);
  return true;
}

function selectedTableIds() {
  const sel = state.selection;
  if (sel?.type === 'table' || sel?.type === 'tables') return selectedTables().map(tableById).filter(Boolean).map(tableKey);
  if (sel?.type === 'link') {
    const l = linkById(sel.id);
    return [tableById(l.localTable), tableById(l.refTable)].filter(Boolean).map(tableKey);
  }
  return [];
}

const tabs = setupTabs({ h });
const uiCtx = { host, state, h, commit, computeSizes, fit, status, events };
const { api: db, ...dbCommands } = setupDatabase(uiCtx);
const spreadsheet = setupSpreadsheetImport(uiCtx);
const dbTree = setupDbTree({ ...uiCtx, db, toDiagram, snap, select, centerOn, viewCenter, showContextMenu });
const workbenchCtx = {
  host, state, h, status, db, events, tabs, dbTree, focusTable, selectedTableIds, showDiagram,
  hasTable: (key) => !!findDiagramTable(key),
  saveDiagram: () => save(),
  refreshSchema: () => db.refreshSchema(),
};
const workbench = setupWorkbench(workbenchCtx);
const assistant = setupAssistant(workbenchCtx, workbench.api);
const dataBrowser = setupDataBrowser(workbenchCtx);
const query = setupQuery(workbenchCtx);
const graph = setupGraph(workbenchCtx);
const queryBuilder = setupQueryBuilder({ ...workbenchCtx, dbTree, openSql: query.setSql, runQuery: query.commands['query-run'] });
erdScripts = setupErdScripts({ ...workbenchCtx, el, measure, workbench: workbench.api, select, render, focusTable });
Object.assign(workbenchCtx, {
  aiConfig: assistant.aiConfig,
  askAssistant: assistant.ask,
  openData: dataBrowser.open,
  openSql: query.setSql,
});
Object.assign(commands, dbCommands, dbTree.commands, spreadsheet.commands, workbench.commands, assistant.commands, dataBrowser.commands, query.commands, queryBuilder.commands, graph.commands, {
  'tab-erd': showDiagram,
  'toggle-erd-scripts': () => {
    showDiagram();
    erdScripts.setShown(!erdScripts.shown());
  },
});
Object.assign(tabSavers, {
  query: query.saveTab,
  scripts: workbench.saveTab,
  builder: queryBuilder.saveTab,
  graph: graph.saveTab,
});
// A diagram tab brings its document; the diagram re-renders when its tab
// comes back (sizes are measured on screen).
tabs.onShow((name) => {
  if (tabs.kind(name) !== 'erd') return;
  useDiagram(name);
  render();
});
// Another database: the diagrams are closed, unsaved changes and all.
events.addEventListener('database-switch', () => {
  for (const id of tabs.ofKind('erd')) if (id !== diagramId) tabs.remove(id);
  loadModel(emptyModel(), null);
});

function runCommand(name) {
  const fn = commands[name];
  if (fn) Promise.resolve(fn()).catch((err) => status(tr('Error: {message}', { message: err.message })));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) runCommand(btn.dataset.cmd);
});

$('#zoom-slider').addEventListener('input', (e) => {
  const n = Number(e.target.value);
  // Snap to 100% near the middle, as Word does.
  setZoom(Math.abs(n - 500) <= 10 ? 1 : Math.round(sliderToZoom(n) * 100) / 100);
});
$('#zoom-slider').addEventListener('change', (e) => e.target.blur());

// The view controls in the status bar only apply to the diagram.
tabs.onShow((name) => {
  $('#status-view').hidden = tabs.kind(name) !== 'erd';
});

$('#grid-size').addEventListener('change', (e) => {
  const size = Number(e.target.value);
  if (!size || size === state.model.view.gridSize) return;
  state.model.view.gridSize = size;
  setDirty(true);
  applyView();
  e.target.blur();
});

$('#sql-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#sql-text').textContent);
  status(tr('SQL copied to clipboard'));
});

// Keys typed in fields, the script editor or the assistant are not diagram shortcuts.
const isEditing = (e) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || tabs.kind(tabs.current()) !== 'erd';

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
  } else if (selectedTables().length && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const [t, ...others] = selectedTables().map(tableById).filter(Boolean);
    // Shift nudges by 1px; otherwise move one cell, landing on the next grid
    // line when snapping is on.
    const g = gridSize();
    const move = (v, dir) => {
      if (e.shiftKey) return v + dir;
      if (!state.snap) return v + dir * g;
      return dir > 0 ? Math.floor(v / g) * g + g : Math.ceil(v / g) * g - g;
    };
    // Other selected tables move by the same step, keeping their layout.
    const [x0, y0] = [t.x, t.y];
    commit(() => {
      if (e.key === 'ArrowLeft') t.x = move(t.x, -1);
      if (e.key === 'ArrowRight') t.x = move(t.x, 1);
      if (e.key === 'ArrowUp') t.y = move(t.y, -1);
      if (e.key === 'ArrowDown') t.y = move(t.y, 1);
      for (const o of others) {
        o.x += t.x - x0;
        o.y += t.y - y0;
      }
    }, { panel: false });
  }
});

// Drag and drop .pgerd files onto the window; spreadsheets open the import
// dialog and .sql files open in the query tab.
// Tables dragged from the database explorer are dropped by dbtree.js and
// querybuilder.js, which also handles columns dragged between its tables.
const wrap = $('.canvas-wrap');
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
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
  if (/\.(sql|pgsql|psql)$/i.test(file.name)) return query.loadFile(await file.text(), host.pathForFile(file) || file.name);
  if (SPREADSHEET_EXT.test(file.name)) {
    const open = document.querySelector('dialog[open]');
    if (!open || open.id === 'xl-import-dialog') await spreadsheet.openFile(file.name, await file.arrayBuffer());
    return;
  }
  openDiagramFile(await file.text(), host.pathForFile(file) || null);
});

// Recent files on the empty diagram's start screen (also in File → Open Recent).
function renderRecentFiles(files) {
  $('#recent-files').hidden = !files.length;
  $('#recent-list').replaceChildren(...files.map((f) => {
    const dir = f.slice(0, f.length - basename(f).length).replace(/[\\/]$/, '');
    return h('li', { title: f, onclick: () => host.recent.open(f) }, [
      h('span', { class: 'recent-name' }, basename(f)),
      h('span', { class: 'recent-dir' }, dir),
      h('button', {
        type: 'button',
        class: 'recent-remove',
        title: tr('Remove from the list'),
        onclick: (e) => { e.stopPropagation(); host.recent.remove(f); },
      }, '×'),
    ]);
  }));
}
$('#recent-clear').addEventListener('click', () => host.recent.clear());

// ---------------------------------------------------------------- startup

(function init() {
  initTheme();
  const style = document.createElement('style');
  style.textContent =
    Object.entries(THEME_DIAGRAM).map(([name, t]) => `:root[data-theme="${name}"]{${t.vars}}`).join('') + DIAGRAM_CSS;
  document.head.append(style);
  $('#pg-types').replaceChildren(...PG_TYPES.map((t) => h('option', { value: t })));

  host.onFileOpened(({ filePath, text }) => openDiagramFile(text, filePath));
  // F5 is the menu accelerator for running scripts; on a query tab it runs the query.
  host.onMenu((name) => runCommand(name === 'script-run' && query.isQueryTab(tabs.current()) ? 'query-run' : name));
  host.recent.onChange(renderRecentFiles);
  host.recent.list().then(renderRecentFiles);

  newDiagram();
  query.restoreTabs();
  queryBuilder.restoreTabs();
})();
