// "Copy rows" end to end: a sample schema with awkward values is created in
// each source, read back into table specs as the import dialog does, and
// copied into a fresh PostgreSQL database; the rows, keys and sequences are
// checked there. Needs PostgreSQL (PGERD_TEST_HOST, as db.integration.test.js)
// and runs each source whose server is configured:
//   PGERD_MYSQL_HOST / _PORT / _USER / _PASSWORD      MySQL
//   PGERD_MARIADB_HOST / _PORT / _USER / _PASSWORD    MariaDB
//   PGERD_MSSQL_HOST / _PORT / _USER / _PASSWORD      SQL Server
//   PGERD_ORACLE_HOST / _PORT / _SERVICE / _USER / _PASSWORD   Oracle (a user that may create tables)
// SQLite and the MySQL dump need only PostgreSQL. For example, with containers:
//   docker run -d -e POSTGRES_PASSWORD=pgerd -p 55433:5432 postgres:17
//   docker run -d -e MYSQL_ROOT_PASSWORD=pgerd -p 33306:3306 mysql:8.4
//   docker run -d -e MARIADB_ROOT_PASSWORD=pgerd -p 33307:3306 mariadb:11.4
//   docker run -d -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Pgerd_Test_2026!' -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
//   docker run -d -e ORACLE_PASSWORD=pgerd -e APP_USER=shop -e APP_USER_PASSWORD=pgerd -p 15521:1521 gvenzl/oracle-free:23-slim-faststart

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mysqlSpecs } from '../src/renderer/lib/mysqlimport.js';
import { mssqlSpecs } from '../src/renderer/lib/mssqlimport.js';
import { oracleSpecs } from '../src/renderer/lib/oracleimport.js';
import { sqliteSpecs } from '../src/renderer/lib/sqliteimport.js';
import { copyRequest } from '../src/renderer/copyui.js';

const require = createRequire(import.meta.url);
const env = process.env;
const pgEnabled = !!env.PGERD_TEST_HOST;
const pgBase = {
  host: env.PGERD_TEST_HOST,
  port: env.PGERD_TEST_PORT || 5432,
  user: env.PGERD_TEST_USER || 'postgres',
  password: env.PGERD_TEST_PASSWORD || '',
  database: 'postgres',
};
const pgName = `pgsql_erd_copy_${process.pid}`;
const mysqlConn = (prefix, port) => ({
  host: env[`${prefix}_HOST`],
  port: env[`${prefix}_PORT`] || port,
  user: env[`${prefix}_USER`] || 'root',
  password: env[`${prefix}_PASSWORD`] || '',
  database: `pgerd_copy_${process.pid}`,
});
const mssqlConn = {
  server: env.PGERD_MSSQL_HOST,
  port: env.PGERD_MSSQL_PORT || 1433,
  user: env.PGERD_MSSQL_USER || 'sa',
  password: env.PGERD_MSSQL_PASSWORD || '',
  database: `pgerd_copy_${process.pid}`,
  trustServerCertificate: true,
};
const oracleConn = {
  host: env.PGERD_ORACLE_HOST,
  port: env.PGERD_ORACLE_PORT || 1521,
  service: env.PGERD_ORACLE_SERVICE || 'FREEPDB1',
  user: env.PGERD_ORACLE_USER || 'shop',
  password: env.PGERD_ORACLE_PASSWORD || '',
};

let db;
let copyRows;
const pg = async () => {
  const { Client } = require('pg');
  const client = new Client({ ...pgBase, database: pgName });
  await client.connect();
  return client;
};
const scalar = async (sql, params = []) => {
  const c = await pg();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};

before(async () => {
  if (!pgEnabled) return;
  db = require('../src/main/db.cjs');
  ({ copyRows } = require('../src/main/database/data-copy.cjs'));
  await db.execute(pgBase, `CREATE DATABASE ${pgName}`);
});

after(async () => {
  if (!pgEnabled) return;
  await db.execute(pgBase, `DROP DATABASE IF EXISTS ${pgName} WITH (FORCE)`);
});

// Copy `specs` (all of them) from `source` into the schema of the specs; returns the copy result.
async function copy(specs, source, opts = {}) {
  const req = copyRequest(specs, source, opts);
  const client = await pg();
  try {
    return await copyRows(client, req);
  } finally {
    await client.end();
  }
}

// What every source's sample must produce in PostgreSQL schema `schema`.
async function checkShop(schema, { names = { customer: 'customer', item: 'order_item' }, flags = true } = {}) {
  const customers = await scalar(`SELECT * FROM ${schema}.${names.customer} ORDER BY id`);
  assert.equal(customers.length, 3);
  assert.equal(customers[0].name, "O'Brien \"Pat\" – Zoë 名前");
  assert.equal(customers[1].name, 'Line\nbreak; and \\ backslash');
  assert.equal(customers[2].name, null);
  if (flags) assert.deepEqual(customers.map((c) => c.active), [true, false, true]);
  assert.deepEqual(customers.map((c) => String(c.balance)), ['12345678901234.56', '0.00', '-1.50']);
  // Wall-clock values survive without a time zone shift.
  const created = await scalar(`SELECT to_char(created, 'YYYY-MM-DD HH24:MI:SS') AS t FROM ${schema}.${names.customer} ORDER BY id`);
  assert.deepEqual(created.map((r) => r.t), ['2026-01-02 03:04:05', '1999-12-31 23:59:59', '2026-06-30 12:00:00']);
  assert.deepEqual(customers[0].photo, Buffer.from([0, 1, 2, 255]));
  const items = await scalar(`SELECT * FROM ${schema}.${names.item} ORDER BY customer_id, line_no`);
  assert.equal(items.length, 4);
  // Foreign keys were added after the rows.
  const fks = await scalar(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = $1::regnamespace`, [schema]);
  assert.equal(fks[0].n, 1);
  // The serial sequence continues after the copied keys.
  const [{ id }] = await scalar(`INSERT INTO ${schema}.${names.customer} (name) VALUES ('new') RETURNING id`);
  assert.equal(Number(id), 4);
}

test('copy: from SQLite', { skip: !pgEnabled }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(path.join(tmpdir(), 'pgerd-copy-'));
  const file = path.join(dir, 'shop.db');
  const s = new DatabaseSync(file);
  s.exec(`CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT, active BOOLEAN NOT NULL DEFAULT 1, balance DECIMAL(16,2), created DATETIME, photo BLOB);
    CREATE TABLE order_item (customer_id INTEGER NOT NULL REFERENCES customer(id), line_no INTEGER NOT NULL, qty INTEGER, PRIMARY KEY (customer_id, line_no));`);
  const ins = s.prepare('INSERT INTO customer VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, "O'Brien \"Pat\" – Zoë 名前", 1, '12345678901234.56', '2026-01-02 03:04:05', new Uint8Array([0, 1, 2, 255]));
  ins.run(2, 'Line\nbreak; and \\ backslash', 0, '0.00', '1999-12-31 23:59:59', null);
  ins.run(3, null, 1, '-1.50', '2026-06-30 12:00:00', null);
  s.exec('INSERT INTO order_item VALUES (1, 1, 2), (1, 2, 1), (2, 1, 5), (3, 1, 1)');
  const { readSqliteCatalog } = require('../src/main/database/sqlite.cjs');
  const catalog = readSqliteCatalog(file);
  s.close();
  const r = await copy(sqliteSpecs(catalog, { schema: 'from_sqlite' }), { kind: 'sqlite', filePath: file });
  assert.equal(r.total, 7);
  await checkShop('from_sqlite');
  rmSync(dir, { recursive: true, force: true });
});

test('copy: from a MySQL dump, and again with the tables emptied first', { skip: !pgEnabled }, async () => {
  const file = fileURLToPath(new URL('./fixtures/shop.mysql.sql', import.meta.url));
  const { readFileSync } = await import('node:fs');
  const { readMysqlDump } = require('../src/main/database/mysql.cjs');
  const { catalog } = await readMysqlDump(readFileSync(file, 'utf8'));
  const specs = mysqlSpecs(catalog, { schema: 'from_dump' });
  const r = await copy(specs, { kind: 'mysql-dump', filePath: file });
  assert.deepEqual(r.tables.map((t) => t.rows), [3, 2, 3]);
  const rows = await scalar('SELECT id, full_name, is_active, status, balance::text, created_at::text, seen_at, birthday, flags, avatar, prefs, upper FROM from_dump.customer_account ORDER BY id');
  assert.equal(rows[0].full_name, 'O\'Brien "Pat"');
  assert.deepEqual([rows[0].is_active, rows[1].is_active], [true, false]);
  assert.equal(rows[1].status, "it's");
  assert.equal(rows[0].created_at, '2026-01-02 03:04:05.678');
  assert.equal(rows[0].seen_at.toISOString(), '2026-01-02T03:04:05.000Z'); // MySQL TIMESTAMP is UTC
  assert.equal(rows[1].birthday, null); // 0000-00-00
  assert.deepEqual([rows[0].flags, rows[1].flags], [false, true]);
  assert.deepEqual(rows[0].avatar, Buffer.from('PNG\0\n', 'latin1'));
  assert.deepEqual([rows[0].prefs, rows[1].prefs], [{}, { theme: 'dark' }]);
  assert.equal(rows[1].upper, 'ZOË – 名前');
  const lines = await scalar('SELECT qty, price, year FROM from_dump.order_line ORDER BY customer_id, line_no');
  assert.deepEqual(lines.map((l) => [l.qty, l.price, l.year]), [[3, 9.99, 2026], [-1, 1000, null], [1, null, 1999]]);
  // A second copy into the same tables needs them emptied first.
  await assert.rejects(copy(specs, { kind: 'mysql-dump', filePath: file }), /duplicate key/);
  const again = await copy(specs, { kind: 'mysql-dump', filePath: file }, { truncate: true });
  assert.equal(again.total, 8);
  assert.equal((await scalar('SELECT count(*)::int AS n FROM from_dump.category'))[0].n, 3);
});

// The sample for the server sources, in each one's dialect.
const MYSQL_SHOP = [
  `CREATE TABLE customer (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100), active tinyint(1) NOT NULL DEFAULT 1,
     balance decimal(16,2), created datetime, photo blob, stamp timestamp NULL, doc json, kind enum('a','b') DEFAULT 'a', big bigint unsigned) COMMENT 'Buyers'`,
  `CREATE TABLE order_item (customer_id int NOT NULL, line_no int NOT NULL, qty int, PRIMARY KEY (customer_id, line_no),
     CONSTRAINT fk_item_customer FOREIGN KEY (customer_id) REFERENCES customer (id))`,
  `INSERT INTO customer (id, name, active, balance, created, photo, stamp, doc, kind, big) VALUES
     (1, 'O''Brien "Pat" – Zoë 名前', 1, 12345678901234.56, '2026-01-02 03:04:05', x'000102FF', '2026-01-02 03:04:05', '{"a": [1, 2]}', 'b', 18446744073709551615),
     (2, 'Line\\nbreak; and \\\\ backslash', 0, 0, '1999-12-31 23:59:59', NULL, NULL, NULL, 'a', 0),
     (3, NULL, 1, -1.5, '2026-06-30 12:00:00', NULL, NULL, NULL, NULL, NULL)`,
  'INSERT INTO order_item VALUES (1, 1, 2), (1, 2, 1), (2, 1, 5), (3, 1, 1)',
];

for (const [label, prefix, port] of [['MySQL', 'PGERD_MYSQL', 3306], ['MariaDB', 'PGERD_MARIADB', 3306]]) {
  const conn = mysqlConn(prefix, port);
  test(`copy: from ${label}`, { skip: !pgEnabled || !conn.host }, async () => {
    const { mysqlConnection, readMysqlCatalog } = require('../src/main/database/mysql.cjs');
    const admin = await mysqlConnection({ ...conn, database: '' });
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${conn.database}\``);
      await admin.query(`CREATE DATABASE \`${conn.database}\` CHARACTER SET utf8mb4`);
      await admin.query(`USE \`${conn.database}\``);
      for (const sql of MYSQL_SHOP) await admin.query(sql);
    } finally {
      await admin.end();
    }
    const res = await readMysqlCatalog(conn);
    assert.equal(res.mariadb, label === 'MariaDB');
    const schema = `from_${label.toLowerCase()}`;
    const r = await copy(mysqlSpecs(res.catalog, { schema }), { kind: 'mysql', conn });
    assert.equal(r.total, 7);
    await checkShop(schema);
    const [row] = await scalar(`SELECT stamp, doc, kind, big::text FROM ${schema}.customer WHERE id = 1`);
    assert.equal(row.stamp.toISOString(), '2026-01-02T03:04:05.000Z');
    assert.deepEqual(row.doc, { a: [1, 2] });
    assert.equal(row.kind, 'b');
    assert.equal(row.big, '18446744073709551615');
    const admin2 = await mysqlConnection({ ...conn, database: '' });
    await admin2.query(`DROP DATABASE \`${conn.database}\``);
    await admin2.end();
  });
}

test('copy: from SQL Server', { skip: !pgEnabled || !mssqlConn.server }, async () => {
  const sql = require('mssql');
  const { mssqlConfig, readMssqlCatalog } = require('../src/main/database/mssql.cjs');
  const run = async (database, batches) => {
    const pool = new sql.ConnectionPool(mssqlConfig({ ...mssqlConn, database }));
    await pool.connect();
    try {
      for (const b of batches) await pool.request().batch(b);
    } finally {
      await pool.close();
    }
  };
  await run('master', [`IF DB_ID('${mssqlConn.database}') IS NOT NULL DROP DATABASE [${mssqlConn.database}]`, `CREATE DATABASE [${mssqlConn.database}]`]);
  await run(mssqlConn.database, [
    `CREATE TABLE dbo.Customer (Id int IDENTITY(1,1) PRIMARY KEY, Name nvarchar(100), Active bit NOT NULL DEFAULT 1,
       Balance decimal(16,2), Created datetime2(0), Photo varbinary(max), Stamp datetimeoffset, Token uniqueidentifier DEFAULT newid(), Price money)`,
    `CREATE TABLE dbo.OrderItem (CustomerId int NOT NULL REFERENCES dbo.Customer (Id), LineNo_ int NOT NULL, Qty int, PRIMARY KEY (CustomerId, LineNo_))`,
    `SET IDENTITY_INSERT dbo.Customer ON;
     INSERT INTO dbo.Customer (Id, Name, Active, Balance, Created, Photo, Stamp, Price) VALUES
       (1, N'O''Brien "Pat" – Zoë 名前', 1, 12345678901234.56, '2026-01-02 03:04:05', 0x000102FF, '2026-01-02 03:04:05 +02:00', 922337203685477.5807),
       (2, N'Line' + CHAR(10) + N'break; and \\ backslash', 0, 0, '1999-12-31 23:59:59', NULL, NULL, 0),
       (3, NULL, 1, -1.5, '2026-06-30 12:00:00', NULL, NULL, NULL);
     SET IDENTITY_INSERT dbo.Customer OFF;
     INSERT INTO dbo.OrderItem VALUES (1, 1, 2), (1, 2, 1), (2, 1, 5), (3, 1, 1);`,
  ]);
  const res = await readMssqlCatalog(mssqlConn);
  const r = await copy(mssqlSpecs(res.catalog, { schema: 'from_mssql' }), { kind: 'mssql', conn: mssqlConn });
  assert.equal(r.total, 7);
  await checkShop('from_mssql', { names: { customer: 'customer', item: 'order_item' } });
  const [row] = await scalar('SELECT stamp, token::text, price::text FROM from_mssql.customer WHERE id = 1');
  assert.equal(row.stamp.toISOString(), '2026-01-02T01:04:05.000Z');
  assert.match(row.token, /^[0-9a-f-]{36}$/);
  assert.equal(row.price, '922337203685477.5807');
  await run('master', [`ALTER DATABASE [${mssqlConn.database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, `DROP DATABASE [${mssqlConn.database}]`]);
});

test('copy: from Oracle', { skip: !pgEnabled || !oracleConn.host }, async () => {
  const { oracleConnection, readOracleCatalog } = require('../src/main/database/oracle.cjs');
  const c = await oracleConnection(oracleConn);
  try {
    for (const t of ['ORDER_ITEM', 'CUSTOMER']) {
      await c.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${t} PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
    }
    await c.execute(`CREATE TABLE customer (id NUMBER(10) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name VARCHAR2(100 CHAR),
      active NUMBER(1) DEFAULT 1 NOT NULL, balance NUMBER(16,2), created DATE, photo BLOB, stamp TIMESTAMP WITH TIME ZONE, token RAW(16) DEFAULT SYS_GUID(), notes CLOB)`);
    await c.execute("COMMENT ON TABLE customer IS 'Buyers'");
    await c.execute(`CREATE TABLE order_item (customer_id NUMBER(10) NOT NULL REFERENCES customer (id), line_no NUMBER(9) NOT NULL, qty NUMBER(9),
      CONSTRAINT pk_order_item PRIMARY KEY (customer_id, line_no))`);
    await c.execute(`INSERT INTO customer (id, name, active, balance, created, photo, stamp, notes) VALUES
      (1, 'O''Brien "Pat" – Zoë 名前', 1, 12345678901234.56, TIMESTAMP '2026-01-02 03:04:05', HEXTORAW('000102FF'), TIMESTAMP '2026-01-02 03:04:05 +02:00', RPAD(TO_CLOB('x'), 5000, 'x'))`);
    await c.execute(`INSERT INTO customer (id, name, active, balance, created) VALUES (2, 'Line' || CHR(10) || 'break; and \\ backslash', 0, 0, TIMESTAMP '1999-12-31 23:59:59')`);
    await c.execute(`INSERT INTO customer (id, name, active, balance, created) VALUES (3, NULL, 1, -1.5, TIMESTAMP '2026-06-30 12:00:00')`);
    for (const v of ['1, 1, 2', '1, 2, 1', '2, 1, 5', '3, 1, 1']) await c.execute(`INSERT INTO order_item VALUES (${v})`);
    await c.commit();
  } finally {
    await c.close();
  }
  const res = await readOracleCatalog(oracleConn);
  const specs = oracleSpecs(res.catalog, { schema: 'from_oracle' });
  const r = await copy(specs, { kind: 'oracle', conn: oracleConn });
  assert.equal(r.total, 7);
  // NUMBER(1) is a number in Oracle, so it stays one.
  await checkShop('from_oracle', { flags: false });
  const [row] = await scalar('SELECT active, stamp, token::text, length(notes) AS notes FROM from_oracle.customer WHERE id = 1');
  assert.equal(row.active, 1);
  assert.equal(row.stamp.toISOString(), '2026-01-02T01:04:05.000Z');
  assert.match(row.token, /^[0-9a-f-]{36}$/);
  assert.equal(row.notes, 5000);
});
