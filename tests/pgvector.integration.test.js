// pgvector against a real PostgreSQL server: DDL and migrations, script
// reads and writes of vector columns, seeding and the query analyzer.
// Skipped unless PGERD_TEST_HOST is set (see tests/db.integration.test.js)
// and the server has the pgvector extension available.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newTable, newColumn, emptyModel } from '../src/renderer/lib/pgerd.js';
import { generateSQL } from '../src/renderer/lib/sql.js';
import { modelFromCatalog } from '../src/renderer/lib/catalog.js';
import { diffModels } from '../src/renderer/lib/diff.js';
import { flattenPlan, analyzePlan } from '../src/shared/plan-analyzer.js';

const require = createRequire(import.meta.url);
const base = {
  host: process.env.PGERD_TEST_HOST,
  port: process.env.PGERD_TEST_PORT || 5432,
  user: process.env.PGERD_TEST_USER || 'postgres',
  password: process.env.PGERD_TEST_PASSWORD || '',
  database: 'postgres',
};
const dbName = `pgsql_erd_vector_${process.pid}`;
const conn = { ...base, database: dbName };
const W = 1;
let db, shared, connections, executions;
let runSeq = 0;

// Checked before the tests are declared, so they can be skipped.
let enabled = false;
if (process.env.PGERD_TEST_HOST) {
  db = require('../src/main/db.cjs');
  const rows = await db.withClient(base, (c) => c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).then((r) => r.rows, () => []);
  enabled = rows.length > 0;
}

before(async () => {
  if (!enabled) return;
  shared = await require('../src/main/shared.cjs').loadShared();
  const { ConnectionManager } = require('../src/main/database/connection-manager.cjs');
  const { ExecutionManager } = require('../src/main/scripting/execution-manager.cjs');
  const { ProjectManager } = require('../src/main/projects/project-manager.cjs');
  const audit = { log: () => {} };
  await db.execute(base, `CREATE DATABASE ${dbName}`);
  connections = new ConnectionManager({ shared, audit });
  executions = new ExecutionManager({ shared, connections, projects: new ProjectManager({ shared }), audit, limits: { timeoutMs: 20000 } });
});

after(async () => {
  if (!enabled) return;
  await executions.closeWindow(W);
  await db.execute(base, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

const load = async () => modelFromCatalog(await db.introspect(conn));
const run = (source, extra = {}) =>
  executions.run(W, { runId: `v${++runSeq}`, source, name: 'test', type: 'query', mode: 'dry-run', ...extra });

function diagram() {
  const m = emptyModel();
  m.tables.push(newTable({
    name: 'doc',
    schema: 'public',
    columns: [
      newColumn({ name: 'id', type: 'integer', pk: true, attnum: 0 }),
      newColumn({ name: 'title', type: 'text', notNull: true, attnum: 1 }),
    ],
  }));
  return m;
}

test('pgvector: migrations create the extension and vector columns', { skip: !enabled }, async () => {
  const erd = diagram();
  await db.execute(conn, generateSQL(erd));
  assert.deepEqual(diffModels(await load(), erd).changes, []);

  erd.tables[0].columns.push(newColumn({ name: 'embedding', type: 'vector', length: 3, notNull: true, attnum: 2 }));
  const { changes, sql } = diffModels(await load(), erd);
  assert.deepEqual(changes.map((c) => c.kind), ['create-extension', 'add-column']);
  await db.execute(conn, sql);

  const after = await load();
  assert.ok(after.extensions.includes('vector'));
  assert.equal(after.tables[0].columns.find((c) => c.name === 'embedding').type, 'vector');
  assert.equal(after.tables[0].columns.find((c) => c.name === 'embedding').length, 3);
  assert.deepEqual(diffModels(after, erd).changes, []);

  // A fresh database from exported DDL.
  await db.execute(conn, 'DROP TABLE doc; DROP EXTENSION vector;');
  await db.execute(conn, generateSQL(erd));
  assert.deepEqual(diffModels(await load(), erd).changes, []);
  await connections.connect(W, conn, { environment: 'development' });
});

test('pgvector: scripts read and write vectors as number arrays', { skip: !enabled }, async () => {
  const r = await run(
    `
    const row = await db.public.doc.insert({ id: 1, title: "a", embedding: [1, 0, 0] });
    await db.public.doc.insertMany([{ id: 2, title: "b", embedding: "[0,1,0]" }, { id: 3, title: "c", embedding: [0.6, 0.8, 0] }]);
    log(row.embedding);
    const found = await db.public.doc.where({ embedding: [0, 1, 0] }).select("id");
    log(found);
    log(await db.public.doc.where({ embedding: { in: [[1, 0, 0], [0.6, 0.8, 0]] } }).count());
    await db.public.doc.where({ id: 2 }).update({ embedding: [0, 0, 1] });
    const near = await db.query("SELECT id FROM doc ORDER BY embedding <=> $1 LIMIT 2", ["[1,0.1,0]"]);
    log(near.map((x) => x.id));
    const first = await db.public.doc.where({ id: 3 }).first();
    log(first?.embedding);
    log(await seed.check("doc", { id: 9, title: "x", embedding: [1, 2] }));
  `,
    { profile: 'full' }
  );
  assert.equal(r.error, null, r.error);
  assert.deepEqual(JSON.parse(r.output[0]), [1, 0, 0]);
  assert.deepEqual(JSON.parse(r.output[1]), [{ id: 2 }]);
  assert.equal(r.output[2], '2');
  assert.deepEqual(JSON.parse(r.output[3]), [1, 3]);
  assert.deepEqual(JSON.parse(r.output[4]), [0.6, 0.8, 0]);
  assert.match(r.output[5], /embedding: must have at least 3 items/);
});

test('pgvector: typed scripts accept number arrays', { skip: !enabled }, async () => {
  const dts = shared.generateDatabaseDts(await connections.schema(W));
  assert.match(dts, /embedding: number\[\];/);
  assert.match(dts, /embedding: number\[\] \| string;/);
});

test('pgvector: seed.fill generates vectors', { skip: !enabled }, async () => {
  const r = await run(
    `
    faker.seed(3);
    const rows = await seed.fill("doc", 5, (i) => ({ id: 100 + i }));
    log(rows.every((x) => Array.isArray(x.embedding) && x.embedding.length === 3));
  `,
    { type: 'generator' }
  );
  assert.equal(r.error, null, r.error);
  assert.equal(r.output[0], 'true');
  assert.equal(r.inserts, 5);
});

test('pgvector: data browser and query analyzer', { skip: !enabled }, async () => {
  const { runQuery } = require('../src/main/database/query-runner.cjs');
  const ctx = { openClient: () => connections.client(W), policy: { allowWrites: true, allowDDL: true }, audit: () => {}, shared };
  await runQuery(ctx, {
    sql: `INSERT INTO doc SELECT g, 't' || g, ARRAY[random(), random(), random()]::vector FROM generate_series(1, 3000) g;
          ANALYZE doc`,
    allowChanges: true,
  });
  const q = "SELECT id FROM doc ORDER BY embedding <=> '[1,0,0]' LIMIT 5";
  let schema = (await connections.refresh(W)).schema;
  let p = await runQuery(ctx, { sql: q, explain: 'analyze' });
  const hints = analyzePlan(flattenPlan(p.plan), schema);
  const hint = hints.find((h) => /Nearest-neighbour/.test(h.message));
  assert.ok(hint, JSON.stringify(hints));
  assert.equal(hint.sql, 'CREATE INDEX ON "public"."doc" USING hnsw ("embedding" vector_cosine_ops);');

  // The suggested index is valid and the planner uses it.
  await runQuery(ctx, { sql: hint.sql, allowChanges: true });
  schema = (await connections.refresh(W)).schema;
  p = await runQuery(ctx, { sql: q, explain: 'plan' });
  const flat = flattenPlan(p.plan);
  assert.ok(flat.nodes.some((n) => n.type === 'Index Scan' && n.relation === 'public.doc'), JSON.stringify(flat.nodes.map((n) => n.type)));
  assert.deepEqual(analyzePlan(flat, schema).filter((h) => /Nearest-neighbour/.test(h.message)), []);

  const browser = require('../src/main/database/data-browser.cjs');
  const t = shared.findTable(schema, 'doc');
  const readOnly = async (fn) => {
    const c = await connections.client(W);
    try {
      await c.query('BEGIN TRANSACTION READ ONLY');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  };
  const page = await browser.browse(readOnly, t, { limit: 1, sort: [{ column: 'id' }] });
  assert.match(page.rows[0].embedding, /^\[[-0-9.e,]+\]$/);
});
