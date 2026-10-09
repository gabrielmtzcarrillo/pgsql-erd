// Database features: connect, import tables into the diagram, and compare the
// diagram with the database to generate (and optionally run) migration SQL.

import { modelFromCatalog, tableKey } from './lib/catalog.js';
import { diffModels, migrationSQL } from './lib/diff.js';
import { mergeFromDb } from './lib/sync.js';
import { autoLayout, contentBounds, placeBelow } from './lib/layout.js';
import { highlightSQL } from './lib/highlight.js';
import { tr, trn } from '../shared/i18n.js';

const STORAGE_KEY = 'pgsql-erd.connection';
const $ = (sel) => document.querySelector(sel);

// Connection environments, by code.
export const envName = (env) =>
  ({ development: tr('Development'), testing: tr('Testing'), staging: tr('Staging'), production: tr('Production') })[env] ?? env;

export function setupDatabase(ctx) {
  const { host, state, h, commit, computeSizes, fit, status, events } = ctx;
  // The connection lives in the main process. Here we keep what it reports
  // back: settings without the password, the profile and its policy.
  let conn = null; // { conn: { host, port, database, user, sslmode }, description, profile }

  const describe = (c) => `${c.user || 'postgres'}@${c.host || 'localhost'}:${c.port || 5432}/${c.database || 'postgres'}`;

  function setStatus(el, text, kind = '') {
    el.textContent = text ?? '';
    el.className = `db-status ${kind}`;
  }

  function updateIndicator() {
    const env = conn?.profile.environment;
    const el = $('#status-db');
    el.textContent = conn
      ? `${tr('DB:')} ${conn.description}${env !== 'development' ? ` · ${envName(env).toUpperCase()}` : ''}${conn.profile.policy.allowWrites ? '' : ` · ${tr('read-only')}`}`
      : tr('Not connected');
    el.className = conn ? `env-${env}` : '';
    document.body.dataset.environment = env ?? '';
    $('#db-button .label').textContent = conn ? tr('Connected') : tr('Connect');
    $('#db-button').title = conn
      ? tr('Connected to {db} ({env}; click to change)', { db: conn.description, env: envName(env) })
      : tr('Connect to a PostgreSQL database');
    events.dispatchEvent(new Event('connection'));
  }

  // Unwrap { ok, result | error } from the main process.
  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  // Reads the catalog; the main process also refreshes its schema model,
  // which scripts and the assistant use.
  // The 'schema' event carries the catalog as a diagram model.
  async function loadCatalog() {
    const { catalog, changes } = await call(host.db.introspect);
    const model = modelFromCatalog(catalog);
    model.schemas = catalog.schemas;
    events.dispatchEvent(Object.assign(new Event('schema'), { changes, model }));
    return { model, changes };
  }

  async function refreshSchema() {
    status(tr('Reading the database schema…'));
    try {
      const { changes } = await loadCatalog();
      status(changes.length
        ? trn(changes.length, 'Schema refreshed: {n} change ({list})', 'Schema refreshed: {n} changes ({list})', { list: changes.slice(0, 3).join('; ') + (changes.length > 3 ? '; …' : '') })
        : tr('Schema refreshed: no changes'));
    } catch (err) {
      status(tr('Could not read the schema: {message}', { message: err.message }));
    }
  }

  // ------------------------------------------------------------ connect

  const connectDialog = $('#db-connect-dialog');
  const connectForm = $('#db-connect-form');
  const connectStatus = $('#db-connect-status');
  const instanceList = $('#db-instance-list');
  const instanceFilter = $('#db-instance-filter');
  let afterConnect = null;
  // Saved instances as the main process reports them: no passwords, only
  // whether one is saved. selected is the instance shown in the form, or null
  // for a new connection.
  let saved = { instances: [], secureStorage: false, lastId: null, reconnect: false };
  let selected = null;

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
  const formProfile = () => {
    const f = connectForm.elements;
    return {
      name: f.profileName.value.trim(),
      environment: f.environment.value,
      policy: { allowWrites: f.allowWrites.checked, allowDDL: f.allowDDL.checked },
    };
  };
  // Production starts read-only; the user can still opt in.
  connectForm.elements.environment.addEventListener('change', () => {
    const prod = connectForm.elements.environment.value === 'production';
    connectForm.elements.allowWrites.checked = !prod;
    connectForm.elements.allowDDL.checked = !prod;
  });

  const instance = (id) => saved.instances.find((i) => i.id === id) ?? null;

  function updateSaveOptions() {
    const f = connectForm.elements;
    f.rememberPassword.disabled = !f.saveInstance.checked;
    if (!f.saveInstance.checked) f.rememberPassword.checked = false;
  }
  connectForm.elements.saveInstance.addEventListener('change', updateSaveOptions);

  async function loadInstances() {
    try {
      saved = await call(host.db.instances);
    } catch {
      /* keep the last list */
    }
    if (selected && !instance(selected)) selected = null;
  }

  function renderInstances() {
    const q = instanceFilter.value.trim().toLowerCase();
    const shown = saved.instances.filter((i) => !q || `${i.name} ${describe(i)}`.toLowerCase().includes(q));
    const items = shown.map((i) => {
      const env = i.environment ?? 'development';
      const item = h('label', { class: `item${i.id === selected ? ' active' : ''}`, role: 'option', 'aria-selected': String(i.id === selected), title: tr('Double-click to connect') }, [
        h('span', { class: 'inst-name' }, [h('span', {}, i.name), h('span', { class: `tag env-${env}` }, envName(env))]),
        h('span', { class: 'inst-target', title: describe(i) }, `${describe(i)}${i.hasPassword ? ` · ${tr('password saved')}` : ''}`),
      ]);
      item.addEventListener('click', () => {
        selectInstance(i.id);
        if (!i.hasPassword) connectForm.elements.password.focus();
      });
      item.addEventListener('dblclick', () => {
        selectInstance(i.id);
        connectForm.requestSubmit(connectForm.querySelector('button[value="ok"]'));
      });
      return item;
    });
    const empty = saved.instances.length ? tr('No matching instances.') : tr('No saved instances yet. Connect with "Save this instance" checked to add one.');
    instanceList.replaceChildren(...(items.length ? items : [h('div', { class: 'db-empty' }, empty)]));
  }

  // Fills the form from saved settings: { host, port, …, profile } or an instance.
  function fillForm(from, { hasPassword = false } = {}) {
    const f = connectForm.elements;
    for (const k of ['host', 'port', 'database', 'user']) f[k].value = from?.[k] ?? '';
    // The password is never read back; leave it empty to use the saved one.
    f.password.value = '';
    f.password.placeholder = hasPassword ? `•••••••• ${tr('(saved — leave empty to use it)')}` : conn && !selected ? tr('(re-enter to reconnect)') : '';
    f.sslmode.value = from?.sslmode || 'disable';
    const profile = from?.profile ?? from;
    f.profileName.value = profile?.name && profile.name !== describe(from ?? {}) ? profile.name : '';
    f.environment.value = profile?.environment ?? 'development';
    const prod = f.environment.value === 'production';
    f.allowWrites.checked = profile?.policy?.allowWrites ?? !prod;
    f.allowDDL.checked = profile?.policy?.allowDDL ?? !prod;
  }

  function showSelection() {
    const i = instance(selected);
    const f = connectForm.elements;
    f.saveInstance.checked = true;
    f.rememberPassword.checked = !!i?.hasPassword;
    updateSaveOptions();
    $('#db-instance-forget').disabled = !i?.hasPassword;
    $('#db-instance-delete').disabled = !i;
    $('#db-password-where').textContent = saved.secureStorage
      ? tr('Saved passwords are encrypted with the system credential store and never shown again.')
      : tr('No system credential store is available: saved passwords are kept in memory until the app quits.');
    $('#db-reconnect').checked = saved.reconnect;
    renderInstances();
  }

  function selectInstance(id) {
    selected = id;
    const i = instance(id);
    fillForm(i, { hasPassword: i?.hasPassword });
    setStatus(connectStatus, '');
    showSelection();
  }

  function newConnection() {
    selected = null;
    fillForm(null);
    setStatus(connectStatus, '');
    showSelection();
    connectForm.elements.host.focus();
  }

  async function openConnect(then = null) {
    afterConnect = then;
    await loadInstances();
    instanceFilter.value = '';
    const current = instance(conn?.instanceId) ? conn.instanceId : !conn && instance(saved.lastId) ? saved.lastId : null;
    if (current) {
      selectInstance(current);
    } else {
      // An unsaved connection, or settings remembered before instances were saved.
      let from = conn ? { ...conn.conn, profile: conn.profile } : null;
      if (!from) {
        try {
          from = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch {
          from = null;
        }
      }
      selected = null;
      fillForm(from);
      setStatus(connectStatus, '');
      showSelection();
    }
    connectDialog.returnValue = '';
    connectDialog.showModal();
    const f = connectForm.elements;
    (!f.host.value ? f.host : instance(selected)?.hasPassword ? f.database : f.password).focus();
  }

  instanceFilter.addEventListener('input', renderInstances);
  $('#db-instance-new').addEventListener('click', newConnection);
  $('#db-instance-forget').addEventListener('click', async () => {
    if (!selected) return;
    try {
      saved = await call(host.db.forgetPassword, selected);
      selectInstance(selected);
      setStatus(connectStatus, tr('Password forgotten'), 'ok');
    } catch (err) {
      setStatus(connectStatus, err.message, 'error');
    }
  });
  $('#db-instance-delete').addEventListener('click', async () => {
    const i = instance(selected);
    if (!i) return;
    const choice = await host.confirm({
      message: tr('Delete the saved instance "{name}"?', { name: i.name }),
      detail: tr('Its settings and saved password are removed. Open connections are not affected.'),
      buttons: [tr('Delete'), tr('Cancel')],
    });
    if (choice !== 0) return;
    try {
      saved = await call(host.db.deleteInstance, i.id);
      if (conn?.instanceId === i.id) conn.instanceId = null;
      newConnection();
      setStatus(connectStatus, tr('Deleted {name}', { name: i.name }), 'ok');
    } catch (err) {
      setStatus(connectStatus, err.message, 'error');
    }
  });
  $('#db-reconnect').addEventListener('change', async (e) => {
    try {
      saved = await call(host.db.setReconnect, e.target.checked);
    } catch (err) {
      setStatus(connectStatus, err.message, 'error');
    }
  });

  async function test(c) {
    setStatus(connectStatus, tr('Connecting…'));
    const info = await call(host.db.test, c, selected);
    setStatus(connectStatus, `${tr('Connected to {db} as {user}', { db: info.database, user: info.user })}\n${info.version}`, 'ok');
    return info;
  }

  $('#db-test').addEventListener('click', () =>
    test(formConn()).catch((err) => setStatus(connectStatus, err.message, 'error'))
  );

  // Changing to another database closes what belongs to the current one.
  // Asked before connecting; true to go ahead.
  async function confirmSwitch(target) {
    const choice = await host.confirm({
      message: tr('Change the connection to {db}?', { db: describe(target) }),
      detail: tr('The diagrams and the data tabs are closed, the query builders emptied and the query results cleared. Unsaved changes to the diagrams are discarded.'),
      buttons: [tr('Change Connection'), tr('Cancel')],
    });
    return choice === 0;
  }

  // Records the new connection and tells the rest of the page. A different
  // database than before sends 'database-switch' first, so the diagram, data
  // tabs, query builder and query results tied to the old one are closed.
  function connected(result) {
    const { saved: list, ...info } = result;
    const switched = !!conn && describe(conn.conn) !== describe(info.conn);
    if (switched) events.dispatchEvent(new Event('database-switch'));
    conn = info;
    if (list) saved = list;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...conn.conn, profile: conn.profile }));
    } catch {
      /* storage unavailable: settings just won't be remembered */
    }
    updateIndicator();
    status(tr('Connected to {db} ({env})', { db: conn.description, env: envName(conn.profile.environment) }));
    refreshSchema();
  }

  connectForm.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault(); // keep the dialog open until the connection works
    const f = connectForm.elements;
    const opts = { instanceId: selected, save: f.saveInstance.checked, rememberPassword: f.saveInstance.checked && f.rememberPassword.checked };
    const target = formConn();
    if (conn && describe(conn.conn) !== describe(target) && !(await confirmSwitch(target))) return;
    setStatus(connectStatus, tr('Connecting…'));
    let result;
    try {
      result = await call(host.db.connect, formConn(), formProfile(), opts);
    } catch (err) {
      return setStatus(connectStatus, err.message, 'error');
    }
    f.password.value = '';
    selected = result.instanceId;
    connected(result);
    connectDialog.close('ok');
    const then = afterConnect;
    afterConnect = null;
    then?.();
  });

  // Reopens the last session when the user asked for that and its password is saved.
  async function reconnectLastSession() {
    let id;
    try {
      id = await call(host.db.startupInstance);
    } catch {
      return;
    }
    if (!id || conn) return;
    status(tr('Reconnecting to the last instance…'));
    try {
      connected(await call(host.db.connectInstance, id));
    } catch (err) {
      status(tr('Could not reconnect to the last instance: {message}', { message: err.message }));
    }
  }

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
            h('span', { class: 'muted' }, trn(t.columns.length, '{n} column', '{n} columns')),
            h('span', { class: `tag${present ? '' : ' new'}` }, present ? tr('in diagram: update') : tr('new')),
          ])
        );
      }
    }
    importList.replaceChildren(...(items.length ? items : [h('div', { class: 'db-empty' }, tr('No tables found.'))]));
  }

  async function refreshImport() {
    setStatus(importStatus, tr('Reading database…'));
    try {
      ({ model: importModel } = await loadCatalog());
      renderImportList();
      setStatus(importStatus, `${trn(importModel.tables.length, '{n} table', '{n} tables')} · ${trn(importModel.schemas.length, '{n} schema', '{n} schemas')} (${conn.description})`);
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
    status(tr('Imported {added} new and updated {updated} existing tables', { added: result.added.length, updated: result.updated.length }));
  });

  // ------------------------------------------------------------ compare

  const compareDialog = $('#db-compare-dialog');
  const compareList = $('#db-compare-list');
  const compareSql = $('#db-compare-sql');
  const compareStatus = $('#db-compare-status');
  const optDestructive = $('#db-opt-destructive');
  const optDropTables = $('#db-opt-droptables');
  const optRecreate = $('#db-opt-recreate');
  let dbModel = null;
  let result = null;
  const schemaChoice = new Map(); // schema -> checked
  // Changes are identified by what they do, so the choice survives a refresh.
  const changeId = (c) => `${c.kind}\0${c.table}\0${c.summary}`;
  const excluded = new Set(); // ids of changes the user unchecked
  const selectedChanges = () => (result?.changes ?? []).filter((c) => !c.skipped && !excluded.has(changeId(c)));

  function selectedSchemas() {
    return [...schemaChoice].filter(([, v]) => v).map(([k]) => k);
  }

  function renderSchemas() {
    const erdSchemas = new Set(state.model.tables.map((t) => t.schema || 'public'));
    const all = [...new Set([...erdSchemas, ...(dbModel?.schemas ?? [])])].sort();
    for (const s of all) if (!schemaChoice.has(s)) schemaChoice.set(s, erdSchemas.has(s));
    $('#db-compare-schemas').replaceChildren(
      h('span', { class: 'muted' }, tr('Schemas:')),
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
      recreateColumns: optRecreate.checked,
      schemas: selectedSchemas(),
    });
    // Tables only in the database are left alone unless dropping them is on.
    result.changes = result.changes.filter((c) => !(c.kind === 'drop-table' && c.skipped));
    const byTable = new Map();
    for (const c of result.changes) {
      if (!byTable.has(c.table)) byTable.set(c.table, []);
      byTable.get(c.table).push(c);
    }
    const sym = (k) => (k.startsWith('add') || k.startsWith('create') ? ['add', '+'] : k.startsWith('drop') ? ['drop', '−'] : ['alter', '~']);
    const items = [];
    for (const [table, list] of byTable) {
      const usable = list.filter((c) => !c.skipped);
      const all = h('input', { type: 'checkbox', disabled: !usable.length });
      const boxes = [];
      const syncAll = () => {
        const on = usable.filter((c) => !excluded.has(changeId(c))).length;
        all.checked = usable.length > 0 && on === usable.length;
        all.indeterminate = on > 0 && on < usable.length;
      };
      all.addEventListener('change', () => {
        for (const c of usable) all.checked ? excluded.delete(changeId(c)) : excluded.add(changeId(c));
        for (const [c, cb] of boxes) cb.checked = !c.skipped && all.checked;
        updateSelection();
      });
      items.push(h('label', { class: 'chg-table' }, [all, table]));
      for (const c of list) {
        const [cls, s] = sym(c.kind);
        const cb = h('input', { type: 'checkbox', disabled: c.skipped, checked: !c.skipped && !excluded.has(changeId(c)) });
        cb.addEventListener('change', () => {
          cb.checked ? excluded.delete(changeId(c)) : excluded.add(changeId(c));
          syncAll();
          updateSelection();
        });
        boxes.push([c, cb]);
        items.push(
          h('label', { class: `chg ${cls}${c.skipped ? ' skipped' : ''}`, title: c.skipped ? tr('Skipped: enable destructive changes to include') : '' }, [
            cb,
            h('span', { class: 'sym' }, s),
            h('span', {}, c.summary),
          ])
        );
      }
      syncAll();
    }
    compareList.replaceChildren(
      ...(items.length ? items : [h('div', { class: 'db-empty' }, tr('No differences: the database matches the diagram.'))])
    );
    updateSelection();
  }

  // Rebuilds the SQL and status from the checked changes, so the migration
  // can be applied in phases.
  function updateSelection() {
    const selected = selectedChanges();
    const active = result.changes.filter((c) => !c.skipped).length;
    const skipped = result.changes.length - active;
    highlightSQL(
      compareSql,
      selected.length ? migrationSQL(selected) : active ? `-- ${tr('No changes selected.')}\n` : migrationSQL(result.changes)
    );
    setStatus(
      compareStatus,
      `${conn.description} — ${trn(active, '{n} change', '{n} changes')}` +
        (selected.length !== active ? `, ${tr('{n} selected', { n: selected.length })}` : '') +
        (skipped ? `, ${trn(skipped, '{n} destructive change skipped', '{n} destructive changes skipped')}` : '')
    );
    $('#db-compare-exec').disabled = selected.length === 0;
  }

  async function refreshCompare() {
    setStatus(compareStatus, tr('Reading database…'));
    try {
      ({ model: dbModel } = await loadCatalog());
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
    excluded.clear();
    compareDialog.showModal();
    await refreshCompare();
  }

  optDestructive.addEventListener('change', recompute);
  optDropTables.addEventListener('change', recompute);
  optRecreate.addEventListener('change', recompute);
  $('#db-compare-refresh').addEventListener('click', refreshCompare);
  $('#db-compare-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(compareSql.textContent);
    setStatus(compareStatus, tr('SQL copied to clipboard'), 'ok');
  });
  $('#db-compare-save').addEventListener('click', async () => {
    const base = state.filePath ? state.filePath.split(/[\\/]/).pop().replace(/\.pgerd$/i, '') : 'diagram';
    const target = await host.saveFile({ text: compareSql.textContent, saveAs: true, defaultName: `${base}-migration.sql`, kind: 'sql' });
    if (target) setStatus(compareStatus, tr('Saved {file}', { file: target }), 'ok');
  });
  $('#db-compare-exec').addEventListener('click', async () => {
    if (!result) return;
    const active = selectedChanges();
    if (!active.length) return;
    const drops = active.filter((c) => c.destructive).length;
    const choice = await host.confirm({
      message: trn(active.length, 'Run {n} change on {db}?', 'Run {n} changes on {db}?', { db: conn.description }),
      detail:
        (drops ? `${trn(drops, '{n} of them drops tables or columns and deletes data.', '{n} of them drop tables or columns and delete data.')}\n` : '') +
        tr('The script runs in a single transaction and is rolled back if any statement fails.'),
      buttons: [tr('Run'), tr('Cancel')],
    });
    if (choice !== 0) return;
    setStatus(compareStatus, tr('Running migration…'));
    try {
      await call(host.db.execute, migrationSQL(active));
    } catch (err) {
      return setStatus(compareStatus, `${tr('Migration failed and was rolled back:')}\n${err.message}`, 'error');
    }
    await refreshCompare();
    setStatus(compareStatus, `${tr('Migration applied.')} ${compareStatus.textContent}`, 'ok');
  });

  updateIndicator();
  reconnectLastSession();

  return {
    api: {
      connected: () => !!conn,
      info: () => conn,
      openConnect,
      refreshSchema,
      catalog: async () => (await loadCatalog()).model,
    },
    'db-connect': () => openConnect(),
    'db-refresh': requireConnection(refreshSchema),
    'db-import': requireConnection(openImport),
    'db-compare': requireConnection(() => {
      if (!state.model.tables.length) return status(tr('The diagram is empty: add or import tables first.'));
      return openCompare();
    }),
  };
}
