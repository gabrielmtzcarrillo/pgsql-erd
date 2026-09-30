// Import tables from spreadsheets: Excel workbooks (.xlsx/.xlsm) and CSV.
//
// Reading: readSpreadsheet() turns a file into sheets of string cells. .xlsx
// is a zip of XML parts; it is unpacked with DecompressionStream so this
// module has no dependencies and runs in the sandboxed renderer and in Node.
//
// Interpreting: each sheet is read in one of two layouts, picked from its
// header row (the first non-empty row):
//
//  - definition: one row per column, with at least a column-name and a type
//    header (e.g. "Table | Column | Type | Length | Nullable | PK | Default |
//    References | Comment"). A "Table" column splits the sheet into several
//    tables; without it the sheet is one table named after the sheet.
//  - data: the header row holds column names and the rows below are data.
//    Column types are inferred from the values.
//
// sheetTables() returns table specs, modelFromSpecs() turns them into an ERD
// model (like catalog.js does for a database) and importSpecs() merges them
// into the diagram through sync.js.

import { emptyModel, newTable, newColumn, uuid } from './pgerd.js';
import { splitType, tableKey } from './catalog.js';
import { mergeFromDb } from './sync.js';

// ---------------------------------------------------------------- zip

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Map of entry name -> () => Promise<Uint8Array>.
export function readZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error('ZIP64 workbooks are not supported');
  const utf8 = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, async () => {
      if (dv.getUint32(offset, true) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`);
      const start = offset + 30 + dv.getUint16(offset + 26, true) + dv.getUint16(offset + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`Unsupported zip compression (method ${method})`);
    });
  }
  return entries;
}

// ---------------------------------------------------------------- xml

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

// Minimal XML to tree: { name, attrs, children, text }. Namespace prefixes are
// dropped from element names; attributes keep theirs ("r:id").
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([\w.:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[6] !== undefined) {
      top.text += decodeXml(m[6]);
    } else if (m[3]) {
      const name = m[3].replace(/^.*:/, '');
      if (m[2]) {
        // Closing tag: pop to the matching element.
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === name) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const attrs = {};
      for (const a of m[4].matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeXml(a[3] ?? a[4]);
      const node = { name, attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}

const kids = (node, name) => (node?.children ?? []).filter((c) => c.name === name);
const kid = (node, name) => node?.children.find((c) => c.name === name);
function find(node, name) {
  if (!node) return null;
  if (node.name === name) return node;
  for (const c of node.children) {
    const r = find(c, name);
    if (r) return r;
  }
  return null;
}
// Text of <t> elements below node, skipping phonetic runs (<rPh>).
function textOf(node) {
  if (node.name === 't') return node.text;
  if (node.name === 'rPh') return '';
  return node.children.map(textOf).join('');
}
const attrEnding = (attrs, suffix) => Object.entries(attrs).find(([k]) => k === suffix || k.endsWith(`:${suffix}`))?.[1];

// ---------------------------------------------------------------- xlsx

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 45, 46, 47]);

// 'date' | 'datetime' | 'time' | null for a number format.
export function dateFormatKind(id, code) {
  if (code === undefined) {
    if (!BUILTIN_DATE_FORMATS.has(id)) return null;
    if (BUILTIN_TIME_FORMATS.has(id)) return 'time';
    return id === 22 ? 'datetime' : 'date';
  }
  const f = code
    .split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '')
    .toLowerCase();
  const hasDate = /[dy]/.test(f) || (/m/.test(f) && !/[hs]/.test(f));
  const hasTime = /[hs]/.test(f);
  if (!hasDate && !hasTime) return null;
  if (hasDate && hasTime) return 'datetime';
  return hasDate ? 'date' : 'time';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Excel serial date to an ISO-like string.
export function serialToString(serial, kind, date1904 = false) {
  const days = serial + (date1904 ? 1462 : 0);
  const ms = Math.round((days - 25569) * 86400000);
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (kind === 'time') return time;
  if (kind === 'datetime' || !Number.isInteger(serial)) return `${date} ${time}`;
  return date;
}

// "BC12" -> 54 (zero-based column index).
function columnIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i)?.[0].toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// Sheets of an .xlsx workbook: [{ name, hidden, rows: string[][] }].
export async function readXlsx(bytes) {
  const zip = readZip(bytes);
  const utf8 = new TextDecoder();
  const part = async (name) => {
    const get = zip.get(name);
    return get ? parseXml(utf8.decode(await get())) : null;
  };

  const workbook = await part('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (xl/workbook.xml is missing)');
  const rels = await part('xl/_rels/workbook.xml.rels');
  const relById = new Map();
  let sharedPath = 'xl/sharedStrings.xml';
  let stylesPath = 'xl/styles.xml';
  for (const r of kids(find(rels, 'Relationships'), 'Relationship')) {
    const target = resolvePart('xl/workbook.xml', r.attrs.Target ?? '');
    relById.set(r.attrs.Id, target);
    if (/\/sharedStrings$/.test(r.attrs.Type ?? '')) sharedPath = target;
    if (/\/styles$/.test(r.attrs.Type ?? '')) stylesPath = target;
  }

  const shared = kids(find(await part(sharedPath), 'sst'), 'si').map(textOf);

  const styles = await part(stylesPath);
  const formats = new Map(kids(find(styles, 'numFmts'), 'numFmt').map((f) => [Number(f.attrs.numFmtId), f.attrs.formatCode ?? '']));
  const xfKinds = kids(find(styles, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    return dateFormatKind(id, formats.get(id));
  });
  const date1904 = /^(1|true)$/i.test(find(workbook, 'workbookPr')?.attrs.date1904 ?? '');

  const sheets = [];
  for (const s of kids(find(workbook, 'sheets'), 'sheet')) {
    const path = relById.get(attrEnding(s.attrs, 'id'));
    const doc = path ? await part(path) : null;
    if (!doc) continue;
    const rows = [];
    let nextRow = 0;
    for (const row of kids(find(doc, 'sheetData'), 'row')) {
      const r = row.attrs.r ? Number(row.attrs.r) - 1 : nextRow;
      nextRow = r + 1;
      const cells = [];
      let nextCol = 0;
      for (const c of kids(row, 'c')) {
        const col = c.attrs.r ? columnIndex(c.attrs.r) : nextCol;
        nextCol = col + 1;
        const v = kid(c, 'v')?.text ?? '';
        let value;
        switch (c.attrs.t) {
          case 's': value = shared[Number(v)] ?? ''; break;
          case 'inlineStr': value = kid(c, 'is') ? textOf(kid(c, 'is')) : v; break;
          case 'b': value = v === '1' ? 'true' : v === '0' ? 'false' : v; break;
          case 'e': value = ''; break;
          case 'str':
          case 'd': value = v; break;
          default: {
            const kind = xfKinds[Number(c.attrs.s ?? 0)];
            value = v !== '' && kind && Number.isFinite(Number(v)) ? serialToString(Number(v), kind, date1904) : v;
          }
        }
        cells[col] = value;
      }
      rows[r] = Array.from(cells, (x) => x ?? '');
    }
    sheets.push({ name: s.attrs.name ?? `Sheet${sheets.length + 1}`, hidden: !!s.attrs.state && s.attrs.state !== 'visible', rows: Array.from(rows, (x) => x ?? []) });
  }
  return sheets;
}

// ---------------------------------------------------------------- csv

export function parseCsv(text, delimiter = null) {
  text = String(text).replace(/^﻿/, '');
  if (!delimiter) {
    const first = text.split(/\r?\n/, 1)[0];
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Sheets from a file's name and bytes.
export async function readSpreadsheet(fileName, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const base = String(fileName).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'sheet';
  if (u8[0] === 0x50 && u8[1] === 0x4b) return readXlsx(u8);
  if (u8[0] === 0xd0 && u8[1] === 0xcf) {
    throw new Error('Old Excel 97-2003 (.xls) files are not supported. Save the workbook as .xlsx and import that.');
  }
  return [{ name: base, hidden: false, rows: parseCsv(new TextDecoder().decode(u8)) }];
}

// ---------------------------------------------------------------- names

// "Customer ID" -> "customer_id", "OrderDate" -> "order_date".
export function snakeCase(s) {
  const out = String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return /^\d/.test(out) ? `_${out}` : out;
}

const headerKey = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Header aliases for the definition layout.
const HEADERS = {
  table: ['table', 'tablename', 'entity', 'tabla', 'nombretabla'],
  schema: ['schema', 'schemaname', 'esquema'],
  name: ['column', 'columnname', 'name', 'field', 'fieldname', 'attribute', 'attributename', 'columna', 'nombre', 'campo', 'nombrecolumna', 'colname'],
  type: ['type', 'datatype', 'columntype', 'fieldtype', 'sqltype', 'dbtype', 'tipo', 'tipodedato', 'tipodato', 'tipodedatos'],
  length: ['length', 'len', 'size', 'maxlength', 'longitud', 'tamano', 'largo'],
  precision: ['precision'],
  scale: ['scale', 'decimals', 'decimalplaces', 'escala', 'decimales'],
  nullable: ['nullable', 'null', 'allownull', 'allownulls', 'isnullable', 'nulo', 'permitenulos', 'aceptanulos'],
  notNull: ['notnull', 'required', 'mandatory', 'nn', 'obligatorio', 'requerido', 'nonulo'],
  pk: ['pk', 'primarykey', 'primary', 'ispk', 'key', 'llaveprimaria', 'claveprimaria', 'llave', 'clave'],
  unique: ['unique', 'uq', 'uk', 'isunique', 'unico'],
  default: ['default', 'defaultvalue', 'valorpordefecto', 'valordefecto', 'predeterminado'],
  comment: ['comment', 'comments', 'description', 'desc', 'remarks', 'notes', 'note', 'comentario', 'comentarios', 'descripcion'],
  references: ['references', 'reference', 'ref', 'fk', 'foreignkey', 'fkreference', 'referencia', 'referencias', 'llaveforanea', 'claveforanea'],
  refTable: ['referencedtable', 'reftable', 'fktable', 'referencestable', 'tablareferenciada'],
  refColumn: ['referencedcolumn', 'refcolumn', 'fkcolumn', 'referencescolumn', 'columnareferenciada'],
};

function headerMap(header) {
  const map = {};
  header.forEach((cell, i) => {
    const k = headerKey(cell);
    if (!k) return;
    for (const [field, aliases] of Object.entries(HEADERS)) {
      if (aliases.includes(k) && map[field] === undefined) {
        map[field] = i;
        return;
      }
    }
  });
  return map;
}

const TRUTHY = new Set(['y', 'yes', 'true', 't', '1', 'x', '✓', '✔', 'si', 'sí', 's', 'pk', 'nn', 'required', '*', 'on']);
const truthy = (v) => TRUTHY.has(String(v ?? '').trim().toLowerCase());

// ---------------------------------------------------------------- types

const TYPE_ALIASES = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', mediumint: 'integer', tinyint: 'smallint',
  serial4: 'serial', serial8: 'bigserial', serial2: 'smallserial',
  varchar: 'character varying', nvarchar: 'character varying', varchar2: 'character varying', nvarchar2: 'character varying',
  string: 'text', str: 'text', nchar: 'character', char: 'character', bpchar: 'character',
  ntext: 'text', clob: 'text', longtext: 'text', mediumtext: 'text', tinytext: 'text',
  bool: 'boolean', bit: 'bit', float8: 'double precision', float4: 'real', float: 'double precision', double: 'double precision',
  decimal: 'numeric', number: 'numeric', dec: 'numeric',
  timestamptz: 'timestamp with time zone', timestamp: 'timestamp without time zone', datetime: 'timestamp without time zone',
  datetime2: 'timestamp without time zone', smalldatetime: 'timestamp without time zone', datetimeoffset: 'timestamp with time zone',
  timetz: 'time with time zone', time: 'time without time zone', varbit: 'bit varying',
  blob: 'bytea', binary: 'bytea', varbinary: 'bytea', longblob: 'bytea', image: 'bytea',
  uniqueidentifier: 'uuid', guid: 'uuid',
};
const NO_LENGTH = new Set(['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'smallserial', 'text', 'boolean', 'real', 'double precision', 'uuid', 'bytea', 'date', 'json', 'jsonb']);

const KNOWN_TYPES = new Set([
  ...Object.values(TYPE_ALIASES), ...NO_LENGTH, 'numeric', 'character varying', 'character', 'bit varying',
  'timestamp without time zone', 'timestamp with time zone', 'time without time zone', 'time with time zone',
  'interval', 'money', 'inet', 'cidr', 'macaddr', 'macaddr8', 'xml', 'point', 'line', 'lseg', 'box', 'path',
  'polygon', 'circle', 'tsvector', 'tsquery', 'oid', 'citext', 'hstore', 'geometry', 'geography',
  'vector', 'halfvec', 'sparsevec',
]);
const isKnownType = (raw) => KNOWN_TYPES.has(normalizeType(raw).type.replace(/(\[\])+$/, ''));

const toInt = (v) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
};

// "VARCHAR(100)" -> { type: 'character varying', length: 100, precision: null }
export function normalizeType(raw) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { type: 'text', length: null, precision: null };
  s = s.replace(/\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/, (m, a, b) => (b === undefined ? `(${a})` : `(${a},${b})`));
  s = s.replace(/\s+unsigned$/, '');
  let { type, length, precision } = splitType(s);
  let arr = '';
  const m = type.match(/^(.*?)((?:\[\])+)$/);
  if (m) {
    type = m[1].trim();
    arr = m[2];
  }
  type = TYPE_ALIASES[type] ?? type;
  if (NO_LENGTH.has(type)) length = precision = null; // int(11) and friends
  return { type: type + arr, length, precision };
}

const RE_INT = /^[-+]?(0|[1-9]\d*)$/;
const RE_NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const RE_BOOL = /^(true|false|yes|no)$/i;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const RE_TSTZ = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(z|[-+]\d{2}(:?\d{2})?)$/i;
const RE_TIME = /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function isJson(v) {
  if (!/^[[{]/.test(v)) return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

// PostgreSQL type for a list of sample values (strings).
export function inferType(values) {
  const vs = values.map((v) => String(v ?? '').trim()).filter((v) => v !== '');
  const all = (re) => vs.every((v) => (typeof re === 'function' ? re(v) : re.test(v)));
  const t = (type) => ({ type, length: null, precision: null });
  if (!vs.length) return t('text');
  if (all(RE_BOOL)) return t('boolean');
  if (all(RE_INT)) {
    const max = Math.max(...vs.map((v) => Math.abs(Number(v))));
    if (max <= 2147483647) return t('integer');
    if (vs.every((v) => BigInt(v) <= 9223372036854775807n && BigInt(v) >= -9223372036854775808n)) return t('bigint');
    return t('numeric');
  }
  if (all((v) => RE_NUM.test(v) && !/^[-+]?0\d/.test(v))) return t('numeric');
  if (all(RE_UUID)) return t('uuid');
  if (all(RE_DATE)) return t('date');
  if (all((v) => RE_DATE.test(v) || RE_TS.test(v))) return t('timestamp without time zone');
  if (all((v) => RE_DATE.test(v) || RE_TS.test(v) || RE_TSTZ.test(v))) return t('timestamp with time zone');
  if (all(RE_TIME)) return t('time without time zone');
  if (all(isJson)) return t('jsonb');
  return t('text');
}

// ---------------------------------------------------------------- sheets

const isBlank = (row) => !row || row.every((c) => String(c ?? '').trim() === '');

function uniqueName(name, used) {
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${name}_${i}`;
  used.add(n);
  return n;
}

// "public.customers.id", "customers(id)", "customers" -> { schema, table, column }
export function parseReference(s) {
  const v = String(s ?? '').trim().replace(/"/g, '');
  if (!v || truthy(v) || /^(n|no|false|f|0|-)$/i.test(v)) return null;
  let m = v.match(/^(?:([^.()\s]+)\.)?([^.()\s]+)\s*\(\s*([^()\s]+)\s*\)$/);
  if (m) return { schema: m[1] ?? null, table: m[2], column: m[3] };
  const parts = v.split('.').map((p) => p.trim());
  if (parts.some((p) => !p || /\s/.test(p))) return null;
  if (parts.length === 1) return { schema: null, table: parts[0], column: null };
  if (parts.length === 2) return { schema: null, table: parts[0], column: parts[1] };
  if (parts.length === 3) return { schema: parts[0], table: parts[1], column: parts[2] };
  return null;
}

/**
 * Table specs for one sheet: { layout, tables: [spec] }, where a spec is
 * { key, sheet, layout, name, schema, rows, columns: [{ name, type, length,
 *   precision, notNull, pk, unique, default, description, ref }] }.
 * Options: schema (for tables without one), snakeCase (convert names),
 * notNull (data layout: mark columns without blanks NOT NULL).
 */
export function sheetTables(sheet, { schema = 'public', snakeCase: snake = true, notNull = false } = {}) {
  const ident = (s) => (snake ? snakeCase(s) : String(s ?? '').trim());
  const rows = sheet.rows ?? [];
  const h = rows.findIndex((r) => !isBlank(r));
  if (h < 0) return { layout: 'empty', tables: [] };
  const header = rows[h].map((c) => String(c ?? '').trim());
  while (header.length && !header[header.length - 1]) header.pop();
  const body = rows.slice(h + 1).filter((r) => !isBlank(r));
  const map = headerMap(header);
  const cell = (row, field) => (map[field] === undefined ? '' : String(row[map[field]] ?? '').trim());

  // Column definitions need "name" and "type" headers, and most of the type
  // cells must be SQL types (a data sheet can have "Name" and "Type" columns).
  const types = map.type === undefined ? [] : body.map((r) => cell(r, 'type')).filter(Boolean);
  if (map.name !== undefined && types.length && types.filter(isKnownType).length >= types.length * 0.6) {
    const tables = new Map();
    let current = sheet.name;
    for (const row of body) {
      if (map.table !== undefined && cell(row, 'table')) current = cell(row, 'table');
      const colName = cell(row, 'name');
      if (!colName) continue;
      const sch = cell(row, 'schema') || schema;
      const tname = ident(current) || 'table';
      const key = `${sch}.${tname}`;
      if (!tables.has(key)) {
        tables.set(key, { key, sheet: sheet.name, layout: 'definition', name: tname, schema: sch, rows: 0, columns: [], used: new Set() });
      }
      const t = tables.get(key);
      const type = normalizeType(cell(row, 'type'));
      const len = toInt(cell(row, 'length'));
      const prec = toInt(cell(row, 'precision'));
      const scale = toInt(cell(row, 'scale'));
      if (len !== null) type.length = len;
      else if (prec !== null) type.length = prec;
      if (scale !== null) type.precision = scale;
      if (NO_LENGTH.has(type.type)) type.length = type.precision = null;
      const keyCell = cell(row, 'pk').toLowerCase();
      const pk = truthy(keyCell) || /\bpk\b|primary/.test(keyCell);
      let nn = pk;
      if (map.notNull !== undefined) nn ||= truthy(cell(row, 'notNull'));
      else if (map.nullable !== undefined) {
        const v = cell(row, 'nullable').toLowerCase();
        nn ||= v !== '' && !truthy(v) && !/^null$/.test(v);
        if (/not ?null/.test(v)) nn = true;
      }
      let ref = parseReference(cell(row, 'references'));
      if (!ref && cell(row, 'refTable')) {
        const parts = cell(row, 'refTable').replace(/"/g, '').split('.');
        ref = { schema: parts.length > 1 ? parts[0] : null, table: parts[parts.length - 1], column: cell(row, 'refColumn') || null };
      }
      if (ref) {
        ref.table = ident(ref.table);
        if (ref.column) ref.column = ident(ref.column);
      }
      t.rows++;
      t.columns.push({
        name: uniqueName(ident(colName) || `column_${t.columns.length + 1}`, t.used),
        ...type,
        notNull: nn,
        pk,
        unique: truthy(cell(row, 'unique')) || /\b(uk|uq|unique)\b/.test(keyCell),
        default: cell(row, 'default'),
        description: cell(row, 'comment'),
        ref,
      });
    }
    const list = [...tables.values()].map(({ used, ...t }) => t);
    return { layout: 'definition', tables: list };
  }

  // Data layout: header row = column names.
  const used = new Set();
  const columns = header.map((name, i) => {
    const values = body.map((r) => r[i]);
    const type = inferType(values);
    const filled = values.filter((v) => String(v ?? '').trim() !== '');
    return {
      name: uniqueName(ident(name) || `column_${i + 1}`, used),
      ...type,
      notNull: notNull && body.length > 0 && filled.length === body.length,
      pk: false,
      unique: false,
      default: '',
      description: snake && ident(name) !== name.trim() ? name.trim() : '',
      ref: null,
      values: filled,
      complete: body.length > 0 && filled.length === body.length,
    };
  });
  // An "id" column, or a first column named like "employee_id", with unique
  // integer or uuid values is the primary key.
  const id = columns.find((c) => c.name.toLowerCase() === 'id') ?? (/(^|_|\s)id$/i.test(columns[0]?.name ?? '') ? columns[0] : null);
  if (id && ['integer', 'bigint', 'uuid'].includes(id.type) && id.complete && new Set(id.values).size === id.values.length) {
    id.pk = true;
    id.notNull = true;
  }
  for (const c of columns) {
    delete c.values;
    delete c.complete;
  }
  const name = ident(sheet.name) || 'table';
  return {
    layout: 'data',
    tables: columns.length ? [{ key: `${schema}.${name}`, sheet: sheet.name, layout: 'data', name, schema, rows: body.length, columns }] : [],
  };
}

// ---------------------------------------------------------------- model

// Find the table a reference points to among `tables` (schema optional).
function resolveTable(ref, tables, defaultSchema) {
  const exact = tables.find((t) => t.name === ref.table && (t.schema || 'public') === (ref.schema || defaultSchema));
  if (exact || ref.schema) return exact ?? null;
  const byName = tables.filter((t) => t.name === ref.table);
  return byName.length === 1 ? byName[0] : null;
}

function refColumn(ref, table) {
  if (ref.column) return table.columns.find((c) => c.name === ref.column) ?? null;
  const pks = table.columns.filter((c) => c.pk);
  return pks.length === 1 ? pks[0] : null;
}

/**
 * ERD model (tables + links) from table specs. References to tables outside
 * the specs are returned in `external` as { table, column, ref } (ids and
 * attnums of the new model) so importSpecs() can link them to the diagram.
 */
export function modelFromSpecs(specs) {
  const model = emptyModel();
  const external = [];
  for (const s of specs) {
    const pkCols = s.columns.filter((c) => c.pk).map((c) => ({ column: c.name }));
    model.tables.push(
      newTable({
        id: uuid(),
        name: s.name,
        schema: s.schema,
        description: s.description ?? '',
        rawData: {
          name: s.name,
          schema: s.schema,
          primary_key: pkCols.length ? [{ columns: pkCols }] : [],
          unique_constraint: s.columns.filter((c) => c.unique && !c.pk).map((c) => ({ name: '', columns: [{ column: c.name }] })),
        },
        columns: s.columns.map((c, i) =>
          newColumn({
            name: c.name,
            type: c.type,
            length: c.length,
            precision: c.precision,
            notNull: !!c.notNull,
            pk: !!c.pk,
            default: c.default ?? '',
            description: c.description ?? '',
            attnum: i,
            raw: { colconstype: 'n' },
          })
        ),
      })
    );
  }
  specs.forEach((s, ti) => {
    const t = model.tables[ti];
    s.columns.forEach((c, ci) => {
      if (!c.ref) return;
      const target = resolveTable(c.ref, model.tables, s.schema);
      const col = target && refColumn(c.ref, target);
      if (!target) {
        external.push({ table: t.id, column: ci, ref: c.ref, schema: s.schema });
        return;
      }
      if (!col) return;
      model.links.push({
        id: uuid(), type: 'onetomany', localTable: t.id, localCol: ci, refTable: target.id, refCol: col.attnum,
        group: uuid(), fkName: '', rawFk: null, raw: null,
      });
    });
  });
  return { model, external };
}

/**
 * Merge the specs into the diagram `erd`. Tables that are already in the
 * diagram (same schema and name) are updated and keep their position; the
 * others are added. Returns { added, updated } table ids, like mergeFromDb.
 */
export function importSpecs(erd, specs) {
  const { model, external } = modelFromSpecs(specs);
  const result = mergeFromDb(erd, model, model.tables.map(tableKey));
  const byKey = new Map(erd.tables.map((t) => [tableKey(t), t]));
  const newById = new Map(model.tables.map((t) => [t.id, t]));
  const sig = (l) => `${l.localTable}:${l.localCol}->${l.refTable}:${l.refCol}`;
  const have = new Set(erd.links.map(sig));
  for (const x of external) {
    const src = newById.get(x.table);
    const local = byKey.get(tableKey(src));
    const localCol = local?.columns.find((c) => c.name === src.columns[x.column].name);
    const target = resolveTable(x.ref, erd.tables, x.schema);
    const col = target && refColumn(x.ref, target);
    if (!localCol || !col) continue;
    const link = {
      id: uuid(), type: 'onetomany', localTable: local.id, localCol: localCol.attnum, refTable: target.id, refCol: col.attnum,
      group: uuid(), fkName: '', rawFk: null, raw: null,
    };
    if (have.has(sig(link))) continue;
    have.add(sig(link));
    erd.links.push(link);
  }
  return result;
}
