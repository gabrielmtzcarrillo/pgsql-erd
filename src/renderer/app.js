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
import { setupWorkbench } from './workbench.js';
import { setupAssistant } from './assistant.js';
import { setupTabs } from './tabs.js';
import { setupDataBrowser } from './databrowser.js';
import { setupQuery } from './query.js';
import { setupErdScripts } from './erdscripts.js';
import { tableKey } from './lib/catalog.js';
import { setupSpreadsheetImport, SPREADSHEET_EXT } from './xlui.js';
import { highlightSQL } from './lib/highlight.js';
import { ICONS, decorateButton, decorateButtons, iconElement } from './icons.js';

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
const scriptLinksLayer = $('#script-links-layer');
const scriptsLayer = $('#scripts-layer');
let erdScripts = null; // scripts drawn in the diagram, set up after the workbench
const panel = $('#panel');

decorateButtons(document.body);

// Notifies the workbench and assistant: 'model' (diagram edited), 'file'
// (diagram opened or saved under a new path), 'connection', 'schema'.
const events = new EventTarget();
const emit = (name) => events.dispatchEvent(new Event(name));

const state = {
  model: emptyModel(),
  filePath: null,
  dirty: false,
  selection: null, // { type: 'table' | 'link', id }
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
  erdScripts?.render(scriptLinksLayer, scriptsLayer);
  $('#empty-hint').hidden = state.model.tables.length > 0;
  $('#status-count').textContent =
    `${state.model.tables.length} tables · ${state.model.links.length} relationships`;
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

// Types that take a length/precision modifier, e.g. varchar(20), numeric(10,2).
const SIZED_TYPE = /^(character varying|varchar|character|char|bpchar|bit|bit varying|varbit|numeric|decimal|time|timestamp|timetz|timestamptz|interval)\b/i;

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
    h('button', { class: 'sb-close', icon: 'close', title: 'Close (Esc)', onclick: () => closeSidebar() }),
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
  else if (sel?.type === 'link' && linkById(sel.id)) renderLinkPanel(linkById(sel.id));
  else if (sel?.type === 'script' && erdScripts?.exists(sel.id))
    panel.replaceChildren(sidebarHeader(erdScripts.title(sel.id), 'Script'), ...erdScripts.panel(sel.id));
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
  const filter = h('input', { type: 'search', placeholder: 'Filter tables…', 'data-key': 'table-filter', value: state.tableFilter ?? '' });
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
            h('span', { class: 'muted' }, `${t.columns.length} cols`),
          ]))
      : [h('li', { class: 'muted' }, m.tables.length ? 'No matching tables.' : 'No tables yet.')]));
  };
  filter.addEventListener('input', fill);
  fill();
  panel.replaceChildren(
    sidebarHeader('Tables', `${m.tables.length} tables · ${m.links.length} relationships`),
    h('div', { class: 'sb-pad' }, [filter, list]),
  );
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
      field('Name', Object.assign(bound(t, 'name', 'table-name'), { id: 'table-name' })),
      field('Schema', bound(t, 'schema', 'table-schema')),
    ]),
    field('Comment', boundText(t, 'description', 'table-comment')),
    field('Note', boundText(t, 'note', 'table-note')),
    h('div', { class: 'sb-inline' }, [
      h('span', { class: 'muted' }, 'Header color'),
      colorInput,
      t.color ? h('button', { icon: 'reset', onclick: () => commit(() => (t.color = null)) }, 'Reset') : null,
    ]),
    h('dl', { class: 'sb-facts' }, [
      h('dt', {}, 'Primary key'), h('dd', {}, pk.length ? pk.join(', ') : '—'),
    ]),
  ];

  const columns = h('ul', { class: 'sb-cols' }, t.columns.map((c, i) => columnItem(t, c, i, fks)));
  const relations = [
    h('div', { class: 'sb-sub' }, 'References'),
    outgoing.length
      ? h('ul', { class: 'list' }, outgoing.map((l) => linkItem(l, 'out')))
      : h('p', { class: 'muted small' }, 'No foreign keys.'),
    h('div', { class: 'sb-sub' }, 'Referenced by'),
    incoming.length
      ? h('ul', { class: 'list' }, incoming.map((l) => linkItem(l, 'in')))
      : h('p', { class: 'muted small' }, 'Not referenced.'),
    h('div', { class: 'actions' }, [
      h('button', { icon: 'plus', onclick: () => openLinkDialog({ localTable: t.id }) }, 'Foreign key'),
    ]),
  ];

  const subtitle = [
    t.schema || 'public',
    `${t.columns.length} column${t.columns.length === 1 ? '' : 's'}`,
    outgoing.length ? `${outgoing.length} FK` : null,
  ].filter(Boolean).join(' · ');

  panel.replaceChildren(
    sidebarHeader(t.name, subtitle, t.color),
    section('props', 'Properties', null, props),
    section('columns', 'Columns', t.columns.length, [
      t.columns.length ? columns : h('p', { class: 'muted small' }, 'No columns yet.'),
    ], h('button', {
      class: 'sb-add', icon: 'plus', title: 'Add column',
      onclick: (e) => { e.preventDefault(); addColumn(t); },
    }, 'Add')),
    section('relations', 'Relationships', outgoing.length + incoming.length, relations),
    tableScriptsSection(t),
    h('div', { class: 'sb-footer' }, [
      h('button', { icon: 'toggle-tables', onclick: () => dataBrowser.open(tableKey(t)), title: 'Open the rows of this table in a data tab' }, 'Browse data'),
      h('button', { class: 'danger', icon: 'delete', onclick: deleteSelection }, 'Delete table'),
    ]),
  );
}

// Project scripts that use the table (validators, generators, …).
function tableScriptsSection(t) {
  const list = erdScripts?.forTable(t) ?? [];
  if (!list.length) return null;
  const badge = (run) => {
    if (!run) return h('span', { class: 'flag' }, 'not run');
    const fail = run.status === 'error' || (run.validations && run.passed < run.validations);
    return h('span', { class: `flag ${fail ? 'fail' : 'pass'}` }, fail ? 'FAIL' : 'PASS');
  };
  return section('scripts', 'Scripts', list.length, [
    h('ul', { class: 'list' }, list.map(({ script, run, relation }) =>
      h('li', { class: 'clickable', title: `${script.path}\nClick to open`, onclick: () => erdScripts.open(script.path) }, [
        h('span', { class: 'grow' }, [h('span', { class: 'muted' }, `${relation} · `), script.name]),
        badge(run),
      ]))),
  ]);
}

// One column: a summary line, plus an editor when it's the expanded column.
function columnItem(t, c, i, fks) {
  const open = state.expandedCol === c.attnum;
  const badges = [];
  if (c.pk) badges.push(h('span', { class: 'badge pk', title: 'Primary key' }, iconElement('pk')));
  if (fks.has(c.attnum)) badges.push(h('span', { class: 'badge fk', title: 'Foreign key' }, iconElement('fk')));
  const flags = [];
  if (c.notNull || c.pk) flags.push(h('span', { class: 'flag', title: 'NOT NULL' }, 'NN'));
  if (c.default) flags.push(h('span', { class: 'flag def', title: `DEFAULT ${c.default}` }, `= ${c.default}`));

  const summary = h('div', {
    class: 'sb-col-row',
    role: 'button',
    tabindex: 0,
    title: open ? 'Collapse' : 'Edit column',
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

function columnEditor(t, c, i) {
  const check = (prop, label, key) => {
    const cb = h('input', { type: 'checkbox', checked: !!c[prop], 'data-key': key });
    cb.addEventListener('change', () => commitField(() => {
      c[prop] = cb.checked;
      if (prop === 'pk' && cb.checked) c.notNull = true;
    }));
    return h('label', { class: 'check' }, [cb, label]);
  };
  const move = (d) => commit(() => {
    const j = i + d;
    [t.columns[i], t.columns[j]] = [t.columns[j], t.columns[i]];
  });
  return h('div', { class: 'sb-col-editor' }, [
    h('div', { class: 'sb-grid' }, [
      field('Name', bound(c, 'name', 'col-name')),
      field('Type', bound(c, 'type', 'col-type', {
        list: 'pg-types',
        after: (v) => {
          if (!SIZED_TYPE.test(String(v).trim())) c.length = c.precision = null;
        },
      })),
    ]),
    h('div', { class: 'sb-grid' }, [
      field('Length / precision', bound(c, 'length', 'col-length', { type: 'number' })),
      field('Scale', bound(c, 'precision', 'col-scale', { type: 'number' })),
    ]),
    field('Default', bound(c, 'default', 'col-default', { placeholder: 'e.g. now() or \'text\'' })),
    h('div', { class: 'sb-inline' }, [
      check('notNull', 'NOT NULL', 'col-nn'),
      check('pk', 'Primary key', 'col-pk'),
    ]),
    h('div', { class: 'sb-inline end' }, [
      h('button', { icon: 'up', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }),
      h('button', { icon: 'down', title: 'Move down', disabled: i === t.columns.length - 1, onclick: () => move(1) }),
      h('span', { class: 'grow' }),
      h('button', { class: 'danger', icon: 'delete', onclick: () => deleteColumn(t, c) }, 'Delete column'),
    ]),
  ]);
}

function linkItem(l, dir) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const text = dir === 'out'
    ? `${colOf(local, l.localCol)?.name} → ${fullName(ref)}.${colOf(ref, l.refCol)?.name}`
    : `${fullName(local)}.${colOf(local, l.localCol)?.name} → ${colOf(ref, l.refCol)?.name}`;
  return h('li', { class: 'clickable', title: 'Show relationship', onclick: () => select({ type: 'link', id: l.id }) }, [
    h('code', { class: 'grow' }, text),
    h('button', {
      class: 'danger',
      icon: 'close',
      title: 'Delete relationship',
      onclick: (e) => { e.stopPropagation(); commit(() => removeLinks((x) => x.id === l.id)); },
    }),
  ]);
}

function renderLinkPanel(l) {
  const local = tableById(l.localTable);
  const ref = tableById(l.refTable);
  const typeSel = h('select', { 'data-key': 'link-type' }, [
    h('option', { value: 'onetomany' }, 'One to many'),
    h('option', { value: 'onetoone' }, 'One to one'),
  ]);
  typeSel.value = l.type === 'onetoone' ? 'onetoone' : 'onetomany';
  typeSel.addEventListener('change', () => commitField(() => {
    for (const x of state.model.links) if (x.group === l.group) x.type = typeSel.value;
  }));

  const fkName = h('input', { value: l.fkName ?? '', placeholder: '(unnamed)', 'data-key': 'link-name' });
  fkName.addEventListener('change', () => commitField(() => {
    for (const x of state.model.links) if (x.group === l.group) x.fkName = fkName.value;
  }));

  panel.replaceChildren(
    sidebarHeader('Relationship', l.fkName || 'Foreign key'),
    section('link', 'Properties', null, [
      h('p', {}, [
        h('code', {}, `${fullName(local)}.${colOf(local, l.localCol)?.name}`),
        ' references ',
        h('code', {}, `${fullName(ref)}.${colOf(ref, l.refCol)?.name}`),
      ]),
      field('Constraint name', fkName),
      field('Cardinality', typeSel),
      h('div', { class: 'actions' }, [
        h('button', { icon: 'go', onclick: () => select({ type: 'table', id: local.id }) }, `Go to ${local.name}`),
        h('button', { icon: 'go', onclick: () => select({ type: 'table', id: ref.id }) }, `Go to ${ref.name}`),
      ]),
    ]),
    h('div', { class: 'sb-footer' }, [
      h('button', { class: 'danger', icon: 'delete', onclick: deleteSelection }, 'Delete relationship'),
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

// `col` expands that column's editor in the sidebar.
function select(sel, { col } = {}) {
  if (sel?.id !== state.selection?.id) state.expandedCol = null;
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
  if (!sel || sel.type === 'script') return;
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

svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  const tableEl = e.target.closest('.erd-table');
  const linkEl = e.target.closest('.erd-link');
  const scriptEl = e.target.closest('.erd-script');
  svg.setPointerCapture(e.pointerId);
  if (scriptEl && e.button === 0) {
    if (state.selection?.id !== scriptEl.dataset.path) select({ type: 'script', id: scriptEl.dataset.path });
    drag = erdScripts.startDrag(scriptEl, e);
  } else if (tableEl && e.button === 0) {
    const t = tableById(tableEl.dataset.id);
    const rowEl = e.target.closest('.t-row');
    const col = rowEl ? Number(rowEl.dataset.attnum) : undefined;
    if (state.selection?.id !== t.id || (col !== undefined && col !== state.expandedCol)) {
      select({ type: 'table', id: t.id }, { col });
    }
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

function endDrag() {
  if (drag?.kind === 'script') erdScripts.endDrag(drag);
  if (drag?.kind === 'table' && drag.moved) setDirty(true);
  if (drag?.kind === 'table' && !drag.moved) ensureVisible(drag.t);
  if (drag?.kind === 'pan') svg.classList.remove('panning');
  drag = null;
  render();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

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
  const moved = target !== state.filePath;
  state.filePath = target;
  setDirty(false);
  if (moved) emit('file');
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
  const b = diagramBounds();
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const clone = viewport.cloneNode(true);
  clone.removeAttribute('transform');
  clone.querySelectorAll('.selected, .related, .focused').forEach((n) => n.classList.remove('selected', 'related', 'focused'));
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
    status(state.snap ? 'Snap to grid on' : 'Snap to grid off');
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
  tabs.show('erd');
  select({ type: 'table', id: t.id });
  centerOn(t);
  return true;
}

function selectedTableIds() {
  const sel = state.selection;
  if (sel?.type === 'table') return [tableKey(tableById(sel.id))];
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
const workbenchCtx = {
  host, state, h, status, db, events, tabs, focusTable, selectedTableIds,
  hasTable: (key) => !!findDiagramTable(key),
  saveDiagram: () => save(false),
  refreshSchema: () => db.refreshSchema(),
};
const workbench = setupWorkbench(workbenchCtx);
const assistant = setupAssistant(workbenchCtx, workbench.api);
const dataBrowser = setupDataBrowser(workbenchCtx);
const query = setupQuery(workbenchCtx);
erdScripts = setupErdScripts({ ...workbenchCtx, el, measure, workbench: workbench.api, select, render, focusTable });
Object.assign(workbenchCtx, {
  aiConfig: assistant.aiConfig,
  askAssistant: assistant.ask,
  openData: dataBrowser.open,
  openSql: query.setSql,
});
Object.assign(commands, dbCommands, spreadsheet.commands, workbench.commands, assistant.commands, dataBrowser.commands, query.commands, {
  'tab-erd': () => tabs.show('erd'),
  'toggle-erd-scripts': () => {
    tabs.show('erd');
    erdScripts.setShown(!erdScripts.shown());
  },
});
// The diagram re-renders when its tab comes back (sizes are measured on screen).
tabs.onShow((name) => {
  if (name === 'erd') render();
});

function runCommand(name) {
  const fn = commands[name];
  if (fn) Promise.resolve(fn()).catch((err) => status(`Error: ${err.message}`));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (btn) runCommand(btn.dataset.cmd);
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
  status('SQL copied to clipboard');
});

// Keys typed in fields, the script editor or the assistant are not diagram shortcuts.
const isEditing = (e) =>
  /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || tabs.current() !== 'erd';

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
    // Shift nudges by 1px; otherwise move one cell, landing on the next grid
    // line when snapping is on.
    const g = gridSize();
    const move = (v, dir) => {
      if (e.shiftKey) return v + dir;
      if (!state.snap) return v + dir * g;
      return dir > 0 ? Math.floor(v / g) * g + g : Math.ceil(v / g) * g - g;
    };
    commit(() => {
      if (e.key === 'ArrowLeft') t.x = move(t.x, -1);
      if (e.key === 'ArrowRight') t.x = move(t.x, 1);
      if (e.key === 'ArrowUp') t.y = move(t.y, -1);
      if (e.key === 'ArrowDown') t.y = move(t.y, 1);
    }, { panel: false });
  }
});

// Drag and drop .pgerd files onto the window; spreadsheets open the import dialog.
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
  if (SPREADSHEET_EXT.test(file.name)) {
    const open = document.querySelector('dialog[open]');
    if (!open || open.id === 'xl-import-dialog') await spreadsheet.openFile(file.name, await file.arrayBuffer());
    return;
  }
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
