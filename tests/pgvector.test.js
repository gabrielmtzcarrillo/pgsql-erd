import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vectorKind, vectorDimensions, usesPgvector, toVectorText, parseVectorText, abbreviateVector,
  vectorIndexSQL, vectorIndexesOn, randomVector,
} from '../src/shared/pgvector.js';
import { newTable, newColumn, emptyModel } from '../src/renderer/lib/pgerd.js';
import { generateSQL, formatType } from '../src/renderer/lib/sql.js';
import { modelFromCatalog, splitType } from '../src/renderer/lib/catalog.js';
import { diffModels } from '../src/renderer/lib/diff.js';
import { schemaFromCatalog } from '../src/shared/schema-model.js';
import { tsType } from '../src/shared/typegen.js';
import { tableJsonSchema, checkRowAgainstTable } from '../src/shared/json-schema.js';
import { valueForColumn } from '../src/shared/seed.js';
import { createFaker } from '../src/shared/fake.js';
import { analyzePlan, flattenPlan } from '../src/shared/plan-analyzer.js';
import { describeTable } from '../src/shared/context-builder.js';

test('recognizes pgvector types', () => {
  assert.equal(vectorKind('vector'), 'vector');
  assert.equal(vectorKind('vector(1536)'), 'vector');
  assert.equal(vectorKind('public.halfvec(3)'), 'halfvec');
  assert.equal(vectorKind('"extensions"."sparsevec"(5)'), 'sparsevec');
  assert.equal(vectorKind('VECTOR'), 'vector');
  assert.equal(vectorKind('vector(3)[]'), null);
  assert.equal(vectorKind('tsvector'), null);
  assert.equal(vectorKind('text'), null);
  assert.equal(vectorDimensions('vector(1536)'), 1536);
  assert.equal(vectorDimensions('vector'), null);
  assert.deepEqual(splitType('vector(1536)'), { type: 'vector', length: 1536, precision: null });
  assert.equal(formatType({ type: 'vector', length: 3 }), 'vector(3)');
});

test('encodes and decodes vector values', () => {
  assert.equal(toVectorText('vector', [1, 2.5, -3]), '[1,2.5,-3]');
  assert.equal(toVectorText('halfvec', new Float32Array([0.5, 1])), '[0.5,1]');
  assert.equal(toVectorText('sparsevec', [0, 1.5, 0, 2]), '{2:1.5,4:2}/4');
  assert.equal(toVectorText('vector', '[1,2]'), '[1,2]');
  assert.throws(() => toVectorText('vector', [1, NaN]), /not a finite number/);
  assert.deepEqual(parseVectorText('[1,2.5,-3]'), [1, 2.5, -3]);
  assert.deepEqual(parseVectorText('[]'), []);
  assert.equal(parseVectorText('{1:1}/3'), '{1:1}/3');
  assert.equal(abbreviateVector('[1,2,3]'), '[1,2,3]');
  assert.equal(abbreviateVector('[1,2,3,4,5,6,7,8]', 3), '[1,2,3,…] (8 dims)');
});

test('index SQL for nearest-neighbour search', () => {
  const t = { schema: 'public', name: 'items' };
  assert.equal(vectorIndexSQL(t, { name: 'embedding', type: 'vector', length: 3 }).sql,
    'CREATE INDEX ON "public"."items" USING hnsw ("embedding" vector_cosine_ops);');
  assert.equal(vectorIndexSQL(t, { name: 'embedding', databaseType: 'vector(3)' }, { metric: 'l2', method: 'ivfflat' }).sql,
    'CREATE INDEX ON "public"."items" USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100);');
  const big = vectorIndexSQL(t, { name: 'e', databaseType: 'vector(3072)' });
  assert.equal(big.sql, 'CREATE INDEX ON "public"."items" USING hnsw (("e"::halfvec(3072)) halfvec_cosine_ops);');
  assert.match(big.note, /halfvec/);
  assert.equal(vectorIndexSQL(t, { name: 'e', databaseType: 'vector(5000)' }), null);
  assert.equal(vectorIndexSQL(t, { name: 'e', databaseType: 'sparsevec(5)' }, { method: 'ivfflat' }), null);
  assert.equal(vectorIndexSQL(t, { name: 'e', databaseType: 'text' }), null);

  const table = { indexes: [
    { name: 'a', definition: 'CREATE INDEX a ON public.items USING hnsw (embedding vector_cosine_ops)' },
    { name: 'b', definition: 'CREATE INDEX b ON public.items USING hnsw (((e)::halfvec(3072)) halfvec_l2_ops)' },
    { name: 'c', definition: 'CREATE INDEX c ON public.items USING btree (embedding_model)' },
  ] };
  assert.deepEqual(vectorIndexesOn(table, 'embedding'), [{ name: 'a', method: 'hnsw', metric: 'cosine' }]);
  assert.deepEqual(vectorIndexesOn(table, 'e'), [{ name: 'b', method: 'hnsw', metric: 'l2' }]);
});

function itemsModel() {
  const m = emptyModel();
  m.tables.push(newTable({
    name: 'items',
    schema: 'public',
    columns: [
      newColumn({ name: 'id', type: 'bigint', pk: true, attnum: 0 }),
      newColumn({ name: 'embedding', type: 'vector', length: 3, attnum: 1 }),
    ],
  }));
  return m;
}

test('DDL creates the extension for vector columns', () => {
  const sql = generateSQL(itemsModel());
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector;\n\nCREATE TABLE IF NOT EXISTS public\.items/);
  assert.match(sql, /embedding vector\(3\)/);
  const plain = itemsModel();
  plain.tables[0].columns.pop();
  assert.doesNotMatch(generateSQL(plain), /EXTENSION/);
  assert.equal(usesPgvector(plain.tables), false);
});

test('migrations create the extension only when the database lacks it', () => {
  const catalog = (extensions, withVector) => ({
    schemas: ['public'],
    extensions,
    tables: [{ oid: 1, schema: 'public', name: 'items' }],
    columns: [
      { oid: 1, attnum: 1, name: 'id', type: 'bigint', notnull: true },
      ...(withVector ? [{ oid: 1, attnum: 2, name: 'embedding', type: 'vector(3)', notnull: false }] : []),
    ],
    constraints: [{ oid: 1, name: 'items_pkey', type: 'p', cols: [1] }],
  });
  const erd = itemsModel();

  let { changes, sql } = diffModels(modelFromCatalog(catalog([{ name: 'plpgsql' }], false)), erd);
  assert.deepEqual(changes.map((c) => c.kind), ['create-extension', 'add-column']);
  assert.ok(sql.indexOf('CREATE EXTENSION') < sql.indexOf('ADD COLUMN embedding vector(3)'));

  ({ changes } = diffModels(modelFromCatalog(catalog([{ name: 'vector' }], true)), erd));
  assert.deepEqual(changes, []);
  // Without the extension list, an existing vector column means it's installed.
  ({ changes } = diffModels(modelFromCatalog(catalog(undefined, true)), erd));
  assert.deepEqual(changes, []);

  erd.tables[0].columns[1].length = 4;
  ({ changes } = diffModels(modelFromCatalog(catalog([{ name: 'vector' }], true)), erd));
  assert.deepEqual(changes.map((c) => c.summary), ['Change embedding type vector(3) → vector(4)']);
});

const schema = () => schemaFromCatalog({
  tables: [{ oid: 1, schema: 'public', name: 'items' }],
  columns: [
    { oid: 1, attnum: 1, name: 'id', type: 'bigint', notnull: true },
    { oid: 1, attnum: 2, name: 'embedding', type: 'vector(3)', notnull: true },
    { oid: 1, attnum: 3, name: 'small', type: 'halfvec(2)', notnull: false },
    { oid: 1, attnum: 4, name: 'sparse', type: 'sparsevec(5)', notnull: false },
    { oid: 1, attnum: 5, name: 'many', type: 'vector(3)[]', notnull: false },
  ],
  constraints: [{ oid: 1, name: 'items_pkey', type: 'p', cols: [1] }],
  indexes: [],
});

test('script types, JSON schema and row checks for vectors', () => {
  const t = schema().schemas[0].tables[0];
  const col = (n) => t.columns.find((c) => c.name === n);
  assert.equal(tsType(col('embedding')), 'number[]');
  assert.equal(tsType(col('embedding'), new Map(), 'insert'), 'number[] | string');
  assert.equal(tsType(col('small')), 'number[]');
  assert.equal(tsType(col('sparse')), 'string');
  assert.equal(tsType(col('sparse'), new Map(), 'insert'), 'string | number[]');
  assert.equal(tsType(col('many')), 'string[]');

  const js = tableJsonSchema(t);
  assert.deepEqual(js.properties.embedding, { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 });
  assert.deepEqual(checkRowAgainstTable(t, { id: 1, embedding: [1, 2, 3] }), []);
  assert.deepEqual(checkRowAgainstTable(t, { id: 1, embedding: '[1,2,3]' }), []);
  assert.deepEqual(checkRowAgainstTable(t, { id: 1, embedding: new Float32Array([1, 2, 3]) }), []);
  assert.match(checkRowAgainstTable(t, { id: 1, embedding: [1, 2] }).join(), /embedding: must have at least 3 items/);
  assert.deepEqual(checkRowAgainstTable(t, { id: 1, embedding: [1, 2, 3], sparse: '{1:1}/5' }), []);
});

test('seed generates unit vectors with the column dimensions', () => {
  const t = schema().schemas[0].tables[0];
  const faker = createFaker(1);
  const v = valueForColumn(t.columns.find((c) => c.name === 'embedding'), faker);
  assert.equal(v.length, 3);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-4);
  assert.match(valueForColumn(t.columns.find((c) => c.name === 'sparse'), faker), /^\{.*\}\/5$/);
  assert.equal(randomVector(faker, 1536).length, 1536);
});

test('query analyzer suggests an HNSW index for nearest-neighbour sorts', () => {
  const plan = (sortKey) => ({
    Plan: {
      'Node Type': 'Limit', 'Plan Rows': 5,
      Plans: [{
        'Node Type': 'Sort', 'Sort Key': [sortKey], 'Plan Rows': 10000,
        Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'items', Schema: 'public', Alias: 'items', 'Plan Rows': 10000 }],
      }],
    },
  });
  const s = schema();
  let hints = analyzePlan(flattenPlan(plan("(embedding <=> '[1,2,3]'::vector)")), s);
  assert.equal(hints.length, 1);
  assert.match(hints[0].message, /Nearest-neighbour search on public\.items\.embedding \(cosine distance, <=>\)/);
  assert.equal(hints[0].sql, 'CREATE INDEX ON "public"."items" USING hnsw ("embedding" vector_cosine_ops);');

  hints = analyzePlan(flattenPlan(plan("(items.embedding <-> '[1,2,3]'::vector)")), s);
  assert.equal(hints[0].sql, 'CREATE INDEX ON "public"."items" USING hnsw ("embedding" vector_l2_ops);');

  // An index for another operator is named; a matching one gets an info note instead.
  s.schemas[0].tables[0].indexes.push({ name: 'items_l2', columns: ['embedding'], definition: 'CREATE INDEX items_l2 ON public.items USING hnsw (embedding vector_l2_ops)' });
  hints = analyzePlan(flattenPlan(plan("(embedding <=> '[1,2,3]'::vector)")), s);
  assert.match(hints[0].message, /items_l2 is for <->, not <=>/);
  hints = analyzePlan(flattenPlan(plan("(embedding <-> '[1,2,3]'::vector)")), s);
  assert.equal(hints[0].severity, 'info');
  assert.equal(hints[0].sql, undefined);

  // Sorting by an ordinary column is left alone.
  assert.deepEqual(analyzePlan(flattenPlan(plan('items.id')), s), []);
});

test('assistant context shows vector index methods', () => {
  const t = schema().schemas[0].tables[0];
  t.indexes.push({ name: 'items_hnsw', columns: ['embedding'], unique: false, definition: 'CREATE INDEX items_hnsw ON public.items USING hnsw (embedding vector_cosine_ops)' });
  assert.match(describeTable(t), /INDEX items_hnsw USING hnsw \(embedding vector_cosine_ops\)/);
  assert.match(describeTable(t), /embedding vector\(3\) NOT NULL/);
});
