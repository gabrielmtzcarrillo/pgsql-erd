// Apache AGE against a real PostgreSQL server: graphs, labels, vertices,
// relationships and Cypher through the Graph tab's service, and AGE's own
// schemas kept out of the diagram. Skipped unless PGERD_TEST_HOST is set (see
// tests/db.integration.test.js) and the server has the age extension.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = {
  host: process.env.PGERD_TEST_HOST,
  port: process.env.PGERD_TEST_PORT || 5432,
  user: process.env.PGERD_TEST_USER || 'postgres',
  password: process.env.PGERD_TEST_PASSWORD || '',
  database: 'postgres',
};
const dbName = `pgsql_erd_age_${process.pid}`;
const conn = { ...base, database: dbName };
const W = 1;
let db, age, connections;
const audit = [];

let enabled = false;
if (process.env.PGERD_TEST_HOST) {
  db = require('../src/main/db.cjs');
  const rows = await db.withClient(base, (c) => c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'age'")).then((r) => r.rows, () => []);
  enabled = rows.length > 0;
}

before(async () => {
  if (!enabled) return;
  const shared = await require('../src/main/shared.cjs').loadShared();
  const { ConnectionManager } = require('../src/main/database/connection-manager.cjs');
  const { AgeService } = require('../src/main/database/age.cjs');
  await db.execute(base, `CREATE DATABASE ${dbName}`);
  await db.execute(conn, 'CREATE TABLE customer (id serial PRIMARY KEY, name text)');
  const log = { log: (event, details) => audit.push({ event, ...details }) };
  connections = new ConnectionManager({ shared, audit: log });
  age = new AgeService({ connections, audit: log, shared });
  await connections.connect(W, conn, { environment: 'development' });
});

after(async () => {
  if (!enabled) return;
  await db.execute(base, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

test('age: install, graphs and labels', { skip: !enabled }, async () => {
  assert.deepEqual(await age.status(W), { available: true, version: null, graphs: [] });
  await age.change(W, 'install');
  await age.change(W, 'create-graph', { graph: 'social' });
  await assert.rejects(age.change(W, 'create-graph', { graph: 'x' }), /Invalid graph name/);
  await age.change(W, 'create-label', { graph: 'social', kind: 'v', label: 'Person' });
  await age.change(W, 'create-label', { graph: 'social', kind: 'e', label: 'KNOWS' });
  const s = await age.status(W);
  assert.match(s.version, /^\d/);
  assert.deepEqual(s.graphs, [{ name: 'social', vertexLabels: [{ name: 'Person', count: 0 }], edgeLabels: [{ name: 'KNOWS', count: 0 }] }]);
  assert.deepEqual(audit.filter((e) => e.event === 'graph-write').map((e) => e.action), ['create-extension', 'create-graph', 'create-label', 'create-label']);

  // The graph's label tables and ag_catalog stay out of the diagram import.
  const catalog = await db.introspect(conn);
  assert.deepEqual(catalog.tables.map((t) => `${t.schema}.${t.name}`), ['public.customer']);
  assert.ok(!catalog.schemas.includes('social') && !catalog.schemas.includes('ag_catalog'));
});

test('age: vertices and relationships', { skip: !enabled }, async () => {
  const g = { graph: 'social' };
  const ann = await age.change(W, 'create-vertex', { ...g, label: 'Person', properties: { name: "Ann O'Neil", tags: ['a'] } });
  const bob = await age.change(W, 'create-vertex', { ...g, label: 'Person', properties: { name: 'Bob' } });
  const acme = await age.change(W, 'create-vertex', { ...g, label: 'Company', properties: { name: 'Acme' } });
  assert.equal(ann.properties.name, "Ann O'Neil");
  assert.match(ann.id, /^\d+$/);

  const knows = await age.change(W, 'create-edge', { ...g, label: 'KNOWS', from: ann.id, to: bob.id, properties: { since: 2020 } });
  assert.deepEqual([knows.start, knows.end, knows.properties], [ann.id, bob.id, { since: 2020 }]);
  // A new relationship type is created on the fly.
  await age.change(W, 'create-edge', { ...g, label: 'WORKS_AT', from: bob.id, to: acme.id });
  await assert.rejects(age.change(W, 'create-edge', { ...g, label: 'KNOWS', from: ann.id, to: '999999' }), /no longer exists/);
  await assert.rejects(age.change(W, 'create-edge', { ...g, label: 'bad type', from: ann.id, to: bob.id }), /Invalid relationship type/);
  await assert.rejects(age.change(W, 'create-edge', { ...g, label: 'KNOWS', from: '1 OR 1=1', to: bob.id }), /Invalid start vertex/);

  let edges = await age.edges(W, { ...g });
  assert.equal(edges.total, 2);
  assert.deepEqual(edges.rows.map((r) => `${r.start.properties.name} ${r.edge.label} ${r.end.properties.name}`), ["Ann O'Neil KNOWS Bob", 'Bob WORKS_AT Acme']);
  assert.equal((await age.edges(W, { ...g, label: 'WORKS_AT' })).total, 1);
  assert.equal((await age.edges(W, { ...g, search: 'acme' })).total, 1);
  assert.equal((await age.edges(W, { ...g, around: ann.id })).total, 1);
  assert.equal((await age.edges(W, { ...g, limit: 1, offset: 1 })).rows[0].edge.label, 'WORKS_AT');
  await assert.rejects(age.edges(W, { ...g, label: 'NOPE' }), /does not exist/);

  const vertices = await age.vertices(W, { ...g });
  assert.deepEqual(vertices.rows.map((r) => [r.vertex.properties.name, r.degree]), [["Ann O'Neil", 1], ['Bob', 2], ['Acme', 1]]);
  assert.equal((await age.vertices(W, { ...g, label: 'Company' })).total, 1);
  assert.equal((await age.vertices(W, { ...g, search: bob.id })).rows[0].vertex.id, bob.id);

  const updated = await age.change(W, 'set-properties', { ...g, kind: 'edge', id: knows.id, properties: { since: 2021, note: 'met at "PGConf"' } });
  assert.deepEqual(updated.properties, { since: 2021, note: 'met at "PGConf"' });
  await age.change(W, 'set-properties', { ...g, kind: 'vertex', id: bob.id, properties: { name: 'Robert' } });
  assert.equal((await age.vertices(W, { ...g, ids: [bob.id] })).rows[0].vertex.properties.name, 'Robert');

  await age.change(W, 'delete-edge', { ...g, id: knows.id });
  edges = await age.edges(W, { ...g });
  assert.deepEqual(edges.rows.map((r) => r.edge.label), ['WORKS_AT']);
  // Deleting a vertex deletes its relationships.
  await age.change(W, 'delete-vertex', { ...g, id: acme.id });
  assert.equal((await age.edges(W, { ...g })).total, 0);
  assert.equal((await age.vertices(W, { ...g })).total, 2);
});

test('age: Cypher console', { skip: !enabled }, async () => {
  const g = { graph: 'social' };
  await assert.rejects(age.cypher(W, { ...g, query: "CREATE (:Person {name: 'Cy'})" }), /Allow changes/);
  const w = await age.cypher(W, { ...g, query: "CREATE (a:Person {name: 'Cy'})-[:KNOWS]->(b:Person {name: 'Di'}) RETURN a, b", allowChanges: true });
  assert.equal(w.committed, true);
  assert.deepEqual(w.rows[0].map((v) => v.properties.name), ['Cy', 'Di']);
  const r = await age.cypher(W, { ...g, query: "MATCH p = (a)-[r:KNOWS]->(b) WHERE a.name = 'Cy' RETURN p, a.name AS who" });
  assert.deepEqual(r.columns, ['p', 'who']);
  assert.equal(r.rows[0][0].kind, 'path');
  assert.equal(r.rows[0][1], 'Cy');
  const c = await age.cypher(W, { ...g, query: 'MATCH (n) RETURN *', columns: 'n' });
  assert.equal(c.columns[0], 'n');
  // Column names are quoted identifiers, not SQL.
  const odd = await age.cypher(W, { ...g, query: 'MATCH (n) RETURN n LIMIT 1', columns: 'n); DROP TABLE customer; --' });
  assert.deepEqual(odd.columns, ['n); DROP TABLE customer; --']);
  assert.equal((await db.introspect(conn)).tables.length, 1);
});

test('age: connection policy blocks changes', { skip: !enabled }, async () => {
  await connections.connect(W, conn, { environment: 'production' });
  await assert.rejects(age.change(W, 'create-vertex', { graph: 'social', label: 'Person', properties: {} }), /read-only/);
  await assert.rejects(age.cypher(W, { graph: 'social', query: "CREATE (:Person)", allowChanges: true }), /read-only/);
  assert.equal((await age.vertices(W, { graph: 'social' })).total, 4);
  await connections.connect(W, conn, { environment: 'development' });
  await age.change(W, 'drop-graph', { graph: 'social' });
  assert.deepEqual((await age.status(W)).graphs, []);
});
