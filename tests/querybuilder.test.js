import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFromCatalog } from '../src/renderer/lib/catalog.js';
import { aliasFor, foreignKeys, autoJoins, buildSQL, reconcile } from '../src/renderer/lib/querybuilder.js';

// Catalog rows shaped like src/main/db.cjs introspect() output.
function dbModel() {
  return modelFromCatalog({
    tables: [
      { oid: 1, schema: 'public', name: 'customers' },
      { oid: 2, schema: 'public', name: 'orders' },
      { oid: 3, schema: 'public', name: 'addresses' },
      { oid: 4, schema: 'hr', name: 'employees' },
      { oid: 5, schema: 'public', name: 'order_lines' },
    ],
    columns: [
      { oid: 1, attnum: 1, name: 'id', type: 'bigint' },
      { oid: 1, attnum: 2, name: 'name', type: 'text' },
      { oid: 2, attnum: 1, name: 'id', type: 'bigint' },
      { oid: 2, attnum: 2, name: 'customer_id', type: 'bigint' },
      { oid: 2, attnum: 3, name: 'billing_id', type: 'bigint' },
      { oid: 2, attnum: 4, name: 'shipping_id', type: 'bigint' },
      { oid: 3, attnum: 1, name: 'id', type: 'bigint' },
      { oid: 3, attnum: 2, name: 'city', type: 'text' },
      { oid: 4, attnum: 1, name: 'id', type: 'integer' },
      { oid: 4, attnum: 2, name: 'name', type: 'text' },
      { oid: 4, attnum: 3, name: 'manager_id', type: 'integer' },
      { oid: 5, attnum: 1, name: 'order_id', type: 'bigint' },
      { oid: 5, attnum: 2, name: 'line', type: 'integer' },
    ],
    constraints: [
      { oid: 2, name: 'orders_customer_fk', type: 'f', cols: [2], ref_oid: 1, ref_cols: [1] },
      { oid: 2, name: 'orders_billing_fk', type: 'f', cols: [3], ref_oid: 3, ref_cols: [1] },
      { oid: 2, name: 'orders_shipping_fk', type: 'f', cols: [4], ref_oid: 3, ref_cols: [1] },
      { oid: 4, name: 'employees_manager_fk', type: 'f', cols: [3], ref_oid: 4, ref_cols: [1] },
      { oid: 5, name: 'lines_order_fk', type: 'f', cols: [1], ref_oid: 2, ref_cols: [1] },
    ],
  });
}

// Adds tables one at a time, as dropping them on the builder does.
function build(keys) {
  const fks = foreignKeys(dbModel());
  const tables = [];
  const joins = [];
  for (const key of keys) {
    const [schema, name] = key.split('.');
    const t = { id: `t${tables.length + 1}`, schema, name, alias: aliasFor(name, new Set(tables.map((x) => x.alias))), columns: [] };
    tables.push(t);
    joins.push(...autoJoins(fks, tables, joins, t).map((j, i) => ({ id: `${t.id}j${i}`, ...j })));
  }
  return { tables, joins };
}

test('query builder: aliases from initials', () => {
  assert.equal(aliasFor('order_items', new Set()), 'oi');
  assert.equal(aliasFor('customers', new Set(['c'])), 'c2');
  assert.equal(aliasFor('Do', new Set()), 'd');
  assert.equal(aliasFor('do_order', new Set()), 'do2'); // DO is reserved
  assert.equal(aliasFor('2024_sales', new Set()), 't2s');
});

test('query builder: foreign keys grouped per constraint', () => {
  const fks = foreignKeys(dbModel());
  assert.equal(fks.length, 5);
  const fk = fks.find((x) => x.name === 'orders_customer_fk');
  assert.deepEqual({ from: fk.from, to: fk.to, pairs: fk.pairs }, { from: 'public.orders', to: 'public.customers', pairs: [['customer_id', 'id']] });
});

test('query builder: relationships become joins', () => {
  const s = build(['public.orders', 'public.customers', 'public.order_lines']);
  assert.equal(s.joins.length, 2);
  s.tables[0].columns = ['id'];
  s.tables[1].columns = ['name'];
  s.tables[2].columns = ['line'];
  assert.equal(
    buildSQL(s),
    [
      'SELECT',
      '  o.id,',
      '  c.name,',
      '  ol.line',
      'FROM public.orders o',
      '  INNER JOIN public.customers c ON c.id = o.customer_id',
      '  INNER JOIN public.order_lines ol ON ol.order_id = o.id;',
    ].join('\n')
  );
});

test('query builder: a second copy of a table takes the next foreign key', () => {
  const s = build(['public.orders', 'public.addresses', 'public.addresses']);
  assert.deepEqual(s.joins.map((j) => j.fk), ['public.orders:orders_billing_fk', 'public.orders:orders_shipping_fk']);
  assert.match(buildSQL(s), /INNER JOIN public\.addresses a ON a\.id = o\.billing_id\n {2}INNER JOIN public\.addresses a2 ON a2\.id = o\.shipping_id;$/);
});

test('query builder: self references join the new copy as the referenced row', () => {
  const s = build(['hr.employees', 'hr.employees']);
  assert.equal(s.joins.length, 1);
  s.tables[0].columns = ['name'];
  s.tables[1].columns = ['name'];
  assert.equal(
    buildSQL(s),
    'SELECT\n  e.name AS e_name,\n  e2.name AS e2_name\nFROM hr.employees e\n  INNER JOIN hr.employees e2 ON e2.id = e.manager_id;'
  );
});

test('query builder: join types follow the order tables are placed in', () => {
  const s = build(['public.customers', 'public.orders']);
  s.joins[0].type = 'left'; // orders LEFT JOIN customers: every order
  assert.match(buildSQL(s), /FROM public\.customers c\n {2}RIGHT JOIN public\.orders o ON o\.customer_id = c\.id;$/);
  s.joins[0].type = 'full';
  assert.match(buildSQL(s), /FULL JOIN/);
});

test('query builder: unrelated tables, no columns, distinct and limit', () => {
  const s = build(['public.customers', 'hr.employees']);
  assert.equal(s.joins.length, 0);
  assert.equal(buildSQL({ ...s, distinct: true, limit: 10 }), 'SELECT DISTINCT *\nFROM public.customers c\n  CROSS JOIN hr.employees e\nLIMIT 10;');
  assert.equal(buildSQL({ tables: [] }), '');
  assert.doesNotMatch(buildSQL({ ...s, limit: 'x' }), /LIMIT/);
});

test('query builder: reconcile drops what the database no longer has', () => {
  const s = build(['public.orders', 'public.customers']);
  s.tables[0].columns = ['id', 'gone'];
  s.tables.push({ id: 'x', schema: 'public', name: 'dropped', alias: 'd', columns: ['id'] });
  s.joins.push({ id: 'y', a: 't1', b: 't2', pairs: [['gone', 'id']], type: 'inner' });
  const r = reconcile(s, dbModel());
  assert.deepEqual(r.tables.map((t) => t.name), ['orders', 'customers']);
  assert.deepEqual(r.tables[0].columns, ['id']);
  assert.equal(r.joins.length, 1);
});
