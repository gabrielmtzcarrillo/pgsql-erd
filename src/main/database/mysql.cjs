// Reads the schema of a MySQL or MariaDB database for "Import from MySQL /
// MariaDB", and opens the connections "Copy rows" reads from.
//
// Only information_schema is queried. The result has the catalog shape
// described at the top of src/shared/mysql-dump.js, the same one the dump
// reader produces; tables of the chosen database have schema null.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sharedDir } = require('../shared.cjs');

const loadDump = () => import(pathToFileURL(path.join(sharedDir, 'mysql-dump.js')).href);

/**
 * Connection settings of the import dialog as a mysql2 configuration:
 * { host, port, database, user, password, ssl ('disable' | 'require' | 'verify') }.
 * Dates and large numbers are read as text, JSON as its text and the session
 * runs in UTC, so values reach PostgreSQL unchanged.
 */
function mysqlConfig(conn = {}) {
  const port = parseInt(conn.port, 10);
  const ssl = conn.ssl === 'require' ? { rejectUnauthorized: false } : conn.ssl === 'verify' ? { rejectUnauthorized: true } : undefined;
  return {
    host: String(conn.host || 'localhost').trim(),
    port: Number.isFinite(port) ? port : 3306,
    user: conn.user || 'root',
    password: conn.password || '',
    database: String(conn.database || '').trim() || undefined,
    ssl,
    connectTimeout: 15000,
    charset: 'UTF8MB4_UNICODE_CI',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    typeCast: (field, next) => (field.type === 'JSON' ? field.string('utf8') : next()),
  };
}

/** An open mysql2 (promise) connection in UTC. */
async function mysqlConnection(conn) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection(mysqlConfig(conn));
  await connection.query("SET time_zone = '+00:00'");
  return connection;
}

// A COLUMN_DEFAULT as the catalog keeps it. MySQL stores literals bare and
// marks expressions with DEFAULT_GENERATED (8.0.13+); MariaDB quotes literals
// and writes NULL for none.
function columnDefault(raw, extra, mariadb) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (mariadb) {
    if (s === 'NULL') return null;
    if (/^'.*'$/s.test(s)) return { literal: s.slice(1, -1).replace(/''/g, "'").replace(/\\(.)/g, '$1') };
    return { expr: s };
  }
  if (/DEFAULT_GENERATED/i.test(extra) || /^current_timestamp(\(\d*\))?$/i.test(s)) return { expr: s };
  return { literal: s };
}

const TABLES = `
SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
ORDER BY TABLE_NAME`;

const COLUMNS = `
SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_DEFAULT AS dflt, IS_NULLABLE AS nullable,
       COLUMN_TYPE AS column_type, EXTRA AS extra, COLUMN_COMMENT AS comment
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, ORDINAL_POSITION`;

const KEYS = `
SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SUB_PART AS sub_part
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

// MariaDB's JSON is LONGTEXT with a json_valid() check; the check tells them apart.
const JSON_CHECKS = `
SELECT TABLE_NAME AS table_name, CHECK_CLAUSE AS clause
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = ? AND CHECK_CLAUSE LIKE '%json_valid%'`;

const FOREIGN_KEYS = `
SELECT TABLE_NAME AS table_name, CONSTRAINT_NAME AS name, COLUMN_NAME AS column_name,
       REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`;

/** The catalog of the result sets of the queries above. */
function catalogFromRows({ database, mariadb, tables, columns, keys, foreignKeys, jsonChecks = [] }, parseColumnType) {
  const byName = new Map();
  const out = tables.map((t) => {
    const table = { schema: null, name: t.name, description: t.comment ?? '', columns: [], primaryKey: [], uniques: [], foreignKeys: [] };
    byName.set(t.name, table);
    return table;
  });
  for (const c of columns) {
    const t = byName.get(c.table_name);
    if (!t) continue;
    const extra = String(c.extra ?? '');
    t.columns.push({
      name: c.name,
      ...parseColumnType(String(c.column_type)).col,
      nullable: c.nullable === 'YES',
      autoIncrement: /auto_increment/i.test(extra),
      generated: /\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(extra),
      default: columnDefault(c.dflt, extra, mariadb),
      description: c.comment ?? '',
    });
  }
  for (const chk of jsonChecks) {
    const m = String(chk.clause).match(/^\s*json_valid\s*\(\s*`?([^`)]+)`?\s*\)\s*$/i);
    const col = m && byName.get(chk.table_name)?.columns.find((c) => c.name === m[1]);
    if (col && /text$/.test(col.type)) col.type = 'json';
  }
  const indexes = new Map();
  for (const k of keys) {
    const id = `${k.table_name}\u0000${k.index_name}`;
    if (!indexes.has(id)) indexes.set(id, []);
    indexes.get(id).push(k);
  }
  for (const rows of indexes.values()) {
    const t = byName.get(rows[0].table_name);
    if (!t) continue;
    const cols = rows.map((r) => r.column_name);
    if (rows[0].index_name === 'PRIMARY') t.primaryKey = cols;
    else if (Number(rows[0].non_unique) === 0 && rows.every((r) => r.column_name && r.sub_part === null)) t.uniques.push(cols);
  }
  const fks = new Map();
  for (const f of foreignKeys) {
    const id = `${f.table_name}\u0000${f.name}`;
    if (!fks.has(id)) fks.set(id, []);
    fks.get(id).push(f);
  }
  for (const rows of fks.values()) {
    const t = byName.get(rows[0].table_name);
    if (!t) continue;
    t.foreignKeys.push({
      columns: rows.map((r) => r.column_name),
      refSchema: rows[0].ref_schema === database ? null : rows[0].ref_schema,
      refTable: rows[0].ref_table,
      refColumns: rows.map((r) => r.ref_column),
    });
  }
  return { tables: out };
}

/** { server, database, version, catalog } for the database of `conn`. */
async function readMysqlCatalog(conn) {
  if (!String(conn?.database ?? '').trim()) throw new Error('Choose the database to read.');
  const { parseColumnType } = await loadDump();
  const connection = await mysqlConnection(conn);
  try {
    const q = async (sql, args = []) => (await connection.query(sql, args))[0];
    const [info] = await q('SELECT DATABASE() AS db, VERSION() AS version');
    const database = info.db;
    const mariadb = /mariadb/i.test(info.version);
    const catalog = catalogFromRows(
      {
        database,
        mariadb,
        tables: await q(TABLES, [database]),
        columns: await q(COLUMNS, [database]),
        keys: await q(KEYS, [database]),
        foreignKeys: await q(FOREIGN_KEYS, [database]),
        jsonChecks: mariadb ? await q(JSON_CHECKS, [database]).catch(() => []) : [],
      },
      parseColumnType
    );
    return { server: `${conn.host || 'localhost'}`, database, version: info.version, mariadb, catalog };
  } finally {
    await connection.end();
  }
}

/** The schema of a dump file: { catalog, databases }. Rows are read later, by "Copy rows". */
async function readMysqlDump(text) {
  const { parseDump } = await loadDump();
  const { tables, databases } = parseDump(text);
  return { catalog: { tables }, databases };
}

module.exports = { readMysqlCatalog, readMysqlDump, mysqlConfig, mysqlConnection, catalogFromRows, columnDefault };
