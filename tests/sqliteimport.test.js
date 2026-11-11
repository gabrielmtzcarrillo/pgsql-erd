import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sqliteSpecs, sqliteType, sqliteDefault, SQLITE_EXT } from '../src/renderer/lib/sqliteimport.js';
import { modelFromSpecs } from '../src/renderer/lib/spreadsheet.js';
import { generateSQL } from '../src/renderer/lib/sql.js';

const require = createRequire(import.meta.url);
const { readSqliteCatalog, SQLITE_EXTENSIONS } = require('../src/main/database/sqlite.cjs');
const { DatabaseSync } = require('node:sqlite');

const DDL = `
CREATE TABLE Customer (
  Id INTEGER PRIMARY KEY AUTOINCREMENT,
  FullName VARCHAR(100) NOT NULL,
  Email TEXT UNIQUE,
  IsActive BOOLEAN NOT NULL DEFAULT 1,
  Balance DECIMAL(10,2) DEFAULT 0,
  CreatedAt DATETIME DEFAULT (datetime('now')),
  Notes
);
CREATE TABLE "Order" (
  OrderId INTEGER PRIMARY KEY,
  CustomerId INTEGER NOT NULL REFERENCES Customer(Id),
  Total REAL,
  Payload BLOB,
  Stamp TEXT DEFAULT (strftime('%s','now'))
);
CREATE TABLE OrderLine (
  OrderId INTEGER NOT NULL REFERENCES "Order",
  LineNo INTEGER NOT NULL,
  Sku TEXT NOT NULL,
  PRIMARY KEY (OrderId, LineNo)
);
CREATE TABLE Shipment (
  Id INTEGER PRIMARY KEY,
  OrderId INTEGER,
  LineNo INTEGER,
  FOREIGN KEY (OrderId, LineNo) REFERENCES OrderLine (OrderId, LineNo)
);
CREATE UNIQUE INDEX ux_line_sku ON OrderLine (Sku);
CREATE UNIQUE INDEX ux_ship ON Shipment (OrderId, LineNo);
CREATE VIEW ActiveCustomer AS SELECT * FROM Customer WHERE IsActive;
CREATE VIRTUAL TABLE Search USING fts5(body);
`;

function withDatabase(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgsql-erd-sqlite-'));
  const file = path.join(dir, 'shop.db');
  try {
    const db = new DatabaseSync(file);
    db.exec(DDL);
    db.close();
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const byName = (specs, name) => specs.find((s) => s.name === name);
const col = (spec, name) => spec.columns.find((c) => c.name === name);

test('reads the ordinary tables of a SQLite file', () => {
  withDatabase((file) => {
    const catalog = readSqliteCatalog(file);
    assert.deepEqual(catalog.tables.map((t) => t.name), ['Customer', 'Order', 'OrderLine', 'Shipment']);
    assert.doesNotThrow(() => structuredClone(catalog), 'the catalog crosses IPC');
  });
  assert.ok(SQLITE_EXTENSIONS.every((e) => SQLITE_EXT.test(`x.${e}`)));
});

test('a file that is not a database is refused', () => {
  const file = path.join(os.tmpdir(), `pgsql-erd-not-a-db-${process.pid}.db`);
  fs.writeFileSync(file, 'this is not a database, just a text file long enough to be read');
  try {
    assert.throws(() => readSqliteCatalog(file), /not a database/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('turns the catalog into table specs with PostgreSQL types', () => {
  const specs = withDatabase((file) => sqliteSpecs(readSqliteCatalog(file), { schema: 'shop' }));
  assert.deepEqual(specs.map((s) => `${s.schema}.${s.name}`), ['shop.customer', 'shop.order', 'shop.order_line', 'shop.shipment']);
  const customer = byName(specs, 'customer');
  assert.deepEqual([col(customer, 'id').type, col(customer, 'id').pk, col(customer, 'id').notNull], ['serial', true, true]);
  assert.deepEqual([col(customer, 'full_name').type, col(customer, 'full_name').length, col(customer, 'full_name').notNull], ['character varying', 100, true]);
  assert.ok(col(customer, 'email').unique);
  assert.deepEqual([col(customer, 'is_active').type, col(customer, 'is_active').default], ['boolean', 'true']);
  assert.deepEqual([col(customer, 'balance').type, col(customer, 'balance').length, col(customer, 'balance').precision], ['numeric', 10, 2]);
  assert.deepEqual([col(customer, 'created_at').type, col(customer, 'created_at').default], ['timestamp without time zone', 'CURRENT_TIMESTAMP']);
  assert.equal(col(customer, 'notes').type, 'text');
  const order = byName(specs, 'order');
  assert.deepEqual(col(order, 'customer_id').ref, { schema: null, table: 'customer', column: 'id' });
  assert.deepEqual([col(order, 'total').type, col(order, 'payload').type], ['double precision', 'bytea']);
  assert.equal(col(order, 'stamp').default, '', 'a SQLite-only function is dropped');
  const line = byName(specs, 'order_line');
  assert.deepEqual(line.columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'line_no']);
  assert.equal(col(line, 'order_id').type, 'integer', 'part of a composite key is not a rowid');
  assert.deepEqual(col(line, 'order_id').ref, { schema: null, table: 'order', column: null });
  assert.ok(col(line, 'sku').unique);
  const shipment = byName(specs, 'shipment');
  assert.deepEqual(col(shipment, 'line_no').ref, { schema: null, table: 'order_line', column: 'line_no' });
  assert.ok(!col(shipment, 'order_id').unique, 'a two-column unique index does not make each column unique');
});

test('names are kept when snake_case is off, and the model links the tables', () => {
  const specs = withDatabase((file) => sqliteSpecs(readSqliteCatalog(file), { snakeCase: false }));
  assert.ok(col(byName(specs, 'Order'), 'CustomerId'));
  const { model, external } = modelFromSpecs(specs);
  assert.equal(model.tables.length, 4);
  assert.equal(model.links.length, 4);
  assert.equal(external.length, 0);
  assert.match(generateSQL(model), /CREATE TABLE/);
});

test('maps declared types by SQLite affinity', () => {
  assert.equal(sqliteType(''), 'text');
  assert.equal(sqliteType('UNSIGNED BIG INT'), 'bigint');
  assert.equal(sqliteType('NATIVE CHARACTER(70)'), 'text');
  assert.equal(sqliteType('VARCHAR(20)'), 'VARCHAR(20)');
  assert.equal(sqliteType('DOUBLE PRECISION'), 'DOUBLE PRECISION');
  assert.equal(sqliteType('whatever'), 'numeric');
});

test('translates defaults', () => {
  assert.equal(sqliteDefault(null), '');
  assert.equal(sqliteDefault('NULL'), '');
  assert.equal(sqliteDefault("'new'"), "'new'");
  assert.equal(sqliteDefault('"new"'), "'new'");
  assert.equal(sqliteDefault('((1 + 2))'), '1 + 2');
  assert.equal(sqliteDefault('(1) + (2)'), '(1) + (2)');
  assert.equal(sqliteDefault("date('now', 'localtime')"), 'CURRENT_DATE');
  assert.equal(sqliteDefault('current_timestamp'), 'CURRENT_TIMESTAMP');
  assert.equal(sqliteDefault('0', 'boolean'), 'false');
  assert.equal(sqliteDefault('0', 'integer'), '0');
  assert.equal(sqliteDefault('(hex(randomblob(16)))'), '');
});
