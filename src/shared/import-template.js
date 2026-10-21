// The portable Excel -> PostgreSQL INSERT template ("excel-pg-insert-template").
//
// The JSON contract is the product; the Import Designer tab is one way to
// author it. This module has no DOM and no database access, so a server or a
// CLI can use the very same code to validate a template and to read rows out
// of a workbook, and the designer uses it for its preview. The contract is
// described in docs/import-template-spec.md and its JSON Schema is published
// as docs/import-template.schema.json (generated from IMPORT_TEMPLATE_SCHEMA).
//
// A workbook is what lib/spreadsheet.js readSpreadsheet() returns:
//   [{ name, hidden, rows: string[][] }]   (rows[0] is Excel row 1)
// Cells are read as text: strings as stored, numbers in their canonical form,
// dates as ISO strings. Formulas are never evaluated.
//
// Design = the designer's editable state (see newDesign()); a template is the
// exported form. designToTemplate() / templateToDesign() convert between them.

import { validateJson } from './json-schema.js';
import { findTable, tableId } from './schema-model.js';

export const FORMAT = 'excel-pg-insert-template';
export const SPEC_VERSION = '1.0';
export const SCHEMA_ID = 'urn:pgsql-erd:excel-pg-insert-template:1.0';

// Limits a runner applies when the template doesn't set its own.
export const DEFAULT_LIMITS = { maxRows: 100000, maxScanRows: 200, maxColumns: 512 };
export const DEFAULT_SCAN = { from: 1, to: 30 };
export const DEFAULT_MATCH = { trim: true, caseSensitive: false };
export const BLANK_POLICIES = ['null', 'emptyString', 'error'];
export const TRANSACTIONS = ['atomic', 'perTask'];

// ---------------------------------------------------------------- columns and headers

// 0 -> "A", 26 -> "AA"
export function colLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// "A" -> 0, "AA" -> 26; -1 for something that is not a column letter.
export function colIndex(letters) {
  const s = String(letters ?? '').toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// Header text as compared: Unicode NFC, runs of whitespace collapsed, then
// optionally trimmed and case-folded. Accents always matter.
export function normHeader(value, match = DEFAULT_MATCH) {
  let v = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ');
  if (match.trim ?? true) v = v.trim();
  if (!(match.caseSensitive ?? false)) v = v.toLowerCase();
  return v;
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const cell = (sheet, row, col) => sheet.rows[row - 1]?.[col] ?? '';

// ---------------------------------------------------------------- JSON Schema

const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$', maxLength: 64 };
const text = { type: 'string', minLength: 1, maxLength: 256 };
const column = { type: 'string', pattern: '^[A-Za-z]{1,3}$' };
const row = { type: 'integer', minimum: 1, maximum: 1048576 };

export const IMPORT_TEMPLATE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: SCHEMA_ID,
  title: 'Excel to PostgreSQL INSERT template',
  description: 'Maps worksheets of any structurally compatible .xlsx workbook onto ordered INSERT tasks. Version 1.x; a runner must reject any other major version.',
  type: 'object',
  required: ['format', 'specVersion', 'templateId', 'name', 'sources', 'execution'],
  properties: {
    format: { const: FORMAT },
    specVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' },
    templateId: id,
    name: text,
    description: { type: 'string', maxLength: 2000 },
    limits: {
      type: 'object',
      description: `Optional ceilings; defaults ${JSON.stringify(DEFAULT_LIMITS)}.`,
      properties: {
        maxRows: { type: 'integer', minimum: 1 },
        maxScanRows: { type: 'integer', minimum: 1 },
        maxColumns: { type: 'integer', minimum: 1 },
      },
    },
    sources: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'sheet', 'header', 'data'],
        properties: {
          id,
          sheet: {
            anyOf: [
              { type: 'object', required: ['mode', 'value'], properties: { mode: { const: 'name' }, value: text } },
              { type: 'object', required: ['mode', 'value'], properties: { mode: { const: 'index' }, value: { type: 'integer', minimum: 1 } } },
              { type: 'object', required: ['mode', 'headers'], properties: { mode: { const: 'requiredHeaders' }, headers: { type: 'array', minItems: 1, items: text } } },
            ],
          },
          header: {
            anyOf: [
              {
                type: 'object',
                required: ['mode', 'row', 'startColumn'],
                properties: {
                  mode: { const: 'fixed' },
                  row,
                  startColumn: column,
                  expected: { type: 'array', items: { type: 'string', maxLength: 256 } },
                  match: { type: 'object', properties: { trim: { type: 'boolean' }, caseSensitive: { type: 'boolean' } } },
                },
              },
              {
                type: 'object',
                required: ['mode', 'scanRows'],
                properties: {
                  mode: { const: 'detect' },
                  scanRows: { type: 'object', required: ['from', 'to'], properties: { from: row, to: row } },
                  match: { type: 'object', properties: { trim: { type: 'boolean' }, caseSensitive: { type: 'boolean' } } },
                },
              },
            ],
          },
          data: {
            type: 'object',
            required: ['firstRow', 'endMode'],
            properties: {
              firstRow: { type: 'object', required: ['mode'], properties: { mode: { const: 'afterHeader' }, offset: { type: 'integer', minimum: 1 } } },
              endMode: { const: 'lastNonEmptyMappedRow' },
              skipEmptyRows: { type: 'boolean' },
            },
          },
        },
      },
    },
    execution: {
      type: 'object',
      required: ['operation', 'transaction', 'tasks'],
      properties: {
        operation: { const: 'insert' },
        transaction: { enum: TRANSACTIONS },
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'order', 'sourceId', 'target', 'mappings'],
            properties: {
              id,
              order: { type: 'integer', minimum: 1 },
              sourceId: id,
              target: { type: 'object', required: ['schema', 'table'], properties: { schema: { type: 'string', minLength: 1, maxLength: 63 }, table: { type: 'string', minLength: 1, maxLength: 63 } } },
              mappings: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['source', 'targetColumn'],
                  properties: {
                    source: {
                      anyOf: [
                        { type: 'object', required: ['mode', 'column'], properties: { mode: { const: 'column' }, column } },
                        { type: 'object', required: ['mode', 'name'], properties: { mode: { const: 'header' }, name: text } },
                      ],
                    },
                    targetColumn: { type: 'string', minLength: 1, maxLength: 63 },
                    read: { enum: ['text'], description: 'How the cell is read; only text in 1.0.' },
                    trim: { type: 'boolean', description: 'Trim the cell text. Default false.' },
                    blank: { enum: BLANK_POLICIES, description: 'Blank cell: null (default), emptyString or error.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    editor: { type: 'object', description: 'Presentation only (node positions). Runners must ignore it.' },
  },
};

// ---------------------------------------------------------------- template validation

// Problems that make a template unusable, as plain messages. Unknown major
// versions are refused, not interpreted.
export function validateTemplate(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['The template must be a JSON object.'];
  if (t.format !== FORMAT) return [`format must be "${FORMAT}".`];
  const major = Number(String(t.specVersion ?? '').split('.')[0]);
  if (!/^\d+\.\d+$/.test(String(t.specVersion ?? ''))) return ['specVersion is missing or malformed.'];
  if (major !== Number(SPEC_VERSION.split('.')[0])) return [`Unsupported specVersion ${t.specVersion}; this reader understands ${SPEC_VERSION.split('.')[0]}.x.`];
  const errors = validateJson(t, IMPORT_TEMPLATE_SCHEMA);
  if (errors.length) return errors;

  const sources = new Map();
  for (const s of t.sources) {
    if (sources.has(s.id)) errors.push(`Duplicate source id ${s.id}.`);
    sources.set(s.id, s);
    if (s.header.mode === 'detect') {
      const { from, to } = s.header.scanRows;
      const max = t.limits?.maxScanRows ?? DEFAULT_LIMITS.maxScanRows;
      if (to < from) errors.push(`Source ${s.id}: scanRows.to is before scanRows.from.`);
      else if (to - from + 1 > max) errors.push(`Source ${s.id}: scanRows covers more than ${max} rows.`);
    } else if (colIndex(s.header.startColumn) < 0) {
      errors.push(`Source ${s.id}: startColumn ${s.header.startColumn} is not a column.`);
    }
  }
  const tasks = t.execution.tasks;
  const ids = new Set();
  const orders = tasks.map((k) => k.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) errors.push('Task orders must be unique and contiguous from 1.');
  for (const k of tasks) {
    if (ids.has(k.id)) errors.push(`Duplicate task id ${k.id}.`);
    ids.add(k.id);
    const src = sources.get(k.sourceId);
    if (!src) {
      errors.push(`Task ${k.id}: unknown source ${k.sourceId}.`);
      continue;
    }
    const seen = new Set();
    for (const m of k.mappings) {
      if (seen.has(m.targetColumn)) errors.push(`Task ${k.id}: ${m.targetColumn} is mapped more than once.`);
      seen.add(m.targetColumn);
      if (m.source.mode === 'column' && src.header.mode === 'detect') errors.push(`Task ${k.id}: ${m.targetColumn} uses a column letter but source ${src.id} detects its header; use a header name.`);
      if (m.source.mode === 'column' && src.header.mode === 'fixed' && colIndex(m.source.column) < colIndex(src.header.startColumn)) {
        errors.push(`Task ${k.id}: column ${m.source.column} is left of the header start ${src.header.startColumn}.`);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------- source resolution

const matchOf = (source) => ({ ...DEFAULT_MATCH, ...(source.header?.match ?? {}) });
const list = (names) => names.map((n) => `"${n}"`).join(', ');

// Header names a source must show: the sheet's required headers plus every
// header some task maps from it.
export function requiredHeaders(template, source) {
  const out = [...(source.sheet.mode === 'requiredHeaders' ? source.sheet.headers : [])];
  for (const task of template.execution?.tasks ?? []) {
    if (task.sourceId !== source.id) continue;
    for (const m of task.mappings) if (m.source.mode === 'header') out.push(m.source.name);
  }
  const match = matchOf(source);
  const seen = new Set();
  return out.filter((h) => {
    const k = normHeader(h, match);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 1-based header rows of `sheet` whose cells include every required header.
function headerRows(sheet, source, required, limits) {
  const match = matchOf(source);
  const need = required.map((h) => normHeader(h, match));
  const h = source.header;
  const rows = h.mode === 'fixed' ? [h.row] : range(h.scanRows.from, Math.min(h.scanRows.to, h.scanRows.from + limits.maxScanRows - 1));
  const start = h.mode === 'fixed' ? colIndex(h.startColumn) : 0;
  return rows.filter((r) => {
    const have = new Set((sheet.rows[r - 1] ?? []).slice(start).filter((c) => !isBlank(c)).map((c) => normHeader(c, match)));
    return need.every((n) => have.has(n));
  });
}

const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

// Which worksheet, header row and columns a source stands for in `workbook`.
// Never guesses: no match or several matches is an error with a reason.
// -> { ok, errors: [{ code, message }], sheetName, sheet, headerRow, firstDataRow,
//      columns: [{ index, letter, label, duplicate }] }
export function resolveSource(template, source, workbook, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(template.limits ?? {}), ...limits };
  const errors = [];
  const fail = (code, message) => {
    errors.push({ code, message, sourceId: source.id });
    return { ok: false, errors, sourceId: source.id };
  };
  const match = matchOf(source);
  const required = requiredHeaders(template, source);

  let sheet;
  const sel = source.sheet;
  if (sel.mode === 'name') {
    sheet = workbook.find((s) => s.name === sel.value);
    if (!sheet) {
      const ci = workbook.filter((s) => s.name.toLowerCase() === sel.value.toLowerCase());
      if (ci.length > 1) return fail('SHEET_AMBIGUOUS', `Worksheets ${list(ci.map((s) => s.name))} all match the name "${sel.value}".`);
      sheet = ci[0];
    }
    if (!sheet) return fail('SHEET_NOT_FOUND', `The workbook has no worksheet named "${sel.value}" (it has ${list(workbook.map((s) => s.name)) || 'none'}).`);
  } else if (sel.mode === 'index') {
    sheet = workbook[sel.value - 1];
    if (!sheet) return fail('SHEET_NOT_FOUND', `The workbook has no worksheet number ${sel.value} (it has ${workbook.length}).`);
  } else {
    const found = workbook.filter((s) => headerRows(s, source, sel.headers, lim).length);
    if (!found.length) return fail('SHEET_NOT_FOUND', `No worksheet has a header row with ${list(sel.headers)}.`);
    if (found.length > 1) return fail('SHEET_AMBIGUOUS', `Worksheets ${list(found.map((s) => s.name))} all have a header row with ${list(sel.headers)}.`);
    sheet = found[0];
  }

  const h = source.header;
  let headerRow;
  let start = 0;
  if (h.mode === 'fixed') {
    headerRow = h.row;
    start = colIndex(h.startColumn);
    const cells = (sheet.rows[headerRow - 1] ?? []).slice(start);
    (h.expected ?? []).forEach((want, i) => {
      if (normHeader(cells[i], match) !== normHeader(want, match)) {
        errors.push({
          code: 'HEADER_MISMATCH',
          sourceId: source.id,
          message: `Worksheet "${sheet.name}", ${colLetter(start + i)}${headerRow}: expected the header "${want}" but found "${String(cells[i] ?? '').trim()}".`,
        });
      }
    });
    if (errors.length) return { ok: false, errors, sourceId: source.id };
  } else {
    if (!required.length) return fail('HEADER_UNDEFINED', `Source ${source.id} detects its header but no header names are mapped.`);
    const rows = headerRows(sheet, source, required, lim);
    if (!rows.length) {
      const { from, to } = h.scanRows;
      return fail('HEADER_NOT_FOUND', `Worksheet "${sheet.name}": no row between ${from} and ${to} has all the headers ${list(required)}.`);
    }
    if (rows.length > 1) return fail('HEADER_AMBIGUOUS', `Worksheet "${sheet.name}": rows ${rows.join(', ')} all have the headers ${list(required)}.`);
    headerRow = rows[0];
  }

  const cells = sheet.rows[headerRow - 1] ?? [];
  let last = cells.length - 1;
  while (last >= start && isBlank(cells[last])) last--;
  if (last - start + 1 > lim.maxColumns) return fail('COLUMN_LIMIT', `Worksheet "${sheet.name}" has more than ${lim.maxColumns} columns in its header row.`);
  const columns = [];
  const count = new Map();
  for (let i = start; i <= last; i++) {
    const label = String(cells[i] ?? '').trim();
    columns.push({ index: i, letter: colLetter(i), label });
    if (label) count.set(normHeader(label, match), (count.get(normHeader(label, match)) ?? 0) + 1);
  }
  for (const c of columns) c.duplicate = !!c.label && count.get(normHeader(c.label, match)) > 1;
  return {
    ok: true,
    errors,
    sourceId: source.id,
    sheetName: sheet.name,
    sheet,
    headerRow,
    firstDataRow: headerRow + (source.data.firstRow.offset ?? 1),
    columns,
  };
}

// ---------------------------------------------------------------- reading rows

// Runs the template's reading rules over a workbook without touching a
// database. -> { ok, errors, tasks: [{ id, order, sourceId, sheetName, target,
// columns, total, rows: [{ row, values }] }] }. `limit` caps the rows listed per
// task (total still counts every row). Each error carries code, message and,
// where known, taskId, row and column.
export function extractRows(template, workbook, { limit = Infinity, maxErrors = 100 } = {}) {
  const problems = validateTemplate(template);
  if (problems.length) return { ok: false, errors: problems.map((message) => ({ code: 'TEMPLATE', message })), tasks: [] };
  const lim = { ...DEFAULT_LIMITS, ...(template.limits ?? {}) };
  const errors = [];
  const push = (e) => errors.length < maxErrors && errors.push(e);
  const sources = new Map();
  const tasks = [];

  for (const task of [...template.execution.tasks].sort((a, b) => a.order - b.order)) {
    const source = template.sources.find((s) => s.id === task.sourceId);
    if (!sources.has(source.id)) sources.set(source.id, resolveSource(template, source, workbook));
    const res = sources.get(source.id);
    const out = {
      id: task.id,
      order: task.order,
      sourceId: source.id,
      sheetName: res.sheetName ?? null,
      target: task.target,
      columns: task.mappings.map((m) => m.targetColumn),
      total: 0,
      rows: [],
    };
    tasks.push(out);
    if (!res.ok) {
      for (const e of res.errors) if (!errors.some((x) => x.message === e.message)) push({ ...e, taskId: task.id });
      continue;
    }

    const match = matchOf(source);
    const picks = [];
    let bad = false;
    for (const m of task.mappings) {
      let col;
      if (m.source.mode === 'column') {
        col = colIndex(m.source.column);
      } else {
        const hits = res.columns.filter((c) => normHeader(c.label, match) === normHeader(m.source.name, match));
        if (hits.length !== 1) {
          push({
            code: hits.length ? 'DUPLICATE_HEADER' : 'HEADER_MISSING',
            taskId: task.id,
            column: m.targetColumn,
            message: hits.length
              ? `Worksheet "${res.sheetName}": the header "${m.source.name}" appears in columns ${hits.map((c) => c.letter).join(', ')}; it must be unique to be mapped.`
              : `Worksheet "${res.sheetName}": there is no header "${m.source.name}".`,
          });
          bad = true;
          continue;
        }
        col = hits[0].index;
      }
      picks.push({ m, col });
    }
    if (bad) continue;

    const rows = res.sheet.rows;
    let last = rows.length;
    while (last >= res.firstDataRow && picks.every((p) => isBlank(rows[last - 1]?.[p.col]))) last--;
    if (last - res.firstDataRow + 1 > lim.maxRows) {
      push({ code: 'ROW_LIMIT', taskId: task.id, message: `Worksheet "${res.sheetName}" has more than ${lim.maxRows} data rows.` });
      continue;
    }
    const skipEmpty = source.data.skipEmptyRows ?? true;
    for (let r = res.firstDataRow; r <= last; r++) {
      const line = rows[r - 1] ?? [];
      if (skipEmpty && picks.every((p) => isBlank(line[p.col]))) continue;
      const values = {};
      for (const { m, col } of picks) {
        let v = String(line[col] ?? '');
        if (m.trim) v = v.trim();
        if (isBlank(v)) {
          const policy = m.blank ?? 'null';
          if (policy === 'error') push({ code: 'BLANK_NOT_ALLOWED', taskId: task.id, row: r, column: m.targetColumn, message: `Worksheet "${res.sheetName}", row ${r}: ${m.targetColumn} cannot be blank.` });
          v = policy === 'emptyString' ? '' : null;
        }
        values[m.targetColumn] = v;
      }
      out.total++;
      if (out.rows.length < limit) out.rows.push({ row: r, values });
    }
  }
  return { ok: errors.length === 0, errors, tasks };
}

// ---------------------------------------------------------------- values vs column types

const INT = /^[+-]?\d+$/;
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOL = /^(true|false|t|f|yes|no|y|n|1|0|on|off)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RANGE = { smallint: 32767, integer: 2147483647, bigint: 9223372036854775807n };

// A message when `value` (a non-null string) is unlikely to be accepted by
// the column, else null. A heuristic: PostgreSQL has the last word.
export function checkValue(col, value) {
  const type = col.baseType;
  const v = String(value).trim();
  if (col.isArray || v === '') return null;
  if (type in INT_RANGE) {
    if (!INT.test(v)) return `"${value}" is not a whole number (${type})`;
    if (BigInt(v) > BigInt(INT_RANGE[type]) || BigInt(v) < -BigInt(INT_RANGE[type]) - 1n) return `"${value}" is out of range for ${type}`;
  } else if (['numeric', 'decimal', 'real', 'double precision', 'money'].includes(type)) {
    if (!NUM.test(v.replace(/^\$/, ''))) return `"${value}" is not a number (${type})`;
  } else if (type === 'boolean') {
    if (!BOOL.test(v)) return `"${value}" is not a boolean`;
  } else if (type === 'date' || type.startsWith('timestamp')) {
    if (!DATE.test(v)) return `"${value}" is not a date (${type})`;
  } else if (type.startsWith('time')) {
    if (!TIME.test(v)) return `"${value}" is not a time`;
  } else if (type === 'uuid') {
    if (!UUID.test(v)) return `"${value}" is not a uuid`;
  } else if (type === 'character varying' || type === 'character') {
    const n = Number(String(col.databaseType).match(/\((\d+)\)/)?.[1]);
    if (n && value.length > n) return `"${value.length > 24 ? `${value.slice(0, 24)}…` : value}" is longer than ${n} characters`;
  }
  return null;
}

// 'integer' | 'number' | 'date' | 'boolean' | 'uuid' | 'text' for a column's
// sample values (blanks ignored); '' without values.
export function inferHint(values) {
  const v = values.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!v.length) return '';
  const all = (re) => v.every((x) => re.test(x));
  if (all(INT)) return 'integer';
  if (all(NUM)) return 'number';
  if (all(DATE)) return 'date';
  if (all(UUID)) return 'uuid';
  if (v.every((x) => /^(true|false)$/i.test(x))) return 'boolean';
  return 'text';
}

// ---------------------------------------------------------------- the design

let seq = 0;
export const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newDesign() {
  return { name: 'Import', templateId: 'import', description: '', transaction: 'atomic', sources: [], tasks: [] };
}

// A source node. `columns` are the labels last seen in the example workbook
// ({ letter, label }); they only draw the node. `expected` / `sheet.headers`
// are explicit header checks kept from an imported template; null means "derive
// them from the mapped columns".
export function newSource(over = {}) {
  return {
    id: newId('src'),
    sheet: { mode: 'name', value: '', headers: null },
    header: { mode: 'fixed', row: 1, startColumn: 'A', scanFrom: 1, scanTo: DEFAULT_SCAN.to, caseSensitive: false, expected: null },
    dataOffset: 1,
    skipEmptyRows: true,
    columns: [],
    x: 40,
    y: 40,
    ...over,
  };
}

export function newTask(schema, table, over = {}) {
  return { id: newId('ins'), sourceId: null, schema, table, mappings: [], x: 520, y: 40, ...over };
}

export const mappedColumns = (design, source) => design.tasks.filter((t) => t.sourceId === source.id).flatMap((t) => t.mappings);

// A mapping's address in its source: the letter (fixed header) or the header text.
export const sourceKey = (source, col) => (source.header.mode === 'detect' ? col.label : col.letter);
export const mappingKey = (source, m) => (source.header.mode === 'detect' ? m.label : m.letter);

function derivedExpected(design, source) {
  const start = colIndex(source.header.startColumn);
  const used = mappedColumns(design, source).map((m) => colIndex(m.letter)).filter((i) => i >= start);
  if (!used.length) return [];
  const byLetter = new Map(source.columns.map((c) => [c.letter, c.label]));
  return range(start, Math.max(...used)).map((i) => byLetter.get(colLetter(i)) ?? '');
}

function derivedHeaders(design, source) {
  const match = { caseSensitive: source.header.caseSensitive };
  const seen = new Set();
  return mappedColumns(design, source).map((m) => m.label).filter((l) => {
    const k = normHeader(l, match);
    if (!l || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function designToTemplate(design, { editor = true } = {}) {
  const sources = design.sources.map((s) => {
    const sheet = s.sheet.mode === 'name' ? { mode: 'name', value: s.sheet.value }
      : s.sheet.mode === 'index' ? { mode: 'index', value: Number(s.sheet.value) || 1 }
      : { mode: 'requiredHeaders', headers: s.sheet.headers ?? derivedHeaders(design, s) };
    const match = { trim: true, caseSensitive: !!s.header.caseSensitive };
    const header = s.header.mode === 'fixed'
      ? { mode: 'fixed', row: s.header.row, startColumn: s.header.startColumn, expected: s.header.expected ?? derivedExpected(design, s), match }
      : { mode: 'detect', scanRows: { from: s.header.scanFrom, to: s.header.scanTo }, match };
    if (header.mode === 'fixed' && !header.expected.length) delete header.expected;
    return {
      id: s.id,
      sheet,
      header,
      data: { firstRow: { mode: 'afterHeader', offset: s.dataOffset }, endMode: 'lastNonEmptyMappedRow', skipEmptyRows: s.skipEmptyRows },
    };
  });
  const byId = new Map(design.sources.map((s) => [s.id, s]));
  const tasks = design.tasks.map((t, i) => {
    const src = byId.get(t.sourceId);
    return {
      id: t.id,
      order: i + 1,
      sourceId: t.sourceId,
      target: { schema: t.schema, table: t.table },
      mappings: t.mappings.map((m) => {
        const out = {
          source: src?.header.mode === 'detect' ? { mode: 'header', name: m.label } : { mode: 'column', column: m.letter },
          targetColumn: m.targetColumn,
        };
        if (m.trim) out.trim = true;
        if (m.blank && m.blank !== 'null') out.blank = m.blank;
        return out;
      }),
    };
  });
  const out = {
    format: FORMAT,
    specVersion: SPEC_VERSION,
    templateId: design.templateId,
    name: design.name,
    ...(design.description ? { description: design.description } : {}),
    sources,
    execution: { operation: 'insert', transaction: design.transaction, tasks },
  };
  if (editor) {
    out.editor = { nodes: Object.fromEntries([...design.sources, ...design.tasks].map((n) => [n.id, { x: Math.round(n.x), y: Math.round(n.y) }])) };
  }
  return out;
}

// Reads a template into an editable design. Throws with the reasons when the
// template is not valid (including an unsupported major version).
export function templateToDesign(t) {
  const problems = validateTemplate(t);
  if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));
  const nodes = t.editor?.nodes ?? {};
  const design = {
    name: t.name,
    templateId: t.templateId,
    description: t.description ?? '',
    transaction: t.execution.transaction,
    sources: [],
    tasks: [],
  };
  t.sources.forEach((s, i) => {
    const h = s.header;
    const src = newSource({
      id: s.id,
      sheet: { mode: s.sheet.mode, value: s.sheet.value ?? (s.sheet.mode === 'index' ? 1 : ''), headers: s.sheet.headers ?? null },
      dataOffset: s.data.firstRow.offset ?? 1,
      skipEmptyRows: s.data.skipEmptyRows ?? true,
      x: nodes[s.id]?.x ?? 40,
      y: nodes[s.id]?.y ?? 40 + i * 320,
    });
    src.header = h.mode === 'fixed'
      ? { ...src.header, mode: 'fixed', row: h.row, startColumn: h.startColumn.toUpperCase(), expected: h.expected ?? null, caseSensitive: !!h.match?.caseSensitive }
      : { ...src.header, mode: 'detect', scanFrom: h.scanRows.from, scanTo: h.scanRows.to, caseSensitive: !!h.match?.caseSensitive };
    if (h.mode === 'fixed') {
      const start = colIndex(h.startColumn);
      src.columns = (h.expected ?? []).map((label, k) => ({ letter: colLetter(start + k), label }));
    }
    design.sources.push(src);
  });
  t.execution.tasks.slice().sort((a, b) => a.order - b.order).forEach((k, i) => {
    const src = design.sources.find((s) => s.id === k.sourceId);
    const task = newTask(k.target.schema, k.target.table, { id: k.id, sourceId: k.sourceId, x: nodes[k.id]?.x ?? 520, y: nodes[k.id]?.y ?? 40 + i * 320 });
    for (const m of k.mappings) {
      const fixed = m.source.mode === 'column';
      const letter = fixed ? m.source.column.toUpperCase() : '';
      const label = fixed ? src.columns.find((c) => c.letter === letter)?.label ?? '' : m.source.name;
      task.mappings.push({ id: newId('map'), letter, label, targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim });
      if (fixed ? !src.columns.some((c) => c.letter === letter) : !src.columns.some((c) => c.label === label)) {
        src.columns.push({ letter, label });
      }
    }
    design.tasks.push(task);
  });
  for (const s of design.sources) s.columns.sort((a, b) => (colIndex(a.letter) - colIndex(b.letter)) || a.label.localeCompare(b.label));
  return design;
}

// ---------------------------------------------------------------- insertion order

// Orders the tasks so a table comes after the tables its foreign keys point
// at. Tasks of one table keep their relative order (a table-level graph cannot
// order repeated inserts further). Cycles are reported, never broken
// silently: then `order` is null.
// -> { order: taskId[] | null, cycles: [tableId[]], selfReferences: tableId[] }
export function suggestOrder(design, schema) {
  const key = (t) => tableId(t.schema, t.table);
  const tables = [...new Set(design.tasks.map(key))];
  const present = new Set(tables);
  const deps = new Map(tables.map((k) => [k, new Set()]));
  const selfReferences = [];
  for (const k of tables) {
    const tb = findTable(schema, k);
    for (const fk of tb?.foreignKeys ?? []) {
      if (fk.refTable === k) selfReferences.push(k);
      else if (present.has(fk.refTable)) deps.get(k).add(fk.refTable);
    }
  }
  // Strongly connected components of size > 1 are the cycles.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of deps.get(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort());
    }
  };
  for (const k of tables) if (!index.has(k)) visit(k);
  if (cycles.length) return { order: null, cycles, selfReferences: [...new Set(selfReferences)] };

  const done = new Set();
  const ranked = [];
  while (ranked.length < tables.length) {
    const next = tables.find((k) => !done.has(k) && [...deps.get(k)].every((d) => done.has(d)));
    done.add(next);
    ranked.push(next);
  }
  const rank = new Map(ranked.map((k, i) => [k, i]));
  const order = design.tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank.get(key(a.t)) - rank.get(key(b.t)) || a.i - b.i)
    .map((x) => x.t.id);
  return { order, cycles: [], selfReferences: [...new Set(selfReferences)] };
}

// ---------------------------------------------------------------- design diagnostics

// Everything wrong or doubtful with a design, as [{ level, code, message,
// taskId?, sourceId? }]; level is 'error' (blocks export), 'warning' (may be
// acknowledged) or 'info'. `schema` (schema-model.js) and `workbook` may be
// null when there is no connection / no example file: the checks that need
// them are then reported as unverified.
export function designDiagnostics(design, schema, workbook, { sampleRows = 200 } = {}) {
  const out = [];
  const add = (level, code, message, extra = {}) => out.push({ level, code, message, ...extra });
  if (!design.tasks.length) add('error', 'NO_TASKS', 'Add at least one PostgreSQL table to insert into.');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(design.templateId ?? '')) add('error', 'TEMPLATE_ID', 'The template id must start with a letter and use only letters, digits, - and _.');
  if (!String(design.name ?? '').trim()) add('error', 'NAME', 'The template needs a name.');

  const sources = new Map(design.sources.map((s) => [s.id, s]));
  for (const t of design.tasks) {
    const label = `${t.schema}.${t.table}`;
    const src = sources.get(t.sourceId);
    if (!src) add('error', 'NO_SOURCE', `${label}: connect at least one Excel column to it.`, { taskId: t.id });
    if (!t.mappings.length) add('error', 'NO_MAPPINGS', `${label}: no column is mapped.`, { taskId: t.id });
    const seen = new Set();
    for (const m of t.mappings) {
      if (seen.has(m.targetColumn)) add('error', 'DUPLICATE_TARGET', `${label}: ${m.targetColumn} is fed by more than one Excel column.`, { taskId: t.id });
      seen.add(m.targetColumn);
      if (src?.header.mode === 'detect' && !m.label) add('error', 'BLANK_HEADER', `${label}.${m.targetColumn}: the Excel column has no header text, so it cannot be found by header.`, { taskId: t.id });
    }
  }
  const emptySheet = design.sources.filter((s) => s.sheet.mode === 'name' && !String(s.sheet.value).trim());
  for (const s of emptySheet) add('error', 'NO_SHEET', 'An Excel source has no worksheet name.', { sourceId: s.id });

  // Structure of the exported file.
  const template = designToTemplate(design, { editor: false });
  if (design.tasks.length && design.sources.length && !hasErrors(out)) {
    for (const message of validateTemplate(template)) add('error', 'TEMPLATE', message);
  }

  // Against the example workbook.
  if (!workbook) {
    if (design.sources.length) add('warning', 'NO_WORKBOOK', 'No example workbook is loaded: the Excel sources were not verified.');
  } else {
    const run = extractRows(template, workbook, { limit: sampleRows });
    for (const e of run.errors) {
      if (e.code === 'TEMPLATE') continue;
      add('error', e.code, e.message, { taskId: e.taskId, sourceId: e.sourceId });
    }
    if (schema) {
      for (const k of run.tasks) {
        const task = design.tasks.find((x) => x.id === k.id);
        const tb = findTable(schema, tableId(task.schema, task.table));
        if (!tb) continue;
        const bad = new Map();
        for (const r of k.rows) {
          for (const [name, v] of Object.entries(r.values)) {
            const col = tb.columns.find((c) => c.name === name);
            const msg = col && v !== null ? checkValue(col, v) : null;
            if (msg && !bad.has(name)) bad.set(name, { msg, row: r.row });
          }
        }
        for (const [name, { msg, row: r }] of bad) {
          add('warning', 'VALUE_TYPE', `${task.schema}.${task.table}.${name}: ${msg} (row ${r} of the example; other rows may differ).`, { taskId: k.id });
        }
      }
    }
  }

  // Against the database.
  if (!schema) {
    if (design.tasks.length) add('warning', 'NO_DATABASE', 'Not connected: the destination tables and columns were not verified.');
  } else {
    for (const t of design.tasks) {
      const label = `${t.schema}.${t.table}`;
      const tb = findTable(schema, tableId(t.schema, t.table));
      if (!tb) {
        add('error', 'TABLE_MISSING', `${label} does not exist in the database.`, { taskId: t.id });
        continue;
      }
      const mapped = new Set();
      for (const m of t.mappings) {
        const col = tb.columns.find((c) => c.name === m.targetColumn);
        if (!col) {
          add('error', 'COLUMN_MISSING', `${label} has no column ${m.targetColumn}.`, { taskId: t.id });
          continue;
        }
        mapped.add(col.name);
        if (col.generated) add('error', 'GENERATED_COLUMN', `${label}.${col.name} is a generated column and cannot be inserted.`, { taskId: t.id });
        else if (col.identity === 'a') add('error', 'IDENTITY_ALWAYS', `${label}.${col.name} is GENERATED ALWAYS AS IDENTITY and rejects explicit values.`, { taskId: t.id });
        else if (col.identity || col.serial) add('warning', 'GENERATED_ID', `${label}.${col.name} is generated by the database; mapping it inserts the Excel values instead.`, { taskId: t.id });
      }
      for (const col of tb.columns) {
        if (mapped.has(col.name) || col.nullable || col.defaultValue || col.identity || col.generated || col.serial) continue;
        add('error', 'REQUIRED_UNMAPPED', `${label}.${col.name} is NOT NULL without a default and is not mapped.`, { taskId: t.id });
      }
    }

    // Order against foreign keys.
    const keyOf = (t) => tableId(t.schema, t.table);
    const plan = suggestOrder(design, schema);
    for (const cycle of plan.cycles) add('warning', 'FK_CYCLE', `Foreign keys form a cycle between ${cycle.join(', ')}; no insertion order satisfies them all.`);
    design.tasks.forEach((t, i) => {
      const tb = findTable(schema, keyOf(t));
      for (const fk of tb?.foreignKeys ?? []) {
        if (fk.refTable === keyOf(t)) continue;
        const later = design.tasks.findIndex((o, j) => j > i && keyOf(o) === fk.refTable);
        const earlier = design.tasks.some((o, j) => j < i && keyOf(o) === fk.refTable);
        if (later !== -1 && !earlier) {
          add('warning', 'FK_ORDER', `${t.schema}.${t.table} is inserted before ${fk.refTable}, which it references (${fk.name}). Fine only if those parent rows already exist.`, { taskId: t.id });
        }
      }
    });
  }
  if (design.tasks.length) add('info', 'RETRY', 'Every run inserts the rows again: running the same workbook twice creates duplicates unless the table has unique constraints.');
  return out;
}

export const hasErrors = (diagnostics) => diagnostics.some((d) => d.level === 'error');
