// Table specs from an Oracle Database schema, read by
// src/main/database/oracle.cjs (its catalog is described there).
//
// The specs are the ones the other imports produce, so the same dialog adds
// them to the diagram:
//  - types become their PostgreSQL equivalents (NUMBER(9) -> integer,
//    NUMBER(18) -> bigint, NUMBER(10,2) -> numeric(10,2), VARCHAR2 ->
//    character varying, CLOB -> text, BLOB -> bytea, RAW(16) -> uuid, DATE ->
//    timestamp(0) since an Oracle DATE has a time, TIMESTAMP WITH TIME ZONE ->
//    timestamp with time zone…)
//  - an identity column of an integer type becomes serial / bigserial / smallserial
//  - primary keys, NOT NULL, single-column unique constraints and indexes,
//    foreign keys and comments are kept; defaults are translated (SYSDATE,
//    SYSTIMESTAMP -> CURRENT_TIMESTAMP, SYS_GUID() -> gen_random_uuid(),
//    USER -> CURRENT_USER) and dropped when they call another function
//  - the imported schema goes to the schema chosen in the dialog; a foreign
//    key to another Oracle schema points to a schema named after it

import { snakeCase } from './spreadsheet.js';
import { parseJsonModel } from './efimport.js';
import { alignForeignKeyTypes } from './fktypes.js';

const SERIAL = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

/** PostgreSQL type for an Oracle catalog column. */
export function oracleType(col = {}) {
  const t = String(col.type ?? '').toUpperCase().replace(/\(\d+\)/g, '');
  const p = col.precision;
  const s = col.scale;
  const n = Number(col.length);
  switch (t) {
    case 'NUMBER':
      if (p === null || p === undefined) return s === 0 ? 'numeric(38,0)' : 'numeric';
      if (!s) return p <= 4 ? 'smallint' : p <= 9 ? 'integer' : p <= 18 ? 'bigint' : `numeric(${p},0)`;
      // A negative scale rounds to tens, hundreds…: whole numbers of p - s digits.
      return s < 0 ? `numeric(${p - s},0)` : `numeric(${Math.max(p, s)},${s})`;
    case 'FLOAT': return p && p <= 24 ? 'real' : 'double precision';
    case 'BINARY_FLOAT': return 'real';
    case 'BINARY_DOUBLE': return 'double precision';
    case 'VARCHAR2': case 'NVARCHAR2': case 'VARCHAR':
      return n > 0 ? `character varying(${n})` : 'text';
    case 'CHAR': case 'NCHAR':
      return `character(${n > 0 ? n : 1})`;
    case 'CLOB': case 'NCLOB': case 'LONG': return 'text';
    case 'RAW': return n === 16 ? 'uuid' : 'bytea';
    case 'BLOB': case 'LONG RAW': case 'BFILE': return 'bytea';
    case 'DATE': return 'timestamp(0)';
    case 'TIMESTAMP': return s !== null && s !== undefined && s < 6 ? `timestamp(${s})` : 'timestamp';
    case 'TIMESTAMP WITH TIME ZONE': case 'TIMESTAMP WITH LOCAL TIME ZONE':
      return s !== null && s !== undefined && s < 6 ? `timestamp(${s}) with time zone` : 'timestamp with time zone';
    case 'INTERVAL YEAR TO MONTH': case 'INTERVAL DAY TO SECOND': return 'interval';
    case 'XMLTYPE': return 'xml';
    case 'JSON': return 'jsonb';
    case 'BOOLEAN': return 'boolean';
    case 'SDO_GEOMETRY': return 'geometry';
    default: return 'text'; // ROWID, UROWID, VECTOR, object types…
  }
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision)/;

/** An Oracle DATA_DEFAULT as a PostgreSQL expression for a column of `pgType`. */
export function oracleDefault(value, pgType = '') {
  let s = String(value ?? '').trim();
  while (/^\(.*\)$/s.test(s) && !/\)\s*\(/.test(s.slice(1, -1))) s = s.slice(1, -1).trim();
  if (!s || /^null$/i.test(s)) return '';
  const base = pgType.replace(/\(.*?\)/, '').trim();
  if (/^(sysdate|systimestamp|current_timestamp|current_date|localtimestamp)(\s*\(\s*\d*\s*\))?$/i.test(s)) return base === 'date' ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP';
  if (/^sys_guid\s*\(\s*\)$/i.test(s)) return base === 'uuid' ? 'gen_random_uuid()' : '';
  if (/^(user|sys_context\s*\(\s*'userenv'\s*,\s*'session_user'\s*\))$/i.test(s)) return 'CURRENT_USER';
  if (/^(true|false)$/i.test(s)) return base === 'boolean' ? s.toLowerCase() : '';
  const str = s.match(/^N?'((?:[^']|'')*)'$/i);
  if (str) {
    if (base === 'boolean') return /^(1|y|yes|t|true)$/i.test(str[1]) ? 'true' : /^(0|n|no|f|false)$/i.test(str[1]) ? 'false' : '';
    if (NUMERIC.test(base)) return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(str[1].trim()) ? str[1].trim() : '';
    return `'${str[1]}'`;
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) {
    if (base === 'boolean') return Number(s) === 0 ? 'false' : 'true';
    return NUMERIC.test(base) ? s.replace(/^\+/, '') : quote(s);
  }
  return ''; // a sequence's NEXTVAL, a function call…
}

/**
 * Table specs for a catalog. Options: schema (for the imported Oracle
 * schema), snakeCase (convert names: CUSTOMER_ID -> customer_id). Each spec
 * carries `source` for "Copy rows":
 * { kind: 'oracle', schema, table, columns: [{ name, type }] }.
 */
export function oracleSpecs(catalog, options = {}) {
  const target = options.schema || 'public';
  const snake = options.snakeCase !== false;
  const mapSchema = (s) => (s ? (snake ? snakeCase(s) : s) : target);
  const tables = (catalog?.tables ?? []).map((t) => {
    const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
    const unique = new Set(t.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    if (t.primaryKey.length === 1) unique.delete(t.primaryKey[0]);
    const columns = t.columns.map((c) => {
      let type = oracleType(c);
      if (c.identity && !fkCols.has(c.name)) type = SERIAL[type] ?? (/^numeric\(\d+,0\)$/.test(type) ? 'bigserial' : type);
      return {
        name: c.name,
        type,
        nullable: !!c.nullable && !t.primaryKey.includes(c.name),
        unique: unique.has(c.name),
        default: c.identity || c.virtual ? '' : oracleDefault(c.default, type),
        description: c.description ?? '',
      };
    });
    const foreignKeys = t.foreignKeys.map((f) => ({
      columns: f.columns,
      references: { schema: mapSchema(f.refSchema), table: f.refTable, columns: f.refColumns ?? [] },
    }));
    return { name: t.name, schema: target, description: t.description ?? '', columns, primaryKey: t.primaryKey, foreignKeys };
  });
  alignForeignKeyTypes(tables, target);
  return parseJsonModel({ tables }, { schema: target, snakeCase: snake }).map((spec, k) => {
    const t = catalog.tables[k];
    return { ...spec, sheet: 'Oracle', source: { kind: 'oracle', schema: catalog.owner ?? null, table: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) } };
  });
}
