// Data browser tabs: one tab per table, a grid with paging and Excel-style
// column filters — sort, a checklist of the column's values (with counts,
// "(Blanks)" and search), and text / number / date conditions. Rows are read
// by the main process in read-only transactions.
//
// "Edit rows" makes the grid editable, like "Edit rows" in SQL Server
// Management Studio: click a cell to change it (Ctrl+0 sets NULL), click the
// last row (*) to add one, × deletes a row. Changes are kept until Save,
// which applies them in one transaction. Rows are found by their primary
// key, and editing is only offered on connections whose policy allows writes.

import { vectorKind, abbreviateVector } from '../shared/pgvector.js';
import { tr, trn, formatNumber } from '../shared/i18n.js';
import { envName } from './dbui.js';

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

const emptyPending = () => ({
  edits: new Map(), // row index -> { [column]: text | null }
  deletes: new Set(), // row indexes
  inserts: [], // { [column]: text | null }; columns left out get their DEFAULT
});
const changeCount = (p) => p.edits.size + p.deletes.size + p.inserts.length;

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
      if (!(await view.confirmDiscard())) return tabs.show(id);
      view.filters = structuredClone(filters);
      view.offset = 0;
    }
    tabs.show(id);
    await view.load();
  }

  function createView(table, id) {
    const view = { table, filters: {}, sort: [], limit: 100, offset: 0, data: null, loading: false, edit: false, pending: emptyPending() };
    let finishEdit = null; // commits (true) or cancels the cell being edited
    const title = h('strong', {}, table);
    const count = h('span', { class: 'muted' });
    const pageInfo = h('span', { class: 'dt-page-info' });
    const prev = h('button', { type: 'button', title: tr('Previous page'), onclick: () => page(-1) }, '‹');
    const next = h('button', { type: 'button', title: tr('Next page'), onclick: () => page(1) }, '›');
    const sizeSelect = h('select', { title: tr('Rows per page') }, PAGE_SIZES.map((n) => h('option', { value: n }, trn(n, '{n} row', '{n} rows'))));
    sizeSelect.addEventListener('change', async () => {
      if (!(await view.confirmDiscard())) return (sizeSelect.value = String(view.limit));
      view.limit = Number(sizeSelect.value);
      view.offset = 0;
      view.load();
    });
    const editBtn = h('button', { type: 'button', icon: 'insert', onclick: () => toggleEdit() }, tr('Edit rows'));
    const saveBtn = h('button', { type: 'button', icon: 'save', class: 'primary', title: tr('Save the changes in one transaction'), onclick: () => saveChanges() }, tr('Save'));
    const discardBtn = h('button', { type: 'button', icon: 'discard', onclick: () => discard() }, tr('Discard'));
    const pendingInfo = h('span', { class: 'dt-pending' });
    const editTools = h('span', { class: 'dt-edit-tools', hidden: true }, [saveBtn, discardBtn, pendingInfo]);
    const editMsg = h('div', { class: 'dt-edit-msg', hidden: true });
    const chips = h('div', { class: 'dt-chips' });
    const grid = h('div', { class: 'dt-grid-wrap' });
    const element = h('section', { class: 'data-page' }, [
      h('div', { class: 'dt-toolbar' }, [
        title,
        count,
        h('button', { type: 'button', icon: 'refresh', onclick: async () => (await view.confirmDiscard()) && view.load() }, tr('Refresh')),
        h('button', { type: 'button', icon: 'check-none', onclick: () => clearAll() }, tr('Clear filters')),
        h('button', { type: 'button', icon: 'copy', title: tr('Copy this page (tab-separated, pastes into a spreadsheet)'), onclick: () => copyPage() }, tr('Copy')),
        h('button', { type: 'button', icon: 'toggle-tables', title: tr('Show the table in the diagram'), onclick: () => ctx.focusTable(table) }, tr('Diagram')),
        editBtn,
        editTools,
        h('span', { class: 'grow' }),
        prev,
        pageInfo,
        next,
        sizeSelect,
      ]),
      editMsg,
      chips,
      grid,
    ]);
    tabs.add({ id, title: table.replace(/^public\./, ''), tooltip: table, icon: 'toggle-tables', element, onClose: () => views.delete(table), canClose: () => view.confirmDiscard() });

    async function page(dir) {
      const total = view.data?.total ?? 0;
      const off = view.offset + dir * view.limit;
      if (off < 0 || off >= Math.max(total, 1)) return;
      if (!(await view.confirmDiscard())) return;
      view.offset = off;
      view.load();
    }

    async function clearAll() {
      if (!(await view.confirmDiscard())) return;
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

    // ---------------------------------------------------------- editing

    const writable = () => !!db.info()?.profile?.policy?.allowWrites;

    // True when nothing is unsaved, or the user agreed to drop it.
    view.confirmDiscard = async () => {
      finishEdit?.(true);
      const n = changeCount(view.pending);
      if (!n) return true;
      tabs.show(id);
      const choice = await host.confirm({
        message: tr('Discard the unsaved changes to {table}?', { table }),
        detail: trn(n, '{n} unsaved change', '{n} unsaved changes'),
        buttons: [tr('Discard'), tr('Cancel')],
      });
      if (choice !== 0) return false;
      view.pending = emptyPending();
      return true;
    };

    async function toggleEdit() {
      if (view.edit && !(await view.confirmDiscard())) return;
      view.edit = !view.edit && writable();
      setEditMsg('');
      if (view.data) render();
      else updateEditBar();
    }

    function discard() {
      finishEdit?.(false);
      view.pending = emptyPending();
      setEditMsg('');
      render();
    }

    function setEditMsg(text, error = false) {
      editMsg.textContent = text;
      editMsg.className = `dt-edit-msg${error ? ' error' : ''}`;
      editMsg.hidden = !text;
    }

    function updateEditBar() {
      const n = changeCount(view.pending);
      const allowed = writable();
      editBtn.classList.toggle('active', view.edit);
      editBtn.disabled = !allowed && !view.edit;
      editBtn.title = !allowed
        ? tr('This connection is read-only (see its policy in Database → Connect).')
        : view.edit ? tr('Stop editing') : tr('Edit, add and delete rows');
      editTools.hidden = !view.edit;
      saveBtn.disabled = discardBtn.disabled = n === 0;
      pendingInfo.textContent = n ? trn(n, '{n} unsaved change', '{n} unsaved changes') : '';
    }

    async function saveChanges() {
      finishEdit?.(true);
      const d = view.data;
      const p = view.pending;
      const n = changeCount(p);
      if (!d || !n) return;
      // Rows are found by their primary key as it was read.
      const key = (i) => Object.fromEntries(d.primaryKey.map((k) => [k, d.rows[i][k]]));
      const changes = {
        deletes: [...p.deletes].map((i) => ({ key: key(i) })),
        updates: [...p.edits].filter(([i]) => !p.deletes.has(i)).map(([i, values]) => ({ key: key(i), values })),
        inserts: p.inserts.map((values) => ({ values })),
      };
      const info = db.info();
      if (info && info.profile.environment !== 'development') {
        const choice = await host.confirm({
          message: trn(n, 'Save {n} change to {table}?', 'Save {n} changes to {table}?', { table }),
          detail: `${info.description} (${envName(info.profile.environment)})`,
          buttons: [tr('Save'), tr('Cancel')],
        });
        if (choice !== 0) return;
      }
      saveBtn.disabled = true;
      try {
        const r = await call(host.data.save, { table, changes });
        view.pending = emptyPending();
        const msg = tr('Saved: {inserted} added, {updated} changed, {deleted} deleted.', r);
        status(msg);
        setEditMsg(msg);
        await view.load();
      } catch (err) {
        setEditMsg(err.message, true);
        updateEditBar();
      }
    }

    // A row of the grid: { i } is a row of the page, { j } a new row.
    const refOf = (row) => (row.dataset.row ? { i: Number(row.dataset.row) } : row.dataset.new ? { j: Number(row.dataset.new) } : null);
    const editableCell = (ref, col) =>
      view.edit && !col.readOnly && (ref.j !== undefined || (view.data.primaryKey.length > 0 && !view.pending.deletes.has(ref.i)));

    // The cell's value with the pending changes applied. `unset`: a new
    // row's column that will get its DEFAULT.
    function cellValue(ref, col) {
      if (ref.j !== undefined) {
        const row = view.pending.inserts[ref.j];
        return col.name in row ? { value: row[col.name], dirty: true } : { value: null, unset: true };
      }
      const e = view.pending.edits.get(ref.i);
      if (e && col.name in e) return { value: e[col.name], dirty: true };
      return { value: view.data.rows[ref.i][col.name] };
    }

    function paintCell(td, ref, col) {
      const { value: v, dirty, unset } = cellValue(ref, col);
      td.className = '';
      td.title = '';
      if (dirty) td.classList.add('dirty');
      if (view.edit && !editableCell(ref, col)) td.classList.add('ro');
      if (unset) {
        td.classList.add('null');
        td.textContent = col.hasDefault ? tr('(default)') : 'NULL';
      } else if (v === null) {
        td.classList.add('null');
        td.textContent = 'NULL';
      } else if (vectorKind(col.baseType) && !/\[\]$/.test(col.type)) {
        // pgvector values: the first elements and the dimension count.
        td.classList.add('dt-vector');
        td.title = v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
        td.textContent = abbreviateVector(v);
      } else {
        if (kindOf(col) === 'number') td.classList.add('num');
        if (v.length > 60) td.title = v.slice(0, 2000);
        td.textContent = v.length > 300 ? `${v.slice(0, 300)}…` : v;
      }
      if (view.edit && col.readOnly) td.title = tr('Generated by the database');
    }

    function setCell(ref, col, value) {
      if (ref.j !== undefined) view.pending.inserts[ref.j][col.name] = value;
      else {
        const edits = view.pending.edits;
        const e = { ...edits.get(ref.i) };
        if (value === view.data.rows[ref.i][col.name]) delete e[col.name];
        else e[col.name] = value;
        Object.keys(e).length ? edits.set(ref.i, e) : edits.delete(ref.i);
      }
      updateEditBar();
    }

    // Edits a cell in place: Enter / Tab keep the value and move on,
    // Shift+Enter starts a new line, Escape cancels, Ctrl+0 sets NULL.
    // Returns false when the cell can't be edited.
    function editCell(td) {
      const ref = refOf(td.parentElement);
      const col = view.data.columns[td.cellIndex - 1];
      if (!ref || !col || !editableCell(ref, col)) return false;
      finishEdit?.(true);
      const { value } = cellValue(ref, col);
      let isNull = value === null;
      let touched = false;
      const input = h('textarea', { class: 'dt-input', rows: 1, spellcheck: false, placeholder: isNull ? 'NULL' : '' });
      input.value = value ?? '';
      input.addEventListener('input', () => {
        touched = true;
        isNull = false;
        input.placeholder = '';
      });
      const finish = (keep) => {
        if (finishEdit !== finish) return;
        finishEdit = null;
        if (keep && touched) setCell(ref, col, isNull ? null : input.value);
        paintCell(td, ref, col);
      };
      const moveTo = (cell, step) => {
        finish(true);
        while (cell && cell.cellIndex > 0 && !editCell(cell)) cell = cell[step];
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          const below = td.parentElement.nextElementSibling;
          moveTo(below && !below.classList.contains('dt-newrow') ? below.children[td.cellIndex] : null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const step = e.shiftKey ? 'previousElementSibling' : 'nextElementSibling';
          moveTo(td[step], step);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          touched = isNull = true;
          input.value = '';
          input.placeholder = 'NULL';
        }
      });
      input.addEventListener('blur', () => finish(true));
      finishEdit = finish;
      td.className = 'editing';
      td.replaceChildren(input);
      input.focus();
      input.select();
      return true;
    }

    grid.addEventListener('click', (e) => {
      if (!view.edit) return;
      const td = e.target.closest('td');
      if (!td || td.cellIndex < 1 || td.classList.contains('editing')) return;
      if (td.parentElement.classList.contains('dt-newrow')) {
        // Clicking the last row (*) adds a row.
        view.pending.inserts.push({});
        render();
        let cell = grid.querySelector(`tr[data-new="${view.pending.inserts.length - 1}"]`)?.children[td.cellIndex];
        while (cell && !editCell(cell)) cell = cell.nextElementSibling;
        return;
      }
      editCell(td);
    });

    function rowButton(ref) {
      const deleted = ref.i !== undefined && view.pending.deletes.has(ref.i);
      const toggle = () => {
        finishEdit?.(true);
        if (ref.j !== undefined) view.pending.inserts.splice(ref.j, 1);
        else if (deleted) view.pending.deletes.delete(ref.i);
        else view.pending.deletes.add(ref.i);
        render();
      };
      return h('button', {
        type: 'button',
        class: 'dt-rowbtn',
        disabled: ref.i !== undefined && !view.data.primaryKey.length,
        title: ref.j !== undefined ? tr('Remove this new row') : deleted ? tr('Keep this row') : tr('Delete this row'),
        onclick: toggle,
      }, deleted ? '↶' : '×');
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
      finishEdit?.(true);
      const d = view.data;
      // The connection became read-only (reconnected): stop editing.
      if (view.edit && !writable() && !changeCount(view.pending)) view.edit = false;
      updateEditBar();
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
      const rowEl = (ref, num, cls) =>
        h('tr', { class: cls, ...(ref.j !== undefined ? { 'data-new': String(ref.j) } : { 'data-row': String(ref.i) }) }, [
          h('td', { class: 'dt-rownum' }, view.edit ? [rowButton(ref), num] : num),
          ...d.columns.map((c) => {
            const td = h('td');
            paintCell(td, ref, c);
            return td;
          }),
        ]);
      const body = d.rows.map((_, i) => rowEl({ i }, String(view.offset + i + 1), view.pending.deletes.has(i) ? 'deleted' : ''));
      if (view.edit) {
        body.push(...view.pending.inserts.map((_, j) => rowEl({ j }, '+', 'new')));
        body.push(h('tr', { class: 'dt-newrow', title: tr('Click a cell to add a row') }, [h('td', { class: 'dt-rownum' }, '*'), ...d.columns.map(() => h('td'))]));
      }
      grid.replaceChildren(
        view.edit && !d.primaryKey.length ? h('div', { class: 'dt-edit-note muted small' }, tr('This table has no primary key: rows can be added here, but not changed or deleted.')) : '',
        h('table', { class: `dt-grid${view.edit ? ' editing' : ''}` }, [h('thead', {}, head), h('tbody', {}, body)]),
        d.rows.length || view.edit ? '' : h('div', { class: 'db-empty' }, filtered ? tr('No rows match the filters.') : tr('The table is empty.'))
      );
    }
    view.render = render;
    return view;
  }

  async function setFilter(view, column, filter) {
    if (!(await view.confirmDiscard())) return;
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
        onclick: async () => {
          closePopup();
          if (!(await view.confirmDiscard())) return;
          view.sort = [{ column: col.name, direction: dir }];
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
  // Reload open tabs after a commit or schema refresh; unsaved edits are kept.
  ctx.events.addEventListener('schema', () => views.forEach((v) => tabs.current() === `data:${v.table}` && !changeCount(v.pending) && v.load()));
  // Another database: its tables' data tabs are closed.
  ctx.events.addEventListener('database-switch', () => {
    for (const table of [...views.keys()]) tabs.remove(`data:${table}`);
  });

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
