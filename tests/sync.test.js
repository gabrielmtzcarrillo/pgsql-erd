import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePgerd, newTable, newColumn, emptyModel } from '../src/renderer/lib/pgerd.js';
import { modelFromCatalog, splitType, tableKey } from '../src/renderer/lib/catalog.js';
import { diffModels, normalizeType, normalizeDefault } from '../src/renderer/lib/diff.js';
import { mergeFromDb } from '../src/renderer/lib/sync.js';

const sample = () => parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8'));

// Catalog rows shaped like src/main/db.cjs introspect() output.
function catalog() {
  return {
    schemas: ['public', 'shop'],
    tables: [
      { oid: 1, schema: 'public', name: 'customer', description: null },
      { oid: 2, schema: 'shop', name: 'orders', description: null },
      { oid: 3, schema: 'shop', name: 'legacy', description: null },
    ],
    columns: [
      { oid: 1, attnum: 1, name: 'id', type: 'bigint', notnull: true, default: null, identity: 'a' },
      { oid: 1, attnum: 2, name: 'email', type: 'character varying(200)', notnull: false, default: null },
      { oid: 1, attnum: 3, name: 'nickname', type: 'text', notnull: false, default: null },
      { oid: 2, attnum: 1, name: 'id', type: 'bigint', notnull: true, default: null },
      { oid: 2, attnum: 2, name: 'customer_id', type: 'bigint', notnull: true, default: null },
      { oid: 2, attnum: 3, name: 'status', type: 'character varying(20)', notnull: true, default: "'new'::character varying" },
      { oid: 3, attnum: 1, name: 'x', type: 'integer', notnull: false, default: null },
    ],
    constraints: [
      { oid: 1, name: 'customer_pkey', type: 'p', cols: [1] },
      { oid: 2, name: 'orders_pkey', type: 'p', cols: [1] },
      { oid: 2, name: 'orders_customer_id_fkey', type: 'f', cols: [2], ref_oid: 1, ref_cols: [1], confupdtype: 'a', confdeltype: 'c', confmatchtype: 's' },
    ],
  };
}

test('splits formatted types', () => {
  assert.deepEqual(splitType('character varying(255)'), { type: 'character varying', length: 255, precision: null });
  assert.deepEqual(splitType('numeric(10,2)[]'), { type: 'numeric[]', length: 10, precision: 2 });
  assert.deepEqual(splitType('timestamp(3) with time zone'), { type: 'timestamp with time zone', length: 3, precision: null });
  assert.deepEqual(splitType('text'), { type: 'text', length: null, precision: null });
});

test('builds a model from catalog rows', () => {
  const m = modelFromCatalog(catalog());
  assert.deepEqual(m.tables.map(tableKey), ['public.customer', 'shop.orders', 'shop.legacy']);
  const customer = m.tables[0];
  assert.equal(customer.columns[0].pk, true);
  assert.equal(customer.columns[0].raw.colconstype, 'i');
  assert.equal(customer.columns[1].length, 200);
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].fkName, 'orders_customer_id_fkey');
  assert.equal(m.links[0].rawFk.confdeltype, 'c');
});

test('normalizes types and defaults for comparison', () => {
  assert.equal(normalizeType({ type: 'varchar', length: 20 }), 'character varying(20)');
  assert.equal(normalizeType({ type: 'VARCHAR(20)' }), 'character varying(20)');
  assert.equal(normalizeType({ type: 'serial' }), 'integer');
  assert.equal(normalizeType({ type: 'timestamptz' }), 'timestamp with time zone');
  assert.equal(normalizeType({ type: 'int4[]' }), 'integer[]');
  assert.equal(normalizeType({ type: 'char' }), 'character(1)');
  assert.equal(normalizeType({ type: 'bit' }), normalizeType({ type: 'bit(1)' }));
  assert.equal(normalizeDefault("'new'::character varying"), normalizeDefault("'new'"));
  assert.equal(normalizeDefault(`B'1'::"bit"`), normalizeDefault("B'1'"));
  assert.equal(normalizeDefault('NOW()'), 'now()');
  assert.notEqual(normalizeDefault("'A'"), normalizeDefault("'a'"));
});

test('diff generates ordered migration SQL', () => {
  const db = modelFromCatalog(catalog());
  db.schemas = catalog().schemas;
  const erd = sample();
  const { changes, sql } = diffModels(db, erd);
  const kinds = changes.map((c) => `${c.table}:${c.kind}`);
  // New tables from the diagram.
  assert.ok(kinds.includes('shop.product:create-table'));
  assert.ok(kinds.includes('shop.order_item:create-table'));
  // Column changes on existing tables.
  assert.ok(kinds.includes('public.customer:alter-type'));      // varchar(200) -> (255)
  assert.ok(kinds.includes('public.customer:add-column'));      // full_name
  assert.ok(kinds.includes('public.customer:alter-null'));      // email NOT NULL
  assert.ok(kinds.includes('public.customer:alter-identity'));  // identity dropped
  assert.ok(kinds.includes('public.customer:add-unique'));
  assert.ok(kinds.includes('public.customer:comment'));
  // Destructive changes are skipped by default.
  const drop = changes.find((c) => c.kind === 'drop-column');
  assert.equal(drop.skipped, true);
  assert.match(sql, /-- ALTER TABLE IF EXISTS public\.customer\n--\s+DROP COLUMN IF EXISTS nickname;/);
  const legacy = changes.find((c) => c.kind === 'drop-table');
  assert.equal(legacy.table, 'shop.legacy');
  assert.equal(legacy.skipped, true);
  // FK delete action differs (cascade in DB, cascade in diagram too) -> no change for orders FK.
  assert.ok(!changes.some((c) => c.table === 'shop.orders' && c.kind.endsWith('fk')));
  // Status default only differs by cast -> no change.
  assert.ok(!changes.some((c) => c.table === 'shop.orders' && c.kind === 'alter-default'));
  // Order: drops first, then creates, then columns, then constraints, then FKs.
  const idx = (k) => changes.findIndex((c) => c.kind === k);
  assert.ok(idx('create-table') < idx('add-column'));
  assert.ok(idx('add-column') < idx('add-unique'));
  assert.ok(idx('add-unique') < idx('add-fk'));
  assert.match(sql, /^-- Migration generated by pgsql-erd\nBEGIN;/);
  assert.match(sql, /COMMIT;/);
});

test('diff includes destructive changes when enabled', () => {
  const db = modelFromCatalog(catalog());
  const erd = sample();
  const { changes, sql } = diffModels(db, erd, { destructive: true, dropTables: true });
  assert.ok(changes.every((c) => !c.skipped));
  assert.match(sql, /^ALTER TABLE IF EXISTS public\.customer\n\s+DROP COLUMN IF EXISTS nickname;$/m);
  assert.match(sql, /^DROP TABLE IF EXISTS shop\.legacy;$/m);
});

test('diff of identical models is empty', () => {
  const db = modelFromCatalog(catalog());
  const erd = modelFromCatalog(catalog());
  const { changes, sql } = diffModels(db, erd, { schemas: ['public', 'shop'] });
  assert.deepEqual(changes, []);
  assert.match(sql, /already matches/);
});

test('import adds new tables and updates existing ones, keeping layout', () => {
  const db = modelFromCatalog(catalog());
  const erd = emptyModel();
  const customer = newTable({
    name: 'customer',
    x: 500,
    y: 300,
    color: '#ff0000',
    columns: [
      newColumn({ name: 'id', type: 'integer', pk: true, attnum: 7 }),
      newColumn({ name: 'old', type: 'text', attnum: 8 }),
    ],
  });
  erd.tables.push(customer);
  const res = mergeFromDb(erd, db, ['public.customer', 'shop.orders']);
  assert.equal(res.updated.length, 1);
  assert.equal(res.added.length, 1);
  assert.equal(customer.x, 500);
  assert.equal(customer.color, '#ff0000');
  assert.deepEqual(customer.columns.map((c) => c.name), ['id', 'email', 'nickname']);
  assert.equal(customer.columns[0].attnum, 7, 'existing column keeps its attnum');
  assert.equal(customer.columns[0].type, 'bigint');
  assert.equal(erd.links.length, 1);
  const orders = erd.tables.find((t) => t.name === 'orders');
  assert.equal(erd.links[0].localTable, orders.id);
  assert.equal(erd.links[0].refTable, customer.id);
  assert.equal(erd.links[0].refCol, 7);
  // After importing, the diagram matches the database for those tables.
  const { changes } = diffModels(db, erd, { schemas: ['public'] });
  assert.deepEqual(changes, []);
});

// The same foreign key created twice under different names, as an unnamed
// ADD FOREIGN KEY run twice leaves it.
function duplicatedFkCatalog() {
  const c = catalog();
  c.constraints.push({ ...c.constraints[2], name: 'orders_customer_id_fkey1' });
  return c;
}

test('diff drops duplicate copies of a foreign key and adds none', () => {
  const db = modelFromCatalog(duplicatedFkCatalog());
  const erd = modelFromCatalog(catalog());
  const { changes, sql } = diffModels(db, erd, { schemas: ['public', 'shop'] });
  assert.deepEqual(changes.map((c) => c.kind), ['drop-fk']);
  assert.match(changes[0].summary, /orders_customer_id_fkey1 .*duplicate of orders_customer_id_fkey/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS orders_customer_id_fkey1;/);
  assert.doesNotMatch(sql, /DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;/);
  // Unnamed in the diagram: the first copy is kept.
  for (const l of erd.links) l.fkName = '';
  assert.deepEqual(diffModels(db, erd, { schemas: ['public', 'shop'] }).changes.map((c) => c.kind), ['drop-fk']);
});

test('unnamed foreign keys are added under a name', () => {
  const c = catalog();
  c.constraints.pop();
  const db = modelFromCatalog(c);
  const erd = modelFromCatalog(catalog());
  for (const l of erd.links) l.fkName = '';
  const { sql } = diffModels(db, erd, { schemas: ['public', 'shop'] });
  assert.match(sql, /ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY \(customer_id\)/);
});

test('import brings in one link for duplicated foreign keys', () => {
  const db = modelFromCatalog(duplicatedFkCatalog());
  const erd = emptyModel();
  mergeFromDb(erd, db, ['public.customer', 'shop.orders']);
  assert.equal(erd.links.length, 1);
  assert.equal(erd.links[0].fkName, 'orders_customer_id_fkey');
});
