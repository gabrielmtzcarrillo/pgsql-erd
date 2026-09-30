// Spreadsheet import: pick an Excel workbook or CSV file, review the tables
// found in its sheets and add them to the diagram.

import { readSpreadsheet, sheetTables, modelFromSpecs, importSpecs } from './lib/spreadsheet.js';
import { tableKey } from './lib/catalog.js';
import { generateSQL } from './lib/sql.js';
import { autoLayout, contentBounds, placeBelow } from './lib/layout.js';
import { highlightSQL } from './lib/highlight.js';

const $ = (sel) => document.querySelector(sel);
export const SPREADSHEET_EXT = /\.(xlsx|xlsm|csv|tsv)$/i;

export function setupSpreadsheetImport(ctx) {
  const { host, state, h, commit, computeSizes, fit, status } = ctx;
  const dialog = $('#xl-import-dialog');
  const list = $('#xl-list');
  const sqlBox = $('#xl-sql');
  const statusEl = $('#xl-status');
  const optSchema = $('#xl-schema');
  const optSnake = $('#xl-snake');
  const optNotNull = $('#xl-notnull');

  let file = null; // { name, sheets }
  let specs = []; // [{ id, spec, checked, name }]

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
    const prev = new Map(specs.map((s) => [s.id, s]));
    specs = [];
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
        items.push(h('div', { class: 'schema' }, `${lastSheet}${sheet?.hidden ? ' (hidden)' : ''} · ${s.spec.layout === 'data' ? 'data' : 'column definitions'}`));
      }
      const cb = h('input', { type: 'checkbox', checked: s.checked });
      cb.addEventListener('change', () => {
        s.checked = cb.checked;
        update();
      });
      const name = h('input', { class: 'xl-name', value: s.name, spellcheck: false, title: 'Table name' });
      name.addEventListener('input', () => {
        s.name = name.value;
        update();
      });
      const tag = h('span', { class: 'tag' });
      s.tag = tag;
      const detail = s.spec.layout === 'data'
        ? `${s.spec.columns.length} columns, ${s.spec.rows} rows`
        : `${s.spec.columns.length} columns`;
      items.push(h('label', { class: 'item' }, [cb, h('span', { class: 'muted' }, `${s.spec.schema}.`), name, h('span', { class: 'muted nowrap' }, detail), tag]));
    }
    list.replaceChildren(...(items.length ? items : [h('div', { class: 'db-empty' }, file ? 'No tables found in this file.' : 'Choose an Excel or CSV file.')]));
  }

  function update() {
    const inErd = new Set(state.model.tables.map(tableKey));
    for (const s of specs) {
      const present = inErd.has(`${s.spec.schema}.${s.name.trim()}`);
      s.tag.textContent = present ? 'in diagram: update' : 'new';
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
    if (dup) setStatus(`More than one selected table is named ${dup}; rename one of them.`, 'error');
    else setStatus(`${file.name}: ${chosen.length} of ${specs.length} tables selected`);
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
      return setStatus(`Could not read ${name}: ${err.message}`, 'error');
    }
    specs = [];
    $('#xl-file').textContent = name;
    analyze();
  }

  async function choose() {
    const res = await host.openSpreadsheet();
    if (res) await load(res.filePath.split(/[\\/]/).pop(), res.data);
  }

  function reset() {
    file = null;
    specs = [];
    $('#xl-file').textContent = 'No file chosen';
    setStatus('');
    renderList();
    update();
    dialog.returnValue = '';
  }

  $('#xl-choose').addEventListener('click', choose);
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
    status(`Imported ${result.added.length} new and updated ${result.updated.length} existing tables from ${file.name}`);
  });

  function open() {
    reset();
    dialog.showModal();
    return choose();
  }

  return {
    commands: { 'import-spreadsheet': open },
    // Open the dialog on a file dropped onto the window.
    async openFile(name, bytes) {
      if (!dialog.open) {
        reset();
        dialog.showModal();
      }
      await load(name, bytes);
    },
  };
}
