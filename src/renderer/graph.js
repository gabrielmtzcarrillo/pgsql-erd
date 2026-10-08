// The Graph tab: Apache AGE graphs. A sidebar lists the graphs with their
// vertex labels and relationship types; the main area has
// - Relationships: a pageable, searchable list of edges with their end
//   vertices, and forms to create, edit and delete relationships;
// - Vertices: the same for vertices, with their relationship counts;
// - Explorer: a force-directed view to browse the graph and connect vertices;
// - Cypher: a console for Cypher queries, with results as a table or graph.
// Changes are committed immediately, only on connections whose policy allows
// them, and are recorded in the audit log.

import { vertexCaption, formatAgValue, formatProperties, graphElements, isGraphName, isLabelName } from '../shared/age.js';
import { decorateButtons } from './icons.js';
import { tr, trn, formatNumber } from '../shared/i18n.js';
import { envName } from './dbui.js';

const $ = (sel) => document.querySelector(sel);
const GRAPH_KEY = 'pgsql-erd.graph';
const CYPHER_KEY = 'pgsql-erd.cypher';
const SVG_NS = 'http://www.w3.org/2000/svg';
const PAGE = 100;

// Label colours: by position among the graph's vertex labels (so they differ),
// or by a hash of the name for labels not in the list.
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#499894'];
let labelOrder = [];
const colorOf = (label) => {
  const i = labelOrder.indexOf(label);
  if (i !== -1) return PALETTE[i % PALETTE.length];
  let x = 0;
  for (const ch of String(label)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[x % PALETTE.length];
};

export function setupGraph(ctx) {
  const { host, h, status, db, tabs, events } = ctx;
  const page = $('#graph-page');
  const side = $('#gr-side-body');
  let seq = 0;

  // The state of one Graph tab. The tabs share the page; `st` is the state of
  // the tab in front. A new tab starts on the graph and Cypher used last.
  const freshState = () => ({
    info: null, // age.status()
    error: null,
    loaded: false,
    graph: load(GRAPH_KEY, null),
    pane: 'edges',
    edges: { label: '', search: '', around: null, offset: 0, data: null, form: null, editing: null },
    vertices: { label: '', search: '', offset: 0, data: null, form: null, editing: null },
    explore: { nodes: new Map(), links: new Map(), selected: null, connectFrom: null, view: { x: 0, y: 0, k: 1 } },
    cypher: { text: load(CYPHER_KEY, 'MATCH (a)-[r]->(b)\nRETURN a, r, b\nLIMIT 50'), columns: '', result: null, error: null },
    sideForm: null, // { kind: 'graph' | 'v' | 'e' }
  });
  const graphTabs = new Map(); // tab id -> { st, title, filePath }
  let st = freshState();
  let tabSeq = 0;
  const isShown = () => tabs.kind(tabs.current()) === 'graph';

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not remembered
    }
  }
  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const setStatus = (text, cls = '') => {
    const el = $('#gr-status');
    el.textContent = text;
    el.className = `small ${cls || 'muted'}`;
  };
  const currentGraph = () => st.info?.graphs.find((g) => g.name === st.graph) ?? null;
  const labelsOf = (kind) => (currentGraph()?.[kind === 'e' ? 'edgeLabels' : 'vertexLabels'] ?? []).map((l) => l.name);

  // Parse a properties textarea: empty = {}.
  function parseProps(text) {
    const s = String(text ?? '').trim();
    if (!s) return {};
    let v;
    try {
      v = JSON.parse(s);
    } catch (err) {
      throw new Error(tr('Properties are not valid JSON: {message}', { message: err.message }));
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(tr('Properties must be a JSON object, e.g. {"since": 2020}.'));
    return v;
  }
  const propsText = (p) => (p && Object.keys(p).length ? JSON.stringify(p, null, 2) : '');

  // ------------------------------------------------------------ changes

  // Runs a change after confirmation (when `confirm` is given), then reloads.
  async function change(op, args, { confirm, done } = {}) {
    if (confirm) {
      const info = db.info();
      const choice = await host.confirm({
        message: confirm,
        detail: `${info?.description ?? ''} (${envName(info?.profile.environment ?? '')})\n\n${tr('This is committed immediately.')}`,
        buttons: [tr('OK'), tr('Cancel')],
      });
      if (choice !== 0) return null;
    }
    try {
      const r = await call(host.age.change, op, { graph: st.graph, ...args });
      done?.(r);
      await refresh({ keepPane: true });
      return r;
    } catch (err) {
      status(`Graph: ${err.message}`);
      setStatus(err.message, 'error');
      throw err;
    }
  }

  // ------------------------------------------------------------ loading

  async function refresh({ keepPane = false } = {}) {
    const s = st;
    s.loaded = true;
    if (!db.connected()) {
      st.info = null;
      st.error = null;
      renderSide();
      renderPane();
      return;
    }
    try {
      s.info = await call(host.age.status);
      s.error = null;
    } catch (err) {
      s.info = null;
      s.error = err.message;
    }
    if (s !== st) return; // another tab came to the front meanwhile
    if (st.info && !currentGraph()) st.graph = st.info.graphs[0]?.name ?? null;
    save(GRAPH_KEY, st.graph);
    renderSide();
    if (keepPane) await reloadPane();
    else {
      st.edges.data = st.vertices.data = null;
      await reloadPane();
    }
  }

  async function reloadPane() {
    if (!st.info?.version || !st.graph) return renderPane();
    const s = st;
    try {
      if (s.pane === 'edges') {
        const e = s.edges;
        e.data = await call(host.age.edges, { graph: s.graph, label: e.label, search: e.search, around: e.around?.id ?? null, limit: PAGE, offset: e.offset });
      } else if (s.pane === 'vertices') {
        const v = s.vertices;
        v.data = await call(host.age.vertices, { graph: s.graph, label: v.label, search: v.search, limit: PAGE, offset: v.offset });
      } else if (s.pane === 'explore' && !s.explore.nodes.size) {
        await loadSample(100);
      }
      if (s === st) setStatus('');
    } catch (err) {
      if (s === st) setStatus(err.message, 'error');
    }
    if (s === st) renderPane();
  }

  function selectGraph(name) {
    st.graph = name;
    save(GRAPH_KEY, name);
    st.edges = { ...st.edges, label: '', around: null, offset: 0, data: null, form: null, editing: null };
    st.vertices = { ...st.vertices, label: '', offset: 0, data: null, form: null, editing: null };
    clearExplorer();
    renderSide();
    reloadPane();
  }

  // ------------------------------------------------------------ sidebar

  function renderSide() {
    labelOrder = labelsOf('v');
    const nodes = [];
    if (!db.connected()) {
      nodes.push(h('div', { class: 'gr-note' }, [
        h('p', {}, tr('Connect to a database to manage its Apache AGE graphs.')),
        h('button', { type: 'button', class: 'primary', onclick: () => db.openConnect(() => refresh()) }, tr('Connect…')),
      ]));
    } else if (st.error) {
      nodes.push(h('div', { class: 'gr-note error' }, st.error));
    } else if (st.info && !st.info.version) {
      nodes.push(h('div', { class: 'gr-note' }, st.info.available
        ? [
            h('p', {}, tr('Apache AGE is available on this server but not installed in this database.')),
            h('button', { type: 'button', class: 'primary', onclick: () => change('install', {}, { confirm: tr('Install the Apache AGE extension (CREATE EXTENSION age)?') }) }, tr('Install AGE')),
          ]
        : [
            h('p', {}, tr('Apache AGE is not installed on this PostgreSQL server.')),
            h('p', { class: 'muted small' }, tr('Install it from age.apache.org (or your package manager, e.g. postgresql-16-age), then reload.')),
          ]));
    } else if (st.info) {
      if (st.sideForm?.kind === 'graph') nodes.push(sideForm(tr('New graph name'), (name) => {
        if (!isGraphName(name)) throw new Error(tr('Graph names have 3–63 letters, digits or _, starting with a letter.'));
        return change('create-graph', { graph: name }, { done: () => (st.graph = name) });
      }));
      if (!st.info.graphs.length && !st.sideForm) nodes.push(h('div', { class: 'gr-note' }, [h('p', {}, tr('No graphs yet.')), h('button', { type: 'button', onclick: () => openSideForm('graph') }, tr('Create a graph'))]));
      for (const g of st.info.graphs) {
        const active = g.name === st.graph;
        const vCount = g.vertexLabels.reduce((n, l) => n + l.count, 0);
        const eCount = g.edgeLabels.reduce((n, l) => n + l.count, 0);
        nodes.push(h('div', { class: `wb-item gr-graph${active ? ' active' : ''}`, onclick: () => selectGraph(g.name), title: `${trn(vCount, '{n} vertex', '{n} vertices')} · ${trn(eCount, '{n} relationship', '{n} relationships')}` }, [
          h('span', { class: 'grow' }, g.name),
          h('span', { class: 'muted small' }, `${vCount} · ${eCount}`),
          h('button', {
            type: 'button', class: 'wb-del', title: tr('Drop graph'),
            onclick: (e) => {
              e.stopPropagation();
              change('drop-graph', { graph: g.name }, { confirm: tr('Drop graph {name} with all its vertices and relationships?', { name: g.name }) });
            },
          }, '×'),
        ]));
        if (active) {
          nodes.push(labelGroup(tr('Vertex labels'), 'v', g.vertexLabels));
          nodes.push(labelGroup(tr('Relationship types'), 'e', g.edgeLabels));
        }
      }
    }
    side.replaceChildren(...nodes);
    $('#gr-new-graph').disabled = !st.info?.version;
  }

  function labelGroup(title, kind, labels) {
    const items = labels.map((l) =>
      h('div', {
        class: 'wb-item gr-label', title: kind === 'e' ? tr('Show these relationships') : tr('Show these vertices'),
        onclick: () => {
          if (kind === 'e') Object.assign(st.edges, { label: l.name, around: null, offset: 0 });
          else Object.assign(st.vertices, { label: l.name, offset: 0 });
          showPane(kind === 'e' ? 'edges' : 'vertices');
        },
      }, [
        h('span', { class: 'gr-swatch', style: `background:${kind === 'e' ? 'var(--muted)' : colorOf(l.name)}` }),
        h('span', { class: 'grow' }, l.name),
        h('span', { class: 'muted small' }, formatNumber(l.count)),
        h('button', {
          type: 'button', class: 'wb-del', title: tr('Drop label'),
          onclick: (e) => {
            e.stopPropagation();
            const args = { name: l.name, n: formatNumber(l.count) };
            const confirm = kind === 'e'
              ? tr('Drop relationship type {name} and its {n} relationships?', args)
              : tr('Drop vertex label {name} and its {n} vertices?', args);
            change('drop-label', { label: l.name }, { confirm });
          },
        }, '×'),
      ])
    );
    return h('div', { class: 'gr-group' }, [
      h('div', { class: 'wb-group gr-group-head' }, [
        h('span', { class: 'grow' }, title),
        h('button', { type: 'button', class: 'gr-mini', title: kind === 'e' ? tr('New relationship type') : tr('New vertex label'), onclick: () => openSideForm(kind) }, '+'),
      ]),
      st.sideForm?.kind === kind
        ? sideForm(kind === 'e' ? tr('Relationship type, e.g. KNOWS') : tr('Vertex label, e.g. Person'), (name) => {
            if (!isLabelName(name)) throw new Error(tr('Label names use letters, digits and _, starting with a letter.'));
            return change('create-label', { kind, label: name });
          })
        : null,
      ...(items.length ? items : [h('div', { class: 'gr-empty-item muted small' }, tr('None yet'))]),
    ]);
  }

  function openSideForm(kind) {
    st.sideForm = { kind };
    renderSide();
    side.querySelector('.gr-side-form input')?.focus();
  }

  function sideForm(placeholder, submit) {
    const input = h('input', { type: 'text', placeholder, spellcheck: false });
    const err = h('div', { class: 'gr-form-error' });
    const go = async () => {
      try {
        await submit(input.value.trim());
        st.sideForm = null;
        renderSide();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') {
        st.sideForm = null;
        renderSide();
      }
    });
    return h('div', { class: 'gr-side-form' }, [
      input,
      h('button', { type: 'button', class: 'primary', onclick: go }, tr('Create')),
      h('button', { type: 'button', onclick: () => ((st.sideForm = null), renderSide()) }, tr('Cancel')),
      err,
    ]);
  }

  // ------------------------------------------------------------ panes

  function showPane(name) {
    st.pane = name;
    syncPaneTabs();
    reloadPane();
  }
  function syncPaneTabs() {
    for (const b of page.querySelectorAll('[data-gtab]')) b.classList.toggle('active', b.dataset.gtab === st.pane);
    for (const p of page.querySelectorAll('[data-gpane]')) p.hidden = p.dataset.gpane !== st.pane;
  }
  page.querySelector('.gr-main .wb-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gtab]');
    if (b) showPane(b.dataset.gtab);
  });

  function renderPane() {
    const pane = page.querySelector(`[data-gpane="${st.pane}"]`);
    let body;
    if (!db.connected() || !st.info?.version) body = [h('div', { class: 'db-empty' }, tr('Apache AGE graphs appear here once you connect to a database with AGE installed.'))];
    else if (!st.graph) body = [h('div', { class: 'db-empty' }, tr('Create a graph in the sidebar to start.'))];
    else if (st.pane === 'edges') body = edgesPane();
    else if (st.pane === 'vertices') body = verticesPane();
    else if (st.pane === 'explore') body = explorePane();
    else body = cypherPane();
    pane.replaceChildren(...body.filter(Boolean));
    decorateButtons(pane);
  }

  function pager(view, reload) {
    const d = view.data;
    if (!d) return null;
    const from = d.total ? view.offset + 1 : 0;
    const to = view.offset + d.rows.length;
    return h('span', { class: 'gr-pager' }, [
      h('span', { class: 'muted small' }, tr('{from}–{to} of {total}', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(d.total) })),
      h('button', { type: 'button', disabled: view.offset === 0, onclick: () => ((view.offset = Math.max(0, view.offset - PAGE)), reload()) }, '‹'),
      h('button', { type: 'button', disabled: to >= d.total, onclick: () => ((view.offset += PAGE), reload()) }, '›'),
    ]);
  }

  function labelSelect(kind, value, onchange) {
    const sel = h('select', { title: kind === 'e' ? tr('Relationship type') : tr('Vertex label'), onchange: (e) => onchange(e.target.value) }, [
      h('option', { value: '' }, kind === 'e' ? tr('All types') : tr('All labels')),
      ...labelsOf(kind).map((l) => h('option', { value: l }, l)),
    ]);
    sel.value = value;
    return sel;
  }

  function searchBox(value, placeholder, onsearch) {
    const input = h('input', { type: 'search', placeholder, value, spellcheck: false, class: 'gr-search' });
    input.addEventListener('input', debounce(() => onsearch(input.value.trim()), 300));
    return input;
  }

  function labelList(kind) {
    const id = `gr-dl-${++seq}`;
    return { id, el: h('datalist', { id }, labelsOf(kind).map((l) => h('option', { value: l }))) };
  }

  function vertexChip(v, onclick) {
    return h('span', { class: 'gr-vertex', title: `${v.label} #${v.id}\n${formatProperties(v.properties)}`, onclick }, [
      h('span', { class: 'gr-dot', style: `background:${colorOf(v.label)}` }),
      h('span', { class: 'gr-caption' }, vertexCaption(v)),
      h('span', { class: 'gr-lbl' }, v.label),
    ]);
  }

  // Search-as-you-type vertex input. Returns { el, get(), set(v) }.
  function vertexPicker(placeholder, initial = null) {
    const id = `gr-vp-${++seq}`;
    const list = h('datalist', { id });
    const input = h('input', { type: 'text', placeholder, list: id, spellcheck: false, autocomplete: 'off', class: 'gr-picker-input' });
    const text = (v) => `${vertexCaption(v)} (${v.label}) #${v.id}`;
    let options = new Map();
    let chosen = initial;
    if (initial) input.value = text(initial);
    const lookup = debounce(async () => {
      try {
        const r = await call(host.age.vertices, { graph: st.graph, search: input.value.replace(/\s*\(.*$/, '').trim(), limit: 25 });
        options = new Map(r.rows.map((x) => [x.vertex.id, x.vertex]));
        list.replaceChildren(...r.rows.map((x) => h('option', { value: text(x.vertex) })));
      } catch {
        // suggestions are optional
      }
    }, 200);
    input.addEventListener('input', () => {
      const m = input.value.match(/#(\d+)$/);
      chosen = m ? options.get(m[1]) ?? (chosen?.id === m[1] ? chosen : { id: m[1], label: '?', properties: {} }) : null;
      if (!m) lookup();
    });
    input.addEventListener('focus', () => {
      if (!options.size) lookup();
    });
    return {
      el: h('span', { class: 'gr-picker' }, [input, list]),
      get: () => chosen,
      set(v) {
        chosen = v;
        input.value = v ? text(v) : '';
      },
    };
  }

  // ------------------------------------------------------------ relationships

  function edgesPane() {
    const e = st.edges;
    const reload = () => reloadPane();
    const toolbar = h('div', { class: 'gr-toolbar' }, [
      h('button', { type: 'button', class: 'primary', 'data-icon': 'add-link', onclick: () => openEdgeForm() }, tr('New relationship')),
      labelSelect('e', e.label, (v) => ((e.label = v), (e.offset = 0), reload())),
      searchBox(e.search, tr('Search properties and labels'), (v) => ((e.search = v), (e.offset = 0), reload())),
      e.around ? h('span', { class: 'gr-filter-chip' }, [`${tr('Around')} `, vertexChip(e.around), h('button', { type: 'button', title: tr('Show all relationships'), onclick: () => ((e.around = null), (e.offset = 0), reload()) }, '×')]) : null,
      h('button', { type: 'button', 'data-icon': 'refresh', title: tr('Reload'), onclick: () => refresh({ keepPane: true }) }),
      h('span', { class: 'grow' }),
      pager(e, reload),
    ]);
    const rows = (e.data?.rows ?? []).map(({ edge, start, end }) => {
      const editing = e.editing === edge.id;
      const ta = editing ? h('textarea', { class: 'gr-props-edit', rows: 4, spellcheck: false }, propsText(edge.properties)) : null;
      return h('tr', { class: editing ? 'editing' : '' }, [
        h('td', {}, vertexChip(start, () => focusVertex(start))),
        h('td', {}, h('span', { class: 'gr-type' }, [h('span', { class: 'gr-arrow' }, '—'), edge.label, h('span', { class: 'gr-arrow' }, '→')])),
        h('td', {}, vertexChip(end, () => focusVertex(end))),
        h('td', { class: 'gr-props' }, editing ? ta : formatProperties(edge.properties)),
        h('td', { class: 'gr-actions' }, editing
          ? [
              h('button', { type: 'button', class: 'primary', onclick: () => saveProps('edge', edge.id, ta.value, () => (e.editing = null)) }, tr('Save')),
              h('button', { type: 'button', onclick: () => ((e.editing = null), renderPane()) }, tr('Cancel')),
            ]
          : [
              h('button', { type: 'button', title: tr('Edit properties'), onclick: () => ((e.editing = edge.id), renderPane()) }, tr('Edit')),
              h('button', { type: 'button', class: 'danger', title: tr('Delete relationship'), onclick: () => change('delete-edge', { id: edge.id }, { confirm: tr('Delete relationship {rel}?', { rel: `${vertexCaption(start)} —${edge.label}→ ${vertexCaption(end)}` }) }) }, tr('Delete')),
            ]),
      ]);
    });
    const table = h('table', { class: 'dt-grid gr-table' }, [
      h('thead', {}, h('tr', {}, [tr('From'), tr('Relationship'), tr('To'), tr('Properties'), ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows),
    ]);
    const empty = e.data && !e.data.rows.length
      ? h('div', { class: 'db-empty' }, e.search || e.label || e.around ? tr('No relationships match.') : tr('No relationships yet. Use “New relationship” to connect two vertices.'))
      : null;
    return [toolbar, e.form ? edgeForm() : null, h('div', { class: 'gr-scroll' }, [table, empty])];
  }

  function openEdgeForm(from = null, to = null) {
    st.edges.form = { from, to, label: st.edges.label || labelsOf('e')[0] || '', props: '' };
    if (st.pane !== 'edges') showPane('edges');
    else renderPane();
    page.querySelector('.gr-form .gr-picker-input')?.focus();
  }

  function edgeForm() {
    const f = st.edges.form;
    const from = vertexPicker(tr('From vertex — type to search'), f.from);
    const to = vertexPicker(tr('To vertex — type to search'), f.to);
    const types = labelList('e');
    const type = h('input', { type: 'text', value: f.label, list: types.id, placeholder: tr('Type, e.g. KNOWS'), spellcheck: false, class: 'gr-type-input' });
    const props = h('textarea', { rows: 2, placeholder: tr('Properties (JSON), e.g. {"since": 2020}'), spellcheck: false }, f.props);
    const err = h('div', { class: 'gr-form-error' });
    const create = async () => {
      err.textContent = '';
      try {
        const a = from.get();
        const b = to.get();
        if (!a || !b) throw new Error(tr('Pick both vertices from the suggestions (or type their #id).'));
        if (!isLabelName(type.value.trim())) throw new Error(tr('Type a relationship type: letters, digits and _, starting with a letter.'));
        const properties = parseProps(props.value);
        Object.assign(f, { from: a, to: b, label: type.value.trim(), props: props.value });
        await change('create-edge', { from: a.id, to: b.id, label: f.label, properties }, {
          done: () => {
            status(tr('Relationship {type} created', { type: f.label }));
            st.edges.form = null;
          },
        });
      } catch (x) {
        err.textContent = x.message;
      }
    };
    return h('div', { class: 'gr-form' }, [
      h('div', { class: 'gr-form-title' }, tr('New relationship')),
      h('div', { class: 'gr-form-row' }, [
        from.el,
        h('span', { class: 'gr-arrow' }, '—'),
        type, types.el,
        h('span', { class: 'gr-arrow' }, '→'),
        to.el,
        h('button', { type: 'button', title: tr('Swap direction'), onclick: () => {
          const a = from.get();
          from.set(to.get());
          to.set(a);
        } }, '⇄'),
      ]),
      props,
      h('div', { class: 'gr-form-row end' }, [
        err,
        h('span', { class: 'grow' }),
        h('button', { type: 'button', onclick: () => ((st.edges.form = null), renderPane()) }, tr('Cancel')),
        h('button', { type: 'button', class: 'primary', onclick: create }, tr('Create relationship')),
      ]),
    ]);
  }

  async function saveProps(kind, id, text, done) {
    try {
      const properties = parseProps(text);
      await change('set-properties', { kind, id, properties }, { done });
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // ------------------------------------------------------------ vertices

  function verticesPane() {
    const v = st.vertices;
    const reload = () => reloadPane();
    const toolbar = h('div', { class: 'gr-toolbar' }, [
      h('button', { type: 'button', class: 'primary', 'data-icon': 'plus', onclick: () => ((v.form = { label: v.label || labelsOf('v')[0] || '', props: '' }), renderPane()) }, tr('New vertex')),
      labelSelect('v', v.label, (x) => ((v.label = x), (v.offset = 0), reload())),
      searchBox(v.search, tr('Search properties, labels or #id'), (x) => ((v.search = x), (v.offset = 0), reload())),
      h('button', { type: 'button', 'data-icon': 'refresh', title: tr('Reload'), onclick: () => refresh({ keepPane: true }) }),
      h('span', { class: 'grow' }),
      pager(v, reload),
    ]);
    const rows = (v.data?.rows ?? []).map(({ vertex, degree }) => {
      const editing = v.editing === vertex.id;
      const ta = editing ? h('textarea', { class: 'gr-props-edit', rows: 4, spellcheck: false }, propsText(vertex.properties)) : null;
      return h('tr', {}, [
        h('td', {}, vertexChip(vertex, () => focusVertex(vertex))),
        h('td', { class: 'gr-props' }, editing ? ta : formatProperties(vertex.properties)),
        h('td', { class: 'num' }, h('a', { href: '#', title: tr('Show its relationships'), onclick: (e) => {
          e.preventDefault();
          Object.assign(st.edges, { around: vertex, label: '', offset: 0 });
          showPane('edges');
        } }, formatNumber(degree))),
        h('td', { class: 'gr-actions' }, editing
          ? [
              h('button', { type: 'button', class: 'primary', onclick: () => saveProps('vertex', vertex.id, ta.value, () => (v.editing = null)) }, tr('Save')),
              h('button', { type: 'button', onclick: () => ((v.editing = null), renderPane()) }, tr('Cancel')),
            ]
          : [
              h('button', { type: 'button', title: tr('New relationship from this vertex'), onclick: () => openEdgeForm(vertex) }, tr('Connect')),
              h('button', { type: 'button', title: tr('Show in the explorer'), onclick: () => focusVertex(vertex) }, tr('Explore')),
              h('button', { type: 'button', title: tr('Edit properties'), onclick: () => ((v.editing = vertex.id), renderPane()) }, tr('Edit')),
              h('button', { type: 'button', class: 'danger', title: tr('Delete the vertex and its relationships'), onclick: () => change('delete-vertex', { id: vertex.id }, {
                confirm: degree
                  ? trn(degree, 'Delete {vertex} and its {n} relationship?', 'Delete {vertex} and its {n} relationships?', { vertex: `${vertexCaption(vertex)} (${vertex.label})` })
                  : tr('Delete {vertex}?', { vertex: `${vertexCaption(vertex)} (${vertex.label})` }),
              }) }, tr('Delete')),
            ]),
      ]);
    });
    const table = h('table', { class: 'dt-grid gr-table' }, [
      h('thead', {}, h('tr', {}, [tr('Vertex'), tr('Properties'), tr('Relationships'), ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows),
    ]);
    const empty = v.data && !v.data.rows.length ? h('div', { class: 'db-empty' }, v.search || v.label ? tr('No vertices match.') : tr('No vertices yet. Use “New vertex” to add one.')) : null;
    return [toolbar, v.form ? vertexForm() : null, h('div', { class: 'gr-scroll' }, [table, empty])];
  }

  function vertexForm() {
    const f = st.vertices.form;
    const labels = labelList('v');
    const label = h('input', { type: 'text', value: f.label, list: labels.id, placeholder: tr('Label, e.g. Person'), spellcheck: false, class: 'gr-type-input' });
    const props = h('textarea', { rows: 3, placeholder: tr('Properties (JSON), e.g. {"name": "Ann"}'), spellcheck: false }, f.props);
    const err = h('div', { class: 'gr-form-error' });
    const create = async () => {
      err.textContent = '';
      try {
        if (!isLabelName(label.value.trim())) throw new Error(tr('Type a label: letters, digits and _, starting with a letter.'));
        Object.assign(f, { label: label.value.trim(), props: props.value });
        await change('create-vertex', { label: f.label, properties: parseProps(props.value) }, {
          done: (vx) => {
            status(tr('Vertex {name} created', { name: vertexCaption(vx) }));
            st.vertices.form = null;
          },
        });
      } catch (x) {
        err.textContent = x.message;
      }
    };
    return h('div', { class: 'gr-form' }, [
      h('div', { class: 'gr-form-title' }, tr('New vertex')),
      h('div', { class: 'gr-form-row' }, [label, labels.el]),
      props,
      h('div', { class: 'gr-form-row end' }, [
        err,
        h('span', { class: 'grow' }),
        h('button', { type: 'button', onclick: () => ((st.vertices.form = null), renderPane()) }, tr('Cancel')),
        h('button', { type: 'button', class: 'primary', onclick: create }, tr('Create vertex')),
      ]),
    ]);
  }

  // ------------------------------------------------------------ explorer

  function clearExplorer() {
    const x = st.explore;
    x.nodes.clear();
    x.links.clear();
    x.selected = null;
    x.connectFrom = null;
    x.view = { x: 0, y: 0, k: 1 };
    x.autoFit = true;
  }

  // Adds vertices and edges to the explorer (edges need both ends present).
  function addToExplorer(vertices, edges, near = null) {
    const x = st.explore;
    for (const v of vertices) {
      const old = x.nodes.get(v.id);
      if (old) old.v = v;
      else {
        const a = Math.random() * Math.PI * 2;
        const r = near ? 60 + Math.random() * 40 : 150 + Math.random() * 150;
        x.nodes.set(v.id, { v, x: (near?.x ?? 0) + Math.cos(a) * r, y: (near?.y ?? 0) + Math.sin(a) * r, vx: 0, vy: 0 });
      }
    }
    for (const e of edges) if (x.nodes.has(e.start) && x.nodes.has(e.end)) x.links.set(e.id, e);
    // Fit once the layout settles, unless the user has moved the view.
    if (!near) x.autoFit = true;
    x.relayout = 1;
  }

  async function loadSample(limit) {
    clearExplorer();
    const [e, v] = await Promise.all([
      call(host.age.edges, { graph: st.graph, limit }),
      call(host.age.vertices, { graph: st.graph, limit: Math.max(20, Math.round(limit / 2)) }),
    ]);
    addToExplorer([...e.rows.flatMap((r) => [r.start, r.end]), ...v.rows.map((r) => r.vertex)], e.rows.map((r) => r.edge));
  }

  async function expand(id) {
    try {
      const r = await call(host.age.edges, { graph: st.graph, around: id, limit: 200 });
      const near = st.explore.nodes.get(id);
      addToExplorer(r.rows.flatMap((x) => [x.start, x.end]), r.rows.map((x) => x.edge), near);
      if (r.total > r.rows.length) setStatus(tr('Showing {n} of {total} relationships of this vertex', { n: r.rows.length, total: formatNumber(r.total) }));
      renderPane();
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  async function focusVertex(v) {
    st.pane = 'explore';
    for (const b of page.querySelectorAll('[data-gtab]')) b.classList.toggle('active', b.dataset.gtab === 'explore');
    for (const p of page.querySelectorAll('[data-gpane]')) p.hidden = p.dataset.gpane !== 'explore';
    if (!st.explore.nodes.has(v.id)) addToExplorer([v], []);
    st.explore.selected = { type: 'vertex', id: v.id };
    await expand(v.id);
  }

  function explorePane() {
    const x = st.explore;
    const picker = vertexPicker(tr('Find a vertex…'));
    const toolbar = h('div', { class: 'gr-toolbar' }, [
      h('select', { title: tr('Load a sample of the graph'), onchange: async (e) => {
        const n = Number(e.target.value);
        e.target.value = '';
        if (!n) return;
        try {
          await loadSample(n);
        } catch (err) {
          setStatus(err.message, 'error');
        }
        renderPane();
      } }, [h('option', { value: '' }, tr('Load sample…')), ...[50, 100, 250, 500].map((n) => h('option', { value: String(n) }, trn(n, '{n} relationship', '{n} relationships')))]),
      picker.el,
      h('button', { type: 'button', title: tr('Add the vertex and its relationships'), onclick: () => picker.get() && focusVertex(picker.get()) }, tr('Add')),
      h('button', { type: 'button', 'data-icon': 'fit', title: tr('Fit to view'), onclick: () => fitView() }),
      h('button', { type: 'button', title: tr('Remove everything from the view'), onclick: () => (clearExplorer(), renderPane()) }, tr('Clear')),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted small gr-hint' }, explorerHint()),
    ]);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'gr-canvas');
    svg.setAttribute('tabindex', '0');
    const wrap = h('div', { class: 'gr-explore' }, [svg, detailPanel()]);
    requestAnimationFrame(() => drawGraph(svg));
    return [toolbar, wrap];
  }

  function explorerHint() {
    const x = st.explore;
    return x.connectFrom
      ? tr('Click the vertex to connect {name} to (Esc cancels)', { name: vertexCaption(x.nodes.get(x.connectFrom)?.v) })
      : `${trn(x.nodes.size, '{n} vertex', '{n} vertices')} · ${trn(x.links.size, '{n} relationship', '{n} relationships')} · ${tr('double-click expands · Shift+click connects')}`;
  }

  // Selection changes update the explorer in place (re-drawing would restart the layout).
  function updateSelection() {
    const x = st.explore;
    const pane = page.querySelector('[data-gpane="explore"]');
    if (!pane || st.pane !== 'explore') return;
    for (const g of pane.querySelectorAll('.gr-node')) {
      g.classList.toggle('selected', x.selected?.type === 'vertex' && x.selected.id === g.dataset.id);
      g.classList.toggle('source', x.connectFrom === g.dataset.id);
    }
    for (const g of pane.querySelectorAll('.gr-link')) g.classList.toggle('selected', x.selected?.type === 'edge' && x.selected.id === g.dataset.id);
    pane.querySelector('.gr-detail')?.replaceWith(detailPanel());
    const hint = pane.querySelector('.gr-hint');
    if (hint) hint.textContent = explorerHint();
    decorateButtons(pane);
  }

  // Removes a vertex and its relationships from the explorer.
  function hideVertex(id) {
    const x = st.explore;
    x.nodes.delete(id);
    for (const l of [...x.links.values()]) if (l.start === id || l.end === id) x.links.delete(l.id);
    if (x.selected?.id === id) x.selected = null;
  }

  function detailPanel() {
    const x = st.explore;
    const sel = x.selected;
    if (!sel) return h('aside', { class: 'gr-detail muted small' }, tr('Select a vertex or relationship to see its properties.'));
    if (sel.type === 'vertex') {
      const n = x.nodes.get(sel.id);
      if (!n) return h('aside', { class: 'gr-detail' });
      const v = n.v;
      const ta = h('textarea', { rows: 8, spellcheck: false, class: 'gr-props-edit' }, propsText(v.properties));
      return h('aside', { class: 'gr-detail' }, [
        vertexChip(v),
        h('div', { class: 'muted small' }, `#${v.id}`),
        h('div', { class: 'wb-section-title' }, tr('Properties')),
        ta,
        h('div', { class: 'gr-form-row' }, [
          h('button', { type: 'button', class: 'primary', onclick: () => saveProps('vertex', v.id, ta.value, (r) => r && (n.v = r)) }, tr('Save')),
          h('button', { type: 'button', onclick: () => expand(v.id) }, tr('Expand')),
          h('button', { type: 'button', title: tr('Then click the target vertex'), onclick: () => ((x.connectFrom = v.id), updateSelection()) }, tr('Connect…')),
        ]),
        h('div', { class: 'gr-form-row' }, [
          h('button', { type: 'button', title: tr('Remove from the view (the vertex stays in the graph)'), onclick: () => (hideVertex(v.id), renderPane()) }, tr('Hide')),
          h('button', { type: 'button', class: 'danger', onclick: () => change('delete-vertex', { id: v.id }, { confirm: tr('Delete {vertex} and its relationships?', { vertex: `${vertexCaption(v)} (${v.label})` }), done: () => hideVertex(v.id) }) }, tr('Delete')),
        ]),
      ]);
    }
    if (sel.type === 'connect') {
      const a = x.nodes.get(sel.from)?.v;
      const b = x.nodes.get(sel.to)?.v;
      if (!a || !b) return h('aside', { class: 'gr-detail' });
      const types = labelList('e');
      const type = h('input', { type: 'text', list: types.id, placeholder: tr('Type, e.g. KNOWS'), value: labelsOf('e')[0] ?? '', spellcheck: false });
      const props = h('textarea', { rows: 3, placeholder: tr('Properties (JSON)'), spellcheck: false });
      const err = h('div', { class: 'gr-form-error' });
      return h('aside', { class: 'gr-detail' }, [
        h('div', { class: 'gr-form-title' }, tr('New relationship')),
        vertexChip(a), h('div', { class: 'gr-arrow' }, '↓'), vertexChip(b),
        type, types.el, props, err,
        h('div', { class: 'gr-form-row' }, [
          h('button', { type: 'button', class: 'primary', onclick: async () => {
            try {
              if (!isLabelName(type.value.trim())) throw new Error(tr('Type a relationship type.'));
              await change('create-edge', { from: a.id, to: b.id, label: type.value.trim(), properties: parseProps(props.value) }, {
                done: (edge) => {
                  x.links.set(edge.id, edge);
                  x.selected = { type: 'edge', id: edge.id };
                  x.relayout = 0.4;
                },
              });
            } catch (e) {
              err.textContent = e.message;
            }
          } }, tr('Create')),
          h('button', { type: 'button', onclick: () => ((x.selected = { type: 'vertex', id: a.id }), updateSelection()) }, tr('Cancel')),
        ]),
      ]);
    }
    const e = x.links.get(sel.id);
    if (!e || !x.nodes.has(e.start) || !x.nodes.has(e.end)) return h('aside', { class: 'gr-detail' });
    const ta = h('textarea', { rows: 8, spellcheck: false, class: 'gr-props-edit' }, propsText(e.properties));
    return h('aside', { class: 'gr-detail' }, [
      h('div', { class: 'gr-form-title' }, e.label),
      vertexChip(x.nodes.get(e.start).v), h('div', { class: 'gr-arrow' }, '↓'), vertexChip(x.nodes.get(e.end).v),
      h('div', { class: 'muted small' }, `#${e.id}`),
      h('div', { class: 'wb-section-title' }, tr('Properties')),
      ta,
      h('div', { class: 'gr-form-row' }, [
        h('button', { type: 'button', class: 'primary', onclick: () => saveProps('edge', e.id, ta.value, (r) => r && x.links.set(r.id, r)) }, tr('Save')),
        h('button', { type: 'button', class: 'danger', onclick: () => change('delete-edge', { id: e.id }, { confirm: tr('Delete this {type} relationship?', { type: e.label }), done: () => (x.links.delete(e.id), (x.selected = null)) }) }, tr('Delete')),
      ]),
    ]);
  }

  function fitView() {
    const x = st.explore;
    const svg = page.querySelector('.gr-canvas');
    if (!svg || !x.nodes.size) return;
    const xs = [...x.nodes.values()];
    const minX = Math.min(...xs.map((n) => n.x)) - 60;
    const maxX = Math.max(...xs.map((n) => n.x)) + 60;
    const minY = Math.min(...xs.map((n) => n.y)) - 60;
    const maxY = Math.max(...xs.map((n) => n.y)) + 60;
    const { width, height } = svg.getBoundingClientRect();
    const k = Math.min(1.4, width / (maxX - minX), height / (maxY - minY));
    x.view = { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k, init: true };
    svg.querySelector('.gr-viewport')?.setAttribute('transform', `translate(${x.view.x},${x.view.y}) scale(${x.view.k})`);
  }

  let animation = null;
  function drawGraph(svg) {
    const x = st.explore;
    cancelAnimationFrame(animation);
    const el = (tag, attrs = {}, parent = null) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent?.append(n);
      return n;
    };
    const { width, height } = svg.getBoundingClientRect();
    if (!x.view.init) x.view = { x: width / 2, y: height / 2, k: 1, init: true };
    const defs = el('defs', {}, svg);
    const marker = el('marker', { id: 'gr-arrowhead', viewBox: '0 0 10 10', refX: '10', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0 0L10 5L0 10z', class: 'gr-arrowhead' }, marker);
    const vp = el('g', { class: 'gr-viewport', transform: `translate(${x.view.x},${x.view.y}) scale(${x.view.k})` }, svg);
    const linkLayer = el('g', {}, vp);
    const nodeLayer = el('g', {}, vp);
    const R = 16;

    const links = [...x.links.values()].filter((e) => x.nodes.has(e.start) && x.nodes.has(e.end)).map((e) => {
      const g = el('g', { class: `gr-link${x.selected?.type === 'edge' && x.selected.id === e.id ? ' selected' : ''}`, 'data-id': e.id }, linkLayer);
      const line = el('line', { 'marker-end': 'url(#gr-arrowhead)' }, g);
      const hit = el('line', { class: 'gr-link-hit' }, g);
      const text = el('text', { 'text-anchor': 'middle' }, g);
      text.textContent = e.label;
      g.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      g.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        x.selected = { type: 'edge', id: e.id };
        updateSelection();
      });
      return { e, line, hit, text };
    });
    const nodes = [...x.nodes.values()].map((n) => {
      const selected = x.selected?.type === 'vertex' && x.selected.id === n.v.id;
      const g = el('g', { class: `gr-node${selected ? ' selected' : ''}${x.connectFrom === n.v.id ? ' source' : ''}`, 'data-id': n.v.id }, nodeLayer);
      el('circle', { r: R, fill: colorOf(n.v.label) }, g);
      const t = el('text', { y: R + 13, 'text-anchor': 'middle' }, g);
      t.textContent = vertexCaption(n.v).slice(0, 24);
      const title = el('title', {}, g);
      title.textContent = `${n.v.label} #${n.v.id}\n${formatProperties(n.v.properties)}`;
      let drag = null;
      g.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        g.setPointerCapture(ev.pointerId);
        drag = { sx: ev.clientX, sy: ev.clientY, x: n.x, y: n.y, moved: false };
      });
      g.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        const dx = (ev.clientX - drag.sx) / x.view.k;
        const dy = (ev.clientY - drag.sy) / x.view.k;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        n.x = drag.x + dx;
        n.y = drag.y + dy;
        n.fixed = true;
        position();
      });
      g.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        const moved = drag?.moved;
        drag = null;
        if (moved) return;
        const from = x.connectFrom ?? (ev.shiftKey && x.selected?.type === 'vertex' ? x.selected.id : null);
        if (from && from !== n.v.id) {
          x.connectFrom = null;
          x.selected = { type: 'connect', from, to: n.v.id };
        } else x.selected = { type: 'vertex', id: n.v.id };
        updateSelection();
      });
      g.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        expand(n.v.id);
      });
      return { n, g };
    });

    function position() {
      for (const { e, line, hit, text } of links) {
        const a = x.nodes.get(e.start);
        const b = x.nodes.get(e.end);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        // Self-loops are drawn as a short stub above the vertex.
        const [x1, y1, x2, y2] = e.start === e.end
          ? [a.x, a.y - R, a.x + 18, a.y - R - 18]
          : [a.x + (dx / d) * R, a.y + (dy / d) * R, b.x - (dx / d) * (R + 2), b.y - (dy / d) * (R + 2)];
        for (const l of [line, hit]) {
          l.setAttribute('x1', x1);
          l.setAttribute('y1', y1);
          l.setAttribute('x2', x2);
          l.setAttribute('y2', y2);
        }
        text.setAttribute('x', (x1 + x2) / 2);
        text.setAttribute('y', (y1 + y2) / 2 - 3);
      }
      for (const { n, g } of nodes) g.setAttribute('transform', `translate(${n.x},${n.y})`);
    }

    // Force layout: repulsion between vertices, springs along relationships,
    // a weak pull to the centre; cools down and stops.
    let alpha = x.relayout ?? 0;
    const list = [...x.nodes.values()];
    const tick = () => {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) (dx = Math.random()), (dy = Math.random()), (d2 = 1);
          const f = (2400 * alpha) / d2;
          a.vx -= dx * f / Math.sqrt(d2);
          a.vy -= dy * f / Math.sqrt(d2);
          b.vx += dx * f / Math.sqrt(d2);
          b.vy += dy * f / Math.sqrt(d2);
        }
      }
      for (const e of x.links.values()) {
        const a = x.nodes.get(e.start);
        const b = x.nodes.get(e.end);
        if (a === b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - 110) / d) * 0.06 * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const n of list) {
        n.vx -= n.x * 0.004 * alpha;
        n.vy -= n.y * 0.004 * alpha;
        if (!n.fixed) {
          n.x += (n.vx *= 0.6);
          n.y += (n.vy *= 0.6);
        } else n.vx = n.vy = 0;
      }
      alpha *= 0.985;
    };
    position();
    const frame = () => {
      if (!svg.isConnected) return;
      for (let k = 0; k < 2; k++) tick();
      position();
      if (alpha > 0.02) animation = requestAnimationFrame(frame);
      else if (x.autoFit) {
        x.autoFit = false;
        fitView();
      }
    };
    // Lay out again only when vertices or relationships were added.
    if (list.length && alpha > 0) {
      x.relayout = 0;
      animation = requestAnimationFrame(frame);
    }

    // Pan and zoom.
    let pan = null;
    svg.addEventListener('pointerdown', (ev) => {
      svg.setPointerCapture(ev.pointerId);
      pan = { sx: ev.clientX, sy: ev.clientY, x: x.view.x, y: x.view.y, moved: false };
      x.autoFit = false;
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!pan) return;
      x.view.x = pan.x + ev.clientX - pan.sx;
      x.view.y = pan.y + ev.clientY - pan.sy;
      if (Math.abs(ev.clientX - pan.sx) + Math.abs(ev.clientY - pan.sy) > 3) pan.moved = true;
      vp.setAttribute('transform', `translate(${x.view.x},${x.view.y}) scale(${x.view.k})`);
    });
    svg.addEventListener('pointerup', () => {
      if (pan && !pan.moved && (x.selected || x.connectFrom)) {
        x.selected = null;
        x.connectFrom = null;
        pan = null;
        updateSelection();
        return;
      }
      pan = null;
    });
    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      x.autoFit = false;
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      const k = Math.min(4, Math.max(0.15, x.view.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
      x.view.x = mx - ((mx - x.view.x) * k) / x.view.k;
      x.view.y = my - ((my - x.view.y) * k) / x.view.k;
      x.view.k = k;
      vp.setAttribute('transform', `translate(${x.view.x},${x.view.y}) scale(${x.view.k})`);
    }, { passive: false });
  }

  // ------------------------------------------------------------ cypher

  function cypherPane() {
    const c = st.cypher;
    const ta = h('textarea', { class: 'gr-cypher', spellcheck: false, rows: 8 }, c.text);
    ta.addEventListener('input', debounce(() => ((c.text = ta.value), save(CYPHER_KEY, ta.value)), 300));
    const allow = h('input', { type: 'checkbox', checked: !!c.allow, onchange: (e) => (c.allow = e.target.checked) });
    const cols = h('input', { type: 'text', value: c.columns, placeholder: tr('auto'), spellcheck: false, class: 'gr-cols', title: tr('Result columns for AS (…): detected from RETURN; list them here for RETURN * or when detection fails') });
    cols.addEventListener('input', () => (c.columns = cols.value));
    const run = async () => {
      c.text = ta.value;
      save(CYPHER_KEY, c.text);
      c.error = null;
      setStatus(tr('Running…'));
      try {
        c.result = await call(host.age.cypher, { graph: st.graph, query: c.text, columns: c.columns, allowChanges: !!c.allow });
        setStatus(`${trn(c.result.rowCount, '{n} row', '{n} rows')} · ${(c.result.durationMs / 1000).toFixed(3)} s${c.result.committed ? ` · ${tr('committed')}` : ''}`);
        if (c.result.committed) await refresh({ keepPane: true });
      } catch (err) {
        c.result = null;
        c.error = err.message;
        setStatus(tr('Error'), 'error');
      }
      renderPane();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run();
      }
    });
    const r = c.result;
    const found = r ? graphElements(r.rows) : null;
    const toolbar = h('div', { class: 'gr-toolbar' }, [
      h('button', { type: 'button', class: 'primary', 'data-icon': 'script-run', title: tr('Run (Ctrl+Enter)'), onclick: run }, tr('Run')),
      h('label', { class: 'check', title: tr('Allow queries that change the graph (CREATE, MERGE, SET, DELETE, REMOVE). They are committed when they succeed.') }, [allow, ` ${tr('Allow changes')}`]),
      h('label', { class: 'gr-cols-label' }, [`${tr('Columns')} `, cols]),
      h('span', { class: 'grow' }),
      found && (found.vertices.length || found.edges.length)
        ? h('button', { type: 'button', title: tr('Show the vertices and relationships of the result in the explorer'), onclick: () => {
            clearExplorer();
            addToExplorer(found.vertices, found.edges);
            showPane('explore');
          } }, `${tr('Show in explorer')} (${found.vertices.length} · ${found.edges.length})`)
        : null,
    ]);
    const out = c.error
      ? h('pre', { class: 'wb-error' }, c.error)
      : r
        ? h('table', { class: 'dt-grid' }, [
            h('thead', {}, h('tr', {}, [h('th', { class: 'dt-rownum' }, '#'), ...r.columns.map((x) => h('th', {}, x))])),
            h('tbody', {}, r.rows.map((row, i) => h('tr', {}, [
              h('td', { class: 'dt-rownum' }, String(i + 1)),
              ...row.map((v) => {
                const text = formatAgValue(v);
                return text === null ? h('td', { class: 'null' }, 'NULL') : h('td', { title: JSON.stringify(v).slice(0, 2000) }, text.length > 300 ? `${text.slice(0, 300)}…` : text);
              }),
            ]))),
          ])
        : h('p', { class: 'muted small' }, tr('Runs on graph {graph}. Reads use a read-only transaction; tick “Allow changes” for CREATE / MERGE / SET / DELETE.', { graph: st.graph }));
    return [toolbar, ta, h('div', { class: 'gr-scroll' }, [out, r?.truncated ? h('p', { class: 'wb-note' }, tr('Only the first {n} rows are shown.', { n: r.rows.length })) : null])];
  }

  // ------------------------------------------------------------ wiring

  $('#gr-refresh').addEventListener('click', () => refresh({ keepPane: true }));
  $('#gr-new-graph').addEventListener('click', () => openSideForm('graph'));
  events.addEventListener('connection', () => {
    const shown = st;
    for (const s of [...graphTabs.values()].map((g) => g.st)) {
      st = s;
      clearExplorer();
      s.info = null;
      s.loaded = false;
    }
    st = shown;
    if (isShown()) refresh();
  });
  tabs.onShow((name) => {
    if (tabs.kind(name) !== 'graph') return;
    cancelAnimationFrame(animation);
    st = graphTabs.get(name).st;
    setStatus('');
    syncPaneTabs();
    if (!st.loaded || !st.info) refresh();
    else {
      renderSide();
      renderPane();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isShown() && st.explore.connectFrom) {
      st.explore.connectFrom = null;
      updateSelection();
    }
  });

  // ------------------------------------------------------------ tabs

  // A new Graph tab after the others, shown.
  function newTab() {
    const id = `graph:${++tabSeq}`;
    let n = 1;
    const used = new Set([...graphTabs.values()].map((g) => g.title));
    while (used.has(tr('Graph {n}', { n }))) n++;
    graphTabs.set(id, { st: freshState(), title: tr('Graph {n}', { n }), filePath: null });
    tabs.add({
      id,
      kind: 'graph',
      title: graphTabs.get(id).title,
      icon: 'graph',
      element: page,
      shared: true,
      onClose: () => {
        if (graphTabs.get(id)?.st === st) cancelAnimationFrame(animation);
        graphTabs.delete(id);
      },
    });
    tabs.show(id);
    return id;
  }

  // Save / Save As the tab's Cypher query to a .cypher file.
  async function saveTab(id, saveAs) {
    const g = graphTabs.get(id);
    if (!g) return false;
    const box = g.st === st ? page.querySelector('.gr-cypher') : null;
    if (box) g.st.cypher.text = box.value;
    const text = g.st.cypher.text;
    if (!text.trim()) {
      status(tr('Nothing to save: the Cypher query is empty.'));
      return false;
    }
    const target = await host.saveFile({ filePath: g.filePath, text, saveAs: saveAs || !g.filePath, defaultName: g.filePath ?? `${g.title}.cypher`, kind: 'cypher' });
    if (!target) return false;
    g.filePath = target;
    g.title = target.split(/[\\/]/).pop();
    tabs.rename(id, g.title, target);
    status(tr('Saved {file}', { file: g.title }));
    return true;
  }

  decorateButtons(page);

  return {
    commands: {
      'graph-tab': () => tabs.show(tabs.ofKind('graph')[0] ?? newTab()),
      'graph-new': () => newTab(),
    },
    saveTab,
  };
}
