// "Copy rows": copies the rows of imported tables from their source (MySQL /
// MariaDB, SQL Server, Oracle, SQLite or a MySQL dump) into the connected PostgreSQL
// database, in one transaction:
//
//   1. create the tables that are missing (the import dialog's SQL without
//      foreign keys), and empty them first when asked
//   2. read the rows of each table from the source and INSERT them in batches,
//      every value converted for its PostgreSQL column and sent as a parameter
//   3. add the foreign keys, then move each serial column's sequence past the
//      copied keys
//
// Any error, or a stop, rolls everything back. A copy is a snapshot, not a
// running replication.
//
// A request: {
//   source: { kind: 'mysql' | 'mssql' | 'oracle', conn } | { kind: 'sqlite' | 'mysql-dump', filePath },
//   tables: [{ target: { schema, name }, columns: [{ name, type }],
//              source: { schema, table, columns: [{ name, type, spatial, generated }] } }],
//   createSql, foreignKeySql, truncate }
// `columns` and `source.columns` are parallel: the n-th source column fills
// the n-th target column. Tables are copied in the order given.

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sharedDir } = require('../shared.cjs');

const MAX_DUMP_FILE = 1024 * 1024 * 1024; // what fits in one string
const MAX_PARAMS = 65000; // PostgreSQL takes at most 65535 parameters per statement
const BATCH_ROWS = 500;

const qid = (s) => `"${String(s).replace(/"/g, '""')}"`;
const qualified = (t) => `${t.schema ? `${qid(t.schema)}.` : ''}${qid(t.name)}`;

// ------------------------------------------------------------ values

const baseType = (type) =>
  String(type ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const INTEGER = /^(smallint|integer|int|bigint|int2|int4|int8|serial|bigserial|smallserial)$/;
const NUMBER = /^(numeric|decimal|real|double precision|float4|float8|money)$/;
const HAS_OFFSET = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;
const HAS_CLOCK = /\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function bytesToBits(bytes, width) {
  let s = '';
  for (const b of bytes) s += b.toString(2).padStart(8, '0');
  return width ? s.slice(-width).padStart(width, '0') : s;
}

/** A value read from a source, ready to be a parameter for a column of PostgreSQL type `type`. */
function convertValue(v, type) {
  if (v === null || v === undefined) return null;
  const base = baseType(type);
  const width = Number(String(type).match(/^bit\s*\((\d+)\)/i)?.[1] ?? 0) || null;
  if (typeof v === 'bigint') v = v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object' && !(v instanceof Uint8Array) && typeof v.bits === 'string') {
    if (base === 'boolean') return /1/.test(v.bits);
    if (base === 'bit' || base === 'bit varying') return width ? v.bits.slice(-width).padStart(width, '0') : v.bits;
    return BigInt(`0b${v.bits || '0'}`).toString();
  }
  if (v instanceof Uint8Array) {
    if (base === 'uuid' && v.length === 16) {
      const hex = Buffer.from(v).toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    if (base === 'bytea') return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (base === 'boolean') return v.some((b) => b !== 0);
    if (base === 'bit' || base === 'bit varying') return bytesToBits(v, width);
    if (INTEGER.test(base) || NUMBER.test(base)) return v.length ? BigInt(`0x${Buffer.from(v).toString('hex')}`).toString() : '0';
    v = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
  }
  if (typeof v === 'object') {
    if (base === 'json' || base === 'jsonb') return JSON.stringify(v);
    v = JSON.stringify(v);
  }
  if (typeof v === 'boolean') {
    if (base === 'boolean') return v;
    if (INTEGER.test(base) || NUMBER.test(base)) return v ? 1 : 0;
    return String(v);
  }
  if (base === 'boolean') {
    const s = String(v).trim();
    if (/^(1|t|true|y|yes|on)$/i.test(s)) return true;
    if (/^(0|f|false|n|no|off)?$/i.test(s)) return false;
    return Number(s) !== 0;
  }
  if (base === 'bytea') return Buffer.from(String(v), 'utf8');
  if (/^(timestamp|date|time)/.test(base)) {
    if (typeof v === 'number') {
      // Unix time (seconds, or milliseconds when that large), as SQLite apps store it.
      const d = new Date(Math.abs(v) < 1e11 ? v * 1000 : v);
      if (Number.isNaN(d.getTime())) return null;
      return base === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
    }
    const s = String(v).trim();
    // MySQL's "zero" dates have no PostgreSQL equivalent.
    if (/^0000-00-00/.test(s)) return null;
    // MySQL TIMESTAMP values are read in UTC; a time zone column needs that said.
    if (base.startsWith('timestamp with time zone') && HAS_CLOCK.test(s) && !HAS_OFFSET.test(s)) return `${s}+00`;
    return s;
  }
  if (base === 'json' || base === 'jsonb') {
    const s = String(v).replace(/\u0000/g, '');
    try {
      JSON.parse(s);
      return s;
    } catch {
      return JSON.stringify(s); // not JSON: kept as a JSON string
    }
  }
  if (typeof v === 'number') return INTEGER.test(base) || NUMBER.test(base) ? v : String(v);
  // PostgreSQL text cannot hold NUL characters.
  return String(v).replace(/\u0000/g, '');
}

// ------------------------------------------------------------ sources

const msq = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const myq = (s) => `\`${String(s).replace(/`/g, '``')}\``;

// SELECT expressions that read SQL Server values exactly: temporal types as
// text (no time zone shifts), decimals as text (no float rounding).
function mssqlExpr(col) {
  const c = msq(col.name);
  switch (String(col.type).toLowerCase()) {
    case 'datetime': case 'datetime2': case 'smalldatetime': case 'date':
      return `CONVERT(varchar(33), ${c}, 121)`;
    case 'time': case 'datetimeoffset':
      return `CAST(${c} AS varchar(40))`;
    case 'decimal': case 'numeric':
      return `CONVERT(varchar(50), ${c})`;
    case 'money': case 'smallmoney':
      return `CONVERT(varchar(50), ${c}, 2)`; // style 2 keeps all four decimals
    case 'geography': case 'geometry':
      return `${c}.STAsText()`;
    case 'hierarchyid':
      return `${c}.ToString()`;
    case 'sql_variant':
      return `CAST(${c} AS nvarchar(4000))`;
    default:
      return c;
  }
}

async function openMssql(conn) {
  const sql = require('mssql');
  const { mssqlConfig } = require('./mssql.cjs');
  const pool = new sql.ConnectionPool({ ...mssqlConfig(conn), requestTimeout: 0 });
  await pool.connect();
  return {
    async *rows(t) {
      const list = t.source.columns.map((c, k) => `${mssqlExpr(c)} AS ${msq(`c${k}`)}`).join(', ');
      const request = pool.request();
      const stream = request.toReadableStream({ highWaterMark: 1000 });
      request.query(`SELECT ${t.limit ? `TOP (${Number(t.limit)}) ` : ''}${list} FROM ${msq(t.source.schema || 'dbo')}.${msq(t.source.table)}`);
      const n = t.source.columns.length;
      for await (const row of stream) {
        const out = new Array(n);
        for (let k = 0; k < n; k++) out[k] = row[`c${k}`];
        yield out;
      }
    },
    close: () => pool.close(),
  };
}

async function openMysql(conn) {
  const { mysqlConnection } = require('./mysql.cjs');
  const connection = await mysqlConnection(conn);
  const core = connection.connection;
  return {
    async *rows(t) {
      const list = t.source.columns.map((c) => (c.spatial ? `ST_AsText(${myq(c.name)})` : myq(c.name))).join(', ');
      const from = `${myq(t.source.schema || conn.database)}.${myq(t.source.table)}`;
      const limit = t.limit ? ` LIMIT ${Number(t.limit)}` : '';
      const stream = core.query({ sql: `SELECT ${list} FROM ${from}${limit}`, rowsAsArray: true }).stream({ highWaterMark: 1000 });
      for await (const row of stream) yield row;
    },
    close: () => connection.end(),
  };
}

// SELECT expressions that read Oracle values as text PostgreSQL understands.
const orq = (s) => `"${String(s).replace(/"/g, '""')}"`;
function oracleExpr(col) {
  const c = orq(col.name);
  const t = String(col.type).toUpperCase();
  if (t === 'XMLTYPE') return `XMLSERIALIZE(CONTENT ${c} AS CLOB)`;
  if (t === 'JSON') return `JSON_SERIALIZE(${c} RETURNING CLOB)`;
  if (t === 'SDO_GEOMETRY') return `SDO_UTIL.TO_WKTGEOMETRY(${c})`;
  if (t === 'ROWID' || t === 'UROWID') return `CAST(${c} AS VARCHAR2(4000))`;
  if (t.startsWith('INTERVAL')) return `TO_CHAR(${c})`;
  // Thin mode turns dates into JavaScript Dates (local time); text keeps the wall-clock value.
  if (t === 'DATE') return `TO_CHAR(${c}, 'YYYY-MM-DD HH24:MI:SS')`;
  if (/^TIMESTAMP(\(\d+\))? WITH LOCAL TIME ZONE$/.test(t)) return `TO_CHAR(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM')`;
  if (/^TIMESTAMP(\(\d+\))? WITH TIME ZONE$/.test(t)) return `TO_CHAR(${c}, 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM')`;
  if (/^TIMESTAMP/.test(t)) return `TO_CHAR(${c}, 'YYYY-MM-DD HH24:MI:SS.FF6')`;
  if (t === 'BFILE') return 'NULL';
  return c;
}

async function openOracle(conn) {
  const { oracleConnection, fetchTypeHandler } = require('./oracle.cjs');
  const connection = await oracleConnection(conn);
  return {
    async *rows(t) {
      const list = t.source.columns.map(oracleExpr).join(', ');
      const from = `${t.source.schema ? `${orq(t.source.schema)}.` : ''}${orq(t.source.table)}`;
      const limit = t.limit ? ` FETCH FIRST ${Number(t.limit)} ROWS ONLY` : '';
      const stream = connection.queryStream(`SELECT ${list} FROM ${from}${limit}`, [], { fetchTypeHandler, fetchArraySize: 1000 });
      try {
        for await (const row of stream) yield row;
      } finally {
        stream.destroy();
      }
    },
    close: () => connection.close(),
  };
}

function openSqlite(filePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath, { readOnly: true });
  return {
    *rows(t) {
      const list = t.source.columns.map((c) => qid(c.name)).join(', ');
      const stmt = db.prepare(`SELECT ${list} FROM ${qid(t.source.table)}${t.limit ? ` LIMIT ${Number(t.limit)}` : ''}`);
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      for (const row of stmt.iterate()) {
        // Integers that fit stay numbers; the larger ones keep every digit as text.
        yield row.map((v) => (typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v));
      }
    },
    close: () => db.close(),
  };
}

// A table's `limit`, when set, reads only that many rows (the Import Designer's sheets).
// Chunks of rows: { table (index), columns (source column indexes), rows }.
async function* tableChunks(source, tables, size) {
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    const columns = t.source.columns.map((_, k) => k);
    let rows = [];
    for await (const row of source.rows(t)) {
      rows.push(row);
      if (rows.length >= size(ti, columns.length)) {
        yield { table: ti, columns, rows };
        rows = [];
      }
    }
    yield { table: ti, columns, rows, last: true };
  }
}

// Chunks from the INSERT statements of a dump, in the dump's order.
async function* dumpChunks(filePath, tables, size) {
  const { size: bytes } = await fs.stat(filePath);
  if (bytes > MAX_DUMP_FILE) throw new Error('The dump is too large to read (over 1 GB). Copy from the live server instead.');
  const data = await fs.readFile(filePath);
  const text = data[0] === 0xff && data[1] === 0xfe ? data.subarray(2).toString('utf16le') : data.toString('utf8').replace(/^﻿/, '');
  const { dumpInserts } = await import(pathToFileURL(path.join(sharedDir, 'mysql-dump.js')).href);
  const key = (schema, table) => `${schema ?? ''}.${table}`.toLowerCase();
  const index = new Map(tables.map((t, k) => [key(t.source.schema, t.source.table), k]));
  // A single-database dump has its tables under no schema; USE `db` may still name it.
  const anySchema = new Map(tables.map((t, k) => [String(t.source.table).toLowerCase(), k]));
  for (const ins of dumpInserts(text)) {
    let ti = index.get(key(ins.schema, ins.table));
    if (ti === undefined && tables.every((t) => !t.source.schema)) ti = anySchema.get(String(ins.table).toLowerCase());
    if (ti === undefined) continue;
    const t = tables[ti];
    const names = t.source.columns.map((c) => String(c.name).toLowerCase());
    let columns;
    if (ins.columns) columns = ins.columns.map((c) => names.indexOf(String(c).toLowerCase()));
    else {
      const all = t.source.columns.map((_, k) => k);
      const stored = all.filter((k) => !t.source.columns[k].generated);
      columns = ins.rows[0]?.length === all.length || ins.rows[0]?.length !== stored.length ? all : stored;
    }
    // Values for columns the table does not have (or not imported) are dropped.
    const keep = columns.map((c, k) => (c >= 0 ? k : -1)).filter((k) => k >= 0);
    const cols = keep.map((k) => columns[k]);
    const step = size(ti, cols.length);
    for (let r = 0; r < ins.rows.length; r += step) {
      yield { table: ti, columns: cols, rows: ins.rows.slice(r, r + step).map((row) => keep.map((k) => row[k])) };
    }
  }
  for (let ti = 0; ti < tables.length; ti++) yield { table: ti, columns: [], rows: [], last: true };
}

async function openSource(source) {
  switch (source?.kind) {
    case 'mysql': return openMysql(source.conn ?? {});
    case 'mssql': return openMssql(source.conn ?? {});
    case 'oracle': return openOracle(source.conn ?? {});
    case 'sqlite': return openSqlite(String(source.filePath));
    default: throw new Error(`Rows cannot be copied from ${source?.kind ?? 'this source'}.`);
  }
}

// ------------------------------------------------------------ copy

/**
 * Runs a copy request on `client` (a connected pg client). `onProgress`
 * receives { table, index, rows, done }; `signal.stopped` set to true stops at
 * the next batch. Returns { tables: [{ table, rows }], total }.
 */
async function copyRows(client, req, { onProgress = () => {}, signal = {} } = {}) {
  const tables = Array.isArray(req?.tables) ? req.tables : [];
  if (!tables.length) throw new Error('No tables to copy.');
  for (const t of tables) {
    if (!t.target?.name || !Array.isArray(t.columns) || !Array.isArray(t.source?.columns) || t.columns.length !== t.source.columns.length) {
      throw new Error(`The copy request for ${t.target?.name ?? 'a table'} is not valid.`);
    }
  }
  const size = (_ti, n) => Math.max(1, Math.min(BATCH_ROWS, Math.floor(MAX_PARAMS / Math.max(1, n))));
  const counts = tables.map(() => 0);
  const name = (ti) => `${tables[ti].target.schema ? `${tables[ti].target.schema}.` : ''}${tables[ti].target.name}`;
  let source = null;
  let current = -1;
  await client.query('BEGIN');
  try {
    if (req.createSql) await client.query(req.createSql);
    if (req.truncate) await client.query(`TRUNCATE ${tables.map((t) => qualified(t.target)).join(', ')}`);
    const chunks = req.source?.kind === 'mysql-dump' ? dumpChunks(String(req.source.filePath), tables, size) : null;
    if (!chunks) source = await openSource(req.source);
    const statements = new Map();
    for await (const chunk of chunks ?? tableChunks(source, tables, size)) {
      if (signal.stopped) throw Object.assign(new Error('The copy was stopped; nothing was changed.'), { stopped: true });
      const t = tables[chunk.table];
      if (chunk.table !== current) {
        current = chunk.table;
        onProgress({ table: name(current), index: current, rows: counts[current], done: false });
      }
      if (chunk.rows.length && chunk.columns.length) {
        const n = chunk.columns.length;
        const types = chunk.columns.map((c) => t.columns[c].type);
        const params = [];
        for (const row of chunk.rows) for (let k = 0; k < n; k++) params.push(convertValue(row[k], types[k]));
        const key = `${chunk.table}:${chunk.columns.join(',')}:${chunk.rows.length}`;
        let text = statements.get(key);
        if (!text) {
          const cols = chunk.columns.map((c) => qid(t.columns[c].name)).join(', ');
          const tuples = chunk.rows.map((_, r) => `(${chunk.columns.map((_c, k) => `$${r * n + k + 1}`).join(', ')})`);
          text = `INSERT INTO ${qualified(t.target)} (${cols}) VALUES ${tuples.join(', ')}`;
          if (statements.size > 200) statements.clear();
          statements.set(key, text);
        }
        try {
          await client.query(text, params);
        } catch (err) {
          throw new Error(`${name(chunk.table)}: ${err.message}`);
        }
        counts[chunk.table] += chunk.rows.length;
        onProgress({ table: name(chunk.table), index: chunk.table, rows: counts[chunk.table], done: false });
      }
      if (chunk.last) onProgress({ table: name(chunk.table), index: chunk.table, rows: counts[chunk.table], done: true });
    }
    if (req.foreignKeySql) {
      try {
        await client.query(req.foreignKeySql);
      } catch (err) {
        throw new Error(`Adding the foreign keys failed: ${err.message}`);
      }
    }
    // Serial columns: the next generated key follows the copied ones.
    for (const t of tables) {
      for (const c of t.columns) {
        if (!/^(serial|bigserial|smallserial)$/i.test(baseType(c.type))) continue;
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${qid(c.name)}), 0), 1), MAX(${qid(c.name)}) IS NOT NULL) FROM ${qualified(t.target)}`,
          [qualified(t.target), c.name]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    try {
      await source?.close();
    } catch {}
  }
  const result = tables.map((t, k) => ({ table: name(k), rows: counts[k] }));
  return { tables: result, total: counts.reduce((a, b) => a + b, 0) };
}

module.exports = { copyRows, convertValue, openSource };
