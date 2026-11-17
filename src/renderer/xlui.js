// Spreadsheet import: pick an Excel workbook or CSV file, review the tables
// found in its sheets and add them to the diagram.

import { parseModelSource, MODEL_EXT } from './lib/efimport.js';
import { sqliteSpecs, SQLITE_EXT } from './lib/sqliteimport.js';
import { mssqlSpecs, parseTsql } from './lib/mssqlimport.js';
import { mysqlSpecs } from './lib/mysqlimport.js';
import { oracleSpecs } from './lib/oracleimport.js';
import { setupCopy } from './copyui.js';
import { readSpreadsheet, sheetTables, modelFromSpecs, importSpecs } from './lib/spreadsheet.js';
import { tableKey } from './lib/catalog.js';
import { generateSQL } from './lib/sql.js';
import { autoLayout, contentBounds, placeBelow } from './lib/layout.js';
import { highlightSQL } from './lib/highlight.js';
import { tr, trn } from '../shared/i18n.js';

const $ = (sel) => document.querySelector(sel);
const remoteMessage = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');
export const SPREADSHEET_EXT = /\.(xlsx|xlsm|csv|tsv)$/i;
export { MODEL_EXT, SQLITE_EXT };

export function setupSpreadsheetImport(ctx) {
  const { host, state, h, commit, computeSizes, fit, status } = ctx;
  const copy = setupCopy(ctx);
  const dialog = $('#xl-import-dialog');
  const list = $('#xl-list');
  const sqlBox = $('#xl-sql');
  const statusEl = $('#xl-status');
  const optSchema = $('#xl-schema');
  const optSnake = $('#xl-snake');
  const optNotNull = $('#xl-notnull');

  // { name, sheets }; for an EF Core / JSON model { name, sources: [{ name, text }], sheets: [] };
  // for a SQLite database { name, sources: [{ name, catalog }], sheets: [] };
  // for SQL Server (a database or a T-SQL script) { name, sources: [{ name, mssql }], sheets: [] };
  // for MySQL / MariaDB (a database or a dump) { name, sources: [{ name, mysql }], sheets: [] };
  // for Oracle { name, sources: [{ name, oracle }], sheets: [] }.
  // `copySource` is where "Copy rows" reads from: { kind, conn } or { kind, filePath }.
  let file = null;
  const title = dialog.querySelector('h3');
  const excelTitle = title.textContent;
  const help = dialog.querySelector('p.muted');
  const excelHelp = help.innerHTML;
  const notNullOption = optNotNull.closest('label');

  // The same dialog serves every import; only its explanation and the Excel-only option differ.
  // `model` is false (Excel / CSV), 'sqlite', 'mssql', 'tsql', 'mysql', 'mysql-dump', 'oracle' or true (Entity Framework / JSON).
  const chooseButton = $('#xl-choose');
  const chooseLabel = () => chooseButton.querySelector('.label') ?? chooseButton;
  let chooseText = null;
  function setMode(model) {
    chooseText ??= chooseLabel().textContent;
    title.textContent = model === 'sqlite' ? tr('Import tables from a SQLite database')
      : model === 'mssql' ? tr('Import tables from a SQL Server database')
      : model === 'tsql' ? tr('Import tables from a SQL Server script')
      : model === 'mysql' ? tr('Import tables from a MySQL / MariaDB database')
      : model === 'mysql-dump' ? tr('Import tables from a MySQL / MariaDB dump')
      : model === 'oracle' ? tr('Import tables from an Oracle database')
      : model ? tr('Import tables from Entity Framework / JSON') : excelTitle;
    chooseLabel().textContent = model === 'mssql' || model === 'mysql' || model === 'oracle' ? tr('Connect…') : chooseText;
    if (model === 'oracle') {
      help.textContent = tr('Each table of the Oracle schema becomes a table. Column types and defaults are translated to PostgreSQL (NUMBER(9) becomes integer, NUMBER(10,2) numeric(10,2), VARCHAR2 character varying, CLOB text, BLOB bytea, RAW(16) uuid, DATE timestamp(0)), an identity column becomes serial, and primary keys, NOT NULL, single-column unique constraints, foreign keys and comments are kept. With snake_case on, CUSTOMER_ID becomes customer_id. The tables go to the schema below. Tables already in the diagram are updated; their position, color and note are kept.');
    } else if (model === 'mysql' || model === 'mysql-dump') {
      help.textContent = tr('Each MySQL / MariaDB table becomes a table. Column types and defaults are translated to PostgreSQL (tinyint(1) becomes boolean, int unsigned bigint, datetime timestamp, enum text, blob bytea, json jsonb), an AUTO_INCREMENT column becomes serial, and primary keys, NOT NULL, single-column unique keys, foreign keys and comments are kept. The tables go to the schema below. Tables already in the diagram are updated; their position, color and note are kept.');
    } else if (model === 'mssql' || model === 'tsql') {
      help.textContent = tr('Each SQL Server table becomes a table. Column types and defaults are translated to PostgreSQL (nvarchar(max) becomes text, datetime2 timestamp, bit boolean, uniqueidentifier uuid), an IDENTITY column becomes serial, and primary keys, NOT NULL, single-column unique constraints, foreign keys and MS_Description comments are kept. Tables of the dbo schema go to the schema below; other schemas keep their name. Tables already in the diagram are updated; their position, color and note are kept.');
    } else if (model === 'sqlite') {
      help.textContent = tr('Each table of the SQLite database becomes a table. Column types and defaults are translated to PostgreSQL, an INTEGER PRIMARY KEY becomes serial, and primary keys, NOT NULL, single-column unique constraints and foreign keys are kept. Views and virtual tables are skipped. The file is only read. Tables already in the diagram are updated; their position, color and note are kept.');
    } else if (model) {
      help.textContent = tr('Each class becomes a table. Entity Framework Core classes (.cs files; choose the entities and the DbContext together) are read for their properties, data annotations, DbSet names and fluent configuration. A JSON file lists tables with their columns (name, type, pk, nullable, unique, default, references). Tables already in the diagram are updated; their position, color and note are kept.');
    } else help.innerHTML = excelHelp;
    notNullOption.style.display = model ? 'none' : '';
  }
  let specs = []; // [{ id, spec, checked, name }]
  let skipped = 0; // JSON files of a folder that describe no tables

  // C# files are read together (entities, context and configurations refer to each other); each JSON file on its own.
  // In a folder, JSON files that are not table descriptions (package.json, settings…) are skipped and counted.
  function modelSpecs(sources, opts, lenient = false) {
    if (sources.some((f) => f.catalog)) return { specs: sources.flatMap((f) => sqliteSpecs(f.catalog, opts)), skipped: 0 };
    if (sources.some((f) => f.mssql)) return { specs: sources.flatMap((f) => mssqlSpecs(f.mssql, opts)), skipped: 0 };
    if (sources.some((f) => f.mysql)) return { specs: sources.flatMap((f) => mysqlSpecs(f.mysql, opts)), skipped: 0 };
    if (sources.some((f) => f.oracle)) return { specs: sources.flatMap((f) => oracleSpecs(f.oracle, opts)), skipped: 0 };
    const isJson = (f) => /\.json$/i.test(f.name);
    const cs = sources.filter((f) => !isJson(f));
    let skipped = 0;
    const json = sources.filter(isJson).flatMap((f) => {
      try {
        return parseModelSource(f.name, f.text, opts);
      } catch (err) {
        if (!lenient) throw err;
        skipped++;
        return [];
      }
    });
    const specs = [...(cs.length ? parseModelSource('model.cs', cs.map((f) => f.text).join('\n'), opts) : []), ...json];
    return { specs, skipped };
  }

  function setStatus(text, kind = '') {
    statusEl.textContent = text ?? '';
    statusEl.className = `db-status ${kind}`;
  }

  const options = () => ({
    schema: optSchema.value.trim() || 'public',
    snakeCase: optSnake.checked,
    notNull: optNotNull.checked,
  });

  // Re-read the sheets with the current options, keeping choices and renames.
  function analyze() {
    copy.offer(file?.copySource ?? null);
    const prev = new Map(specs.map((s) => [s.id, s]));
    specs = [];
    skipped = 0;
    if (file?.sources) {
      try {
        const found = modelSpecs(file.sources, options(), !!file.folder);
        for (const spec of found.specs) {
          const id = `\u0000${spec.key}`;
          const old = prev.get(id);
          specs.push({ id, spec, checked: old ? old.checked : true, name: old?.name ?? spec.name });
        }
        skipped = found.skipped;
      } catch (err) {
        setStatus(tr('Could not read {file}: {message}', { file: file.name, message: err.message }), 'error');
      }
    }
    for (const sheet of file?.sheets ?? []) {
      for (const spec of sheetTables(sheet, options()).tables) {
        const id = `${sheet.name}\u0000${spec.key}`;
        const old = prev.get(id);
        specs.push({ id, spec, checked: old ? old.checked : !sheet.hidden, name: old?.name ?? spec.name });
      }
    }
    renderList();
    update();
  }

  // Checked specs with the user's table names; references to a renamed table follow it.
  function selected() {
    const chosen = specs.filter((s) => s.checked && s.name.trim());
    const renamed = new Map(chosen.filter((s) => s.name.trim() !== s.spec.name).map((s) => [tableKey(s.spec), s.name.trim()]));
    return chosen.map(({ spec, name }) => {
      const t = structuredClone(spec);
      t.name = name.trim();
      for (const c of t.columns) {
        if (!c.ref) continue;
        const target = renamed.get(`${c.ref.schema || t.schema}.${c.ref.table}`) ?? (c.ref.schema ? null : [...renamed].find(([k]) => k.endsWith(`.${c.ref.table}`))?.[1]);
        if (target) c.ref.table = target;
      }
      return t;
    });
  }

  function renderList() {
    const items = [];
    let lastSheet = null;
    for (const s of specs) {
      if (s.spec.sheet !== lastSheet) {
        lastSheet = s.spec.sheet;
        const sheet = file.sheets.find((x) => x.name === lastSheet);
        items.push(h('div', { class: 'schema' }, `${lastSheet}${sheet?.hidden ? ` ${tr('(hidden)')}` : ''} · ${s.spec.layout === 'data' ? tr('data') : tr('column definitions')}`));
      }
      const cb = h('input', { type: 'checkbox', checked: s.checked });
      cb.addEventListener('change', () => {
        s.checked = cb.checked;
        update();
      });
      const name = h('input', { class: 'xl-name', value: s.name, spellcheck: false, title: tr('Table name') });
      name.addEventListener('input', () => {
        s.name = name.value;
        update();
      });
      const tag = h('span', { class: 'tag' });
      s.tag = tag;
      const detail = s.spec.layout === 'data'
        ? `${trn(s.spec.columns.length, '{n} column', '{n} columns')}, ${trn(s.spec.rows, '{n} row', '{n} rows')}`
        : trn(s.spec.columns.length, '{n} column', '{n} columns');
      items.push(h('label', { class: 'item' }, [cb, h('span', { class: 'muted' }, `${s.spec.schema}.`), name, h('span', { class: 'muted nowrap' }, detail), tag]));
    }
    list.replaceChildren(...(items.length ? items : [h('div', { class: 'db-empty' }, file ? tr('No tables found in this file.') : tr('Choose an Excel or CSV file.'))]));
  }

  function update() {
    const inErd = new Set(state.model.tables.map(tableKey));
    for (const s of specs) {
      const present = inErd.has(`${s.spec.schema}.${s.name.trim()}`);
      s.tag.textContent = present ? tr('in diagram: update') : tr('new');
      s.tag.className = `tag${present ? '' : ' new'}`;
    }
    const chosen = selected();
    $('#xl-import-ok').disabled = !chosen.length;
    if (!file) {
      sqlBox.textContent = '';
      return;
    }
    highlightSQL(sqlBox, chosen.length ? generateSQL(modelFromSpecs(chosen).model) : '');
    const keys = chosen.map(tableKey);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) setStatus(tr('More than one selected table is named {name}; rename one of them.', { name: dup }), 'error');
    else setStatus(`${file.name}: ${tr('{n} of {total} tables selected', { n: chosen.length, total: specs.length })}${skipped ? `. ${trn(skipped, '{n} JSON file without tables was skipped.', '{n} JSON files without tables were skipped.')}` : ''}`);
    if (dup) $('#xl-import-ok').disabled = true;
  }

  async function load(name, bytes) {
    try {
      file = { name, sheets: await readSpreadsheet(name, bytes) };
    } catch (err) {
      file = null;
      specs = [];
      renderList();
      update();
      return setStatus(tr('Could not read {file}: {message}', { file: name, message: err.message }), 'error');
    }
    specs = [];
    $('#xl-file').textContent = name;
    analyze();
  }

  function loadModel(files, folder = null) {
    file = { name: files.map((f) => f.name).join(', '), sources: files, sheets: [], folder };
    specs = [];
    setMode(true);
    $('#xl-file').textContent = file.name;
    analyze();
  }

  async function chooseModel() {
    const res = await host.openModel();
    if (res) loadModel(res.map((f) => ({ name: f.filePath.split(/[\\/]/).pop(), text: f.text })));
  }

  function loadSqlite(name, catalog, filePath) {
    file = { name, sources: [{ name, catalog }], sheets: [], copySource: { kind: 'sqlite', filePath } };
    specs = [];
    setMode('sqlite');
    $('#xl-file').textContent = name;
    analyze();
  }

  // `filePath` is a dropped file; without it the user picks one.
  async function chooseSqlite(filePath = null) {
    setMode('sqlite');
    try {
      const res = filePath ? await host.readSqlite(filePath) : await host.openSqlite();
      if (res) loadSqlite(res.filePath.split(/[\\/]/).pop(), res.catalog, res.filePath);
    } catch (err) {
      const name = filePath ? filePath.split(/[\\/]/).pop() : tr('SQLite database');
      setStatus(tr('Could not read {file}: {message}', { file: name, message: remoteMessage(err) }), 'error');
    }
  }

  function loadMssql(name, catalog, mode, copySource = null) {
    file = { name, sources: [{ name, mssql: catalog }], sheets: [], copySource };
    specs = [];
    setMode(mode);
    $('#xl-file').textContent = name;
    analyze();
  }

  async function chooseTsql() {
    setMode('tsql');
    try {
      const res = await host.openTsql();
      if (res) loadMssql(res.filePath.split(/[\\/]/).pop(), parseTsql(res.text), 'tsql');
    } catch (err) {
      setStatus(tr('Could not read {file}: {message}', { file: tr('T-SQL script'), message: remoteMessage(err) }), 'error');
    }
  }

  // A connection dialog for a source database. The last settings but the
  // password are remembered. On "Read schema" `read(conn)` runs; the dialog
  // closes when it succeeds and shows the error when it does not.
  function sourceDialog(id, key, defaultRead) {
    const dlg = $(`#${id}`);
    let read = defaultRead;
    const form = dlg.querySelector('form');
    const statusLine = dlg.querySelector('.db-status');
    const ok = dlg.querySelector('button[value="ok"]');
    const fields = [...form.elements].filter((el) => el.name);
    const field = (name) => form.elements.namedItem(name);
    const collect = () => {
      const conn = Object.fromEntries(fields.map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.type === 'password' ? el.value : el.value.trim()]));
      for (const k of ['server', 'host']) if (k in conn && !conn[k]) conn[k] = 'localhost';
      return conn;
    };
    form.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const conn = collect();
      const { password, ...remembered } = conn;
      try {
        localStorage.setItem(key, JSON.stringify(remembered));
      } catch {}
      statusLine.textContent = tr('Reading the schema…');
      statusLine.className = 'db-status';
      ok.disabled = true;
      try {
        await read(conn);
        dlg.close('ok');
      } catch (err) {
        statusLine.textContent = tr('Could not connect: {message}', { message: remoteMessage(err) });
        statusLine.className = 'db-status error';
      } finally {
        ok.disabled = false;
      }
    });
    return {
      field,
      // `onRead` replaces what "Read schema" does, for this opening only.
      open(onOpen, onRead = null) {
        read = onRead ?? defaultRead;
        let saved = {};
        try {
          saved = JSON.parse(localStorage.getItem(key) || '{}');
        } catch {}
        for (const el of fields) {
          if (el.type === 'password') el.value = '';
          else if (el.type === 'checkbox') el.checked = el.name in saved ? !!saved[el.name] : el.defaultChecked;
          else if (el.tagName === 'SELECT') el.value = saved[el.name] ?? el.options[0].value;
          else el.value = saved[el.name] ?? '';
        }
        onOpen?.();
        statusLine.textContent = '';
        statusLine.className = 'db-status';
        ok.disabled = false;
        dlg.showModal();
        const first = fields.find((el) => !el.value && el.type !== 'checkbox' && el.tagName !== 'SELECT' && el.closest('label')?.style.display !== 'none');
        (first ?? field('password')).focus();
      },
    };
  }

  const mssqlDialog = sourceDialog('mssql-connect-dialog', 'pgsql-erd.mssql-connection', async (conn) => {
    const res = await host.readMssql(conn);
    loadMssql(`${conn.server}/${res.database}`, res.catalog, 'mssql', { kind: 'mssql', conn });
  });
  const showDomain = () => ($('#mssql-domain').style.display = mssqlDialog.field('auth').value === 'ntlm' ? '' : 'none');
  mssqlDialog.field('auth').addEventListener('change', showDomain);
  function chooseMssql() {
    setMode('mssql');
    mssqlDialog.open(showDomain);
  }

  function loadMysql(name, catalog, mode, copySource) {
    file = { name, sources: [{ name, mysql: catalog }], sheets: [], copySource };
    specs = [];
    setMode(mode);
    $('#xl-file').textContent = name;
    analyze();
  }

  const mysqlDialog = sourceDialog('mysql-connect-dialog', 'pgsql-erd.mysql-connection', async (conn) => {
    const res = await host.readMysql(conn);
    loadMysql(`${conn.host}/${res.database}`, res.catalog, 'mysql', { kind: 'mysql', conn });
  });
  function chooseMysql() {
    setMode('mysql');
    mysqlDialog.open();
  }

  const oracleDialog = sourceDialog('oracle-connect-dialog', 'pgsql-erd.oracle-connection', async (conn) => {
    const res = await host.readOracle(conn);
    const name = `${conn.host}/${conn.service}: ${res.owner}`;
    file = { name, sources: [{ name, oracle: res.catalog }], sheets: [], copySource: { kind: 'oracle', conn } };
    specs = [];
    setMode('oracle');
    $('#xl-file').textContent = name;
    analyze();
  });
  function chooseOracle() {
    setMode('oracle');
    oracleDialog.open();
  }

  async function chooseMysqlDump() {
    setMode('mysql-dump');
    try {
      const res = await host.openMysqlDump();
      if (res) loadMysql(res.filePath.split(/[\\/]/).pop(), res.catalog, 'mysql-dump', { kind: 'mysql-dump', filePath: res.filePath });
    } catch (err) {
      setStatus(tr('Could not read {file}: {message}', { file: tr('MySQL / MariaDB dump'), message: remoteMessage(err) }), 'error');
    }
  }

  // Every JSON file under a folder, each read on its own; names are relative to the folder.
  async function chooseModelFolder() {
    const res = await host.openModelFolder();
    if (!res) return;
    loadModel(res.files.map((f) => ({ name: f.name, text: f.text })), res.folder);
    $('#xl-file').textContent = res.folder;
  }

  async function choose() {
    setMode(false);
    const res = await host.openSpreadsheet();
    if (res) await load(res.filePath.split(/[\\/]/).pop(), res.data);
  }

  function reset() {
    file = null;
    copy.offer(null);
    specs = [];
    $('#xl-file').textContent = tr('No file chosen');
    setMode(false);
    setStatus('');
    renderList();
    update();
    dialog.returnValue = '';
  }

  let mode = 'excel'; // what "Choose file…" picks: 'excel', 'model', 'model-folder', 'sqlite', 'mssql', 'tsql', 'mysql', 'mysql-dump' or 'oracle'
  $('#xl-choose').addEventListener('click', () => (mode === 'oracle' ? chooseOracle() : mode === 'mysql' ? chooseMysql() : mode === 'mysql-dump' ? chooseMysqlDump() : mode === 'mssql' ? chooseMssql() : mode === 'tsql' ? chooseTsql() : mode === 'sqlite' ? chooseSqlite() : mode === 'model-folder' || (mode === 'model' && file?.folder) ? chooseModelFolder() : mode === 'model' ? chooseModel() : choose()));
  optSchema.addEventListener('change', analyze);
  optSnake.addEventListener('change', analyze);
  optNotNull.addEventListener('change', analyze);
  const setAll = (v) => {
    for (const s of specs) s.checked = v;
    renderList();
    update();
  };
  $('#xl-all').addEventListener('click', () => setAll(true));
  $('#xl-none').addEventListener('click', () => setAll(false));

  // Enter in a table name field must not submit the dialog.
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input.xl-name, #xl-schema')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'ok' || !file) return;
    const chosen = selected();
    if (!chosen.length) return;
    const wasEmpty = state.model.tables.length === 0;
    let result;
    commit(() => {
      computeSizes();
      const before = contentBounds(state.model, state.sizes);
      result = importSpecs(state.model, chosen);
      computeSizes();
      if (wasEmpty) autoLayout(state.model, state.sizes);
      else if (result.added.length) placeBelow(state.model, state.sizes, result.added, before);
    });
    if (wasEmpty || result.added.length) fit();
    status(tr('Imported {added} new and updated {updated} existing tables from {file}', { added: result.added.length, updated: result.updated.length, file: file.name }));
    if (file.copySource && copy.wanted()) copy.run(chosen, file.copySource, file.name);
  });

  function open() {
    reset();
    mode = 'excel';
    dialog.showModal();
    return choose();
  }

  function openModel() {
    reset();
    mode = 'model';
    dialog.showModal();
    return chooseModel();
  }

  function openSqlite(filePath = null) {
    if (!dialog.open) {
      reset();
      dialog.showModal();
    }
    mode = 'sqlite';
    return chooseSqlite(filePath);
  }

  function openMssql() {
    reset();
    mode = 'mssql';
    dialog.showModal();
    return chooseMssql();
  }

  function openTsql() {
    reset();
    mode = 'tsql';
    dialog.showModal();
    return chooseTsql();
  }

  function openMysql() {
    reset();
    mode = 'mysql';
    dialog.showModal();
    return chooseMysql();
  }

  function openOracle() {
    reset();
    mode = 'oracle';
    dialog.showModal();
    return chooseOracle();
  }

  function openMysqlDump() {
    reset();
    mode = 'mysql-dump';
    dialog.showModal();
    return chooseMysqlDump();
  }

  function openModelFolder() {
    reset();
    dialog.showModal();
    mode = 'model-folder';
    return chooseModelFolder();
  }

  /**
   * Open the connection dialog of a source database (`kind`: 'mysql', 'mssql'
   * or 'oracle') for another feature: `use(conn)` runs on "Read schema" and
   * its errors show in the dialog. Resolves with what `use` returned, or null
   * when the dialog is cancelled.
   */
  function pickConnection(kind, use) {
    const d = { mysql: mysqlDialog, mssql: mssqlDialog, oracle: oracleDialog }[kind];
    const el = $(`#${kind}-connect-dialog`);
    return new Promise((resolve) => {
      let result = null;
      el.addEventListener('close', () => resolve(result), { once: true });
      d.open(kind === 'mssql' ? showDomain : null, async (conn) => {
        result = await use(conn);
      });
    });
  }

  return {
    pickConnection,
    commands: { 'import-spreadsheet': open, 'import-model': openModel, 'import-sqlite': () => openSqlite(), 'import-model-folder': openModelFolder, 'import-mssql': openMssql, 'import-tsql': openTsql, 'import-mysql': openMysql, 'import-mysql-dump': openMysqlDump, 'import-oracle': openOracle },
    // Open the dialog on a dropped SQLite database file.
    openSqliteFile: (filePath) => openSqlite(filePath),
    // Open the dialog on dropped .cs / .json files.
    openModelFiles(files) {
      if (!dialog.open) {
        reset();
        dialog.showModal();
      }
      mode = 'model';
      loadModel(files);
    },
    // Open the dialog on a file dropped onto the window.
    async openFile(name, bytes) {
      if (!dialog.open) {
        reset();
        dialog.showModal();
      }
      mode = 'excel';
      setMode(false);
      await load(name, bytes);
    },
  };
}
