import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newColumn } from '../src/renderer/lib/pgerd.js';
import { fkColumnName, newFkColumn, refColumnType, singlePrimaryKey } from '../src/renderer/lib/fkcolumn.js';

const table = (name, cols) => ({ name, columns: cols.map((c, i) => newColumn({ attnum: i, ...c })) });

test('the new column takes the referenced column name and plain type', () => {
  const customer = table('customer', [{ name: 'customer_id', type: 'bigserial', pk: true }]);
  const orders = table('orders', [{ name: 'id', type: 'bigserial', pk: true }]);
  const c = newFkColumn(orders, customer, customer.columns[0]);
  assert.equal(c.name, 'customer_id');
  assert.equal(c.type, 'bigint');
  assert.equal(c.attnum, 1);
  assert.equal(c.pk, false);
});

test('a taken name gets the referenced table as prefix, then a number', () => {
  const customer = table('customer', [{ name: 'id', type: 'serial', pk: true }]);
  const orders = table('orders', [{ name: 'ID', type: 'serial' }]);
  assert.equal(fkColumnName(orders, customer, customer.columns[0]), 'customer_id');
  orders.columns.push(newColumn({ name: 'customer_id', attnum: 1 }));
  assert.equal(fkColumnName(orders, customer, customer.columns[0]), 'customer_id_2');
});

test('length and precision are copied', () => {
  assert.deepEqual(refColumnType({ type: 'varchar', length: 20, precision: null }), { type: 'varchar', length: 20, precision: null });
  assert.deepEqual(refColumnType({ type: 'smallserial' }), { type: 'smallint', length: null, precision: null });
});

test('a drop on a table uses its primary key only when it has one column', () => {
  const one = table('a', [{ name: 'id', pk: true }, { name: 'x' }]);
  const two = table('b', [{ name: 'k1', pk: true }, { name: 'k2', pk: true }]);
  assert.equal(singlePrimaryKey(one).name, 'id');
  assert.equal(singlePrimaryKey(two), null);
  assert.equal(singlePrimaryKey(table('c', [{ name: 'x' }])), null);
});
