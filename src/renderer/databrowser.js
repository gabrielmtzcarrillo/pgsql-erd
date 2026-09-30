// Data browser tabs: one tab per table, a read-only grid with paging and
// Excel-style column filters — sort, a checklist of the column's values
// (with counts, "(Blanks)" and search), and text / number / date conditions.
// Rows are read by the main process in read-only transactions.

import { vectorKind, abbreviateVector } from '../shared/pgvector.js';
import { tr, trn, formatNumber } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);

const NUMERIC = /^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]|money|serial|bigserial|smallserial|oid)$/;
const TEMPORAL = /^(date|time.*|timestamp.*|interval)$/;

const TEXT_OPS = [
  ['contains', tr('Contains')],
  ['notContains', tr('Does not contain')],
  ['equals', tr('Equals')],
  ['notEquals', tr('Does not equal')],
  ['beginsWith', tr('Begins with')],
  ['endsWith', tr('Ends with')],
  ['empty', tr('Is empty')],
  ['notEmpty', tr('Is not empty')],
];
const RANGE_OPS = [
  ['equals', tr('Equals')],
  ['notEquals', tr('Does not equal')],
  ['gt', tr('Greater than')],
  ['gte', tr('Greater than or equal to')],
  ['lt', tr('Less than')],
  ['lte', tr('Less than or equal to')],
  ['between', tr('Between')],
  ['empty', tr('Is empty')],
  ['notEmpty', tr('Is not empty')],
];
const NO_VALUE = new Set(['empty', 'notEmpty']);
const PAGE_SIZES = [100, 500, 1000];

const kindOf = (col) => (NUMERIC.test(col.baseType) ? 'number' : TEMPORAL.test(col.baseType) ? 'date' : 'text');

export function setupDataBrowser(ctx) {
  const { host, h, status, db, tabs } = ctx;
  const views = new Map(); // table id -> view

  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  // ------------------------------------------------------------ tabs

  async function open(table, { filters } = {}) {
    if (!db.connected()) return db.openConnect(() => open(table, { filters }));
    const id = `data:${table}`;
    let view = views.get(table);
    if (!view) {
      view = createView(table, id);
      views.set(table, view);
    }
    if (filters) {
      view.filters = structuredClone(filters);
      view.offset = 0;
    }
    tabs.show(id);
    await view.load();
  }

  function createView(table, id) {
    const view = { table, filters: {}, sort: [], limit: 100, offset: 0, data: null, loading: false };
    const title = h('strong', {}, table);
    const count = h('span', { class: 'muted' });
    const pageInfo = h('span', { class: 'dt-page-info' });
    const prev = h('button', { type: 'button', title: tr('Previous page'), onclick: () => page(-1) }, '‹');
    const next = h('button', { type: 'button', title: tr('Next page'), onclick: () => page(1) }, '›');
    const sizeSelect = h('select', { title: tr('Rows per page') }, PAGE_SIZES.map((n) => h('option', { value: n }, trn(n, '{n} row', '{n} rows'))));
    sizeSelect.addEventListener('change', () => {
      view.limit = Number(sizeSelect.value);
      view.offset = 0;
      view.load();
    });
    const chips = h('div', { class: 'dt-chips' });
    const grid = h('div', { class: 'dt-grid-wrap' });
    const element = h('section', { class: 'data-page' }, [
      h('div', { class: 'dt-toolbar' }, [
        title,
        count,
        h('button', { type: 'button', icon: 'refresh', onclick: () => view.load() }, tr('Refresh')),
        h('button', { type: 'button', icon: 'check-none', onclick: () => clearAll() }, tr('Clear filters')),
        h('button', { type: 'button', icon: 'copy', title: tr('Copy this page (tab-separated, pastes into a spreadsheet)'), onclick: () => copyPage() }, tr('Copy')),
        h('button', { type: 'button', icon: 'toggle-tables', title: tr('Show the table in the diagram'), onclick: () => ctx.focusTable(table) }, tr('Diagram')),
        h('span', { class: 'grow' }),
        prev,
        pageInfo,
        next,
        sizeSelect,
      ]),
      chips,
      grid,
    ]);
    tabs.add({ id, title: table.replace(/^public\./, ''), tooltip: table, icon: 'toggle-tables', element, onClose: () => views.delete(table) });

    function page(dir) {
      const total = view.data?.total ?? 0;
      const off = view.offset + dir * view.limit;
      if (off < 0 || off >= Math.max(total, 1)) return;
      view.offset = off;
      view.load();
    }

    function clearAll() {
      view.filters = {};
      view.sort = [];
      view.offset = 0;
      view.load();
    }

    async function copyPage() {
      if (!view.data) return;
      const esc = (v) => (v === null ? '' : /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const cols = view.data.columns.map((c) => c.name);
      const text = [cols.join('\t'), ...view.data.rows.map((r) => cols.map((c) => esc(r[c])).join('\t'))].join('\n');
      await navigator.clipboard.writeText(text);
      status(trn(view.data.rows.length, 'Copied {n} row', 'Copied {n} rows'));
    }

    view.load = async () => {
      view.loading = true;
      grid.classList.add('loading');
      try {
        view.data = await call(host.data.browse, { table, filters: view.filters, sort: view.sort, limit: view.limit, offset: view.offset });
        render();
      } catch (err) {
        grid.replaceChildren(h('pre', { class: 'wb-error' }, err.message));
      } finally {
        view.loading = false;
        grid.classList.remove('loading');
      }
    };

    function render() {
      const d = view.data;
      const filtered = Object.keys(view.filters).length > 0;
      count.textContent = trn(d.total, '{n} row', '{n} rows', { n: formatNumber(d.total) }) + (filtered ? ` ${tr('(filtered)')}` : '');
      const from = d.total ? view.offset + 1 : 0;
      pageInfo.textContent = tr('{from}–{to} of {total}', { from: formatNumber(from), to: formatNumber(view.offset + d.rows.length), total: formatNumber(d.total) });
      prev.disabled = view.offset === 0;
      next.disabled = view.offset + d.rows.length >= d.total;
      sizeSelect.value = String(view.limit);
      chips.replaceChildren(
        ...Object.entries(view.filters).map(([col, f]) =>
          h('span', { class: 'dt-chip' }, [
            h('span', {}, `${col}: ${describeFilter(f)}`),
            h('button', { type: 'button', title: tr('Remove this filter'), onclick: () => setFilter(view, col, null) }, '×'),
          ])
        )
      );
      chips.hidden = !filtered;
      const pk = new Set(d.primaryKey);
      const head = h('tr', {}, [
        h('th', { class: 'dt-rownum' }, '#'),
        ...d.columns.map((c) => {
          const sort = view.sort.find((s) => s.column === c.name);
          const active = !!view.filters[c.name];
          const btn = h('button', { type: 'button', class: `dt-filter${active ? ' active' : ''}`, title: tr('Sort and filter'), onclick: (e) => openFilter(view, c, e.currentTarget) }, active ? '⏷' : '▾');
          return h('th', { title: `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}` }, [
            h('div', { class: 'dt-th' }, [
              h('span', { class: `dt-colname${pk.has(c.name) ? ' pk' : ''}` }, c.name),
              sort ? h('span', { class: 'dt-sort' }, sort.direction === 'desc' ? '↓' : '↑') : null,
              btn,
            ]),
            h('div', { class: 'dt-type' }, c.type),
          ]);
        }),
      ]);
      const body = d.rows.map((r, i) =>
        h('tr', {}, [
          h('td', { class: 'dt-rownum' }, String(view.offset + i + 1)),
          ...d.columns.map((c) => {
            const v = r[c.name];
            if (v === null) return h('td', { class: 'null' }, 'NULL');
            // pgvector values: the first elements and the dimension count.
            if (vectorKind(c.baseType) && !/\[\]$/.test(c.type)) return h('td', { class: 'dt-vector', title: v.length > 2000 ? `${v.slice(0, 2000)}…` : v }, abbreviateVector(v));
            return h('td', { class: kindOf(c) === 'number' ? 'num' : '', title: v.length > 60 ? v.slice(0, 2000) : '' }, v.length > 300 ? `${v.slice(0, 300)}…` : v);
          }),
        ])
      );
      grid.replaceChildren(
        h('table', { class: 'dt-grid' }, [h('thead', {}, head), h('tbody', {}, body)]),
        d.rows.length ? '' : h('div', { class: 'db-empty' }, filtered ? tr('No rows match the filters.') : tr('The table is empty.'))
      );
    }
    view.render = render;
    return view;
  }

  function setFilter(view, column, filter) {
    if (filter) view.filters[column] = filter;
    else delete view.filters[column];
    view.offset = 0;
    view.load();
  }

  function describeFilter(f) {
    const parts = [];
    if (Array.isArray(f.values)) {
      const n = f.values.length + (f.blanks ? 1 : 0);
      parts.push(n <= 3 ? [...f.values.map((v) => (v === '' ? tr('(empty)') : v)), ...(f.blanks ? [tr('(Blanks)')] : [])].join(', ') : trn(n, '{n} value', '{n} values'));
    }
    if (f.cond) {
      const label = [...TEXT_OPS, ...RANGE_OPS].find(([k]) => k === f.cond.op)?.[1].toLowerCase();
      parts.push(NO_VALUE.has(f.cond.op) ? label : f.cond.op === 'between' ? tr('between {a} and {b}', { a: f.cond.value, b: f.cond.value2 }) : `${label} "${f.cond.value}"`);
    }
    return parts.join('; ');
  }

  // ------------------------------------------------------------ filter popup

  const popup = $('#filter-popup');
  let popupState = null;

  function closePopup() {
    popup.hidden = true;
    popupState = null;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!popup.hidden && !popup.contains(e.target) && !e.target.closest('.dt-filter')) closePopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popup.hidden) closePopup();
  });

  async function openFilter(view, col, anchor) {
    if (popupState?.col === col.name && popupState.view === view) return closePopup();
    const current = view.filters[col.name] ?? {};
    const kind = kindOf(col);
    const ops = kind === 'text' ? TEXT_OPS : RANGE_OPS;
    const st = {
      view,
      col: col.name,
      values: [],
      truncated: false,
      checked: null, // Set of checked keys; null = everything
      search: '',
    };
    popupState = st;
    const key = (v) => (v === null ? '\u0000null' : v);
    if (Array.isArray(current.values)) st.checked = new Set([...current.values, ...(current.blanks ? ['\u0000null'] : [])]);

    const sortLabels = kind === 'number'
      ? [tr('Sort smallest to largest'), tr('Sort largest to smallest')]
      : kind === 'date'
        ? [tr('Sort oldest to newest'), tr('Sort newest to oldest')]
        : [tr('Sort A to Z'), tr('Sort Z to A')];
    const sortBtn = (dir, label) =>
      h('button', {
        type: 'button',
        class: `fp-item${view.sort[0]?.column === col.name && view.sort[0].direction === dir ? ' on' : ''}`,
        onclick: () => {
          view.sort = [{ column: col.name, direction: dir }];
          closePopup();
          view.load();
        },
      }, `${dir === 'asc' ? '↑' : '↓'}  ${label}`);

    const opSelect = h('select', {}, [h('option', { value: '' }, kind === 'text' ? tr('Text filter…') : kind === 'number' ? tr('Number filter…') : tr('Date filter…')), ...ops.map(([k, l]) => h('option', { value: k }, l))]);
    const input1 = h('input', { type: 'text', placeholder: kind === 'date' ? tr('YYYY-MM-DD') : tr('value') });
    const input2 = h('input', { type: 'text', placeholder: tr('and'), hidden: true });
    opSelect.value = current.cond?.op ?? '';
    input1.value = current.cond?.value ?? '';
    input2.value = current.cond?.value2 ?? '';
    const syncInputs = () => {
      input1.hidden = !opSelect.value || NO_VALUE.has(opSelect.value);
      input2.hidden = opSelect.value !== 'between';
    };
    opSelect.addEventListener('change', syncInputs);
    syncInputs();

    const search = h('input', { type: 'search', placeholder: tr('Search values') });
    const list = h('div', { class: 'fp-list' }, h('div', { class: 'muted small' }, tr('Loading…')));
    const note = h('div', { class: 'fp-note muted small' });

    const isChecked = (k) => st.checked === null || st.checked.has(k);
    function renderList() {
      const visible = st.values;
      const allOn = visible.length > 0 && visible.every((v) => isChecked(key(v.value)));
      const all = h('input', { type: 'checkbox', checked: allOn });
      all.addEventListener('change', () => {
        if (st.checked === null) st.checked = new Set(st.values.map((v) => key(v.value)));
        for (const v of visible) all.checked ? st.checked.add(key(v.value)) : st.checked.delete(key(v.value));
        renderList();
      });
      list.replaceChildren(
        h('label', { class: 'fp-check all' }, [all, st.search ? tr('(Select all search results)') : tr('(Select all)')]),
        ...visible.map((v) => {
          const k = key(v.value);
          const cb = h('input', { type: 'checkbox', checked: isChecked(k) });
          cb.addEventListener('change', () => {
            if (st.checked === null) st.checked = new Set(st.values.map((x) => key(x.value)));
            cb.checked ? st.checked.add(k) : st.checked.delete(k);
            renderList();
          });
          const label = v.value === null ? tr('(Blanks)') : v.value === '' ? tr('(empty)') : v.value.length > 80 ? `${v.value.slice(0, 80)}…` : v.value;
          return h('label', { class: `fp-check${v.value === null ? ' blank' : ''}`, title: v.value ?? 'NULL' }, [cb, h('span', { class: 'grow' }, label), h('span', { class: 'muted' }, formatNumber(v.count))]);
        })
      );
      note.textContent = st.truncated ? tr('Showing the first values only — search to find others.') : '';
    }

    async function loadValues() {
      try {
        const others = { ...view.filters };
        const r = await call(host.data.distinct, { table: view.table, column: col.name, filters: others, search: st.search });
        if (popupState !== st) return;
        st.values = r.values;
        st.truncated = r.truncated;
        renderList();
      } catch (err) {
        list.replaceChildren(h('div', { class: 'wb-error' }, err.message));
      }
    }
    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        st.search = search.value.trim();
        // A search starts from "everything that matches is ticked", as in Excel.
        st.checked = null;
        loadValues();
      }, 250);
    });

    function apply() {
      const f = {};
      const op = opSelect.value;
      if (op && (NO_VALUE.has(op) || input1.value !== '')) {
        f.cond = { op };
        if (!NO_VALUE.has(op)) f.cond.value = input1.value;
        if (op === 'between') f.cond.value2 = input2.value;
      }
      const everything = !st.search && !st.truncated && st.values.every((v) => isChecked(key(v.value)));
      if (st.checked !== null && !everything) {
        const chosen = st.values.filter((v) => isChecked(key(v.value)));
        f.values = chosen.filter((v) => v.value !== null).map((v) => v.value);
        f.blanks = chosen.some((v) => v.value === null);
      } else if (st.search) {
        // Search + OK keeps what matched the search.
        f.values = st.values.filter((v) => v.value !== null).map((v) => v.value);
        f.blanks = st.values.some((v) => v.value === null);
      }
      closePopup();
      setFilter(view, col.name, Object.keys(f).length ? f : null);
    }

    popup.replaceChildren(
      h('div', { class: 'fp-head' }, [h('strong', {}, col.name), h('span', { class: 'muted small' }, col.type)]),
      sortBtn('asc', sortLabels[0]),
      sortBtn('desc', sortLabels[1]),
      h('button', {
        type: 'button',
        class: 'fp-item',
        disabled: !view.filters[col.name],
        onclick: () => {
          closePopup();
          setFilter(view, col.name, null);
        },
      }, `✕  ${tr('Clear filter from "{name}"', { name: col.name })}`),
      h('div', { class: 'fp-sep' }),
      h('div', { class: 'fp-cond' }, [opSelect, input1, input2]),
      h('div', { class: 'fp-sep' }),
      search,
      list,
      note,
      h('div', { class: 'fp-actions' }, [
        h('button', { type: 'button', class: 'primary', onclick: apply }, tr('OK')),
        h('button', { type: 'button', onclick: closePopup }, tr('Cancel')),
      ])
    );
    popup.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = popup.offsetWidth;
    popup.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    popup.style.top = `${Math.min(r.bottom + 4, window.innerHeight - popup.offsetHeight - 8)}px`;
    search.focus();
    loadValues();
  }

  // ------------------------------------------------------------ table picker

  const pick = $('#data-pick-dialog');
  const pickFilter = $('#data-pick-filter');
  let pickTables = [];
  function renderPick() {
    const q = pickFilter.value.trim().toLowerCase();
    const items = pickTables.filter((t) => t.toLowerCase().includes(q));
    $('#data-pick-list').replaceChildren(
      ...(items.length
        ? items.map((t) => h('label', { class: 'item', onclick: () => (pick.close(), open(t)) }, [h('span', { class: 'grow' }, t)]))
        : [h('div', { class: 'db-empty' }, tr('No tables.'))])
    );
  }
  pickFilter.addEventListener('input', renderPick);
  pickFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('#data-pick-list .item');
      first?.click();
    }
  });

  async function openPicker() {
    if (!db.connected()) return db.openConnect(openPicker);
    try {
      pickTables = await call(host.data.tables);
    } catch (err) {
      return status(err.message);
    }
    pickFilter.value = '';
    renderPick();
    pick.showModal();
    pickFilter.focus();
  }
  $('#data-tab-add').addEventListener('click', openPicker);

  // Reload open tabs after a commit or schema refresh.
  ctx.events.addEventListener('schema', () => views.forEach((v) => tabs.current() === `data:${v.table}` && v.load()));

  return {
    open,
    commands: {
      'data-browse': () => {
        const sel = ctx.selectedTableIds()[0];
        return sel && db.connected() ? open(sel) : openPicker();
      },
    },
  };
}
