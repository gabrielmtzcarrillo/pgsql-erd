// Runs against a real PostgreSQL server. Skipped unless PGERD_TEST_HOST is set:
//   PGERD_TEST_HOST=127.0.0.1 PGERD_TEST_PORT=5432 PGERD_TEST_USER=postgres npm test
// A temporary database is created and dropped.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parsePgerd, newColumn, newTable, uuid } from '../src/renderer/lib/pgerd.js';
import { generateSQL } from '../src/renderer/lib/sql.js';
import { modelFromCatalog, tableKey } from '../src/renderer/lib/catalog.js';
import { diffModels } from '../src/renderer/lib/diff.js';
import { mergeFromDb } from '../src/renderer/lib/sync.js';

const require = createRequire(import.meta.url);
const enabled = !!process.env.PGERD_TEST_HOST;
const base = {
  host: process.env.PGERD_TEST_HOST,
  port: process.env.PGERD_TEST_PORT || 5432,
  user: process.env.PGERD_TEST_USER || 'postgres',
  password: process.env.PGERD_TEST_PASSWORD || '',
  database: 'postgres',
};
const dbName = `pgsql_erd_test_${process.pid}`;
const conn = { ...base, database: dbName };
let db;

const sample = () => parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8'));
async function load() {
  const catalog = await db.introspect(conn);
  const m = modelFromCatalog(catalog);
  m.schemas = catalog.schemas;
  return m;
}

before(async () => {
  if (!enabled) return;
  db = require('../src/main/db.cjs');
  await db.execute(base, `CREATE DATABASE ${dbName}`);
});

after(async () => {
  if (!enabled) return;
  await db.execute(base, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('connection test reports the server', { skip: !enabled }, async () => {
  const info = await db.testConnection(conn);
  assert.equal(info.database, dbName);
  assert.match(info.version, /PostgreSQL/);
});

test('schema created from the diagram compares as identical', { skip: !enabled }, async () => {
  const erd = sample();
  await db.execute(conn, generateSQL(erd));
  const { changes } = diffModels(await load(), erd);
  assert.deepEqual(changes.map((c) => c.summary), []);
});

test('migration SQL brings the database in line with an edited diagram', { skip: !enabled }, async () => {
  const erd = sample();
  const customer = erd.tables.find((t) => t.name === 'customer');
  const orders = erd.tables.find((t) => t.name === 'orders');
  const product = erd.tables.find((t) => t.name === 'product');

  customer.columns.find((c) => c.name === 'email').length = 320;             // alter type
  customer.columns.find((c) => c.name === 'full_name').notNull = false;      // drop not null
  customer.columns.push(newColumn({ name: 'phone', type: 'varchar', length: 30, attnum: 10 })); // add column
  customer.rawData.unique_constraint = [];                                   // drop unique
  customer.description = 'People who buy things';                            // comment
  orders.columns = orders.columns.filter((c) => c.name !== 'placed_at');     // drop column
  orders.columns.find((c) => c.name === 'status').default = "'pending'";     // default
  product.columns.find((c) => c.name === 'sku').pk = false;
  const review = newTable({                                                  // new table + FK
    name: 'review',
    schema: 'shop',
    columns: [
      newColumn({ name: 'id', type: 'bigint', pk: true, attnum: 0, raw: { colconstype: 'i', attidentity: 'a' } }),
      newColumn({ name: 'product_id', type: 'integer', notNull: true, attnum: 1 }),
      newColumn({ name: 'stars', type: 'smallint', notNull: true, default: '5', attnum: 2 }),
    ],
    rawData: { unique_constraint: [{ name: 'review_product_stars_key', columns: [{ column: 'product_id' }, { column: 'stars' }] }] },
  });
  erd.tables.push(review);
  erd.links.push({ id: uuid(), type: 'onetomany', localTable: review.id, localCol: 1, refTable: product.id, refCol: 0, group: uuid(), fkName: 'review_product_fk', rawFk: { confdeltype: 'c' } });

  // Without destructive changes the dropped column is only commented out.
  const safe = diffModels(await load(), erd);
  assert.ok(safe.changes.find((c) => c.kind === 'drop-column').skipped);
  await db.execute(conn, safe.sql);
  let after = diffModels(await load(), erd);
  assert.deepEqual(after.changes.map((c) => c.kind), ['drop-column']);

  const full = diffModels(await load(), erd, { destructive: true });
  await db.execute(conn, full.sql);
  after = diffModels(await load(), erd, { destructive: true });
  assert.deepEqual(after.changes.map((c) => c.summary), []);

  // Primary key change on a referenced table (orders.customer_id -> customer.id
  // keeps working through a new unique constraint), and an FK action change.
  customer.columns.find((c) => c.name === 'email').pk = true;
  customer.rawData.unique_constraint = [{ name: 'customer_id_key', columns: [{ column: 'id' }] }];
  erd.links.find((l) => l.localTable === review.id).rawFk = { confdeltype: 'r' };
  const pk = diffModels(await load(), erd);
  assert.ok(pk.changes.some((c) => c.kind === 'drop-pk'));
  assert.ok(pk.changes.some((c) => /re-created after key change/.test(c.summary)));
  assert.ok(pk.changes.some((c) => c.kind === 'drop-fk' && /actions changed/.test(c.summary)));
  await db.execute(conn, pk.sql);
  assert.deepEqual(diffModels(await load(), erd).changes.map((c) => c.summary), []);
});

test('a failing migration is rolled back', { skip: !enabled }, async () => {
  const sql = 'BEGIN;\nCREATE TABLE public.should_not_exist (id int);\nSELECT 1/0;\nCOMMIT;';
  await assert.rejects(db.execute(conn, sql), /division by zero/);
  const m = await load();
  assert.ok(!m.tables.some((t) => t.name === 'should_not_exist'));
});

test('importing from the database reproduces it', { skip: !enabled }, async () => {
  const dbModel = await load();
  const erd = { ...parsePgerd('{"data":{"layers":[]}}') };
  const res = mergeFromDb(erd, dbModel, dbModel.tables.map(tableKey));
  assert.equal(res.added.length, dbModel.tables.length);
  assert.equal(erd.links.length, dbModel.links.length);
  assert.deepEqual(diffModels(dbModel, erd).changes, []);
  // And the imported model generates DDL that PostgreSQL accepts.
  const other = { ...conn, database: `${dbName}_copy` };
  await db.execute(base, `CREATE DATABASE ${other.database}`);
  try {
    await db.execute(other, generateSQL(erd));
    const copy = modelFromCatalog(await db.introspect(other));
    assert.deepEqual(diffModels(copy, erd).changes, []);
  } finally {
    await db.execute(base, `DROP DATABASE IF EXISTS ${other.database} WITH (FORCE)`);
  }
});
