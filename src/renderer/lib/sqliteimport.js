// Table specs from the catalog of a SQLite database, as read by
// src/main/database/sqlite.cjs ({ tables: [{ name, sql, columns, foreignKeys,
// indexes }] }, the rows of SQLite's table_xinfo, foreign_key_list and
// index_list pragmas).
//
// The specs are the ones the Excel and Entity Framework imports produce, so
// the same dialog adds them to the diagram:
//  - declared types become PostgreSQL types; a type PostgreSQL does not have
//    is replaced by the one for its SQLite affinity, and a column without a
//    type becomes text
//  - an INTEGER PRIMARY KEY (the rowid) becomes serial
//  - primary keys, NOT NULL, single-column UNIQUE constraints and indexes,
//    and foreign keys are kept; defaults are translated where SQLite and
//    PostgreSQL spell them differently and dropped when they call a function
//    PostgreSQL does not have
//  - views, virtual tables and SQLite's own tables are skipped

import { normalizeType, isKnownType } from './spreadsheet.js';
import { parseJsonModel } from './efimport.js';

export const SQLITE_EXT = /\.(db|sqlite|sqlite3|db3|s3db|sl3)$/i;

/** PostgreSQL type for a type declared in SQLite ('' when there is none). */
export function sqliteType(declared) {
  const raw = String(declared ?? '').trim();
  if (!raw) return 'text';
  if (/^real$/i.test(raw)) return 'double precision'; // SQLite's REAL is an 8-byte float
  if (isKnownType(raw)) return raw;
  // SQLite's affinity rules (https://www.sqlite.org/datatype3.html, 3.1).
  const s = raw.toLowerCase();
  if (s.includes('int')) return /big|int8|long/.test(s) ? 'bigint' : 'integer';
  if (/char|clob|text/.test(s)) return 'text';
  if (s.includes('blob')) return 'bytea';
  if (/real|floa|doub/.test(s)) return 'double precision';
  return 'numeric';
}

// Remove the parentheses around a whole expression: "(1 + 2)" -> "1 + 2".
function unwrap(expr) {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "'") {
        i = s.indexOf("'", i + 1);
        if (i < 0) return s;
      } else if (s[i] === '(') depth++;
      else if (s[i] === ')' && --depth === 0) {
        closesAtEnd = false;
        break;
      }
    }
    if (!closesAtEnd) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const NOW = /^(datetime|date|time)\s*\(\s*'now'\s*(?:,\s*'(?:localtime|utc)'\s*)?\)$/i;
const NOW_SQL = { datetime: 'CURRENT_TIMESTAMP', date: 'CURRENT_DATE', time: 'CURRENT_TIME' };
const SQLITE_ONLY = /\b(strftime|julianday|unixepoch|datetime|randomblob|zeroblob|hex|unhex|ifnull|last_insert_rowid|typeof|printf|json|jsonb)\s*\(/i;

/** A SQLite column default as a PostgreSQL expression ('' for none). */
export function sqliteDefault(value, type = '') {
  if (value === null || value === undefined) return '';
  const s = unwrap(String(value));
  if (!s || /^null$/i.test(s)) return '';
  const now = s.match(NOW);
  if (now) return NOW_SQL[now[1].toLowerCase()];
  if (/^current_(timestamp|date|time)$/i.test(s)) return s.toUpperCase();
  // SQLite accepts a double-quoted string where PostgreSQL wants an identifier.
  if (/^"[^"]*"$/.test(s)) return `'${s.slice(1, -1).replace(/'/g, "''")}'`;
  if (type === 'boolean' && /^[01]$/.test(s)) return s === '1' ? 'true' : 'false';
  if (/^x'[0-9a-f]*'$/i.test(s)) return type === 'bytea' ? `'\\x${s.slice(2, -1)}'` : '';
  if (SQLITE_ONLY.test(s)) return '';
  return s;
}

/** Table specs for a catalog. Options: schema, snakeCase (convert names). */
export function sqliteSpecs(catalog, options = {}) {
  const tables = (catalog?.tables ?? []).map((t) => {
    const cols = t.columns.filter((c) => c.hidden !== 1); // hidden columns of virtual tables
    const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const fkCols = new Set(t.foreignKeys.map((f) => f.from));
    const unique = new Set(
      t.indexes.filter((ix) => ix.unique && !ix.partial && ix.origin !== 'pk' && ix.columns.length === 1 && ix.columns[0]).map((ix) => ix.columns[0])
    );
    const withoutRowid = /\bwithout\s+rowid\b/i.test(t.sql.slice(t.sql.lastIndexOf(')') + 1));
    const columns = cols.map((c) => {
      let type = sqliteType(c.type);
      // An INTEGER PRIMARY KEY is the rowid: SQLite numbers the rows itself.
      const rowid = !withoutRowid && pk.length === 1 && pk[0] === c.name && /^integer$/i.test(String(c.type).trim());
      if (rowid && !fkCols.has(c.name)) type = 'serial';
      return {
        name: c.name,
        type,
        notNull: !!c.notnull,
        unique: unique.has(c.name),
        default: type === 'serial' ? '' : sqliteDefault(c.dflt_value, normalizeType(type).type),
      };
    });
    const groups = new Map();
    for (const f of t.foreignKeys) {
      if (!groups.has(f.id)) groups.set(f.id, []);
      groups.get(f.id).push(f);
    }
    const foreignKeys = [...groups.values()].map((rows) => {
      rows.sort((a, b) => a.seq - b.seq);
      const to = rows.map((f) => f.to);
      return { columns: rows.map((f) => f.from), references: { table: rows[0].table, columns: to.every(Boolean) ? to : [] } };
    });
    return { name: t.name, columns, primaryKey: pk, foreignKeys };
  });
  return parseJsonModel({ tables }, options).map((spec) => ({ ...spec, sheet: 'SQLite' }));
}
