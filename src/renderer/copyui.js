// "Copy rows" in the import dialog: after tables from MySQL / MariaDB, SQL
// Server, SQLite or a MySQL dump are added to the diagram, their rows can be
// copied into the connected PostgreSQL database. The main process does the
// copy (src/main/database/data-copy.cjs) in one transaction; this module
// offers the option, builds the request and shows the progress.

import { modelFromSpecs } from './lib/spreadsheet.js';
import { generateSQL } from './lib/sql.js';
import { tr, trn } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);

// generateSQL wraps its statements in BEGIN / END; the copy runs them inside its own transaction.
const statementsOf = (sql) =>
  sql
    .split('\n')
    .filter((l) => !/^(BEGIN|END);$/.test(l.trim()))
    .join('\n');

/** Tables in an order where a table comes after the ones it references (cycles keep their order). */
export function copyOrder(specs) {
  const key = (schema, name) => `${schema}.${name}`.toLowerCase();
  const byKey = new Map(specs.map((s) => [key(s.schema, s.name), s]));
  const out = [];
  const state = new Map(); // spec -> 'visiting' | 'done'
  const visit = (s) => {
    if (state.has(s)) return;
    state.set(s, 'visiting');
    for (const c of s.columns) {
      if (!c.ref) continue;
      const target = byKey.get(key(c.ref.schema || s.schema, c.ref.table));
      if (target && target !== s && state.get(target) !== 'visiting') visit(target);
    }
    state.set(s, 'done');
    out.push(s);
  };
  specs.forEach(visit);
  return out;
}

/**
 * The request for src/main/database/data-copy.cjs. `chosen` are the dialog's
 * specs with the user's names (each with its `source`), `source` where the
 * rows come from ({ kind, conn } or { kind, filePath }).
 */
export function copyRequest(chosen, source, { truncate = false } = {}) {
  const ordered = copyOrder(chosen.filter((s) => s.source));
  const withoutRefs = ordered.map((s) => ({ ...s, columns: s.columns.map((c) => ({ ...c, ref: null })) }));
  return {
    source,
    truncate,
    createSql: statementsOf(generateSQL(modelFromSpecs(withoutRefs).model)),
    foreignKeySql: statementsOf(generateSQL(modelFromSpecs(ordered).model)),
    tables: ordered.map((s) => ({
      target: { schema: s.schema, name: s.name },
      columns: s.columns.map((c) => ({ name: c.name, type: c.length ? `${c.type}(${c.length}${c.precision !== null && c.precision !== undefined ? `,${c.precision}` : ''})` : c.type })),
      source: s.source,
    })),
  };
}

export function setupCopy({ host, h, status }) {
  const options = $('#xl-copy-options');
  const copyBox = $('#xl-copy');
  const truncateBox = $('#xl-truncate');
  const targetEl = $('#xl-copy-target');
  const dialog = $('#copy-dialog');
  const progress = $('#copy-progress');
  const tablesEl = $('#copy-tables');
  const statusEl = $('#copy-status');
  const stopButton = $('#copy-stop');
  const closeButton = $('#copy-close');
  let target = null; // the connection's public info when it can take the copy
  let running = false;

  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };

  const syncTruncate = () => {
    truncateBox.disabled = !copyBox.checked || copyBox.disabled;
  };
  copyBox.addEventListener('change', syncTruncate);

  /** Show the option for a source that has rows (null hides it), checking the connection again. */
  async function offer(source) {
    options.hidden = !source;
    if (!source) return;
    let info = null;
    try {
      info = await call(host.db.info);
    } catch {}
    const policy = info?.profile?.policy ?? {};
    target = info && policy.allowWrites && policy.allowDDL ? info : null;
    copyBox.disabled = !target;
    if (!target) copyBox.checked = false;
    targetEl.textContent = !info
      ? tr('Connect to a PostgreSQL database to copy rows.')
      : !target
        ? tr('The connection {name} does not allow writes and schema changes.', { name: info.description })
        : `→ ${info.description}${info.profile?.environment ? ` (${tr(info.profile.environment[0].toUpperCase() + info.profile.environment.slice(1))})` : ''}`;
    syncTruncate();
  }

  const wanted = () => !options.hidden && copyBox.checked && !copyBox.disabled;

  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `db-status ${kind}`;
  }

  let rows = []; // [{ el, count }]
  host.copy.onProgress((p) => {
    if (!running) return;
    rows.forEach((r, k) => r.el.classList.toggle('current', k === p.index && !p.done));
    const r = rows[p.index];
    if (r) {
      r.count.textContent = trn(p.rows, '{n} row', '{n} rows');
      if (p.done) r.el.classList.add('done');
    }
    progress.value = rows.filter((x) => x.el.classList.contains('done')).length;
  });

  stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    setStatus(tr('Stopping…'));
    await host.copy.stop();
  });
  // Esc must not hide a copy that is still running.
  dialog.addEventListener('cancel', (e) => {
    if (running) e.preventDefault();
  });

  /** Run the copy for the imported specs; resolves when it is over. */
  async function run(chosen, source, fileName) {
    const req = copyRequest(chosen, source, { truncate: truncateBox.checked });
    if (!req.tables.length) return;
    running = true;
    rows = req.tables.map((t) => {
      const count = h('span', { class: 'count' }, '');
      const el = h('div', { class: 'item' }, [h('span', {}, `${t.target.schema}.${t.target.name}`), count]);
      return { el, count };
    });
    tablesEl.replaceChildren(...rows.map((r) => r.el));
    progress.max = req.tables.length;
    progress.value = 0;
    $('#copy-target').textContent = tr('From {source} into {target}. Everything is copied in one transaction: if anything fails, nothing is changed.', {
      source: fileName,
      target: target?.description ?? '',
    });
    setStatus(tr('Copying…'));
    stopButton.disabled = false;
    stopButton.style.display = '';
    closeButton.disabled = true;
    dialog.showModal();
    try {
      const r = await call(host.copy.run, req);
      setStatus(tr('Copied {rows} rows into {tables} tables.', { rows: r.total, tables: r.tables.length }), 'ok');
      status(tr('Copied {rows} rows into {tables} tables.', { rows: r.total, tables: r.tables.length }));
    } catch (err) {
      setStatus(err.message, 'error');
      status(tr('The copy failed: {message}', { message: err.message }));
    } finally {
      running = false;
      rows.forEach((r) => r.el.classList.remove('current'));
      stopButton.style.display = 'none';
      closeButton.disabled = false;
      closeButton.focus();
    }
  }

  return { offer, wanted, run };
}
