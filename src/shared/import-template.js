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
// 1.7 adds the join (several columns in one value) and constant sources, and the clean, extract and default processors.
// 1.6 adds `processors`: several processors in a row, each taking the text the one before gave.
// 1.5 adds the map (replace values) and convert (date, number, boolean) processors.
// 1.4 adds the case processor: the text in upper or lower case.
// 1.9 adds the range source: a run of worksheet columns as an array.
// 1.8 adds the distinct processor and source: the different values of a worksheet column or of a table column are the rows a task inserts.
// A template is written with the lowest version that covers what it uses.
export const SPEC_VERSION = '1.9';
export const RANGE_VERSION = '1.9';
export const DISTINCT_VERSION = '1.8';
export const MORE_BLOCKS_VERSION = '1.7';
export const CHAIN_VERSION = '1.6';
export const MAP_VERSION = '1.5';
export const INSERTED_VERSION = '1.3';
export const CASE_VERSION = '1.4';
export const LOOKUP_VERSION = '1.2';
export const BASE_VERSION = '1.0';
export const BLOCKS_VERSION = '1.1';
export const SCHEMA_ID = 'urn:pgsql-erd:excel-pg-insert-template:1.8';
export const LOOKUP_MISSING = ['error', 'null'];

// Limits a runner applies when the template doesn't set its own.
export const DEFAULT_LIMITS = { maxRows: 100000, maxScanRows: 200, maxColumns: 512 };
export const DEFAULT_SCAN = { from: 1, to: 30 };
export const DEFAULT_MATCH = { trim: true, caseSensitive: false };
export const BLANK_POLICIES = ['null', 'emptyString', 'error'];
export const TRANSACTIONS = ['atomic', 'perTask'];
export const CASE_MODES = ['upper', 'lower'];
export const CONVERT_TYPES = ['date', 'timestamp', 'number', 'boolean'];
export const DATE_ORDERS = ['dmy', 'mdy', 'ymd'];
export const MAP_OTHERWISE = ['keep', 'null', 'error'];
// Processors that give text, so that another one can follow.
const isTextProcessor = (pr) => ['map', 'convert', 'clean', 'extract', 'default', 'distinct'].includes(pr.type) || (pr.type === 'case' && !pr.split);
// Names the table column a distinct source reads; extractRows() takes its values by this key.
export const distinctKey = (s) => JSON.stringify([s.schema, s.table, s.column]);
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
            required: ['id', 'order', 'target', 'mappings'],
            properties: {
              id,
              order: { type: 'integer', minimum: 1 },
              sourceId: { ...id, description: 'Omit it only when the task reads a table column with a distinct source (1.8).' },
              target: { type: 'object', required: ['schema', 'table'], properties: { schema: { type: 'string', minLength: 1, maxLength: 63 }, table: { type: 'string', minLength: 1, maxLength: 63 } } },
              mappings: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['source', 'targetColumn'],
                  properties: {
                    optional: { type: 'boolean', description: 'Only with a `header` source: when the worksheet has no such header, the column is left out of the INSERT instead of failing.' },
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
                        {
                          type: 'object',
                          required: ['mode', 'value'],
                          description: 'The same text for every row (1.7). Not for processors.',
                          properties: { mode: { const: 'constant' }, value: { type: 'string', maxLength: 1000 } },
                        },
                        {
                          type: 'object',
                          required: ['mode', 'schema', 'table', 'column'],
                          description: 'The different values of a table column (1.8): the task inserts one row for each. The runner reads them from the database. Processors may follow; the task can hold no other column of the worksheet.',
                          properties: {
                            mode: { const: 'distinct' },
                            schema: { type: 'string', minLength: 1, maxLength: 63 },
                            table: { type: 'string', minLength: 1, maxLength: 63 },
                            column: { type: 'string', minLength: 1, maxLength: 63 },
                          },
                        },
                        {
                          type: 'object',
                          required: ['mode', 'from', 'to'],
                          description: 'The cells of every worksheet column from `from` to `to`, both included, as an array of texts (1.9). Use column letters with a fixed header and header names with a detected one. Only a case processor (without split) may follow.',
                          properties: {
                            mode: { const: 'range' },
                            from: { anyOf: [{ type: 'object', required: ['column'], properties: { column } }, { type: 'object', required: ['header'], properties: { header: text } }] },
                            to: { anyOf: [{ type: 'object', required: ['column'], properties: { column } }, { type: 'object', required: ['header'], properties: { header: text } }] },
                          },
                        },
                        {
                          type: 'object',
                          required: ['mode', 'parts'],
                          description: 'Several columns of the worksheet written as one text (1.7); processors may follow. Use column letters with a fixed header and header names with a detected one.',
                          properties: {
                            mode: { const: 'join' },
                            parts: {
                              type: 'array',
                              minItems: 1,
                              items: {
                                anyOf: [
                                  { type: 'object', required: ['column'], properties: { column } },
                                  { type: 'object', required: ['header'], properties: { header: text } },
                                ],
                              },
                            },
                            separator: { type: 'string', maxLength: 16, description: 'Written between the parts. Default a space.' },
                            skipBlank: { type: 'boolean', description: 'Leave out the parts that are blank. Default true.' },
                            prefix: { type: 'string', maxLength: 64 },
                            suffix: { type: 'string', maxLength: 64 },
                          },
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
                          required: ['type', 'pairs'],
                          description: 'map (1.5): replaces the text by the `to` of the first pair whose `from` equals it (trimmed, ignoring case unless caseSensitive).',
                          properties: {
                            type: { const: 'map' },
                            pairs: { type: 'array', minItems: 1, items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', maxLength: 1000 }, to: { type: 'string', maxLength: 1000 } } } },
                            caseSensitive: { type: 'boolean', description: 'Default false.' },
                            otherwise: { enum: MAP_OTHERWISE, description: 'A text that is in no pair: keep it (default), insert NULL or report an error.' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type', 'to'],
                          description: 'convert (1.5): the text as a date (YYYY-MM-DD), timestamp (YYYY-MM-DD HH:MM:SS), number or boolean (true/false). A text that cannot be converted is an error.',
                          properties: {
                            type: { const: 'convert' },
                            to: { enum: CONVERT_TYPES },
                            order: { enum: DATE_ORDERS, description: 'Order of day, month and year for dates written with / . or -. Default dmy.' },
                            decimal: { enum: ['.', ','], description: 'Decimal mark of numbers. Default ".".' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type'],
                          description: 'clean (1.7): tidies the text.',
                          properties: {
                            type: { const: 'clean' },
                            collapseSpaces: { type: 'boolean', description: 'Runs of white space become one space and the ends are trimmed. Default true.' },
                            removeControl: { type: 'boolean', description: 'Remove control and zero-width characters; a non-breaking space becomes a space. Default true.' },
                            removeAccents: { type: 'boolean', description: 'Remove the accents of letters. Default false.' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type', 'mode'],
                          description: 'extract (1.7): a part of the text, by position (substring) or by a regular expression (regex).',
                          properties: {
                            type: { const: 'extract' },
                            mode: { enum: ['substring', 'regex'] },
                            start: { type: 'integer', minimum: 1, description: 'substring: first character, counting from 1. Default 1.' },
                            length: { type: 'integer', minimum: 1, description: 'substring: how many characters. Default: up to the end.' },
                            pattern: { type: 'string', minLength: 1, maxLength: 500, description: 'regex: a JavaScript regular expression.' },
                            group: { type: 'integer', minimum: 0, maximum: 99, description: 'regex: the capture group to keep. Default 0, the whole match.' },
                            ignoreCase: { type: 'boolean', description: 'regex: ignore case. Default false.' },
                            otherwise: { enum: MAP_OTHERWISE, description: 'Nothing to extract: insert NULL (default), keep the text, or report an error.' },
                          },
                        },
                        {
                          type: 'object',
                          required: ['type', 'value'],
                          description: 'default (1.7): the text to use when the cell is blank. It must be the first processor.',
                          properties: { type: { const: 'default' }, value: { type: 'string', minLength: 1, maxLength: 1000 } },
                        },
                        {
                          type: 'object',
                          required: ['type'],
                          description: 'distinct (1.8): keeps the first of each different text (blank texts are dropped), so the task inserts one row for each different value. Processors before it work on every cell, the ones after it on each different value. One per column; the task can hold no other worksheet column.',
                          properties: {
                            type: { const: 'distinct' },
                            ignoreCase: { type: 'boolean', description: 'A and a are the same value. Default false.' },
                            stopAtEmpty: { type: 'boolean', description: 'Stop reading rows at the first blank cell of the column instead of skipping the blanks. Default false.' },
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

// 1.6: the same processors, one after the other.
{
  const mapping = IMPORT_TEMPLATE_SCHEMA.properties.execution.properties.tasks.items.properties.mappings.items.properties;
  mapping.processors = {
    description: 'Processors applied in order (1.6), each to the text the one before gave. Only the last may make an array (split) or look a key up (lookup); the others are case without split, map or convert. Use `processor` for a single one; never both.',
    type: 'array',
    minItems: 2,
    items: { anyOf: mapping.processor.anyOf },
  };
}

// A mapping whose values are the different values of a table column or of a worksheet column.
const isDistinctMapping = (m) => m.source.mode === 'distinct' || (m.processors ?? (m.processor ? [m.processor] : [])).some((p) => p.type === 'distinct');

// The table columns a template reads distinct values from: [{ schema, table, column }].
// A runner reads them from the database and hands them to extractRows() as `tableValues`.
export function distinctTables(template) {
  const out = new Map();
  for (const task of template.execution?.tasks ?? []) {
    for (const m of task.mappings) if (m.source.mode === 'distinct') out.set(distinctKey(m.source), { schema: m.source.schema, table: m.source.table, column: m.source.column });
  }
  return [...out.values()];
}

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
    if (k.sourceId === undefined) {
      if (!k.mappings.some((m) => m.source.mode === 'distinct')) {
        errors.push(`Task ${k.id}: it needs a sourceId.`);
        continue;
      }
    } else if (!src) {
      errors.push(`Task ${k.id}: unknown source ${k.sourceId}.`);
      continue;
    }
    const dedup = k.mappings.filter(isDistinctMapping);
    if (dedup.length > 1) errors.push(`Task ${k.id}: only one column can take distinct values.`);
    for (const m of k.mappings) {
      if (dedup.length && !dedup.includes(m) && m.source.mode !== 'parameter' && m.source.mode !== 'constant') {
        errors.push(`Task ${k.id}: ${m.targetColumn}: a task that inserts distinct values can only hold fixed values and dropdowns besides.`);
      }
    }
    const seen = new Set();
    if (k.mappings.every((m) => m.source.mode === 'parameter' || m.source.mode === 'constant')) errors.push(`Task ${k.id}: it needs at least one column of the worksheet, or the inserted key of an earlier task, to know its rows.`);
    for (const m of k.mappings) {
      if (seen.has(m.targetColumn)) errors.push(`Task ${k.id}: ${m.targetColumn} is mapped more than once.`);
      seen.add(m.targetColumn);
      const chain = m.processors ?? (m.processor ? [m.processor] : []);
      if (m.processor && m.processors) errors.push(`Task ${k.id}: ${m.targetColumn} has both processor and processors.`);
      chain.forEach((pr, at) => {
        if (pr.type === 'distinct' && chain.findIndex((x) => x.type === 'distinct') !== at) errors.push(`Task ${k.id}: ${m.targetColumn}: a column has one distinct processor at most.`);
        if (pr.type === 'default' && at > 0) errors.push(`Task ${k.id}: ${m.targetColumn}: a default processor must be the first one.`);
        if (pr.type === 'extract' && pr.mode === 'regex') {
          try {
            new RegExp(pr.pattern ?? '');
          } catch {
            errors.push(`Task ${k.id}: ${m.targetColumn}: the pattern ${pr.pattern} is not a valid regular expression.`);
          }
        }
        if (pr.type === 'extract' && pr.mode === 'regex' && !pr.pattern) errors.push(`Task ${k.id}: ${m.targetColumn}: a regex extract needs a pattern.`);
      });
      chain.slice(0, -1).forEach((pr) => {
        if (!isTextProcessor(pr)) {
          errors.push(`Task ${k.id}: ${m.targetColumn}: a ${pr.type} processor gives ${pr.type === 'lookup' ? 'a key' : 'an array'}, so no other processor can follow it.`);
        }
      });
      if (m.source.mode === 'inserted') {
        const from = tasks.find((x) => x.id === m.source.taskId);
        if (m.processor || m.processors) errors.push(`Task ${k.id}: ${m.targetColumn}: an inserted value cannot have a processor.`);
        if (!from) errors.push(`Task ${k.id}: ${m.targetColumn} uses the inserted values of the unknown task ${m.source.taskId}.`);
        else if (from.mappings.some(isDistinctMapping)) errors.push(`Task ${k.id}: ${m.targetColumn} uses ${from.id}, which inserts distinct values: they have no worksheet row to match.`);
        else if (from.order >= k.order) errors.push(`Task ${k.id}: ${m.targetColumn} uses ${from.id}, which runs after it (order ${from.order}); a task can only use the keys of earlier tasks.`);
        else if (from.sourceId !== k.sourceId) errors.push(`Task ${k.id}: ${m.targetColumn} uses ${from.id}, which reads another source: rows are matched by worksheet row, so both must read the same source.`);
        continue;
      }
      if (m.source.mode === 'constant') {
        if (m.processor || m.processors) errors.push(`Task ${k.id}: ${m.targetColumn}: a constant cannot have a processor.`);
        continue;
      }
      if (m.source.mode === 'distinct') continue;
      if (m.source.mode === 'join') {
        for (const part of m.source.parts) {
          if (part.column === undefined) continue;
          if (src.header.mode === 'detect') errors.push(`Task ${k.id}: ${m.targetColumn} joins a column letter but source ${src.id} detects its header; use header names.`);
          else if (colIndex(part.column) < colIndex(src.header.startColumn)) errors.push(`Task ${k.id}: column ${part.column} is left of the header start ${src.header.startColumn}.`);
        }
        continue;
      }
      if (m.source.mode === 'range') {
        for (const end of [m.source.from, m.source.to]) {
          if (end.column === undefined) continue;
          if (src.header.mode === 'detect') errors.push(`Task ${k.id}: ${m.targetColumn} selects a column letter but source ${src.id} detects its header; use header names.`);
          else if (colIndex(end.column) < colIndex(src.header.startColumn)) errors.push(`Task ${k.id}: column ${end.column} is left of the header start ${src.header.startColumn}.`);
        }
        if (procsOf(m).some((x) => !(x.type === 'case' && !x.split))) errors.push(`Task ${k.id}: ${m.targetColumn}: a range gives an array; only a case processor without split may follow.`);
        continue;
      }
      if (m.source.mode === 'parameter') {
        if (!params.has(m.source.name)) errors.push(`Task ${k.id}: ${m.targetColumn} uses the undeclared parameter ${m.source.name}.`);
        if (m.processor || m.processors) errors.push(`Task ${k.id}: ${m.targetColumn}: a parameter cannot have a processor.`);
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
    for (const m of task.mappings) {
      if (m.source.mode === 'header' && !m.optional) out.push(m.source.name);
      if (m.source.mode === 'join') for (const part of m.source.parts) if (part.header !== undefined) out.push(part.header);
      if (m.source.mode === 'range') for (const end of [m.source.from, m.source.to]) if (end.header !== undefined) out.push(end.header);
    }
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

// The map processor: the text replaced by the `to` of its pair. -> { ok, value }
export function mapText(value, cfg) {
  const key = (s) => {
    const t = String(s ?? '').trim();
    return cfg.caseSensitive ? t : t.toLowerCase();
  };
  const hit = (cfg.pairs ?? []).find((p) => key(p.from) === key(value));
  if (hit) return { ok: true, value: hit.to };
  const otherwise = cfg.otherwise ?? 'keep';
  return otherwise === 'error' ? { ok: false } : { ok: true, value: otherwise === 'null' ? null : value };
}

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'on', 'si', 'sí', 'verdadero', 'v', 's']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', 'off', 'falso']);
const pad = (n, w = 2) => String(n).padStart(w, '0');

// The convert processor: date, timestamp, number or boolean from text. -> { ok, value }
export function convertText(value, cfg) {
  const v = String(value).trim();
  if (cfg.to === 'boolean') {
    const k = v.toLowerCase();
    return TRUE_WORDS.has(k) ? { ok: true, value: 'true' } : FALSE_WORDS.has(k) ? { ok: true, value: 'false' } : { ok: false };
  }
  if (cfg.to === 'number') {
    const decimal = cfg.decimal === ',' ? ',' : '.';
    let n = v.replace(/[\s$€£¥%]/g, '');
    const neg = /^\(.*\)$/.test(n);
    if (neg) n = n.slice(1, -1);
    n = decimal === ',' ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
    return NUM.test(n) ? { ok: true, value: neg ? `-${n.replace(/^[+-]/, '')}` : n } : { ok: false };
  }
  const m = /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(v);
  if (!m) return { ok: false };
  let [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const order = cfg.order ?? 'dmy';
  let [d, mo, y] = order === 'ymd' ? [c, b, a] : order === 'mdy' ? [b, a, c] : [a, b, c];
  const yearText = order === 'ymd' ? m[1] : m[3];
  if (yearText.length <= 2) y += y < 70 ? 2000 : 1900;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return { ok: false };
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  if (cfg.to === 'date') return { ok: true, value: date };
  const [hh, mm, ss] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (hh > 23 || mm > 59 || ss > 59) return { ok: false };
  return { ok: true, value: `${date} ${pad(hh)}:${pad(mm)}:${pad(ss)}` };
}

// The clean processor: tidier text.
export function cleanText(value, cfg = {}) {
  let v = String(value);
  if (cfg.removeControl ?? true) v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
  if (cfg.collapseSpaces ?? true) v = v.replace(/\s+/g, ' ').trim();
  if (cfg.removeAccents) v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  return v;
}

// The extract processor: a part of the text. -> { ok, value } | { ok: false }
export function extractText(value, cfg) {
  const v = String(value);
  let got;
  if (cfg.mode === 'regex') {
    let re;
    try {
      re = new RegExp(cfg.pattern ?? '', cfg.ignoreCase ? 'i' : '');
    } catch {
      return { ok: false, invalid: true };
    }
    got = re.exec(v)?.[cfg.group ?? 0];
  } else {
    const chars = Array.from(v);
    const start = (cfg.start ?? 1) - 1;
    if (start < chars.length) got = chars.slice(start, cfg.length ? start + cfg.length : undefined).join('');
  }
  if (got !== undefined && got !== '') return { ok: true, value: got };
  const otherwise = cfg.otherwise ?? 'null';
  return otherwise === 'error' ? { ok: false } : { ok: true, value: otherwise === 'keep' ? v : null };
}

// One processor applied to text. -> { ok, value } | { ok: false, code, what }
export function applyProcessor(v, proc) {
  switch (proc?.type) {
    case 'split':
      return { ok: true, value: splitText(proc.case ? changeCase(v, proc.case) : v, proc) };
    case 'case':
      return { ok: true, value: changeCase(proc.split ? splitText(v, proc.split) : v, proc.mode) };
    case 'map': {
      const r = mapText(v, proc);
      return r.ok ? r : { ok: false, code: 'MAP_NO_MATCH', what: 'is not one of the values to replace' };
    }
    case 'convert': {
      const r = convertText(v, proc);
      return r.ok ? r : { ok: false, code: 'CONVERT_FAILED', what: `cannot be read as ${proc.to}` };
    }
    case 'clean':
      return { ok: true, value: cleanText(v, proc) };
    case 'extract': {
      const r = extractText(v, proc);
      return r.ok ? r : { ok: false, code: 'EXTRACT_NO_MATCH', what: r.invalid ? 'cannot be checked: the pattern is not valid' : 'has nothing to extract' };
    }
    default: // default, lookup: nothing to do here
      return { ok: true, value: v };
  }
}
const procsOf = (m) => m.processors ?? (m.processor ? [m.processor] : []);

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
export function extractRows(template, workbook, { limit = Infinity, maxErrors = 100, parameters = {}, previewMissing = false, tableValues = {} } = {}) {
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
    // A task that reads only a table column has no worksheet.
    if (source && !sources.has(source.id)) sources.set(source.id, resolveSource(template, source, workbook));
    const res = source ? sources.get(source.id) : { ok: true, errors: [], columns: [], sheetName: null };
    const out = {
      id: task.id,
      order: task.order,
      sourceId: source?.id ?? null,
      sheetName: res.sheetName ?? null,
      target: task.target,
      columns: task.mappings.map((m) => m.targetColumn),
      skipped: [], // optional columns the worksheet lacks; the INSERT leaves them out
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

    const match = source ? matchOf(source) : DEFAULT_MATCH;
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
      if (m.source.mode === 'constant') {
        picks.push({ m, param: m.source.value });
        continue;
      }
      if (m.source.mode === 'distinct') {
        picks.push({ m, table: distinctKey(m.source) });
        continue;
      }
      // The index of the column a header names, or -1 after reporting why not.
      const byHeader = (name) => {
        const hits = res.columns.filter((c) => normHeader(c.label, match) === normHeader(name, match));
        if (hits.length === 1) return hits[0].index;
        push({
          code: hits.length ? 'DUPLICATE_HEADER' : 'HEADER_MISSING',
          taskId: task.id,
          column: m.targetColumn,
          message: hits.length
            ? `Worksheet "${res.sheetName}": the header "${name}" appears in columns ${hits.map((c) => c.letter).join(', ')}; it must be unique to be mapped.`
            : `Worksheet "${res.sheetName}": there is no header "${name}".`,
        });
        bad = true;
        return -1;
      };
      if (m.source.mode === 'join') {
        const cols = m.source.parts.map((part) => (part.column !== undefined ? colIndex(part.column) : byHeader(part.header)));
        if (!cols.includes(-1)) picks.push({ m, cols });
        continue;
      }
      if (m.source.mode === 'range') {
        const ends = [m.source.from, m.source.to].map((end) => (end.column !== undefined ? colIndex(end.column) : byHeader(end.header)));
        if (!ends.includes(-1)) {
          const lo = Math.min(...ends);
          picks.push({ m, cols: Array.from({ length: Math.max(...ends) - lo + 1 }, (_, i) => lo + i), range: true });
        }
        continue;
      }
      if (m.source.mode === 'column') {
        col = colIndex(m.source.column);
      } else {
        // An optional column the worksheet lacks is left out of the INSERT.
        if (m.optional && !res.columns.some((c) => normHeader(c.label, match) === normHeader(m.source.name, match))) {
          out.skipped.push(m.targetColumn);
          continue;
        }
        col = byHeader(m.source.name);
        if (col === -1) continue;
      }
      picks.push({ m, col });
    }
    if (bad) continue;

    const rows = res.sheet?.rows ?? [];
    const reads = picks.filter((p) => p.col !== undefined || p.cols);
    const blankAt = (p, r) => (p.cols ? p.cols.every((c) => isBlank(rows[r - 1]?.[c])) : isBlank(rows[r - 1]?.[p.col]));
    // The worksheet rows this task inserts. A task that reads no column of its own (only
    // inserted keys and dropdowns) inserts one row for each row of the task whose key it uses.
    let rowList = [];
    const tablePick = picks.find((p) => p.table !== undefined);
    const listed = tablePick ? tableValues[tablePick.table] : null;
    const where = (r) => (tablePick ? `${tablePick.m.source.schema}.${tablePick.m.source.table}.${tablePick.m.source.column}, value ${r}` : `Worksheet "${res.sheetName}", row ${r}`);
    if (tablePick) {
      if (!listed) {
        if (!previewMissing) push({ code: 'DISTINCT_TABLE_MISSING', taskId: task.id, message: `The values of ${tablePick.m.source.schema}.${tablePick.m.source.table}.${tablePick.m.source.column} were not read from the database.` });
      } else listed.forEach((v, i) => !isBlank(v) && rowList.push(i + 1));
    } else if (reads.length) {
      let last = rows.length;
      while (last >= res.firstDataRow && reads.every((p) => blankAt(p, last))) last--;
      if (last - res.firstDataRow + 1 > lim.maxRows) {
        push({ code: 'ROW_LIMIT', taskId: task.id, message: `Worksheet "${res.sheetName}" has more than ${lim.maxRows} data rows.` });
        continue;
      }
      const skipEmpty = source.data.skipEmptyRows ?? true;
      const stoppers = reads.filter((p) => procsOf(p.m).some((x) => x.type === 'distinct' && x.stopAtEmpty));
      for (let r = res.firstDataRow; r <= last; r++) {
        if (stoppers.some((p) => blankAt(p, r))) break; // distinct with stopAtEmpty: reading ends at the first blank cell
        if (skipEmpty && reads.every((p) => blankAt(p, r))) continue;
        rowList.push(r);
      }
    } else {
      const parent = task.mappings.find((m) => m.source.mode === 'inserted')?.source.taskId;
      rowList = rowNumbers.get(parent) ?? [];
    }
    rowNumbers.set(task.id, rowList);
    const seenValues = new Set(); // for a distinct processor
    // Processors in order on one value; a failure is reported and gives null.
    const runAll = (list, v, r0, m) => {
      for (const proc of list) {
        if (v === null) break;
        const done = applyProcessor(v, proc);
        if (!done.ok) {
          push({ code: done.code, taskId: task.id, row: r0, column: m.targetColumn, message: `${where(r0)}: ${m.targetColumn}: "${v}" ${done.what}.` });
          return null;
        }
        v = done.value;
      }
      return v;
    };
    let stop = false; // a distinct processor with stopAtEmpty met a blank cell
    for (const r of rowList) {
      if (stop) break;
      const r0 = r;
      const line = rows[r - 1] ?? [];
      const values = {};
      let skip = false;
      for (const { m, col, cols, param, table, range } of picks) {
        if (col === undefined && !cols && table === undefined) {
          values[m.targetColumn] = param;
          continue;
        }
        let v;
        if (table !== undefined) {
          v = String(listed[r - 1]);
        } else if (range) {
          const cells = cols.map((c) => (m.trim ? String(line[c] ?? '').trim() : String(line[c] ?? '')));
          v = cells.every(isBlank) ? '' : cells;
        } else if (cols) {
          const parts = cols.map((c) => (m.trim ? String(line[c] ?? '').trim() : String(line[c] ?? '')));
          const shown = (m.source.skipBlank ?? true) ? parts.filter((x) => !isBlank(x)) : parts;
          v = shown.some((x) => !isBlank(x)) ? `${m.source.prefix ?? ''}${shown.join(m.source.separator ?? ' ')}${m.source.suffix ?? ''}` : '';
        } else {
          v = String(line[col] ?? '');
          if (m.trim) v = v.trim();
        }
        // A default processor fills in a blank cell before the blank policy is looked at.
        const fill = procsOf(m)[0];
        if (isBlank(v) && fill?.type === 'default' && !isBlank(fill.value)) v = fill.value;
        if (isBlank(v)) {
          const policy = m.blank ?? 'null';
          const dist = procsOf(m).find((x) => x.type === 'distinct');
          if (dist) {
            skip = true; // distinct values leave the blanks out, or end the reading
            if (dist.stopAtEmpty) stop = true;
            break;
          }
          if (policy === 'error') push({ code: 'BLANK_NOT_ALLOWED', taskId: task.id, row: r, column: m.targetColumn, message: `${where(r)}: ${m.targetColumn} cannot be blank.` });
          v = policy === 'emptyString' ? (range || makesArray(procsOf(m).at(-1)) ? [] : '') : null;
        } else {
          const procs = procsOf(m);
          const at = procs.findIndex((x) => x.type === 'distinct');
          v = runAll(at === -1 ? procs : procs.slice(0, at), v, r0, m);
          if (at !== -1) {
            // Only the first row with each text is kept; the processors after it work on that text.
            if (v === null || isBlank(v)) {
              skip = true;
              if (procs[at].stopAtEmpty) stop = true;
              break;
            }
            const key = procs[at].ignoreCase ? String(v).toLowerCase() : String(v);
            if (seenValues.has(key)) {
              skip = true;
              break;
            }
            seenValues.add(key);
            v = runAll(procs.slice(at + 1), v, r0, m);
          }
        }
        values[m.targetColumn] = v;
      }
      if (skip) continue;
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
export function newMap(over = {}) {
  return { id: newId('proc'), kind: 'map', pairs: [{ from: '', to: '' }], caseSensitive: false, otherwise: 'keep', input: null, x: 300, y: 40, ...over };
}
export function newConvert(over = {}) {
  return { id: newId('proc'), kind: 'convert', to: 'date', order: 'dmy', decimal: '.', input: null, x: 300, y: 40, ...over };
}
export function newJoin(over = {}) {
  return { id: newId('proc'), kind: 'join', inputs: [], separator: ' ', skipBlank: true, prefix: '', suffix: '', x: 300, y: 40, ...over };
}
// A select block gives the cells of the Excel columns from its first input to its second, as an array.
export function newSelect(over = {}) {
  return { id: newId('proc'), kind: 'select', inputs: [], x: 300, y: 40, ...over };
}
export const isMultiInput = (p) => p?.kind === 'join' || p?.kind === 'select';
export function newConstant(over = {}) {
  return { id: newId('proc'), kind: 'constant', value: '', x: 300, y: 40, ...over };
}
export function newClean(over = {}) {
  return { id: newId('proc'), kind: 'clean', collapseSpaces: true, removeControl: true, removeAccents: false, input: null, x: 300, y: 40, ...over };
}
export function newExtract(over = {}) {
  return { id: newId('proc'), kind: 'extract', mode: 'substring', start: 1, length: null, pattern: '', group: 0, ignoreCase: false, otherwise: 'null', input: null, x: 300, y: 40, ...over };
}
export function newDefault(over = {}) {
  return { id: newId('proc'), kind: 'default', value: '', input: null, x: 300, y: 40, ...over };
}
// A distinct block gives the different values of an Excel column (`from` "column", it reads `input`
// like the other blocks) or of a table column (`from` "table"); the task inserts one row for each.
export function newDistinct(over = {}) {
  return { id: newId('proc'), kind: 'distinct', from: 'column', ignoreCase: false, stopAtEmpty: false, schema: 'public', table: '', column: '', input: null, x: 300, y: 40, ...over };
}
export const isTableDistinct = (p) => p?.kind === 'distinct' && p.from === 'table';
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
    if (isMultiInput(q)) return q.inputs?.[0] ?? null;
    if (q.input?.sourceId) return q.input;
  }
  return null;
}
// Blocks that give text, which another block may take as its input.
export const isTextBlock = (p) => ['map', 'convert', 'clean', 'extract', 'default', 'join', 'distinct'].includes(p?.kind) || (p?.kind === 'case' && !p.list);
// Blocks whose value does not come from the worksheet: a table dropdown and a constant.
export const isFixedBlock = (p) => p?.kind === 'choice' || p?.kind === 'constant';
// The blocks from the one that reads the Excel column up to `p`.
export function chainOf(design, p) {
  const out = [];
  for (let q = p; q && !out.includes(q); q = q.input?.procId ? procOf(design, q.input.procId) : null) out.unshift(q);
  return out;
}
const processorOf = (p) => (p.kind === 'split'
  ? { type: 'split', delimiter: p.delimiter, trim: !!p.trim, dropEmpty: !!p.dropEmpty }
  : p.kind === 'map'
  ? { type: 'map', pairs: p.pairs.filter((x) => x.from !== '').map((x) => ({ from: x.from, to: x.to })), caseSensitive: !!p.caseSensitive, otherwise: p.otherwise }
  : p.kind === 'convert'
  ? { type: 'convert', to: p.to, ...(p.to === 'date' || p.to === 'timestamp' ? { order: p.order } : {}), ...(p.to === 'number' ? { decimal: p.decimal } : {}) }
  : p.kind === 'case'
  ? { type: 'case', mode: p.mode, ...(p.list ? { split: { delimiter: p.delimiter, trim: !!p.trim, dropEmpty: !!p.dropEmpty } } : {}) }
  : p.kind === 'clean'
  ? { type: 'clean', collapseSpaces: !!p.collapseSpaces, removeControl: !!p.removeControl, removeAccents: !!p.removeAccents }
  : p.kind === 'extract'
  ? { type: 'extract', mode: p.mode, ...(p.mode === 'regex' ? { pattern: p.pattern, group: Number(p.group) || 0, ignoreCase: !!p.ignoreCase } : { start: Number(p.start) || 1, ...(Number(p.length) > 0 ? { length: Number(p.length) } : {}) }), otherwise: p.otherwise }
  : p.kind === 'default'
  ? { type: 'default', value: p.value }
  : p.kind === 'distinct'
  ? { type: 'distinct', ...(p.ignoreCase ? { ignoreCase: true } : {}), ...(p.stopAtEmpty ? { stopAtEmpty: true } : {}) }
  : { type: 'lookup', schema: p.schema, table: p.table, matchColumn: p.matchColumn, valueColumn: p.valueColumn, onMissing: p.onMissing });
export const hasInput = (p) => p?.kind === 'split' || p?.kind === 'lookup' || p?.kind === 'case' || p?.kind === 'map' || p?.kind === 'convert' || p?.kind === 'clean' || p?.kind === 'extract' || p?.kind === 'default' || isMultiInput(p) || (p?.kind === 'distinct' && p.from === 'column');
export const procOf = (design, id) => (design.processors ?? []).find((p) => p.id === id) ?? null;

// The blocks a mapping goes through, from the first to the one it takes its value from.
export const mappingChain = (design, m) => {
  const p = m.via ? procOf(design, m.via) : null;
  return p ? chainOf(design, p) : [];
};
// True when a task inserts the different values of a column.
export const isDistinctTask = (design, t) => t.mappings.some((m) => mappingChain(design, m).some((b) => b.kind === 'distinct'));

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
      const root = p ? chainOf(design, p)[0] : null;
      if (isMultiInput(root)) {
        out.push(...root.inputs.filter((i) => i.sourceId === source.id));
        continue;
      }
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
  let usesChain = false;
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
      if (p?.kind === 'constant') {
        use(p);
        return [{ source: { mode: 'constant', value: p.value }, targetColumn: m.targetColumn }];
      }
      const whole = p ? chainOf(design, p) : [];
      if (isTableDistinct(whole[0])) {
        for (const b of whole) use(b);
        const d = whole[0];
        const rest = whole.slice(1).map(processorOf);
        if (rest.length > 1) usesChain = true;
        return [{ source: { mode: 'distinct', schema: d.schema, table: d.table, column: d.column }, targetColumn: m.targetColumn, ...(rest.length === 1 ? { processor: rest[0] } : rest.length > 1 ? { processors: rest } : {}) }];
      }
      const ref = mappingRef(design, m);
      if (!ref) return [];
      let chain = whole;
      for (const b of chain) use(b);
      if (chain[0]?.kind === 'select') {
        const detect = src?.header.mode === 'detect';
        const [a, b] = chain[0].inputs;
        const end = (i) => (detect ? { header: i.label } : { column: i.letter });
        if (!a || !b) return [];
        out.source = { mode: 'range', from: end(a), to: end(b) };
        chain = chain.slice(1);
      } else if (chain[0]?.kind === 'join') {
        const j = chain[0];
        const detect = src?.header.mode === 'detect';
        out.source = {
          mode: 'join',
          parts: j.inputs.map((i) => (detect ? { header: i.label } : { column: i.letter })),
          separator: j.separator,
          ...(j.skipBlank ? {} : { skipBlank: false }),
          ...(j.prefix ? { prefix: j.prefix } : {}),
          ...(j.suffix ? { suffix: j.suffix } : {}),
        };
        chain = chain.slice(1);
      } else {
        out.source = src?.header.mode === 'detect' ? { mode: 'header', name: ref.label } : { mode: 'column', column: ref.letter };
      }
      let procs = [];
      if (chain.length) {
        // A case block feeding a split is written as the split's `case`.
        const legacy = chain.length === 2 && chain[0].kind === 'case' && !chain[0].list && chain[1].kind === 'split';
        procs = legacy ? [{ ...processorOf(chain[1]), case: chain[0].mode }] : chain.map(processorOf);
        if (procs.length > 1) usesChain = true;
      }
      if (m.trim) out.trim = true;
      if (m.blank && m.blank !== 'null') out.blank = m.blank;
      if (m.optional && out.source.mode === 'header') out.optional = true;
      return [{ source: out.source, targetColumn: out.targetColumn, ...(out.optional ? { optional: true } : {}), ...(procs.length === 1 ? { processor: procs[0] } : procs.length > 1 ? { processors: procs } : {}), ...(out.trim ? { trim: true } : {}), ...(out.blank ? { blank: out.blank } : {}) }];
    });
    return { id: t.id, order: i + 1, ...(t.sourceId ? { sourceId: t.sourceId } : {}), target: { schema: t.schema, table: t.table }, mappings };
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
    specVersion: used.some((p) => p.kind === 'select') ? RANGE_VERSION : used.some((p) => p.kind === 'distinct') ? DISTINCT_VERSION : used.some((p) => ['join', 'constant', 'clean', 'extract', 'default'].includes(p.kind)) ? MORE_BLOCKS_VERSION : usesChain ? CHAIN_VERSION : used.some((p) => p.kind === 'map' || p.kind === 'convert') ? MAP_VERSION : used.some((p) => p.kind === 'case' || (p.kind === 'choice' && hasFilter(p))) ? CASE_VERSION : usesInserted ? INSERTED_VERSION : used.some((p) => p.kind === 'lookup') ? LOOKUP_VERSION : used.length ? BLOCKS_VERSION : BASE_VERSION,
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

  const constants = new Map();
  const constantOf = (value) => {
    if (!constants.has(value)) constants.set(value, place(newConstant({ value })));
    return constants.get(value);
  };

  t.execution.tasks.slice().sort((a, b) => a.order - b.order).forEach((k, i) => {
    const src = design.sources.find((s) => s.id === k.sourceId);
    const task = newTask(k.target.schema, k.target.table, { id: k.id, sourceId: k.sourceId ?? null, x: nodes[k.id]?.x ?? 520, y: nodes[k.id]?.y ?? 40 + i * 320, ...size(nodes[k.id]) });
    for (const m of k.mappings) {
      if (m.source.mode === 'inserted') {
        task.mappings.push({ id: newId('map'), letter: '', label: '', inserted: { taskId: m.source.taskId, column: m.source.column }, targetColumn: m.targetColumn, blank: 'null', trim: false });
        continue;
      }
      if (m.source.mode === 'parameter') {
        task.mappings.push({ id: newId('map'), letter: '', label: '', via: choiceOf(m.source.name).id, targetColumn: m.targetColumn, blank: 'null', trim: false });
        continue;
      }
      if (m.source.mode === 'constant') {
        task.mappings.push({ id: newId('map'), letter: '', label: '', via: constantOf(m.source.value).id, targetColumn: m.targetColumn, blank: 'null', trim: false });
        continue;
      }
      const list = m.processors ?? (m.processor ? [m.processor] : []);
      if (m.source.mode === 'distinct') {
        const d = m.source;
        const dkey = JSON.stringify(['distinct', d.schema, d.table, d.column]);
        if (!splits.has(dkey)) splits.set(dkey, place(newDistinct({ from: 'table', schema: d.schema, table: d.table, column: d.column })));
      }
      let mapping;
      let root = null;
      let fixed = false;
      let letter = '';
      let label = '';
      if (m.source.mode === 'distinct') {
        const d = m.source;
        root = splits.get(JSON.stringify(['distinct', d.schema, d.table, d.column]));
        mapping = { id: newId('map'), letter: '', label: '', targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim };
      } else if (m.source.mode === 'range') {
        const inputs = [m.source.from, m.source.to].map((end) => {
          const byLetter = end.column !== undefined;
          const l = byLetter ? end.column.toUpperCase() : '';
          const lab = byLetter ? src.columns.find((c) => c.letter === l)?.label ?? '' : end.header;
          if (byLetter ? !src.columns.some((c) => c.letter === l) : !src.columns.some((c) => c.label === lab)) src.columns.push({ letter: l, label: lab });
          return { sourceId: k.sourceId, letter: l, label: lab };
        });
        const skey = JSON.stringify([k.sourceId, 'select', inputs.map((x) => [x.letter, x.label])]);
        if (!splits.has(skey)) splits.set(skey, place(newSelect({ inputs })));
        root = splits.get(skey);
        mapping = { id: newId('map'), letter: '', label: '', targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim };
      } else if (m.source.mode === 'join') {
        const j = m.source;
        const inputs = j.parts.map((part) => {
          const byLetter = part.column !== undefined;
          const l = byLetter ? part.column.toUpperCase() : '';
          const lab = byLetter ? src.columns.find((c) => c.letter === l)?.label ?? '' : part.header;
          if (byLetter ? !src.columns.some((c) => c.letter === l) : !src.columns.some((c) => c.label === lab)) src.columns.push({ letter: l, label: lab });
          return { sourceId: k.sourceId, letter: l, label: lab };
        });
        const jkey = JSON.stringify([k.sourceId, 'join', inputs.map((x) => [x.letter, x.label]), j.separator ?? ' ', j.skipBlank ?? true, j.prefix ?? '', j.suffix ?? '']);
        if (!splits.has(jkey)) splits.set(jkey, place(newJoin({ inputs, separator: j.separator ?? ' ', skipBlank: j.skipBlank ?? true, prefix: j.prefix ?? '', suffix: j.suffix ?? '' })));
        root = splits.get(jkey);
        mapping = { id: newId('map'), letter: '', label: '', targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim };
      } else {
        fixed = m.source.mode === 'column';
        letter = fixed ? m.source.column.toUpperCase() : '';
        label = fixed ? src.columns.find((c) => c.letter === letter)?.label ?? '' : m.source.name;
        if (fixed ? !src.columns.some((c) => c.letter === letter) : !src.columns.some((c) => c.label === label)) {
          src.columns.push({ letter, label });
        }
        mapping = { id: newId('map'), letter, label, targetColumn: m.targetColumn, blank: m.blank ?? 'null', trim: !!m.trim, ...(m.optional ? { optional: true } : {}) };
      }
      if (list.length || root) {
        // One block per processor, each reading the one before (the first reads the Excel column).
        const build = (proc, from) => {
          if (proc.type === 'split' && proc.case) {
            const { case: mode, ...rest } = proc;
            return build(rest, build({ type: 'case', mode }, from));
          }
          const input = from ? { procId: from.id } : { sourceId: k.sourceId, letter, label };
          const base = from ? from.id : [k.sourceId, fixed ? letter : label];
          let desc;
          let make;
          if (proc.type === 'split') {
            const cfg = { ...DEFAULT_SPLIT, ...proc };
            desc = ['split', cfg.delimiter, cfg.trim, cfg.dropEmpty];
            make = () => newSplit({ delimiter: cfg.delimiter, trim: cfg.trim, dropEmpty: cfg.dropEmpty, input });
          } else if (proc.type === 'map') {
            const pairs = proc.pairs.map((x) => ({ from: x.from, to: x.to }));
            desc = ['map', pairs, !!proc.caseSensitive, proc.otherwise ?? 'keep'];
            make = () => newMap({ pairs, caseSensitive: !!proc.caseSensitive, otherwise: proc.otherwise ?? 'keep', input });
          } else if (proc.type === 'convert') {
            desc = ['convert', proc.to, proc.order ?? 'dmy', proc.decimal ?? '.'];
            make = () => newConvert({ to: proc.to, order: proc.order ?? 'dmy', decimal: proc.decimal ?? '.', input });
          } else if (proc.type === 'case') {
            const sp = proc.split ? { ...DEFAULT_SPLIT, ...proc.split } : null;
            desc = ['case', proc.mode, sp];
            make = () => newCase({ mode: proc.mode, input, ...(sp ? { list: true, delimiter: sp.delimiter, trim: sp.trim, dropEmpty: sp.dropEmpty } : {}) });
          } else if (proc.type === 'clean') {
            desc = ['clean', proc.collapseSpaces ?? true, proc.removeControl ?? true, !!proc.removeAccents];
            make = () => newClean({ collapseSpaces: proc.collapseSpaces ?? true, removeControl: proc.removeControl ?? true, removeAccents: !!proc.removeAccents, input });
          } else if (proc.type === 'extract') {
            const cfg = { mode: proc.mode, start: proc.start ?? 1, length: proc.length ?? null, pattern: proc.pattern ?? '', group: proc.group ?? 0, ignoreCase: !!proc.ignoreCase, otherwise: proc.otherwise ?? 'null' };
            desc = ['extract', cfg];
            make = () => newExtract({ ...cfg, input });
          } else if (proc.type === 'distinct') {
            desc = ['distinct', !!proc.ignoreCase, !!proc.stopAtEmpty];
            make = () => newDistinct({ from: 'column', ignoreCase: !!proc.ignoreCase, stopAtEmpty: !!proc.stopAtEmpty, input });
          } else if (proc.type === 'default') {
            desc = ['default', proc.value];
            make = () => newDefault({ value: proc.value, input });
          } else {
            desc = ['lookup', proc.schema, proc.table, proc.matchColumn, proc.valueColumn, proc.onMissing ?? 'error'];
            make = () => newLookup({ schema: proc.schema, table: proc.table, matchColumn: proc.matchColumn, valueColumn: proc.valueColumn, onMissing: proc.onMissing ?? 'error', input });
          }
          const key = JSON.stringify([base, ...desc]);
          if (!splits.has(key)) splits.set(key, place(make()));
          return splits.get(key);
        };
        let last = root;
        for (const proc of list) last = build(proc, last);
        Object.assign(mapping, { letter: '', label: '', via: last.id });
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
export function designDiagnostics(design, schema, workbook, { sampleRows = 200, tableValues = {} } = {}) {
  const out = [];
  const add = (level, code, message, extra = {}) => out.push({ level, code, message, ...extra });
  if (!design.tasks.length) add('error', 'NO_TASKS', 'Add at least one PostgreSQL table to insert into.');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(design.templateId ?? '')) add('error', 'TEMPLATE_ID', 'The template id must start with a letter and use only letters, digits, - and _.');
  if (!String(design.name ?? '').trim()) add('error', 'NAME', 'The template needs a name.');

  const sources = new Map(design.sources.map((s) => [s.id, s]));
  for (const t of design.tasks) {
    const label = `${t.schema}.${t.table}`;
    const src = sources.get(t.sourceId);
    const dedup = t.mappings.filter((m) => mappingChain(design, m).some((b) => b.kind === 'distinct'));
    if (dedup.length > 1) add('error', 'DISTINCT_MANY', `${label}: only one column of a task can take distinct values.`, { taskId: t.id });
    if (dedup.length && t.mappings.some((m) => !dedup.includes(m) && !isFixedBlock(procOf(design, m.via)))) add('error', 'DISTINCT_MIX', `${label}: a task that inserts distinct values cannot also read other Excel columns or inserted keys; its other columns can only hold fixed values and table dropdowns.`, { taskId: t.id });
    if (!src && !t.mappings.some((m) => isTableDistinct(mappingChain(design, m)[0]))) add('error', 'NO_SOURCE', `${label}: connect at least one Excel column to it.`, { taskId: t.id });
    if (!t.mappings.length) add('error', 'NO_MAPPINGS', `${label}: no column is mapped.`, { taskId: t.id });
    else if (src && t.mappings.every((m) => isFixedBlock(procOf(design, m.via)))) add('error', 'NO_SOURCE_COLUMN', `${label}: it needs at least one column of the worksheet, or the inserted key of an earlier task, not only table dropdowns.`, { taskId: t.id });
    const seen = new Set();
    for (const m of t.mappings) {
      if (seen.has(m.targetColumn)) add('error', 'DUPLICATE_TARGET', `${label}: ${m.targetColumn} is fed by more than one Excel column.`, { taskId: t.id });
      seen.add(m.targetColumn);
      if (m.inserted) {
        const i = design.tasks.indexOf(t);
        const j = design.tasks.findIndex((x) => x.id === m.inserted.taskId);
        const from = design.tasks[j];
        if (!from) add('error', 'INSERTED_TASK', `${label}.${m.targetColumn}: the task it takes the inserted key from no longer exists.`, { taskId: t.id });
        else if (isDistinctTask(design, from)) add('error', 'INSERTED_DISTINCT', `${label}.${m.targetColumn} uses the key of ${from.schema}.${from.table}, which inserts distinct values: they have no worksheet row to match.`, { taskId: t.id });
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
  // A block reads an Excel column, directly or through the blocks before it, or starts from a table column.
  const rooted = (p) => sources.has(blockSource(design, p)?.sourceId) || isTableDistinct(chainOf(design, p)[0]);
  for (const p of design.processors ?? []) {
    if (hasInput(p) && p.input?.procId && !isTextBlock(procOf(design, p.input.procId))) {
      add('error', 'CHAIN_INPUT', 'A block can only take its text from a case block that gives text (List off), a replace block or a convert block.', { processorId: p.id });
    }
    if (p.kind === 'split') {
      if (!p.delimiter) add('error', 'SPLIT_DELIMITER', 'A split block needs a delimiter.', { processorId: p.id });
      if (!rooted(p)) add('error', 'SPLIT_NO_INPUT', 'A split block has no Excel column connected to it.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'constant') continue;
    if (p.kind === 'distinct') {
      if (p.from === 'column') {
        if (!rooted(p)) add('error', 'DISTINCT_NO_INPUT', 'A distinct block has no Excel column connected to it.', { processorId: p.id });
      } else if (!p.table || !p.column) {
        add('error', 'DISTINCT_TABLE', 'A distinct block needs a table and a column.', { processorId: p.id });
      } else if (schema) {
        const tb = findTable(schema, tableId(p.schema, p.table));
        if (!tb) add('error', 'DISTINCT_TABLE', `The distinct block: ${p.schema}.${p.table} does not exist.`, { processorId: p.id });
        else if (!tb.columns.some((x) => x.name === p.column)) add('error', 'DISTINCT_TABLE', `The distinct block: ${p.schema}.${p.table} has no column ${p.column}.`, { processorId: p.id });
      }
      if (!design.tasks.some((t) => t.mappings.some((m) => mappingChain(design, m).includes(p)))) add('info', 'DISTINCT_UNUSED', 'A distinct block is not connected to a table column.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'select') {
      const ids = new Set(p.inputs.map((i) => i.sourceId));
      if (p.inputs.length !== 2 || [...ids].some((x) => !sources.has(x))) add('error', 'SELECT_NO_INPUT', 'A select block needs two Excel columns connected to it: the first and the last of the range.', { processorId: p.id });
      else if (ids.size > 1) add('error', 'SELECT_SOURCE', 'A select block reads columns of different worksheets.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'join') {
      const ids = new Set(p.inputs.map((i) => i.sourceId));
      if (!p.inputs.length || [...ids].some((x) => !sources.has(x))) add('error', 'JOIN_NO_INPUT', 'A join block needs at least one Excel column connected to it.', { processorId: p.id });
      else if (ids.size > 1) add('error', 'JOIN_SOURCE', 'A join block reads columns of different worksheets.', { processorId: p.id });
      continue;
    }
    if (['map', 'convert', 'clean', 'extract', 'default'].includes(p.kind)) {
      const name = { map: 'replace', convert: 'convert', clean: 'clean', extract: 'extract', default: 'fill-blanks' }[p.kind];
      if (!rooted(p)) add('error', 'BLOCK_NO_INPUT', `A ${name} block has no Excel column connected to it.`, { processorId: p.id });
      if (p.kind === 'default' && p.input?.procId) add('warning', 'DEFAULT_POSITION', 'A fill-blanks block only works when it reads the Excel column directly.', { processorId: p.id });
      if (p.kind === 'default' && p.value === '') add('error', 'DEFAULT_EMPTY', 'A fill-blanks block needs a value.', { processorId: p.id });
      if (p.kind === 'extract' && p.mode === 'regex') {
        let ok = !!p.pattern;
        try {
          new RegExp(p.pattern);
        } catch {
          ok = false;
        }
        if (!ok) add('error', 'EXTRACT_PATTERN', 'An extract block needs a valid regular expression.', { processorId: p.id });
      }
      if (p.kind === 'map') {
        const froms = p.pairs.filter((x) => x.from !== '').map((x) => (p.caseSensitive ? x.from.trim() : x.from.trim().toLowerCase()));
        if (!froms.length) add('error', 'MAP_EMPTY', 'A replace block needs at least one value to replace.', { processorId: p.id });
        else if (new Set(froms).size < froms.length) add('warning', 'MAP_DUPLICATE', 'A replace block lists the same value twice: only the first one is used.', { processorId: p.id });
      }
      continue;
    }
    if (p.kind === 'case') {
      if (!rooted(p)) add('error', 'CASE_NO_INPUT', 'A case block has no Excel column connected to it.', { processorId: p.id });
      if (p.list && !p.delimiter) add('error', 'SPLIT_DELIMITER', 'A case block that converts a list needs a separator.', { processorId: p.id });
      continue;
    }
    if (p.kind === 'lookup') {
      const what = `${p.schema}.${p.table || '?'}`;
      if (!rooted(p)) add('error', 'LOOKUP_NO_INPUT', `The lookup in ${what} has no Excel column connected to it.`, { processorId: p.id });
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
    const run = extractRows(template, workbook, { limit: sampleRows, previewMissing: true, tableValues });
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
