import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parsePgerd, serializePgerd, stringifyPgerd, emptyModel, newTable, newColumn,
} from '../src/renderer/lib/pgerd.js';
import { generateSQL, formatType, quoteIdent, defaultForeignKeyName, defaultExpr } from '../src/renderer/lib/sql.js';
import { tableSize, routeLink, autoLayout } from '../src/renderer/lib/layout.js';

const sample = readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8');
const measure = (s) => String(s).length * 7;

test('parses tables, columns and relationships from a pgAdmin .pgerd file', () => {
  const m = parsePgerd(sample);
  assert.equal(m.version, 80900);
  assert.deepEqual(m.tables.map((t) => t.name).sort(), ['customer', 'order_item', 'orders', 'product']);
  const orders = m.tables.find((t) => t.name === 'orders');
  assert.equal(orders.schema, 'shop');
  assert.equal(orders.x, 400);
  assert.deepEqual(orders.columns.map((c) => c.name), ['id', 'customer_id', 'status', 'placed_at']);
  assert.ok(orders.columns[0].pk);
  assert.equal(m.links.length, 3);
  const itemToProduct = m.links.find(
    (l) => m.tables.find((t) => t.id === l.refTable).name === 'product'
  );
  assert.equal(itemToProduct.fkName, 'order_item_product_id_fkey');
  assert.ok(itemToProduct.raw, 'link layer entry attached');
  const noted = m.tables.find((t) => t.name === 'order_item');
  assert.equal(noted.note, 'Line items; composite PK.');
});

test('round-trips through serialize without losing data', () => {
  const m = parsePgerd(sample);
  const again = parsePgerd(stringifyPgerd(m));
  assert.equal(again.tables.length, m.tables.length);
  assert.equal(again.links.length, m.links.length);
  for (const t of m.tables) {
    const u = again.tables.find((x) => x.id === t.id);
    assert.equal(u.name, t.name);
    assert.equal(u.x, t.x);
    assert.deepEqual(u.columns.map((c) => [c.name, c.type, c.pk]), t.columns.map((c) => [c.name, c.type, c.pk]));
    // Unknown pgAdmin properties survive.
    assert.equal(u.rawData.spcname, 'pg_default');
  }
  assert.equal(generateSQL(again), generateSQL(m));
});

test('serialized output has the structure pgAdmin expects', () => {
  const out = serializePgerd(parsePgerd(sample));
  assert.equal(out.data.zoom, 100);
  const nodes = out.data.layers.find((l) => l.type === 'diagram-nodes').models;
  const links = out.data.layers.find((l) => l.type === 'diagram-links').models;
  for (const link of Object.values(links)) {
    const src = nodes[link.source];
    const tgt = nodes[link.target];
    assert.ok(src.ports.some((p) => p.id === link.sourcePort && p.links.includes(link.id)));
    assert.ok(tgt.ports.some((p) => p.id === link.targetPort && p.links.includes(link.id)));
    assert.equal(link.data.local_table_uid, link.target);
    assert.equal(link.data.referenced_table_uid, link.source);
    assert.ok(tgt.otherInfo.data.foreign_key.length > 0);
  }
});

test('writes a new diagram that can be read back', () => {
  const m = emptyModel();
  const a = newTable({ name: 'author', columns: [newColumn({ name: 'id', type: 'serial', pk: true, attnum: 0 })] });
  const b = newTable({
    name: 'book',
    x: 300,
    columns: [
      newColumn({ name: 'id', type: 'serial', pk: true, attnum: 0 }),
      newColumn({ name: 'author_id', type: 'integer', notNull: true, attnum: 1 }),
    ],
  });
  m.tables.push(a, b);
  m.links.push({ id: 'l1', type: 'onetomany', localTable: b.id, localCol: 1, refTable: a.id, refCol: 0, group: 'g', fkName: '' });
  const back = parsePgerd(stringifyPgerd(m));
  assert.equal(back.links.length, 1);
  assert.equal(back.links[0].localTable, b.id);
  // Unnamed relationships get PostgreSQL's default name, so running the
  // script again replaces the constraint instead of adding a copy.
  assert.match(generateSQL(back), /ALTER TABLE IF EXISTS public\.book\n\s+DROP CONSTRAINT IF EXISTS book_author_id_fkey,\n\s+ADD CONSTRAINT book_author_id_fkey FOREIGN KEY \(author_id\)\n\s+REFERENCES public\.author \(id\)/);
  assert.equal(defaultForeignKeyName({ name: 'x'.repeat(70) }, ['a']).length, 63);
});

test('rejects files that are not ERDs', () => {
  assert.throws(() => parsePgerd('not json'), /Not a valid \.pgerd file/);
  assert.throws(() => parsePgerd('{"foo": 1}'), /no diagram layers/);
});

test('generates PostgreSQL DDL', () => {
  const sql = generateSQL(parsePgerd(sample));
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS shop;/);
  assert.match(sql, /email character varying\(255\) NOT NULL/);
  assert.match(sql, /price numeric\(10,2\) NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(order_id, product_id\)/);
  assert.match(sql, /CONSTRAINT customer_email_key UNIQUE \(email\)/);
  assert.match(sql, /ON DELETE RESTRICT;/);
  assert.match(sql, /COMMENT ON TABLE public\.customer\n\s+IS 'Customers of the shop';/);
});

test('writes numeric defaults of bit columns as bit literals', () => {
  assert.equal(defaultExpr({ type: 'bit', default: '1' }), "B'1'");
  assert.equal(defaultExpr({ type: 'bit', length: 1, default: '0' }), "B'0'");
  assert.equal(defaultExpr({ type: 'bit(8)', default: '5' }), "B'00000101'");
  assert.equal(defaultExpr({ type: 'bit', length: 2, default: '7' }), "B'11'");
  assert.equal(defaultExpr({ type: 'bit varying', default: '101' }), "B'101'");
  assert.equal(defaultExpr({ type: 'bit', default: "B'1'" }), "B'1'");
  assert.equal(defaultExpr({ type: 'integer', default: '1' }), '1');
});

test('formats types and identifiers', () => {
  assert.equal(formatType({ type: 'character varying[]', length: 10 }), 'character varying(10)[]');
  assert.equal(formatType({ type: 'timestamp with time zone', length: 3 }), 'timestamp(3) with time zone');
  assert.equal(formatType({ type: 'integer', length: null }), 'integer');
  assert.equal(quoteIdent('user'), '"user"');
  assert.equal(quoteIdent('Order Items'), '"Order Items"');
  assert.equal(quoteIdent('orders'), 'orders');
});

test('layout places referenced tables before referencing ones', () => {
  const m = parsePgerd(sample);
  const sizes = new Map(m.tables.map((t) => [t.id, tableSize(t, measure)]));
  autoLayout(m, sizes);
  const x = (n) => m.tables.find((t) => t.name === n).x;
  assert.ok(x('customer') < x('orders'));
  assert.ok(x('orders') < x('order_item'));
  for (const l of m.links) {
    const r = routeLink(l, m.tables.find((t) => t.id === l.localTable), m.tables.find((t) => t.id === l.refTable), sizes);
    assert.match(r.path, /^M[-\d.]+,[-\d.]+ L/);
  }
});

test('layout with a grid puts every table on a grid line without shrinking gaps', () => {
  const m = parsePgerd(sample);
  const sizes = new Map(m.tables.map((t) => [t.id, tableSize(t, measure)]));
  autoLayout(m, sizes, { grid: 20, gapX: 120, gapY: 50 });
  for (const t of m.tables) {
    assert.equal(t.x % 20, 0, `${t.name}.x`);
    assert.equal(t.y % 20, 0, `${t.name}.y`);
  }
  for (const a of m.tables) {
    for (const b of m.tables) {
      if (a === b || a.x !== b.x || a.y >= b.y) continue;
      assert.ok(b.y - (a.y + sizes.get(a.id).height) >= 50);
    }
  }
});

test('keeps the custom palette in the file, outside the pgAdmin data', () => {
  const m = parsePgerd(sample);
  assert.deepEqual(m.palette, []);
  assert.equal('pgsqlErd' in serializePgerd(m), false, 'no key while the palette is empty');
  m.palette = ['#AA3366', '#aa3366', 'red', '#2f6fb3'];
  const json = serializePgerd(m);
  assert.deepEqual(json.pgsqlErd, { palette: ['#aa3366', '#2f6fb3'] });
  const again = parsePgerd(JSON.stringify(json));
  assert.deepEqual(again.palette, ['#aa3366', '#2f6fb3']);
  again.palette = [];
  assert.equal('pgsqlErd' in serializePgerd(again), false, 'emptied palette is dropped');
});

test('reads links saved with *_table_uuid and writes the *_table_uid keys pgAdmin reads', () => {
  const old = sample.replaceAll('"local_table_uid"', '"local_table_uuid"').replaceAll('"referenced_table_uid"', '"referenced_table_uuid"');
  const m = parsePgerd(old);
  assert.equal(m.links.length, parsePgerd(sample).links.length);
  const links = serializePgerd(m).data.layers.find((l) => l.type === 'diagram-links').models;
  for (const link of Object.values(links)) {
    assert.equal(link.data.local_table_uid, link.target);
    assert.equal(link.data.referenced_table_uid, link.source);
    assert.equal('local_table_uuid' in link.data, false);
    assert.equal('referenced_table_uuid' in link.data, false);
  }
});

test('saves the file pretty-printed so it diffs well', () => {
  const m = parsePgerd(sample);
  const text = stringifyPgerd(m);
  assert.ok(text.startsWith('{\n  "version": '));
  assert.ok(text.endsWith('}\n'));
  assert.equal(parsePgerd(text).tables.length, m.tables.length);
});

test('saving an unchanged diagram again writes the same text', () => {
  const once = stringifyPgerd(parsePgerd(sample));
  assert.equal(stringifyPgerd(parsePgerd(once)), once);
});
