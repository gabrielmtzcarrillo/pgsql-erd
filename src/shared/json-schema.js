// A small JSON Schema validator for structured model output (the subset
// models are asked to follow: type, properties, required, additionalProperties,
// items, enum, const, min/max, lengths, pattern, format, anyOf/oneOf), and
// helpers that derive schemas from tables and check rows against tables.

import { tsType } from './typegen.js';
import { vectorKind, vectorDimensions, parseVectorText } from './pgvector.js';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function matchesType(v, type) {
  const t = typeOf(v);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
}

const FORMATS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
};

export function validateJson(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf;
    const ok = options.filter((s) => validateJson(value, s, path).length === 0).length;
    if (schema.anyOf ? ok === 0 : ok !== 1) errors.push(`${path}: does not match ${schema.anyOf ? 'any' : 'exactly one'} of the allowed shapes`);
    return errors;
  }
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: must have at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match ${schema.pattern}`);
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) errors.push(`${path}: must be a valid ${schema.format}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validateJson(v, schema.items, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}.${k}: is required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validateJson(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: is not allowed`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validateJson(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}

// Parse model output as JSON: accepts a bare object, or one inside a
// ```json fence or surrounded by prose.
export function parseModelJson(text) {
  const s = String(text ?? '').trim();
  const attempts = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const first = s.search(/[[{]/);
  if (first !== -1) {
    const close = s[first] === '{' ? '}' : ']';
    const last = s.lastIndexOf(close);
    if (last > first) attempts.push(s.slice(first, last + 1));
  }
  for (const a of attempts) {
    try {
      return { ok: true, value: JSON.parse(a) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: 'The response is not valid JSON.' };
}

// ------------------------------------------------------------ tables

const lengthOf = (databaseType) => Number(databaseType.match(/\((\d+)/)?.[1]) || undefined;

function columnSchema(col, enums) {
  const t = tsType(col, enums, 'insert');
  const vec = !col.isArray && vectorKind(col.baseType);
  const dims = vec && vectorDimensions(col.databaseType);
  let s;
  if (vec) s = { type: 'array', items: { type: 'number' }, ...(dims ? { minItems: dims, maxItems: dims } : {}) };
  else if (col.isArray) s = { type: 'array' };
  else if (t === 'number') s = { type: /int|serial|oid/.test(col.baseType) ? 'integer' : 'number' };
  else if (t === 'boolean') s = { type: 'boolean' };
  else if (t.startsWith('string | number')) s = { type: ['string', 'number'] };
  else if (t === 'Date | string') s = { type: 'string', format: col.baseType === 'date' ? 'date' : 'date-time' };
  else if (t === 'Json') s = {};
  else if (t.includes('"')) s = { type: 'string', enum: JSON.parse(`[${t.split(' | ').join(',')}]`) };
  else {
    s = { type: 'string' };
    if (col.baseType === 'uuid') s.format = 'uuid';
    const len = /char/.test(col.baseType) ? lengthOf(col.databaseType) : undefined;
    if (len) s.maxLength = len;
  }
  if (col.comment) s.description = col.comment;
  if (col.nullable && s.type) s.type = [].concat(s.type, 'null');
  return s;
}

function enumMap(schema) {
  const map = new Map();
  for (const e of schema?.enums ?? []) {
    const union = e.values.map((v) => JSON.stringify(v)).join(' | ');
    map.set(e.name.toLowerCase(), union);
    map.set(`${e.schema}.${e.name}`.toLowerCase(), union);
  }
  return map;
}

// JSON Schema for the values a model should produce for one row of a table.
// Columns the database fills in (serial, identity, generated, defaults on
// key columns) and foreign keys (they must point at existing rows) are left out.
export function tableJsonSchema(table, schema = null, { includeForeignKeys = false } = {}) {
  const enums = enumMap(schema);
  const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns));
  const pk = new Set(table.primaryKey?.columns ?? []);
  const properties = {};
  const required = [];
  for (const c of table.columns) {
    if (c.generated || c.identity || c.serial) continue;
    if (pk.has(c.name) && c.defaultValue) continue;
    if (fkCols.has(c.name) && !includeForeignKeys) continue;
    properties[c.name] = columnSchema(c, enums);
    if (!c.nullable && !c.defaultValue) required.push(c.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// Check a row against a table without the database: unknown columns,
// missing NOT NULL values and type mismatches. Foreign keys are checked by
// the runner, which can query the referenced tables.
export function checkRowAgainstTable(table, row, schema = null) {
  const problems = [];
  const cols = new Map(table.columns.map((c) => [c.name, c]));
  for (const k of Object.keys(row ?? {})) if (!cols.has(k)) problems.push(`${k}: no such column in ${table.id}`);
  const enums = enumMap(schema);
  for (const c of table.columns) {
    const v = row?.[c.name];
    if (v === undefined) {
      if (!c.nullable && !c.defaultValue && !c.serial && !c.identity && !c.generated) problems.push(`${c.name}: NOT NULL column has no value`);
      continue;
    }
    if (c.generated || c.identity === 'a') {
      problems.push(`${c.name}: is generated by the database and can't be set`);
      continue;
    }
    if (v === null) {
      if (!c.nullable) problems.push(`${c.name}: can't be null`);
      continue;
    }
    const s = columnSchema({ ...c, nullable: false }, enums);
    let value = v instanceof Date ? v.toISOString() : v;
    const vec = !c.isArray && vectorKind(c.baseType);
    if (vec && ArrayBuffer.isView(value)) value = Array.from(value);
    if (vec && typeof value === 'string') {
      // pgvector text: check the dimensions of '[…]'; sparsevec text is left to the database.
      value = parseVectorText(value);
      if (typeof value === 'string') continue;
    }
    const errs = validateJson(value, s, c.name).map((e) => e.replace(/^[^:]+: /, `${c.name}: `));
    problems.push(...errs);
  }
  return problems;
}
