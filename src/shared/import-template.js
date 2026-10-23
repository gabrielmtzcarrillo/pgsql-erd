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
// 1.1 adds processor blocks: split a cell into an array, and table dropdown
// parameters. 1.2 adds the lookup processor (a foreign key found from a value).
// 1.3 adds `inserted`: a column fed by the key an earlier task's INSERT returned.
// 1.4 adds the case processor: the text in upper or lower case.
// A template is written with the lowest version that covers what it uses.
export const SPEC_VERSION = '1.4';
export const INSERTED_VERSION = '1.3';
export const CASE_VERSION = '1.4';
export const LOOKUP_VERSION = '1.2';
export const BASE_VERSION = '1.0';
export const BLOCKS_VERSION = '1.1';
export const SCHEMA_ID = 'urn:pgsql-erd:excel-pg-insert-template:1.4';
export const LOOKUP_MISSING = ['error', 'null'];

// Limits a runner applies when the template doesn't set its own.
export const DEFAULT_LIMITS = { maxRows: 100000, maxScanRows: 200, maxColumns: 512 };
export const DEFAULT_SCAN = { from: 1, to: 30 };
export const DEFAULT_MATCH = { trim: true, caseSensitive: false };
export const BLANK_POLICIES = ['null', 'emptyString', 'error'];
export const TRANSACTIONS = ['atomic', 'perTask'];
export const CASE_MODES = ['upper', 'lower'];
export const DEFAULT_SPLIT = { delimiter: ',', trim: true, dropEmpty: true };

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
    parameters: {
      type: 'array',
      description: 'Values the person running the import picks (1.1), used by mappings with source.mode "parameter".',
      items: {
        type: 'object',
        required: ['name', 'source'],
        properties: {
          name: id,
          label: { type: 'string', maxLength: 256 },
          default: { type: 'string', maxLength: 1000, description: 'Value selected at first; the runner may override it.' },
          source: {
            type: 'object',
            required: ['type', 'schema', 'table', 'valueColumn'],
            description: 'A dropdown of the rows of a table: the value of valueColumn is used, labelColumn is what the person reads and searches.',
            properties: {
              type: { const: 'table' },
              schema: { type: 'string', minLength: 1, maxLength: 63 },
              table: { type: 'string', minLength: 1, maxLength: 63 },
              valueColumn: { type: 'string', minLength: 1, maxLength: 63 },
              labelColumn: { type: 'string', minLength: 1, maxLength: 63 },
              filter: {
                type: 'object',
                required: ['column'],
                description: 'Only the rows whose `column`, as text, equals the value are offered (1.4). The value is either `value` (fixed) or `parameter` (the value picked in another dropdown); give exactly one.',
                properties: {
                  column: { type: 'string', minLength: 1, maxLength: 63 },
                  value: { type: 'string', maxLength: 1000 },
                  parameter: id,
                },
              },
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
                        { type: 'object', required: ['mode', 'name'], properties: { mode: { const: 'parameter' }, name: id }, description: 'A value chosen when the import runs (1.1).' },
                        {
                          type: 'object',
                          required: ['mode', 'taskId', 'column'],
                          description: 'The value of `column` that the INSERT of an earlier task returned (RETURNING) for the same worksheet row (1.3).',
                          properties: { mode: { const: 'inserted' }, taskId: id, column: { type: 'string', minLength: 1, maxLength: 63 } },
                        },
                      ],
                    },
                    processor: {
                      description: 'What happens to the cell text before it is inserted (1.1). Not for parameters.',
                      anyOf: [
                        {
                          type: 'object',
                          required: ['type'],
                          description: 'split: the text as an array of strings.',
                          properties: {
                            type: { const: 'split' },
                            delimiter: { type: 'string', minLength: 1, maxLength: 8, description: 'Literal text, default ",".' },
                            trim: { type: 'boolean', description: 'Trim each element. Default true.' },
                            dropEmpty: { type: 'boolean', description: 'Drop empty elements. Default true.' },
                            case: { enum: CASE_MODES, description: 'Convert the text to upper or lower case before cutting it (1.4); what a case block feeding the split does.' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type', 'mode'],
                          description: 'case (1.4): the text in upper or lower case. With `split` the text is first cut like the split processor and every element is converted: the result is an array.',
                          properties: {
                            type: { const: 'case' },
                            mode: { enum: CASE_MODES },
                            split: {
                              type: 'object',
                              properties: {
                                delimiter: { type: 'string', minLength: 1, maxLength: 8, description: 'Literal text, default ",".' },
                                trim: { type: 'boolean', description: 'Trim each element. Default true.' },
                                dropEmpty: { type: 'boolean', description: 'Drop empty elements. Default true.' },
                              },
                            },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type', 'schema', 'table', 'matchColumn', 'valueColumn'],
                          description: 'lookup (1.2): the value of valueColumn in the row of the table whose matchColumn equals the cell text, found when the task runs.',
                          properties: {
                            type: { const: 'lookup' },
                            schema: { type: 'string', minLength: 1, maxLength: 63 },
                            table: { type: 'string', minLength: 1, maxLength: 63 },
                            matchColumn: { type: 'string', minLength: 1, maxLength: 63 },
                            valueColumn: { type: 'string', minLength: 1, maxLength: 63 },
                            onMissing: { enum: LOOKUP_MISSING, description: 'No row matches: error (default) or null.' },
                          },
                        },
                      ],
                    },
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
  const minor = Number(String(t.specVersion).split('.')[1]);
  const [supMajor, supMinor] = SPEC_VERSION.split('.').map(Number);
  // Newer fields can change what a template means, so a newer minor is refused too.
  if (major !== supMajor || minor > supMinor) return [`Unsupported specVersion ${t.specVersion}; this reader understands up to ${SPEC_VERSION}.`];
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
  const params = new Set();
  for (const p of t.parameters ?? []) {
    if (params.has(p.name)) errors.push(`Duplicate parameter ${p.name}.`);
    params.add(p.name);
  }
  for (const p of t.parameters ?? []) {
    const f = p.source.filter;
    if (!f) continue;
    if ((f.value === undefined) === (f.parameter === undefined)) {
      errors.push(`Parameter ${p.name}: its filter needs exactly one of value and parameter.`);
      continue;
    }
    const seen = new Set([p.name]);
    for (let q = p; q?.source.filter?.parameter !== undefined; ) {
      const next = q.source.filter.parameter;
      if (!params.has(next)) errors.push(`Parameter ${p.name}: its filter follows the undeclared parameter ${next}.`);
      else if (seen.has(next)) errors.push(`Parameter ${p.name}: its filter follows ${next}, which leads back to it.`);
      if (!params.has(next) || seen.has(next)) break;
      seen.add(next);
      q = t.parameters.find((x) => x.name === next);
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
    if (k.mappings.every((m) => m.source.mode === 'parameter')) errors.push(`Task ${k.id}: it needs at least one column of the worksheet, or the inserted key of an earlier task, to know its rows.`);
    for (const m of k.mappings) {
      if (seen.has(m.targetColumn)) errors.push(`Task ${k.id}: ${m.targetColumn} is mapped more than once.`);
      seen.add(m.targetColumn);
      if (m.source.mode === 'inserted') {
        const from = tasks.find((x) => x.id === m.source.taskId);
        if (m.processor) errors.push(`Task ${k.id}: ${m.targetColumn}: an inserted value cannot have a processor.`);
        if (!from) errors.push(`Task ${k.id}: ${m.targetColumn} uses the inserted values of the unknown task ${m.source.taskId}.`);
        else if (from.order >= k.order) errors.push(`Task ${k.id}: ${m.targetColumn} uses ${from.id}, which runs after it (order ${from.order}); a task can only use the keys of earlier tasks.`);
        else if (from.sourceId !== k.sourceId) errors.push(`Task ${k.id}: ${m.targetColumn} uses ${from.id}, which reads another source: rows are matched by worksheet row, so both must read the same source.`);
        continue;
      }
      if (m.source.mode === 'parameter') {
        if (!params.has(m.source.name)) errors.push(`Task ${k.id}: ${m.targetColumn} uses the undeclared parameter ${m.source.name}.`);
        if (m.processor) errors.push(`Task ${k.id}: ${m.targetColumn}: a parameter cannot have a processor.`);
        continue;
      }
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

// The case processor: a string, or each string of an array, in upper or lower case (locale independent).
export const changeCase = (value, mode) => (Array.isArray(value)
  ? value.map((x) => changeCase(x, mode))
  : mode === 'upper' ? String(value).toUpperCase() : String(value).toLowerCase());
// Processors whose result is an array: split, and case over a list.
const makesArray = (p) => p?.type === 'split' || (p?.type === 'case' && !!p.split);

// The split processor: the text cut at a literal delimiter into an array of strings.
export function splitText(value, processor = {}) {
  const { delimiter, trim, dropEmpty } = { ...DEFAULT_SPLIT, ...processor };
  let parts = String(value).split(delimiter);
  if (trim) parts = parts.map((x) => x.trim());
  if (dropEmpty) parts = parts.filter((x) => x !== '');
  return parts;
}

// Runs the template's reading rules over a workbook without touching a
// database. A column fed by `inserted` is null, with the reference in the task's `inserted`;
// a lookup mapping keeps the cell text: the runner resolves it against the
// database. -> { ok, errors, tasks: [{ id, order, sourceId, sheetName, target,
// columns, total, rows: [{ row, values }] }] }. `limit` caps the rows listed per
// task (total still counts every row). Each error carries code, message and,
// where known, taskId, row and column.
// `parameters` gives the values of the table dropdowns by name (over the template's
// defaults); with `previewMissing` a parameter without a value reads as null.
export function extractRows(template, workbook, { limit = Infinity, maxErrors = 100, parameters = {}, previewMissing = false } = {}) {
  const problems = validateTemplate(template);
  if (problems.length) return { ok: false, errors: problems.map((message) => ({ code: 'TEMPLATE', message })), tasks: [] };
  const lim = { ...DEFAULT_LIMITS, ...(template.limits ?? {}) };
  const errors = [];
  const push = (e) => errors.length < maxErrors && errors.push(e);
  const sources = new Map();
  const tasks = [];
  const rowNumbers = new Map(); // task id -> worksheet rows it inserts
  const given = Object.fromEntries((template.parameters ?? []).filter((p) => p.default !== undefined).map((p) => [p.name, p.default]));
  Object.assign(given, parameters);

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
    // Columns fed by an earlier task's returned key stay null here: the runner fills them.
    const inserted = Object.fromEntries(task.mappings.filter((m) => m.source.mode === 'inserted').map((m) => [m.targetColumn, `${m.source.taskId}.${m.source.column}`]));
    if (Object.keys(inserted).length) out.inserted = inserted;
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
      if (m.source.mode === 'inserted') {
        picks.push({ m, param: null });
        continue;
      }
      if (m.source.mode === 'parameter') {
        const value = given[m.source.name];
        if (value === undefined || value === null || value === '') {
          if (!previewMissing) {
            push({ code: 'PARAMETER_MISSING', taskId: task.id, column: m.targetColumn, message: `The parameter "${m.source.name}" has no value.` });
            bad = true;
          }
          picks.push({ m, param: previewMissing ? null : undefined });
        } else picks.push({ m, param: String(value) });
        continue;
      }
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
    const reads = picks.filter((p) => p.col !== undefined);
    // The worksheet rows this task inserts. A task that reads no column of its own (only
    // inserted keys and dropdowns) inserts one row for each row of the task whose key it uses.
    let rowList = [];
    if (reads.length) {
      let last = rows.length;
      while (last >= res.firstDataRow && reads.every((p) => isBlank(rows[last - 1]?.[p.col]))) last--;
      if (last - res.firstDataRow + 1 > lim.maxRows) {
        push({ code: 'ROW_LIMIT', taskId: task.id, message: `Worksheet "${res.sheetName}" has more than ${lim.maxRows} data rows.` });
        continue;
      }
      const skipEmpty = source.data.skipEmptyRows ?? true;
      for (let r = res.firstDataRow; r <= last; r++) {
        if (skipEmpty && reads.every((p) => isBlank(rows[r - 1]?.[p.col]))) continue;
        rowList.push(r);
      }
    } else {
      const parent = task.mappings.find((m) => m.source.mode === 'inserted')?.source.taskId;
      rowList = rowNumbers.get(parent) ?? [];
    }
    rowNumbers.set(task.id, rowList);
    for (const r of rowList) {
      const line = rows[r - 1] ?? [];
      const values = {};
      for (const { m, col, param } of picks) {
        if (col === undefined) {
          values[m.targetColumn] = param;
          continue;
        }
        let v = String(line[col] ?? '');
        if (m.trim) v = v.trim();
        if (isBlank(v)) {
          const policy = m.blank ?? 'null';
          if (policy === 'error') push({ code: 'BLANK_NOT_ALLOWED', taskId: task.id, row: r, column: m.targetColumn, message: `Worksheet "${res.sheetName}", row ${r}: ${m.targetColumn} cannot be blank.` });
          v = policy === 'emptyString' ? (makesArray(m.processor) ? [] : '') : null;
        } else if (m.processor?.type === 'split') v = splitText(m.processor.case ? changeCase(v, m.processor.case) : v, m.processor);
        else if (m.processor?.type === 'case') v = changeCase(m.processor.split ? splitText(v, m.processor.split) : v, m.processor.mode);
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
// checkValue() for a cell value, or for each element of a split cell.
export function checkSample(col, value) {
  if (!Array.isArray(value)) return checkValue(col, value);
  for (const v of value) {
    const msg = checkValue({ ...col, isArray: false }, v);
    if (msg) return msg;
  }
  return null;
}

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
  return { name: 'Import', templateId: 'import', description: '', transaction: 'atomic', sources: [], tasks: [], processors: [] };
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

// A task is one INSERT pass. A mapping feeds one target column from an Excel
// column ({ letter, label }), from the output of a processor (`via`), or from
// the key an earlier task's INSERT returned (`inserted: { taskId, column }`).
export function newTask(schema, table, over = {}) {
  return { id: newId('ins'), sourceId: null, schema, table, mappings: [], x: 520, y: 40, ...over };
}

// Processor blocks sit between the worksheet and a table column.
//  - split: reads one Excel column (`input`: { sourceId, letter, label }) and
//    outputs the cell cut at a delimiter as an array;
//  - choice: a table dropdown. Its value is picked when the import runs; the
//    designer keeps a default (`value`, shown as `valueLabel`).
export function newSplit(over = {}) {
  return { id: newId('proc'), kind: 'split', ...DEFAULT_SPLIT, input: null, x: 300, y: 40, ...over };
}
export function newChoice(over = {}) {
  return { id: newId('proc'), kind: 'choice', name: '', label: '', schema: 'public', table: '', valueColumn: '', labelColumn: '', value: '', valueLabel: '', filterColumn: '', filterValue: '', filterParam: '', x: 300, y: 40, ...over };
}
export function newCase(over = {}) {
  return { id: newId('proc'), kind: 'case', mode: 'upper', list: false, ...DEFAULT_SPLIT, input: null, x: 300, y: 40, ...over };
}
export function newLookup(over = {}) {
  return { id: newId('proc'), kind: 'lookup', schema: 'public', table: '', matchColumn: '', valueColumn: '', onMissing: 'error', input: null, x: 300, y: 40, ...over };
}
// Split, case and lookup blocks read an Excel column.
// A dropdown's optional filter: a column equal to a fixed value or to the value of another dropdown.
export const hasFilter = (p) => !!p.filterColumn && (!!p.filterParam || (p.filterValue !== '' && p.filterValue != null));
// True when the dropdowns a filter follows all exist and do not lead back to `p`.
export function filterChain(design, p) {
  const seen = new Set([p.name]);
  for (let q = p; q.filterParam; ) {
    if (seen.has(q.filterParam)) return false;
    seen.add(q.filterParam);
    q = (design.processors ?? []).find((x) => x.kind === 'choice' && x.name === q.filterParam);
    if (!q) return false;
  }
  return true;
}
// The Excel column a block reads, following a split block back through the case block that feeds it.
// -> { sourceId, letter, label } | null
export function blockSource(design, p) {
  const seen = new Set();
  for (let q = p; q && !seen.has(q.id); q = q.input?.procId ? procOf(design, q.input.procId) : null) {
    seen.add(q.id);
    if (q.input?.sourceId) return q.input;
  }
  return null;
}
export const hasInput = (p) => p?.kind === 'split' || p?.kind === 'lookup' || p?.kind === 'case';
export const procOf = (design, id) => (design.processors ?? []).find((p) => p.id === id) ?? null;

// The Excel column a mapping reads ({ letter, label }), directly or through a
// split block; null for a table dropdown or a split without input.
export function mappingRef(design, m) {
  if (m.inserted) return null;
  if (!m.via) return { letter: m.letter, label: m.label };
  const p = procOf(design, m.via);
  const src = hasInput(p) ? blockSource(design, p) : null;
  return src ? { letter: src.letter, label: src.label } : null;
}

// Every column of a source that some task reads.
export function columnRefs(design, source) {
  const out = [];
  for (const t of design.tasks) {
    if (t.sourceId !== source.id) continue;
    for (const m of t.mappings) {
      const p = m.via ? procOf(design, m.via) : null;
      if (p && hasInput(p) && blockSource(design, p)?.sourceId !== source.id) continue;
      const ref = mappingRef(design, m);
      if (ref) out.push(ref);
    }
  }
  return out;
}

// A mapping's address in its source: the letter (fixed header) or the header text.
export const sourceKey = (source, col) => (source.header.mode === 'detect' ? col.label : col.letter);
export const mappingKey = (source, m) => (source.header.mode === 'detect' ? m.label : m.letter);

function derivedExpected(design, source) {
  const start = colIndex(source.header.startColumn);
  const used = columnRefs(design, source).map((m) => colIndex(m.letter)).filter((i) => i >= start);
  if (!used.length) return [];
  const byLetter = new Map(source.columns.map((c) => [c.letter, c.label]));
  return range(start, Math.max(...used)).map((i) => byLetter.get(colLetter(i)) ?? '');
}

function derivedHeaders(design, source) {
  const match = { caseSensitive: source.header.caseSensitive };
  const seen = new Set();
  return columnRefs(design, source).map((m) => m.label).filter((l) => {
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
  let usesInserted = false;
  const used = []; // processors in order of first use
  const use = (p) => {
    if (!used.includes(p)) used.push(p);
  };
  const tasks = design.tasks.map((t, i) => {
    const src = byId.get(t.sourceId);
    const mappings = t.mappings.flatMap((m) => {
      if (m.inserted) {
        if (!design.tasks.some((x) => x.id === m.inserted.taskId)) return [];
        usesInserted = true;
        return [{ source: { mode: 'inserted', taskId: m.inserted.taskId, column: m.inserted.column }, targetColumn: m.targetColumn }];
      }
      const p = m.via ? procOf(design, m.via) : null;
      if (m.via && !p) return [];
      const out = { targetColumn: m.targetColumn };
      if (p?.kind === 'choice') {
        use(p);
        out.source = { mode: 'parameter', name: p.name };
        return [{ source: out.source, targetColumn: m.targetColumn }];
      }
      const ref = mappingRef(design, m);
      if (!ref) return [];
      out.source = src?.header.mode === 'detect' ? { mode: 'header', name: ref.label } : { mode: 'column', column: ref.letter };
      if (p) {
        // A case block feeding a split is written as the split's `case`.
        const pre = p.kind === 'split' && p.input?.procId ? procOf(design, p.input.procId) : null;
        if (pre) use(pre);
        use(p);
        out.processor = p.kind === 'split'
          ? { type: 'split', delimiter: p.delimiter, trim: !!p.trim, dropEmpty: !!p.dropEmpty, ...(pre?.kind === 'case' ? { case: pre.mode } : {}) }
          : p.kind === 'case'
          ? { type: 'case', mode: p.mode, ...(p.list ? { split: { delimiter: p.delimiter, trim: !!p.trim, dropEmpty: !!p.dropEmpty } } : {}) }
          : { type: 'lookup', schema: p.schema, table: p.table, matchColumn: p.matchColumn, valueColumn: p.valueColumn, onMissing: p.onMissing };
      }
      if (m.trim) out.trim = true;
      if (m.blank && m.blank !== 'null') out.blank = m.blank;
      return [{ source: out.source, targetColumn: out.targetColumn, ...(out.processor ? { processor: out.processor } : {}), ...(out.trim ? { trim: true } : {}), ...(out.blank ? { blank: out.blank } : {}) }];
    });
    return { id: t.id, order: i + 1, sourceId: t.sourceId, target: { schema: t.schema, table: t.table }, mappings };
  });
  const parameters = [];
  for (const p of used) {
    if (p.kind !== 'choice' || parameters.some((x) => x.name === p.name)) continue;
    // A filter that follows another dropdown needs that dropdown in the template too.
    const dep = p.filterParam && (design.processors ?? []).find((q) => q.kind === 'choice' && q.name === p.filterParam);
    if (dep) use(dep);
    parameters.push({
      name: p.name,
      ...(p.label ? { label: p.label } : {}),
      ...(p.value !== '' && p.value != null ? { default: String(p.value) } : {}),
      source: { type: 'table', schema: p.schema, table: p.table, valueColumn: p.valueColumn, ...(p.labelColumn ? { labelColumn: p.labelColumn } : {}), ...(hasFilter(p) ? { filter: { column: p.filterColumn, ...(p.filterParam ? { parameter: p.filterParam } : { value: String(p.filterValue) }) } } : {}) },
    });
  }
  const out = {
    format: FORMAT,
    specVersion: used.some((p) => p.kind === 'case' || (p.kind === 'choice' && hasFilter(p))) ? CASE_VERSION : usesInserted ? INSERTED_VERSION : used.some((p) => p.kind === 'lookup') ? LOOKUP_VERSION : used.length ? BLOCKS_VERSION : BASE_VERSION,
    templateId: design.templateId,
    name: design.name,
    ...(design.description ? { description: design.description } : {}),
    sources,
    ...(parameters.length ? { parameters } : {}),
    execution: { operation: 'insert', transaction: design.transaction, tasks },
  };
  if (editor) {
    const box = (n) => ({ x: Math.round(n.x), y: Math.round(n.y), ...(n.w && n.h ? { w: Math.round(n.w), h: Math.round(n.h) } : {}) });
    out.editor = { nodes: Object.fromEntries([...design.sources, ...design.tasks].map((n) => [n.id, box(n)])) };
    if (used.length) out.editor.processors = used.map(box);
  }
  return out;
}

// The saved size of a node, when it has one.
const size = (n) => (n?.w > 0 && n?.h > 0 ? { w: n.w, h: n.h } : {});

// Reads a template into an editable design. Throws with the reasons when the
// template is not valid (including an unsupported version).
export function templateToDesign(t) {
  const problems = validateTemplate(t);
  if (problems.length) throw new Error(problems.slice(0, 5).join('\n'));
  const nodes = t.editor?.nodes ?? {};
  const procSpots = t.editor?.processors ?? [];
  const design = {
    name: t.name,
    templateId: t.templateId,
    description: t.description ?? '',
    transaction: t.execution.transaction,
    sources: [],
    tasks: [],
    processors: [],
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
      ...size(nodes[s.id]),
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

  // Blocks are made in the order the tasks first use them, which is the order they are exported in.
  const choices = new Map();
  const splits = new Map();
  const place = (p) => {
    const spot = procSpots[design.processors.length];
    design.processors.push(Object.assign(p, spot ? { x: spot.x, y: spot.y, ...size(spot) } : { y: 40 + design.processors.length * 220 }));
    return p;
  };
  const choiceOf = (name) => {
    if (!choices.has(name)) {
      const param = t.parameters.find((x) => x.name === name);
      choices.set(name, place(newChoice({
        name,
        label: param.label ?? '',
        schema: param.source.schema,
        table: param.source.table,
        valueColumn: param.source.valueColumn,
        labelColumn: param.source.labelColumn ?? '',
        filterColumn: param.source.filter?.column ?? '',
        filterValue: param.source.filter?.value ?? '',
        filterParam: param.source.filter?.parameter ?? '',
        value: param.default ?? '',
        valueLabel: '',
      })));
    }
    return choices.get(name);
  };

  t.execution.tasks.slice().sort((a, b) => a.order - b.order).forEach((k, i) => {
    const src = design.sources.find((s) => s.id === k.sourceId);
    const task = newTask(k.target.schema, k.target.table, { id: k.id, sourceId: k.sourceId, x: nodes[k.id]?.x ?? 520, y: nodes[k.id]?.y ?? 40 + i * 320, ...size(nodes[k.id]) });
    for (const m of k.mappings) {
      if (m.source.mode === 'inserted') {
        task.mappings.push({ id: newId('map'), letter: '', label: '', inserted: { taskId: m.source.taskId, column: m.source.column }, targetColumn: m.targetColumn, blank: 'null', trim: false });
        continue;
      }
      if (m.source.mode === 'parameter') {
        task.mappings.push({ id: newId('map'), letter: '', label: '', via: choiceOf(m.source.name).id, targetColumn: m.targetColumn, blank: 'null', trim: false });
        continue;
      }
      const fixed = m.source.mode === 'column';
      const letter = fixed ? m.source.column.toUpperCase() : '';
      const label = fixed ? src.columns.find((c) => c.letter === letter)?.label ?? '' : m.source.name;
      if (fixed ? !src.columns.some((c) => c.letter === letter) : !src.columns.some((c) => c.label === label)) {
        src.columns.push({ letter, label });
      }
      const mapping = { id: newId('map'), letter, label, targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim };
      if (m.processor) {
        const input = { sourceId: k.sourceId, letter, label };
        let key;
        let make;
        if (m.processor.type === 'split') {
          const cfg = { ...DEFAULT_SPLIT, ...m.processor };
          let pre = null;
          if (cfg.case) {
            const ck = JSON.stringify([k.sourceId, fixed ? letter : label, 'case', cfg.case, null]);
            if (!splits.has(ck)) splits.set(ck, place(newCase({ mode: cfg.case, input })));
            pre = splits.get(ck);
          }
          key = JSON.stringify([k.sourceId, fixed ? letter : label, 'split', cfg.delimiter, cfg.trim, cfg.dropEmpty, cfg.case ?? null]);
          make = () => newSplit({ delimiter: cfg.delimiter, trim: cfg.trim, dropEmpty: cfg.dropEmpty, input: pre ? { procId: pre.id } : input });
        } else if (m.processor.type === 'case') {
          const sp = m.processor.split ? { ...DEFAULT_SPLIT, ...m.processor.split } : null;
          key = JSON.stringify([k.sourceId, fixed ? letter : label, 'case', m.processor.mode, sp]);
          make = () => newCase({ mode: m.processor.mode, input, ...(sp ? { list: true, delimiter: sp.delimiter, trim: sp.trim, dropEmpty: sp.dropEmpty } : {}) });
        } else {
          const l = m.processor;
          key = JSON.stringify([k.sourceId, fixed ? letter : label, 'lookup', l.schema, l.table, l.matchColumn, l.valueColumn, l.onMissing ?? 'error']);
          make = () => newLookup({ schema: l.schema, table: l.table, matchColumn: l.matchColumn, valueColumn: l.valueColumn, onMissing: l.onMissing ?? 'error', input });
        }
        if (!splits.has(key)) splits.set(key, place(make()));
        Object.assign(mapping, { letter: '', label: '', via: splits.get(key).id });
      }
      task.mappings.push(mapping);
    }
    design.tasks.push(task);
  });
  for (const p of t.parameters ?? []) choiceOf(p.name);
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
  // Using the key another task inserted also needs that task first.
  for (const t of design.tasks) {
    for (const m of t.mappings) {
      const from = m.inserted && design.tasks.find((x) => x.id === m.inserted.taskId);
      if (from && key(from) !== key(t)) deps.get(key(t)).add(key(from));
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
    else if (src && t.mappings.every((m) => procOf(design, m.via)?.kind === 'choice')) add('error', 'NO_SOURCE_COLUMN', `${label}: it needs at least one column of the worksheet, or the inserted key of an earlier task, not only table dropdowns.`, { taskId: t.id });
    const seen = new Set();
    for (const m of t.mappings) {
      if (seen.has(m.targetColumn)) add('error', 'DUPLICATE_TARGET', `${label}: ${m.targetColumn} is fed by more than one Excel column.`, { taskId: t.id });
      seen.add(m.targetColumn);
      if (m.inserted) {
        const i = design.tasks.indexOf(t);
        const j = design.tasks.findIndex((x) => x.id === m.inserted.taskId);
        const from = design.tasks[j];
        if (!from) add('error', 'INSERTED_TASK', `${label}.${m.targetColumn}: the task it takes the inserted key from no longer exists.`, { taskId: t.id });
        else if (j >= i) add('error', 'INSERTED_ORDER', `${label}.${m.targetColumn} uses inserted.${m.inserted.column} of ${from.schema}.${from.table}, which is inserted at the same time or later: move that task before it.`, { taskId: t.id });
        else if (from.sourceId !== t.sourceId) add('error', 'INSERTED_SOURCE', `${label}.${m.targetColumn} uses inserted.${m.inserted.column} of ${from.schema}.${from.table}, which reads another worksheet: rows are matched by worksheet row, so both tasks must read the same source.`, { taskId: t.id });
        else if (schema) {
          const tb = findTable(schema, tableId(from.schema, from.table));
          if (tb && !(tb.primaryKey?.columns ?? []).includes(m.inserted.column)) add('error', 'INSERTED_NOT_PK', `${label}.${m.targetColumn}: ${m.inserted.column} is not a primary key column of ${from.schema}.${from.table}.`, { taskId: t.id });
        }
        continue;
      }
      const p = m.via ? procOf(design, m.via) : null;
      if (m.via && !p) add('error', 'MISSING_BLOCK', `${label}.${m.targetColumn}: its processor block no longer exists.`, { taskId: t.id });
      else if (hasInput(p) && blockSource(design, p) && blockSource(design, p).sourceId !== t.sourceId) add('error', 'SPLIT_SOURCE', `${label}.${m.targetColumn}: its block reads another worksheet than the rest of the task.`, { taskId: t.id, processorId: p.id });
      const ref = mappingRef(design, m);
      if (ref && src?.header.mode === 'detect' && !ref.label) add('error', 'BLANK_HEADER', `${label}.${m.targetColumn}: the Excel column has no header text, so it cannot be found by header.`, { taskId: t.id });
    }
  }

  // A lookup finds rows an earlier task inserted: that task must come first.
  design.tasks.forEach((t, i) => {
    for (const m of t.mappings) {
      const p = m.via ? procOf(design, m.via) : null;
      if (p?.kind !== 'lookup' || !p.table) continue;
      const same = (o) => tableId(o.schema, o.table) === tableId(p.schema, p.table);
      if (design.tasks.some((o, j) => j > i && same(o)) && !design.tasks.some((o, j) => j < i && same(o))) {
        add('warning', 'LOOKUP_ORDER', `${t.schema}.${t.table}.${m.targetColumn} looks up ${p.schema}.${p.table}, which a later task inserts into: move that task earlier so the rows exist.`, { taskId: t.id, processorId: p.id });
      }
    }
  });

  // Processor blocks.
  const names = new Set();
  for (const p of design.processors ?? []) {
    if (p.kind === 'split') {
      if (!p.delimiter) add('error', 'SPLIT_DELIMITER', 'A split block needs a delimiter.', { processorId: p.id });
      const feeder = p.input?.procId ? procOf(design, p.input.procId) : null;
      if (p.input?.procId && (feeder?.kind !== 'case' || feeder.list)) add('error', 'SPLIT_CHAIN', 'A split block can only follow a case block that gives text (its List option off).', { processorId: p.id });
      else if (!sources.has(blockSource(design, p)?.sourceId)) add('error', 'SPLIT_NO_INPUT', 'A split block has no Excel column connected to it.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'case') {
      if (!p.input || !sources.has(p.input.sourceId)) add('error', 'CASE_NO_INPUT', 'A case block has no Excel column connected to it.', { processorId: p.id });
      if (p.list && !p.delimiter) add('error', 'SPLIT_DELIMITER', 'A case block that converts a list needs a separator.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'lookup') {
      const what = `${p.schema}.${p.table || '?'}`;
      if (!p.input || !sources.has(p.input.sourceId)) add('error', 'LOOKUP_NO_INPUT', `The lookup in ${what} has no Excel column connected to it.`, { processorId: p.id });
      if (!p.table || !p.matchColumn || !p.valueColumn) add('error', 'LOOKUP_TABLE', 'A lookup needs a table, the column to match and the column to return.', { processorId: p.id });
      else if (schema) {
        const tb = findTable(schema, tableId(p.schema, p.table));
        if (!tb) add('error', 'LOOKUP_TABLE', `The lookup: ${what} does not exist.`, { processorId: p.id });
        else {
          for (const c of [p.matchColumn, p.valueColumn]) if (!tb.columns.some((x) => x.name === c)) add('error', 'LOOKUP_TABLE', `The lookup: ${what} has no column ${c}.`, { processorId: p.id });
          // The value to look for is a primary key of the table.
          if (tb.columns.some((x) => x.name === p.matchColumn) && !(tb.primaryKey?.columns ?? []).includes(p.matchColumn)) {
            add('error', 'LOOKUP_NOT_PK', `The lookup: ${p.matchColumn} is not part of the primary key of ${what}${tb.primaryKey ? ` (${tb.primaryKey.columns.join(', ')})` : ', which has none'}.`, { processorId: p.id });
          }
        }
      }
      continue;
    }
    const label = p.name || p.table || '?';
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(p.name ?? '')) add('error', 'PARAM_NAME', 'A table dropdown needs a name: a letter, then letters, digits, - and _.', { processorId: p.id });
    else if (names.has(p.name)) add('error', 'PARAM_NAME', `Two table dropdowns are named ${p.name}.`, { processorId: p.id });
    names.add(p.name);
    if (!p.table || !p.valueColumn) {
      add('error', 'PARAM_TABLE', `The table dropdown "${label}" needs a table and a value column.`, { processorId: p.id });
    } else if (schema) {
      const tb = findTable(schema, tableId(p.schema, p.table));
      if (!tb) add('error', 'PARAM_TABLE', `The table dropdown "${label}": ${p.schema}.${p.table} does not exist.`, { processorId: p.id });
      else for (const c of [p.valueColumn, p.labelColumn].filter(Boolean)) if (!tb.columns.some((x) => x.name === c)) add('error', 'PARAM_TABLE', `The table dropdown "${label}": ${p.table} has no column ${c}.`, { processorId: p.id });
    }
    if (!p.filterColumn !== !(p.filterParam || (p.filterValue !== '' && p.filterValue != null))) add('error', 'PARAM_FILTER', `The table dropdown "${label}": the filter needs both a column and a value (or another dropdown).`, { processorId: p.id });
    else if (p.filterParam && !filterChain(design, p)) add('error', 'PARAM_FILTER', `The table dropdown "${label}": its filter follows ${p.filterParam}, which is missing or leads back to it.`, { processorId: p.id });
    else if (p.filterColumn && schema) {
      const tb = findTable(schema, tableId(p.schema, p.table));
      if (tb && !tb.columns.some((x) => x.name === p.filterColumn)) add('error', 'PARAM_FILTER', `The table dropdown "${label}": ${p.table} has no column ${p.filterColumn}.`, { processorId: p.id });
    }
    if (p.name && (p.value === '' || p.value == null)) add('info', 'PARAM_NO_DEFAULT', `The table dropdown "${label}" has no default: whoever runs the import must pick a value.`, { processorId: p.id });
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
    const run = extractRows(template, workbook, { limit: sampleRows, previewMissing: true });
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
            const msg = col && v !== null ? checkSample(col, v) : null;
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
        const via = procOf(design, m.via);
        if ((via?.kind === 'split' || (via?.kind === 'case' && via.list)) && !col.isArray) add('error', 'SPLIT_TARGET', `${label}.${col.name} is ${col.databaseType}, not an array: a ${via.kind} block over a list produces an array (for example text[]).`, { taskId: t.id });
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
