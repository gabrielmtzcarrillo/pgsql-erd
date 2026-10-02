// The Builder tab: a visual query builder. Tables are dragged from the
// database explorer onto the canvas and their columns picked with
// checkboxes; tables with a foreign key between them are joined
// automatically, and dragging a column onto a column of another table joins
// them by hand. The SQL is shown below the canvas and opens (or runs) in the
// Query tab. The SQL itself comes from lib/querybuilder.js.

import { TABLE_DRAG_TYPE } from './dbtree.js';
import { tableKey } from './lib/catalog.js';
import { formatType } from './lib/sql.js';
import { aliasFor, foreignKeys, autoJoins, buildSQL, reconcile, JOIN_TYPES } from './lib/querybuilder.js';
import { highlightSQL } from './lib/highlight.js';
import { iconElement, decorateButtons } from './icons.js';
import { tr, trn } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);
const STATE_KEY = 'pgsql-erd.query-builder';
const SPLIT_KEY = 'pgsql-erd.query-builder-split';
// dataTransfer type of a column dragged onto another to join them.
const COLUMN_DRAG_TYPE = 'application/x-pgsql-erd-column';
const MARGIN = 20;
const GAP = 60;

export function setupQueryBuilder(ctx) {
  const { h, status, db, tabs, events, dbTree } = ctx;
  const page = $('#builder-page');
  const canvas = $('#qb-canvas');
  const area = $('#qb-area');
  const lines = $('#qb-lines');
  const sqlBox = $('#qb-sql');
  let st = load();
  let seq = 0;
  const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  function load() {
    const empty = { tables: [], joins: [], distinct: false, limit: '' };
    try {
      const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
      return saved && Array.isArray(saved.tables) && Array.isArray(saved.joins) ? { ...empty, ...saved } : empty;
    } catch {
      return empty;
    }
  }
  function save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(st));
    } catch {
      // not remembered
    }
  }

  const tableById = (id) => st.tables.find((t) => t.id === id);
  // The table as read from the database: columns, types and keys.
  const dbTable = (t) => dbTree.model()?.tables.find((x) => tableKey(x) === tableKey(t)) ?? null;
  const sql = () => buildSQL(st);

  // ------------------------------------------------------------ editing

  function changed() {
    save();
    render();
    if (tabs.current() === 'builder') dbTree.render();
  }

  // Adds a table at `at` (canvas coordinates), or after the last one, joined
  // to the tables already there that it has a foreign key with.
  async function addTable(key, at) {
    if (!dbTree.model()) await dbTree.load();
    const model = dbTree.model();
    const src = model?.tables.find((t) => tableKey(t) === key);
    if (!src) return;
    const pos = at ?? nextSpot();
    const t = {
      id: newId(),
      schema: src.schema,
      name: src.name,
      alias: aliasFor(src.name, new Set(st.tables.map((x) => x.alias))),
      x: Math.max(0, Math.round(pos.x)),
      y: Math.max(0, Math.round(pos.y)),
      columns: [],
    };
    st.tables.push(t);
    const added = autoJoins(foreignKeys(model), st.tables, st.joins, t).map((j) => ({ id: newId(), ...j }));
    st.joins.push(...added);
    changed();
    status(added.length
      ? trn(added.length, 'Added {name} with {n} join', 'Added {name} with {n} joins', { name: key })
      : tr('Added {name}', { name: key }));
  }

  // Right of the last table, or below everything when the row is full.
  function nextSpot() {
    const cards = [...area.querySelectorAll('.qb-table')];
    if (!cards.length) return { x: MARGIN, y: MARGIN };
    const last = cards.at(-1);
    const x = last.offsetLeft + last.offsetWidth + GAP;
    if (x + last.offsetWidth <= canvas.clientWidth) return { x, y: last.offsetTop };
    return { x: MARGIN, y: Math.max(...cards.map((c) => c.offsetTop + c.offsetHeight)) + GAP / 2 };
  }

  function removeTable(id) {
    st.tables = st.tables.filter((t) => t.id !== id);
    st.joins = st.joins.filter((j) => j.a !== id && j.b !== id);
    changed();
  }

  // Ticks or unticks a column, keeping the table's column order.
  function setColumns(t, names) {
    const order = dbTable(t)?.columns.map((c) => c.name) ?? t.columns;
    const set = new Set(names);
    t.columns = order.filter((c) => set.has(c));
    save();
    updateSql();
  }

  function renameAlias(t, input) {
    const alias = input.value.trim();
    if (!alias || st.tables.some((x) => x !== t && x.alias === alias)) {
      input.value = t.alias;
      if (alias) status(tr('The alias {alias} is already used.', { alias }));
      return;
    }
    t.alias = alias;
    changed();
  }

  // A join by hand: column `ca` of table `a` equals column `cb` of table `b`.
  // Added to the join between the two tables when there is one.
  function joinColumns(a, ca, b, cb) {
    if (a === b) return;
    const j = st.joins.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    const pair = j?.a === b ? [cb, ca] : [ca, cb];
    if (j) {
      if (j.pairs.some(([x, y]) => x === pair[0] && y === pair[1])) return;
      j.pairs.push(pair);
      j.fk = null;
    } else {
      st.joins.push({ id: newId(), a, b, pairs: [pair], type: 'inner', fk: null });
    }
    changed();
  }

  // ------------------------------------------------------------ rendering

  function render() {
    const scroll = new Map([...area.querySelectorAll('.qb-table')].map((c) => [c.dataset.id, c.querySelector('.qb-cols').scrollTop]));
    $('#qb-empty').hidden = st.tables.length > 0;
    area.replaceChildren(lines, ...st.tables.map(card));
    for (const c of area.querySelectorAll('.qb-table')) c.querySelector('.qb-cols').scrollTop = scroll.get(c.dataset.id) ?? 0;
    $('#qb-distinct').checked = !!st.distinct;
    $('#qb-limit').value = st.limit ?? '';
    drawJoins();
    updateSql();
  }

  function updateSql() {
    const text = sql();
    highlightSQL(sqlBox, text || `-- ${tr('Drag tables here from the database explorer.')}`);
    for (const b of page.querySelectorAll('#qb-copy, #qb-open, #qb-run')) b.disabled = !text;
    $('#qb-status').textContent = st.tables.length
      ? `${trn(st.tables.length, '{n} table', '{n} tables')} · ${trn(st.joins.length, '{n} join', '{n} joins')} · ${trn(st.tables.reduce((n, t) => n + t.columns.length, 0), '{n} column', '{n} columns')}`
      : '';
    for (const c of area.querySelectorAll('.qb-table')) {
      const t = tableById(c.dataset.id);
      const all = c.querySelector('.qb-head input[type="checkbox"]');
      const total = c.querySelectorAll('.qb-col input').length;
      all.checked = total > 0 && t.columns.length === total;
      all.indeterminate = t.columns.length > 0 && t.columns.length < total;
    }
  }

  function card(t) {
    const src = dbTable(t);
    const fkCols = new Set();
    if (src) {
      for (const l of dbTree.model().links) if (l.localTable === src.id) fkCols.add(l.localCol);
    }
    // Without the database (not connected yet) only the picked columns are known.
    const cols = src ? src.columns : t.columns.map((name) => ({ name }));
    const all = h('input', {
      type: 'checkbox',
      title: tr('Select all columns'),
      onchange: (e) => setColumns(t, e.target.checked ? cols.map((c) => c.name) : []),
    });
    const head = h('div', { class: 'qb-head', title: tr('Drag to move') }, [
      all,
      iconElement('toggle-tables', 'tree-icon'),
      h('span', { class: 'qb-name', title: tableKey(t) }, t.name),
      h('input', {
        class: 'qb-alias',
        value: t.alias,
        spellcheck: 'false',
        title: tr('Alias of the table in the query'),
        onchange: (e) => renameAlias(t, e.target),
        onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
      }),
      h('button', { type: 'button', class: 'qb-remove', icon: 'close', title: tr('Remove the table from the query'), onclick: () => removeTable(t.id) }),
    ]);
    head.addEventListener('pointerdown', (e) => startMove(e, t, head.parentElement));
    const body = h('div', { class: 'qb-cols' }, cols.map((c) => columnRow(t, c, fkCols)));
    body.addEventListener('scroll', drawJoins);
    if (!src) body.append(h('div', { class: 'qb-note' }, db.connected() ? tr('Not in the database.') : tr('Connect to see the columns.')));
    return h('div', { class: 'qb-table', 'data-id': t.id, style: `left:${t.x}px;top:${t.y}px` }, [head, body]);
  }

  function columnRow(t, c, fkCols) {
    const icon = c.pk ? iconElement('pk', 'tree-icon') : fkCols.has(c.attnum) ? iconElement('fk', 'tree-icon') : h('span', { class: 'tree-icon' });
    const type = c.type ? formatType(c) : '';
    const row = h('label', {
      class: 'qb-col',
      'data-col': c.name,
      draggable: 'true',
      title: `${c.name}${type ? ` ${type}` : ''}${c.notNull ? ' NOT NULL' : ''}\n${tr('Drag onto a column of another table to join them.')}`,
      ondragstart: (e) => {
        e.dataTransfer.setData(COLUMN_DRAG_TYPE, JSON.stringify({ table: t.id, col: c.name }));
        e.dataTransfer.effectAllowed = 'link';
      },
      ondragover: (e) => {
        if (!e.dataTransfer.types.includes(COLUMN_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        row.classList.add('drop');
      },
      ondragleave: () => row.classList.remove('drop'),
      ondrop: (e) => {
        row.classList.remove('drop');
        const raw = e.dataTransfer.getData(COLUMN_DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        const from = JSON.parse(raw);
        joinColumns(from.table, from.col, t.id, c.name);
      },
    }, [
      h('input', {
        type: 'checkbox',
        checked: t.columns.includes(c.name),
        onchange: (e) => setColumns(t, e.target.checked ? [...t.columns, c.name] : t.columns.filter((x) => x !== c.name)),
      }),
      icon,
      h('span', { class: `grow${c.notNull || c.pk ? ' nn' : ''}` }, c.name),
      h('span', { class: 'tree-type' }, type),
    ]);
    return row;
  }

  // Where a column's row is, for the end of a join line: its middle, kept
  // inside the visible part of the list when the list is scrolled.
  function anchor(cardEl, col) {
    const body = cardEl.querySelector('.qb-cols');
    const row = body.querySelector(`[data-col="${CSS.escape(col)}"]`);
    const top = cardEl.offsetTop + body.offsetTop;
    let y = top + (row ? row.offsetTop - body.scrollTop + row.offsetHeight / 2 : 0);
    y = Math.min(Math.max(y, top + 4), top + body.clientHeight - 4);
    return { left: cardEl.offsetLeft, right: cardEl.offsetLeft + cardEl.offsetWidth, y };
  }

  // Short label and explanation of each join type, by the tables' aliases.
  function joinTypes(j) {
    const a = tableById(j.a).alias;
    const b = tableById(j.b).alias;
    return {
      inner: [tr('Matching'), tr('Only rows of {a} and {b} that match', { a, b })],
      left: [tr('All of {alias}', { alias: a }), tr('Every row of {a}, with {b} where it matches', { a, b })],
      right: [tr('All of {alias}', { alias: b }), tr('Every row of {a}, with {b} where it matches', { a: b, b: a })],
      full: [tr('All of both'), tr('Every row of {a} and of {b}, matched where they can be', { a, b })],
    };
  }

  function drawJoins() {
    const cards = new Map([...area.querySelectorAll('.qb-table')].map((c) => [c.dataset.id, c]));
    let w = canvas.clientWidth;
    let hgt = canvas.clientHeight;
    for (const c of cards.values()) {
      w = Math.max(w, c.offsetLeft + c.offsetWidth + MARGIN);
      hgt = Math.max(hgt, c.offsetTop + c.offsetHeight + MARGIN);
    }
    area.style.width = `${w}px`;
    area.style.height = `${hgt}px`;
    lines.setAttribute('width', w);
    lines.setAttribute('height', hgt);
    area.querySelectorAll('.qb-join').forEach((x) => x.remove());
    const paths = [];
    for (const j of st.joins) {
      const ca = cards.get(j.a);
      const cb = cards.get(j.b);
      if (!ca || !cb) continue;
      let mid = null;
      for (const [x, y] of j.pairs) {
        const p = anchor(ca, x);
        const q = anchor(cb, y);
        // Each end leaves its table sideways (d = -1 left, 1 right).
        let x1, x2, d1, d2;
        if (p.right + 10 < q.left) [x1, x2, d1, d2] = [p.right, q.left, 1, -1];
        else if (q.right + 10 < p.left) [x1, x2, d1, d2] = [p.left, q.right, -1, 1];
        else [x1, x2, d1, d2] = [p.right, q.right, 1, 1]; // one above the other: loop out to the right
        const bend = Math.max(40, Math.abs(x2 - x1) / 2);
        paths.push(`M${x1},${p.y} C${x1 + d1 * bend},${p.y} ${x2 + d2 * bend},${q.y} ${x2},${q.y}`);
        mid ??= { x: d1 === d2 ? Math.max(x1, x2) + bend * 0.75 : (x1 + x2) / 2, y: (p.y + q.y) / 2 };
      }
      if (mid) area.append(joinWidget(j, mid));
    }
    lines.innerHTML = paths.map((d) => `<path class="qb-line" d="${d}"/>`).join('');
  }

  function joinWidget(j, at) {
    const a = tableById(j.a);
    const b = tableById(j.b);
    const types = joinTypes(j);
    const cond = j.pairs.map(([x, y]) => `${a.alias}.${x} = ${b.alias}.${y}`).join(' AND ');
    const help = () => `${cond}\n${types[j.type]?.[1] ?? ''}`;
    return h('div', { class: 'qb-join', style: `left:${at.x}px;top:${at.y}px` }, [
      h('select', {
        title: help(),
        onchange: (e) => {
          j.type = e.target.value;
          e.target.title = help();
          save();
          updateSql();
        },
      }, JOIN_TYPES.map((type) => h('option', { value: type, selected: j.type === type, title: types[type][1] }, types[type][0]))),
      h('button', {
        type: 'button',
        icon: 'close',
        title: tr('Remove the join'),
        onclick: () => {
          st.joins = st.joins.filter((x) => x !== j);
          changed();
        },
      }),
    ]);
  }

  // Drag a table by its header.
  function startMove(e, t, el) {
    if (e.button !== 0 || e.target.closest('input, button, select')) return;
    e.preventDefault();
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX - t.x;
    const sy = e.clientY - t.y;
    el.classList.add('moving');
    const move = (ev) => {
      t.x = Math.max(0, Math.round(ev.clientX - sx));
      t.y = Math.max(0, Math.round(ev.clientY - sy));
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
      drawJoins();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      el.classList.remove('moving');
      save();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------ drops from the explorer

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
    const r = area.getBoundingClientRect();
    addTable(key, { x: e.clientX - r.left - 20, y: e.clientY - r.top - 12 });
  });

  // ------------------------------------------------------------ toolbar

  $('#qb-distinct').addEventListener('change', (e) => {
    st.distinct = e.target.checked;
    save();
    updateSql();
  });
  $('#qb-limit').addEventListener('input', (e) => {
    st.limit = e.target.value;
    save();
    updateSql();
  });
  $('#qb-clear').addEventListener('click', () => {
    st = { ...st, tables: [], joins: [] };
    changed();
  });
  $('#qb-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(sql());
    status(tr('SQL copied to the clipboard'));
  });
  $('#qb-open').addEventListener('click', () => ctx.openSql(sql()));
  $('#qb-run').addEventListener('click', async () => {
    await ctx.openSql(sql());
    ctx.runQuery();
  });

  (function setupResize() {
    const handle = $('#qb-resize');
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      if (saved) sqlBox.style.height = `${saved}px`;
    } catch { /* storage unavailable */ }
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = sqlBox.getBoundingClientRect().height;
      const move = (ev) => (sqlBox.style.height = `${Math.max(60, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY)))}px`);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        drawJoins();
        try {
          localStorage.setItem(SPLIT_KEY, String(Math.round(sqlBox.getBoundingClientRect().height)));
        } catch { /* storage unavailable */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  })();

  // ------------------------------------------------------------ explorer and schema

  // While this tab is shown the explorer sits beside the canvas and sends
  // tables here.
  const explorerTarget = {
    present: () => new Set(st.tables.map(tableKey)),
    add: (key) => addTable(key),
    title: (key, present) => present
      ? tr('{name} is in the query. Double-click to add it again.', { name: key })
      : tr('Drag {name} into the query, or double-click.', { name: key }),
    tag: () => tr('In the query'),
    hint: () => tr('Drag tables into the query; related tables are joined.'),
  };
  tabs.onShow((name) => {
    if (name === 'builder') {
      dbTree.attach(page, explorerTarget);
      if (!dbTree.model() && db.connected()) dbTree.load();
      render();
    } else if (name === 'erd') {
      dbTree.attach($('main.workspace'));
    }
  });
  // The schema was read again: drop tables and columns that are gone.
  events.addEventListener('schema', (e) => {
    if (!e.model) return;
    st = reconcile(st, e.model);
    save();
    if (tabs.current() === 'builder') render();
  });
  // Another database: the query is closed.
  events.addEventListener('database-switch', () => {
    st = { ...st, tables: [], joins: [] };
    changed();
  });
  window.addEventListener('resize', () => tabs.current() === 'builder' && drawJoins());

  decorateButtons(page);

  return {
    commands: {
      'query-builder': () => tabs.show('builder'),
    },
  };
}
