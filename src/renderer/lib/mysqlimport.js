// Table specs from a MySQL or MariaDB schema, read either from a live server
// (src/main/database/mysql.cjs) or from a dump (src/shared/mysql-dump.js);
// both give the catalog described at the top of mysql-dump.js.
//
// The specs are the ones the other imports produce, so the same dialog adds
// them to the diagram:
//  - types become their PostgreSQL equivalents (tinyint(1) -> boolean,
//    int unsigned -> bigint, datetime -> timestamp, timestamp -> timestamp
//    with time zone, enum / set -> text, blob -> bytea, json -> jsonb…)
//  - an AUTO_INCREMENT integer column becomes serial / bigserial / smallserial
//  - primary keys, NOT NULL, single-column unique keys (not prefix ones),
//    foreign keys and comments are kept; defaults are translated
//    (CURRENT_TIMESTAMP, now() -> CURRENT_TIMESTAMP, uuid() ->
//    gen_random_uuid(), '1' -> true on a boolean) and dropped when they call a
//    function PostgreSQL does not have
//  - the database being imported goes to the schema chosen in the dialog;
//    tables of another database (a multi-database dump, a foreign key to
//    another database) go to a schema named after it

import { snakeCase } from './spreadsheet.js';
import { parseJsonModel } from './efimport.js';
import { alignForeignKeyTypes } from './fktypes.js';

export const MYSQL_DUMP_EXT = /\.sql$/i;

const SERIAL = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };
const SPATIAL = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);

/** PostgreSQL type for a MySQL catalog column. */
export function mysqlType(col = {}) {
  const t = String(col.type ?? '').toLowerCase();
  const u = !!col.unsigned;
  const sized = (pg, n) => (Number(n) > 0 ? `${pg}(${Number(n)})` : pg);
  if (SPATIAL.has(t)) return 'geometry';
  switch (t) {
    case 'tinyint': return Number(col.length) === 1 ? 'boolean' : 'smallint';
    case 'bool': case 'boolean': return 'boolean';
    case 'smallint': return u ? 'integer' : 'smallint';
    case 'mediumint': return 'integer';
    case 'int': case 'integer': return u ? 'bigint' : 'integer';
    case 'bigint': return u ? 'numeric(20,0)' : 'bigint';
    case 'decimal': case 'numeric': case 'dec': case 'fixed':
      return col.precision ? `numeric(${col.precision},${col.scale ?? 0})` : 'numeric(10,0)';
    case 'float': return col.precision > 24 ? 'double precision' : 'real';
    case 'double': case 'real': return 'double precision';
    case 'bit': return Number(col.length ?? 1) <= 1 ? 'boolean' : `bit(${Number(col.length)})`;
    case 'char': return sized('character', col.length ?? 1);
    case 'varchar': return sized('character varying', col.length);
    case 'tinytext': case 'text': case 'mediumtext': case 'longtext': case 'enum': case 'set': return 'text';
    case 'binary': case 'varbinary': case 'tinyblob': case 'blob': case 'mediumblob': case 'longblob': return 'bytea';
    case 'date': return 'date';
    case 'datetime': return col.scale !== null && col.scale !== undefined && col.scale < 6 ? `timestamp(${col.scale})` : 'timestamp';
    case 'timestamp': return col.scale !== null && col.scale !== undefined && col.scale < 6 ? `timestamp(${col.scale}) with time zone` : 'timestamp with time zone';
    case 'time': return col.scale !== null && col.scale !== undefined && col.scale < 6 ? `time(${col.scale})` : 'time';
    case 'year': return 'smallint';
    case 'json': return 'jsonb';
    case 'uuid': return 'uuid';
    case 'inet4': case 'inet6': return 'inet';
    default: return 'text';
  }
}

const NOW = /^(current_timestamp|now|localtime|localtimestamp|sysdate|utc_timestamp)(\s*\(\s*\d*\s*\))?$/i;
const TODAY = /^(curdate|current_date|utc_date)(\s*\(\s*\))?$/i;
const CLOCK = /^(curtime|current_time|utc_time)(\s*\(\s*\d*\s*\))?$/i;

const unwrap = (s) => {
  let t = String(s).trim();
  while (/^\(.*\)$/s.test(t)) {
    let depth = 0;
    let whole = true;
    for (let k = 0; k < t.length - 1; k++) {
      if (t[k] === '(') depth++;
      else if (t[k] === ')' && --depth === 0) {
        whole = false;
        break;
      }
    }
    if (!whole) break;
    t = t.slice(1, -1).trim();
  }
  return t;
};
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NUMERIC = /^(smallint|integer|bigint|numeric|real|double precision|serial|bigserial|smallserial)/;

/** A catalog default ({ literal } / { expr } / null) as a PostgreSQL expression for a column of `pgType`. */
export function mysqlDefault(def, pgType = '') {
  if (!def) return '';
  const base = pgType.replace(/\(.*?\)/, '').trim();
  if ('literal' in def) {
    const v = String(def.literal);
    if (base === 'boolean') return /^(1|true|b'1')$/i.test(v) ? 'true' : /^(0|false|b'0')$/i.test(v) ? 'false' : '';
    if (NUMERIC.test(base)) return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim()) ? v.trim().replace(/^\+/, '') : '';
    if (/^(timestamp|date|time)/.test(base) && /^0000-00-00/.test(v)) return '';
    if (base === 'bytea') return '';
    if (base === 'jsonb') return `${quote(v)}::jsonb`;
    return quote(v);
  }
  const s = unwrap(def.expr ?? '');
  if (!s || /^null$/i.test(s)) return '';
  if (NOW.test(s)) return base === 'date' ? 'CURRENT_DATE' : base.startsWith('time') && !base.startsWith('timestamp') ? 'CURRENT_TIME' : 'CURRENT_TIMESTAMP';
  if (TODAY.test(s)) return 'CURRENT_DATE';
  if (CLOCK.test(s)) return 'CURRENT_TIME';
  if (/^uuid\s*\(\s*\)$/i.test(s)) return 'gen_random_uuid()';
  if (/^(true|false)$/i.test(s)) return base === 'boolean' ? s.toLowerCase() : s.toLowerCase() === 'true' ? '1' : '0';
  const bits = s.match(/^b'([01]*)'$/i) ?? s.match(/^0b([01]+)$/);
  if (bits) return base === 'boolean' ? (/1/.test(bits[1]) ? 'true' : 'false') : base.startsWith('bit') ? `B'${bits[1]}'` : String(parseInt(bits[1] || '0', 2));
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) {
    if (base === 'boolean') return Number(s) === 0 ? 'false' : 'true';
    if (NUMERIC.test(base)) return s.replace(/^\+/, '');
    return quote(s);
  }
  const str = s.match(/^(?:_\w+\s*)?'((?:[^'\\]|''|\\.)*)'$/s);
  if (str) return mysqlDefault({ literal: str[1].replace(/''/g, "'").replace(/\\(.)/g, '$1') }, pgType);
  return '';
}

/**
 * Table specs for a catalog. Options: schema (for the imported database),
 * snakeCase (convert names). Each spec carries `source` for "Copy rows":
 * { kind: 'mysql', schema, table, columns: [{ name, type, spatial }] }.
 */
export function mysqlSpecs(catalog, options = {}) {
  const target = options.schema || 'public';
  const snake = options.snakeCase !== false;
  const mapSchema = (s) => (s ? (snake ? snakeCase(s) : s) : target);
  const tables = (catalog?.tables ?? []).map((t) => {
    const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns));
    const unique = new Set(t.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    if (t.primaryKey.length === 1) unique.delete(t.primaryKey[0]);
    const columns = t.columns.map((c) => {
      let type = mysqlType(c);
      if (c.autoIncrement && SERIAL[type] && !fkCols.has(c.name)) type = SERIAL[type];
      // bigint unsigned AUTO_INCREMENT: numbered by bigserial, which goes up to 2^63 - 1.
      if (c.autoIncrement && type === 'numeric(20,0)' && !fkCols.has(c.name)) type = 'bigserial';
      return {
        name: c.name,
        type,
        nullable: !!c.nullable && !t.primaryKey.includes(c.name),
        unique: unique.has(c.name),
        default: Object.values(SERIAL).includes(type) || c.generated ? '' : mysqlDefault(c.default, type),
        description: c.description ?? '',
      };
    });
    const foreignKeys = t.foreignKeys.map((f) => ({
      columns: f.columns,
      references: { schema: mapSchema(f.refSchema), table: f.refTable, columns: f.refColumns ?? [] },
    }));
    return { name: t.name, schema: mapSchema(t.schema), description: t.description ?? '', columns, primaryKey: t.primaryKey, foreignKeys };
  });
  alignForeignKeyTypes(tables, target);
  const specs = parseJsonModel({ tables }, { schema: target, snakeCase: snake });
  return specs.map((spec, k) => {
    const t = catalog.tables[k];
    return {
      ...spec,
      sheet: 'MySQL',
      source: { kind: 'mysql', schema: t.schema ?? null, table: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, spatial: SPATIAL.has(String(c.type).toLowerCase()), generated: !!c.generated })) },
    };
  });
}
