// The tables of a MySQL / MariaDB, SQL Server, Oracle or SQLite database (or
// of a MySQL dump) as worksheets of text cells, for the Import Designer: a
// database can then be the "example workbook", and each of its tables a
// source block on the canvas, mapped and transformed like an Excel sheet.
//
//   readSourceSheets({ kind, conn | filePath }) -> { name, sheets: [{ name, hidden, rows }], truncated }
//
// The first row of a sheet holds the column names. Values become the text a
// worksheet cell would hold: numbers and dates as written by the database,
// booleans as true / false, binary values as \x hex (PostgreSQL's bytea input),
// NULL as an empty cell. Sheets are named after their tables (schema.table
// when not the default one); rows are read up to a limit, as the designer
// keeps them in the page.

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sharedDir } = require('../shared.cjs');
const { openSource } = require('./data-copy.cjs');

const MAX_ROWS = 100000; // per table
const MAX_CELLS = 5000000; // in all
const MAX_DUMP_FILE = 1024 * 1024 * 1024;
const SPATIAL = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection']);

/** The text of a cell for a value read from a database. */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}`;
  if (typeof v === 'object' && typeof v.bits === 'string') return v.bits;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Tables of the source as { label, source: { schema, table, columns } } for the readers of data-copy.cjs.
async function tablesOf(src) {
  switch (src.kind) {
    case 'mysql': {
      const { readMysqlCatalog } = require('./mysql.cjs');
      const { catalog, database } = await readMysqlCatalog(src.conn);
      return {
        name: `${src.conn.host || 'localhost'}/${database}`,
        tables: catalog.tables.map((t) => ({ label: t.name, source: { schema: null, table: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, spatial: SPATIAL.has(c.type) })) } })),
      };
    }
    case 'mssql': {
      const { readMssqlCatalog } = require('./mssql.cjs');
      const { catalog, database } = await readMssqlCatalog(src.conn);
      return {
        name: `${src.conn.server || 'localhost'}/${database}`,
        tables: catalog.tables.map((t) => ({ label: t.schema === 'dbo' ? t.name : `${t.schema}.${t.name}`, source: { schema: t.schema, table: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) } })),
      };
    }
    case 'oracle': {
      const { readOracleCatalog } = require('./oracle.cjs');
      const { catalog, owner } = await readOracleCatalog(src.conn);
      return {
        name: `${src.conn.host || 'localhost'}/${src.conn.service || ''}: ${owner}`,
        tables: catalog.tables.map((t) => ({ label: t.name, source: { schema: owner, table: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) } })),
      };
    }
    case 'sqlite': {
      const { readSqliteCatalog } = require('./sqlite.cjs');
      const catalog = readSqliteCatalog(String(src.filePath));
      return {
        name: path.basename(String(src.filePath)),
        tables: catalog.tables.map((t) => ({ label: t.name, source: { schema: null, table: t.name, columns: t.columns.filter((c) => c.hidden !== 1).map((c) => ({ name: c.name, type: String(c.type ?? '') })) } })),
      };
    }
    default:
      throw new Error(`Cannot read tables from ${src.kind}.`);
  }
}

// A dump's tables and the rows of its INSERTs.
async function dumpSheets(filePath) {
  if ((await fs.stat(filePath)).size > MAX_DUMP_FILE) throw new Error('The dump is too large to read (over 1 GB).');
  const data = await fs.readFile(filePath);
  const text = data[0] === 0xff && data[1] === 0xfe ? data.subarray(2).toString('utf16le') : data.toString('utf8').replace(/^﻿/, '');
  const { parseDump, dumpInserts } = await import(pathToFileURL(path.join(sharedDir, 'mysql-dump.js')).href);
  const { tables } = parseDump(text);
  const key = (schema, table) => `${schema ?? ''}.${table}`.toLowerCase();
  const sheets = tables.map((t) => ({ name: t.schema ? `${t.schema}.${t.name}` : t.name, hidden: false, rows: [t.columns.map((c) => c.name)], table: t }));
  const byKey = new Map(sheets.map((s) => [key(s.table.schema, s.table.name), s]));
  const byName = new Map(sheets.map((s) => [String(s.table.name).toLowerCase(), s]));
  let truncated = false;
  for (const ins of dumpInserts(text)) {
    const sheet = byKey.get(key(ins.schema, ins.table)) ?? byName.get(String(ins.table).toLowerCase());
    if (!sheet) continue;
    const names = sheet.table.columns.map((c) => c.name.toLowerCase());
    const stored = sheet.table.columns.map((c, k) => (c.generated ? -1 : k)).filter((k) => k >= 0);
    for (const row of ins.rows) {
      if (sheet.rows.length > MAX_ROWS) {
        truncated = true;
        break;
      }
      const out = new Array(names.length).fill('');
      const at = ins.columns ? ins.columns.map((c) => names.indexOf(String(c).toLowerCase())) : row.length === names.length ? names.map((_, k) => k) : stored;
      row.forEach((v, k) => at[k] >= 0 && (out[at[k]] = cellText(v)));
      sheet.rows.push(out);
    }
  }
  return { name: path.basename(filePath), sheets: sheets.map(({ table, ...s }) => s), truncated };
}

async function readSourceSheets(src) {
  if (src?.kind === 'mysql-dump') return dumpSheets(String(src.filePath));
  const { name, tables } = await tablesOf(src);
  const reader = await openSource(src);
  let cells = 0;
  let truncated = false;
  const sheets = [];
  try {
    for (const t of tables) {
      const rows = [t.source.columns.map((c) => c.name)];
      // One row more than kept tells whether the table had more.
      const fit = Math.min(MAX_ROWS, Math.floor((MAX_CELLS - cells) / Math.max(1, t.source.columns.length)));
      if (fit > 0) {
        for await (const row of reader.rows({ ...t, limit: fit + 1 })) {
          if (rows.length > fit) {
            truncated = true;
            continue; // the stream is read to its end, a row at most
          }
          rows.push(row.map(cellText));
          cells += row.length;
        }
      } else truncated = true;
      sheets.push({ name: t.label, hidden: false, rows });
    }
  } finally {
    try {
      await reader.close();
    } catch {}
  }
  return { name, sheets, truncated };
}

module.exports = { readSourceSheets, cellText, MAX_ROWS };
