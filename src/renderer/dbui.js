// Database features: connect, import tables into the diagram, and compare the
// diagram with the database to generate (and optionally run) migration SQL.

import { modelFromCatalog, tableKey } from './lib/catalog.js';
import { diffModels } from './lib/diff.js';
import { mergeFromDb } from './lib/sync.js';
import { autoLayout, contentBounds, placeBelow } from './lib/layout.js';
import { highlightSQL } from './lib/highlight.js';

const STORAGE_KEY = 'pgsql-erd.connection';
const $ = (sel) => document.querySelector(sel);

export function setupDatabase(ctx) {
  const { host, state, h, commit, computeSizes, fit, status } = ctx;
  let conn = null; // { host, port, database, user, password, sslmode }

  const describe = (c) => `${c.user || 'postgres'}@${c.host || 'localhost'}:${c.port || 5432}/${c.database || 'postgres'}`;

  function setStatus(el, text, kind = '') {
    el.textContent = text ?? '';
    el.className = `db-status ${kind}`;
  }

  function updateIndicator() {
    $('#status-db').textContent = conn ? `DB: ${describe(conn)}` : 'Not connected';
    $('#db-button .label').textContent = conn ? 'Connected' : 'Connect';
    $('#db-button').title = conn ? `Connected to ${describe(conn)} (click to change)` : 'Connect to a PostgreSQL database';
  }

  // Unwrap { ok, result | error } from the main process.
  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  async function loadCatalog() {
    const catalog = await call(host.db.introspect, conn);
    const model = modelFromCatalog(catalog);
    model.schemas = catalog.schemas;
    return model;
  }

  // ------------------------------------------------------------ connect

  const connectDialog = $('#db-connect-dialog');
  const connectForm = $('#db-connect-form');
  const connectStatus = $('#db-connect-status');
  let afterConnect = null;

  const formConn = () => {
    const f = connectForm.elements;
    return {
      host: f.host.value.trim(),
      port: f.port.value.trim(),
      database: f.database.value.trim(),
      user: f.user.value.trim(),
      password: f.password.value,
      sslmode: f.sslmode.value,
    };
  };

  function openConnect(then = null) {
    afterConnect = then;
    let saved = conn;
    if (!saved) {
      try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      } catch {
        saved = null;
      }
    }
    const f = connectForm.elements;
    for (const k of ['host', 'port', 'database', 'user']) f[k].value = saved?.[k] ?? '';
    f.password.value = conn?.password ?? '';
    f.sslmode.value = saved?.sslmode ?? 'disable';
    setStatus(connectStatus, '');
    connectDialog.returnValue = '';
    connectDialog.showModal();
    (f.host.value ? f.password : f.host).focus();
  }

  async function test(c) {
    setStatus(connectStatus, 'Connecting…');
    const info = await call(host.db.test, c);
    setStatus(connectStatus, `Connected to ${info.database} as ${info.user}\n${info.version}`, 'ok');
    return info;
  }

  $('#db-test').addEventListener('click', () =>
    test(formConn()).catch((err) => setStatus(connectStatus, err.message, 'error'))
  );

  connectForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault(); // keep the dialog open until the connection works
    const c = formConn();
    try {
      await test(c);
    } catch (err) {
      return setStatus(connectStatus, err.message, 'error');
    }
    conn = c;
    const { password, ...rest } = c;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable: settings just won't be remembered */
    }
    updateIndicator();
    connectDialog.close('ok');
    status(`Connected to ${describe(c)}`);
    const then = afterConnect;
    afterConnect = null;
    then?.();
  });

  const requireConnection = (fn) => () => (conn ? fn() : openConnect(fn));

  // ------------------------------------------------------------ import

  const importDialog = $('#db-import-dialog');
  const importList = $('#db-import-list');
  const importStatus = $('#db-import-status');
  const importFilter = $('#db-import-filter');
  let importModel = null;

  function renderImportList() {
    const q = importFilter.value.trim().toLowerCase();
    const inErd = new Set(state.model.tables.map(tableKey));
    const bySchema = new Map();
    for (const t of importModel.tables) {
      const key = tableKey(t);
      if (q && !key.toLowerCase().includes(q)) continue;
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, []);
      bySchema.get(t.schema).push(t);
    }
    const checked = new Set([...importList.querySelectorAll('input:checked')].map((i) => i.value));
    const items = [];
    for (const [schema, tables] of bySchema) {
      items.push(h('div', { class: 'schema' }, schema));
      for (const t of tables) {
        const key = tableKey(t);
        const present = inErd.has(key);
        items.push(
          h('label', { class: 'item' }, [
            h('input', { type: 'checkbox', value: key, checked: checked.has(key) }),
            h('span', {}, t.name),
            h('span', { class: 'muted' }, `${t.columns.length} columns`),
            h('span', { class: `tag${present ? '' : ' new'}` }, present ? 'in diagram: update' : 'new'),
          ])
        );
      }
    }
    importList.replaceChildren(...(items.length ? items : [h('div', { class: 'db-empty' }, 'No tables found.')]));
  }

  async function refreshImport() {
    setStatus(importStatus, 'Reading database…');
    try {
      importModel = await loadCatalog();
      renderImportList();
      setStatus(importStatus, `${importModel.tables.length} tables in ${importModel.schemas.length} schemas (${describe(conn)})`);
    } catch (err) {
      importList.replaceChildren();
      setStatus(importStatus, err.message, 'error');
    }
  }

  async function openImport() {
    importFilter.value = '';
    importList.replaceChildren();
    importDialog.returnValue = '';
    importDialog.showModal();
    await refreshImport();
  }

  importFilter.addEventListener('input', () => importModel && renderImportList());
  $('#db-import-refresh').addEventListener('click', refreshImport);
  const setAll = (v) => importList.querySelectorAll('input[type=checkbox]').forEach((i) => (i.checked = v));
  $('#db-import-all').addEventListener('click', () => setAll(true));
  $('#db-import-none').addEventListener('click', () => setAll(false));

  importDialog.addEventListener('close', () => {
    if (importDialog.returnValue !== 'ok' || !importModel) return;
    const keys = [...importList.querySelectorAll('input:checked')].map((i) => i.value);
    if (!keys.length) return;
    const wasEmpty = state.model.tables.length === 0;
    let result;
    commit(() => {
      computeSizes();
      const before = contentBounds(state.model, state.sizes);
      result = mergeFromDb(state.model, importModel, keys);
      computeSizes();
      if (wasEmpty) {
        autoLayout(state.model, state.sizes);
      } else if (result.added.length) {
        placeBelow(state.model, state.sizes, result.added, before);
      }
    });
    if (wasEmpty || result.added.length) fit();
    status(`Imported ${result.added.length} new and updated ${result.updated.length} existing tables`);
  });

  // ------------------------------------------------------------ compare

  const compareDialog = $('#db-compare-dialog');
  const compareList = $('#db-compare-list');
  const compareSql = $('#db-compare-sql');
  const compareStatus = $('#db-compare-status');
  const optDestructive = $('#db-opt-destructive');
  const optDropTables = $('#db-opt-droptables');
  let dbModel = null;
  let result = null;
  const schemaChoice = new Map(); // schema -> checked

  function selectedSchemas() {
    return [...schemaChoice].filter(([, v]) => v).map(([k]) => k);
  }

  function renderSchemas() {
    const erdSchemas = new Set(state.model.tables.map((t) => t.schema || 'public'));
    const all = [...new Set([...erdSchemas, ...(dbModel?.schemas ?? [])])].sort();
    for (const s of all) if (!schemaChoice.has(s)) schemaChoice.set(s, erdSchemas.has(s));
    $('#db-compare-schemas').replaceChildren(
      h('span', { class: 'muted' }, 'Schemas:'),
      ...all.map((s) => {
        const cb = h('input', { type: 'checkbox', checked: schemaChoice.get(s) });
        cb.addEventListener('change', () => {
          schemaChoice.set(s, cb.checked);
          recompute();
        });
        return h('label', { class: 'check' }, [cb, s]);
      })
    );
  }

  function recompute() {
    if (!dbModel) return;
    result = diffModels(dbModel, state.model, {
      destructive: optDestructive.checked,
      dropTables: optDropTables.checked,
      schemas: selectedSchemas(),
    });
    const byTable = new Map();
    for (const c of result.changes) {
      if (!byTable.has(c.table)) byTable.set(c.table, []);
      byTable.get(c.table).push(c);
    }
    const sym = (k) => (k.startsWith('add') || k.startsWith('create') ? ['add', '+'] : k.startsWith('drop') ? ['drop', '−'] : ['alter', '~']);
    const items = [];
    for (const [table, list] of byTable) {
      items.push(h('div', { class: 'chg-table' }, table));
      for (const c of list) {
        const [cls, s] = sym(c.kind);
        items.push(
          h('div', { class: `chg ${cls}${c.skipped ? ' skipped' : ''}`, title: c.skipped ? 'Skipped: enable destructive changes to include' : '' }, [
            h('span', { class: 'sym' }, s),
            h('span', {}, c.summary),
          ])
        );
      }
    }
    compareList.replaceChildren(
      ...(items.length ? items : [h('div', { class: 'db-empty' }, 'No differences: the database matches the diagram.')])
    );
    highlightSQL(compareSql, result.sql);
    const active = result.changes.filter((c) => !c.skipped).length;
    const skipped = result.changes.length - active;
    setStatus(
      compareStatus,
      `${describe(conn)} — ${active} change${active === 1 ? '' : 's'}` + (skipped ? `, ${skipped} destructive skipped` : '')
    );
    $('#db-compare-exec').disabled = active === 0;
  }

  async function refreshCompare() {
    setStatus(compareStatus, 'Reading database…');
    try {
      dbModel = await loadCatalog();
      renderSchemas();
      recompute();
    } catch (err) {
      dbModel = null;
      compareList.replaceChildren();
      compareSql.textContent = '';
      $('#db-compare-exec').disabled = true;
      setStatus(compareStatus, err.message, 'error');
    }
  }

  async function openCompare() {
    compareList.replaceChildren();
    compareSql.textContent = '';
    schemaChoice.clear();
    compareDialog.showModal();
    await refreshCompare();
  }

  optDestructive.addEventListener('change', recompute);
  optDropTables.addEventListener('change', recompute);
  $('#db-compare-refresh').addEventListener('click', refreshCompare);
  $('#db-compare-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(compareSql.textContent);
    setStatus(compareStatus, 'SQL copied to clipboard', 'ok');
  });
  $('#db-compare-save').addEventListener('click', async () => {
    const base = state.filePath ? state.filePath.split(/[\\/]/).pop().replace(/\.pgerd$/i, '') : 'diagram';
    const target = await host.saveFile({ text: compareSql.textContent, saveAs: true, defaultName: `${base}-migration.sql`, kind: 'sql' });
    if (target) setStatus(compareStatus, `Saved ${target}`, 'ok');
  });
  $('#db-compare-exec').addEventListener('click', async () => {
    if (!result) return;
    const active = result.changes.filter((c) => !c.skipped);
    const drops = active.filter((c) => c.destructive).length;
    const choice = await host.confirm({
      message: `Run ${active.length} change${active.length === 1 ? '' : 's'} on ${describe(conn)}?`,
      detail:
        (drops ? `${drops} of them drop tables or columns and delete data.\n` : '') +
        'The script runs in a single transaction and is rolled back if any statement fails.',
      buttons: ['Run', 'Cancel'],
    });
    if (choice !== 0) return;
    setStatus(compareStatus, 'Running migration…');
    try {
      await call(host.db.execute, conn, result.sql);
    } catch (err) {
      return setStatus(compareStatus, `Migration failed and was rolled back:\n${err.message}`, 'error');
    }
    await refreshCompare();
    setStatus(compareStatus, `Migration applied. ${compareStatus.textContent}`, 'ok');
  });

  updateIndicator();

  return {
    'db-connect': () => openConnect(),
    'db-import': requireConnection(openImport),
    'db-compare': requireConnection(() => {
      if (!state.model.tables.length) return status('The diagram is empty: add or import tables first.');
      return openCompare();
    }),
  };
}
