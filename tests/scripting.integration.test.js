// Script runs against a real PostgreSQL server: dry runs, commits,
// permissions, validators and generated test data. Skipped unless
// PGERD_TEST_HOST is set (see tests/db.integration.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const enabled = !!process.env.PGERD_TEST_HOST;
const base = {
  host: process.env.PGERD_TEST_HOST,
  port: process.env.PGERD_TEST_PORT || 5432,
  user: process.env.PGERD_TEST_USER || 'postgres',
  password: process.env.PGERD_TEST_PASSWORD || '',
  database: 'postgres',
};
const dbName = `pgsql_erd_script_${process.pid}`;
const conn = { ...base, database: dbName };
const W = 1; // window id
let db, shared, connections, executions, projects, audit;
let runSeq = 0;

const SETUP = `
CREATE TYPE mood AS ENUM ('ok', 'sad');
CREATE TABLE cat_area (id serial PRIMARY KEY, name varchar(60) NOT NULL UNIQUE);
CREATE TABLE employee (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name text NOT NULL,
  email varchar(120) UNIQUE,
  area_id integer REFERENCES cat_area(id),
  mood mood NOT NULL DEFAULT 'ok',
  hired_on date,
  active boolean NOT NULL DEFAULT true,
  CHECK (length(full_name) > 1)
);
CREATE INDEX employee_name_idx ON employee (full_name);
INSERT INTO cat_area (name) VALUES ('Finance'), ('IT');
INSERT INTO employee (full_name, email, area_id) VALUES ('Ana López', 'ana@example.com', 1), ('Luis Pérez', NULL, NULL);
`;

before(async () => {
  if (!enabled) return;
  db = require('../src/main/db.cjs');
  shared = await require('../src/main/shared.cjs').loadShared();
  const { ConnectionManager } = require('../src/main/database/connection-manager.cjs');
  const { ExecutionManager } = require('../src/main/scripting/execution-manager.cjs');
  const { ProjectManager } = require('../src/main/projects/project-manager.cjs');
  const events = [];
  audit = { events, log: (event, details) => events.push({ event, ...details }) };
  await db.execute(base, `CREATE DATABASE ${dbName}`);
  await db.execute(conn, SETUP);
  connections = new ConnectionManager({ shared, audit });
  projects = new ProjectManager({ shared });
  executions = new ExecutionManager({ shared, connections, projects, audit, limits: { timeoutMs: 20000 } });
  await connections.connect(W, conn, { environment: 'development' });
});

after(async () => {
  if (!enabled) return;
  await executions.closeWindow(W);
  await db.execute(base, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

const run = (source, extra = {}) =>
  executions.run(W, { runId: `r${++runSeq}`, source, name: 'test', type: 'query', mode: 'dry-run', ...extra });
const count = async (table) => Number((await db.withClient(conn, (c) => c.query(`SELECT count(*) FROM ${table}`))).rows[0].count);

test('schema model includes enums, checks and indexes', { skip: !enabled }, async () => {
  const schema = await connections.schema(W);
  const emp = shared.findTable(schema, 'employee');
  assert.equal(emp.id, 'public.employee');
  assert.deepEqual(schema.enums, [{ schema: 'public', name: 'mood', values: ['ok', 'sad'] }]);
  assert.equal(emp.checks.length, 1);
  assert.deepEqual(emp.indexes.map((i) => i.name), ['employee_name_idx']);
  assert.equal(emp.columns.find((c) => c.name === 'id').identity, 'a');
  assert.deepEqual(emp.foreignKeys[0].refTable, 'public.cat_area');
  assert.match(shared.generateDatabaseDts(schema), /mood: "ok" \| "sad";/);
});

test('reads rows with the typed API', { skip: !enabled }, async () => {
  const r = await run(`
    const rows = await db.public.employee.where({ area_id: { isNull: false } }).orderBy("id").select("full_name", "email");
    log(rows);
    log(await db.table("employee").count());
  `);
  assert.equal(r.error, null);
  assert.equal(r.status, 'rolled back');
  assert.deepEqual(JSON.parse(r.output[0]), [{ full_name: 'Ana López', email: 'ana@example.com' }]);
  assert.equal(r.output[1], '2');
  assert.equal(r.rowsRead, 1);
});

test('type errors stop the run unless ignored', { skip: !enabled }, async () => {
  const r = await run('await db.public.employee.insert({ full_name: 123 });', { profile: 'full' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'typecheck');
  assert.match(r.diagnostics[0].message, /not assignable to type 'string'/);
});

test('unknown table names are flagged', { skip: !enabled }, async () => {
  const schema = await connections.schema(W);
  const d = executions.check(schema, 'await db.table("nope").select();');
  assert.equal(d.find((x) => x.code === 'pgsql-erd').severity, 'warning');
});

test('writes are denied without permission (read-only transaction)', { skip: !enabled }, async () => {
  const r = await run('await db.public.cat_area.insert({ name: "Legal" });');
  assert.match(r.error, /Permission denied: INSERT/);
  const r2 = await run("await db.query(\"UPDATE cat_area SET name = 'x'\");", { profile: 'read-only', overrides: { rawSql: false } });
  assert.match(r2.error, /Permission denied/);
  assert.equal(await count('cat_area'), 2);
});

test('dry run rolls back and reports counts', { skip: !enabled }, async () => {
  const r = await run(
    `
    await db.public.cat_area.insert({ name: "Legal" });
    await db.public.employee.where({ email: "ana@example.com" }).update({ active: false });
    await db.table("employee").where({ email: null }).delete();
    log(await db.public.cat_area.count());
  `,
    { profile: 'full' }
  );
  assert.equal(r.error, null);
  assert.equal(r.status, 'rolled back');
  assert.deepEqual([r.inserts, r.updates, r.deletes], [1, 1, 1]);
  assert.deepEqual(
    r.affectedTables.sort((a, b) => a.table.localeCompare(b.table)),
    [
      { table: 'public.cat_area', insert: 1, update: 0, delete: 0 },
      { table: 'public.employee', insert: 0, update: 1, delete: 1 },
    ]
  );
  assert.equal(r.output[0], '3');
  assert.equal(await count('cat_area'), 2);
  assert.equal(await count('employee'), 2);
});

test('run holds the transaction until commit', { skip: !enabled }, async () => {
  const r = await run('await db.public.cat_area.insert({ name: "Research" });', { mode: 'run', profile: 'seeder' });
  assert.equal(r.status, 'pending');
  await assert.rejects(run('log(1)'), /Commit or discard/);
  assert.equal(await count('cat_area'), 2);
  const c = await executions.commit(W, r.runId);
  assert.equal(c.status, 'committed');
  assert.equal(await count('cat_area'), 3);
  assert.ok(audit.events.some((e) => e.event === 'database-write'));
});

test('discard rolls a pending run back', { skip: !enabled }, async () => {
  const r = await run('await db.public.cat_area.insert({ name: "Temp" });', { mode: 'run', profile: 'seeder' });
  assert.equal(r.status, 'pending');
  await executions.discard(W, r.runId);
  assert.equal(await count('cat_area'), 3);
});

test('read-only runs complete without a pending commit', { skip: !enabled }, async () => {
  const r = await run('log(await db.public.cat_area.count())', { mode: 'run' });
  assert.equal(r.status, 'completed');
});

test('production policy blocks writes and DDL', { skip: !enabled }, async () => {
  await connections.connect(W, conn, { environment: 'production' });
  try {
    const r = await run('await db.public.cat_area.insert({ name: "X" });', { profile: 'full' });
    assert.match(r.error, /Permission denied/);
    assert.ok(r.restricted.includes('insertData'));
    await assert.rejects(connections.execute(W, 'SELECT 1'), /doesn't allow schema changes/);
  } finally {
    await connections.connect(W, conn, { environment: 'development' });
  }
});

test('savepoints undo a failed db.transaction()', { skip: !enabled }, async () => {
  const r = await run(
    `
    try {
      await db.transaction(async (tx) => {
        await tx.public.cat_area.insert({ name: "Inner" });
        throw new Error("boom");
      });
    } catch (e) { log("caught", (e as Error).message); }
    await db.public.cat_area.insert({ name: "Outer" });
    log(await db.public.cat_area.where({ name: ["Inner", "Outer"] }).count());
  `,
    { profile: 'seeder' }
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.output, ['caught boom', '1']);
  assert.equal(r.inserts, 1);
});

test('validators report errors per validation', { skip: !enabled }, async () => {
  const r = await run(
    `
    validate("Employees have an area", async () => {
      for (const e of await db.public.employee.select()) {
        if (!e.area_id) report.error({ table: "public.employee", row: e.id, column: "area_id", message: "No area" });
      }
    });
    validate("Areas have names", async () => {
      const n = await db.public.cat_area.where({ name: { eq: "" } }).count();
      if (n) report.error("Empty names");
    });
  `,
    { type: 'validator' }
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.validations.map((v) => [v.name, v.status, v.errors]), [
    ['Employees have an area', 'failed', 1],
    ['Areas have names', 'passed', 0],
  ]);
  const m = r.messages[0];
  assert.equal(m.table, 'public.employee');
  assert.equal(m.row, '2');
  assert.equal(m.validation, 'Employees have an area');
  assert.equal(r.success, false);
});

test('seed.fill generates valid rows with foreign keys', { skip: !enabled }, async () => {
  const r = await run(
    `
    faker.seed(7);
    const order = db.describe.insertOrder(["employee", "cat_area"]);
    log(order);
    const rows = await seed.fill("public.employee", 25);
    const areas = (await db.public.cat_area.select()).map((a) => a.id);
    log(rows.length, rows.every((e) => e.area_id === null || areas.includes(e.area_id)));
    log(await seed.check("employee", { full_name: "A", area_id: 999 }));
  `,
    { type: 'generator' }
  );
  assert.equal(r.error, null, r.error);
  assert.deepEqual(JSON.parse(r.output[0]), ['public.cat_area', 'public.employee']);
  assert.equal(r.output[1], '25 true');
  assert.match(r.output[2], /no matching row in public.cat_area/);
  assert.equal(r.inserts, 25);
  assert.equal(await count('employee'), 2);
});

test('raw DDL needs the DDL permission and marks the schema changed', { skip: !enabled }, async () => {
  const denied = await run('await db.query("ALTER TABLE cat_area ADD COLUMN code text");', { profile: 'seeder' });
  assert.match(denied.error, /executeDDL/);
  const r = await run('await db.query("ALTER TABLE cat_area ADD COLUMN code text");', { profile: 'migration' });
  assert.equal(r.error, null);
  assert.equal(r.schemaChanged, true);
  assert.equal(r.status, 'rolled back');
  const tx = await run('await db.query("COMMIT");', { profile: 'full' });
  assert.match(tx.error, /transaction managed by the app/);
});

test('long scripts are stopped at the timeout', { skip: !enabled }, async () => {
  const { ExecutionManager } = require('../src/main/scripting/execution-manager.cjs');
  const quick = new ExecutionManager({ shared, connections, projects, audit, limits: { timeoutMs: 1500 } });
  const r = await quick.run(W, { runId: 'slow', source: 'await new Promise((r) => setTimeout(r, 10000));', mode: 'dry-run' });
  assert.match(r.error, /longer than/);
  assert.equal(r.status, 'failed');
});

// ------------------------------------------------------------ data browser

async function readOnly(fn) {
  const c = await connections.client(W);
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

test('data browser: pages, sorting and Excel-style filters', { skip: !enabled }, async () => {
  const browser = require('../src/main/database/data-browser.cjs');
  const t = shared.findTable(await connections.refresh(W).then((r) => r.schema), 'employee');
  const all = await browser.browse(readOnly, t, { sort: [{ column: 'full_name', direction: 'desc' }] });
  assert.equal(all.total, 2);
  assert.deepEqual(all.rows.map((r) => r.full_name), ['Luis Pérez', 'Ana López']);
  assert.equal(all.rows[0].id, '2'); // text output
  const byValue = await browser.browse(readOnly, t, { filters: { email: { values: ['ana@example.com'] } } });
  assert.deepEqual(byValue.rows.map((r) => r.id), ['1']);
  const blanks = await browser.browse(readOnly, t, { filters: { email: { values: [], blanks: true } } });
  assert.deepEqual(blanks.rows.map((r) => r.id), ['2']);
  const cond = await browser.browse(readOnly, t, { filters: { full_name: { cond: { op: 'contains', value: 'LÓP' } } } });
  assert.equal(cond.total, 1);
  const num = await browser.browse(readOnly, t, { filters: { id: { cond: { op: 'gt', value: '1' } } } });
  assert.deepEqual(num.rows.map((r) => r.id), ['2']);
  const like = await browser.browse(readOnly, t, { filters: { full_name: { cond: { op: 'contains', value: '%' } } } });
  assert.equal(like.total, 0); // % is literal
  const page = await browser.browse(readOnly, t, { limit: 1, offset: 1 });
  assert.deepEqual([page.rows.length, page.total, page.rows[0].id], [1, 2, '2']);
  // The value list ignores the column's own filter but applies the others.
  const d = await browser.distinct(readOnly, t, 'email', { filters: { email: { values: ['x'] }, id: { cond: { op: 'lte', value: '2' } } } });
  assert.deepEqual(d.values, [{ value: null, count: 1 }, { value: 'ana@example.com', count: 1 }]);
  const searched = await browser.distinct(readOnly, t, 'full_name', { search: 'ana' });
  assert.deepEqual(searched.values.map((v) => v.value), ['Ana López']);
  await assert.rejects(browser.browse(readOnly, t, { filters: { nope: { values: [] } } }), /Unknown column/);
});

// ------------------------------------------------------------ query tab

test('query tab: reads, guarded writes and plans', { skip: !enabled }, async () => {
  const { runQuery } = require('../src/main/database/query-runner.cjs');
  const { flattenPlan, analyzePlan } = await import('../src/shared/plan-analyzer.js');
  const events = [];
  const ctx = (policy = { allowWrites: true, allowDDL: true }) => ({
    openClient: () => connections.client(W),
    policy,
    audit: (e, d) => events.push({ e, ...d }),
    shared,
  });
  const r = await runQuery(ctx(), { sql: 'SELECT id, full_name, hired_on FROM employee ORDER BY id; SELECT 1 AS one' });
  assert.equal(r.kind, 'results');
  assert.deepEqual(r.results[0].columns, ['id', 'full_name', 'hired_on']);
  assert.deepEqual(r.results[0].rows[0], ['1', 'Ana López', null]);
  assert.deepEqual(r.results[1].rows, [['1']]);
  await assert.rejects(runQuery(ctx(), { sql: "UPDATE cat_area SET name = name" }), /Allow changes/);
  await assert.rejects(runQuery(ctx({ allowWrites: false, allowDDL: false }), { sql: 'UPDATE cat_area SET name = name', allowChanges: true }), /read-only/);
  await assert.rejects(runQuery(ctx(), { sql: 'BEGIN; SELECT 1' }), /does not end with COMMIT/);
  await assert.rejects(runQuery(ctx(), { sql: 'SELECT 1; COMMIT' }), /single BEGIN/);
  await assert.rejects(runQuery(ctx(), { sql: 'BEGIN; UPDATE cat_area SET name = name; COMMIT' }), /Allow changes/);
  const tx = await runQuery(ctx(), {
    sql: "BEGIN ISOLATION LEVEL SERIALIZABLE;\nCREATE TABLE tx_demo (id int);\nSAVEPOINT a;\nINSERT INTO tx_demo VALUES (1);\nROLLBACK TO a;\nINSERT INTO tx_demo VALUES (2);\nSELECT current_setting('transaction_isolation') AS iso;\nCOMMIT;",
    allowChanges: true,
  });
  assert.equal(tx.committed, true);
  assert.deepEqual(tx.results.at(-1).rows, [['serializable']]);
  assert.deepEqual((await runQuery(ctx(), { sql: 'SELECT id FROM tx_demo' })).results[0].rows, [['2']]);
  const dry = await runQuery(ctx(), { sql: 'BEGIN; DELETE FROM tx_demo; ROLLBACK;', allowChanges: true });
  assert.equal(dry.committed, false);
  assert.equal(dry.rolledBack, true);
  assert.equal(dry.results[0].rowCount, 1);
  assert.deepEqual((await runQuery(ctx(), { sql: 'SELECT count(*) FROM tx_demo' })).results[0].rows, [['1']]);
  await assert.rejects(runQuery(ctx(), { sql: 'BEGIN READ WRITE; DO $$ BEGIN DELETE FROM tx_demo; END $$; COMMIT' }), /read-only transaction/);
  await assert.rejects(runQuery(ctx(), { sql: 'BEGIN;\nSELEC 1;\nCOMMIT' }), /at character 8/);
  await assert.rejects(runQuery(ctx(), { sql: 'SELEC 1' }), /syntax error.*at character 1/);
  const w = await runQuery(ctx(), { sql: "CREATE TABLE big AS SELECT g AS id, g % 100 AS grp, md5(g::text) AS label FROM generate_series(1, 20000) g", allowChanges: true });
  assert.equal(w.committed, true);
  assert.equal(events.at(-1).e, 'query-write');
  await runQuery(ctx(), { sql: 'ANALYZE big', allowChanges: true });

  const p = await runQuery(ctx(), { sql: 'SELECT * FROM big WHERE grp = 7', explain: 'analyze' });
  assert.equal(p.kind, 'plan');
  const flat = flattenPlan(p.plan);
  assert.equal(flat.analyzed, true);
  assert.ok(flat.nodes.some((n) => n.type === 'Seq Scan' && n.relation === 'public.big'));
  const schema = (await connections.refresh(W)).schema;
  const hints = analyzePlan(flat, schema);
  const seq = hints.find((h) => /Sequential scan on public\.big/.test(h.message));
  assert.ok(seq, JSON.stringify(hints));
  assert.equal(seq.sql, 'CREATE INDEX ON "public"."big" ("grp");');
  // FK without index on employee.area_id
  const p2 = await runQuery(ctx(), { sql: 'SELECT * FROM employee e JOIN cat_area a ON a.id = e.area_id', explain: 'plan' });
  const hints2 = analyzePlan(flattenPlan(p2.plan), schema);
  assert.ok(hints2.some((h) => h.sql === 'CREATE INDEX ON "public"."employee" ("area_id");'));
  // EXPLAIN ANALYZE of a write is rolled back.
  await runQuery(ctx(), { sql: 'DELETE FROM big', explain: 'analyze', allowChanges: true });
  assert.equal(Number((await runQuery(ctx(), { sql: 'SELECT count(*) FROM big' })).results[0].rows[0][0]), 20000);
});

test('data browser: default and explicit order use the column types', { skip: !enabled }, async () => {
  const browser = require('../src/main/database/data-browser.cjs');
  const t = shared.findTable(await connections.schema(W), 'big');
  const r = await browser.browse(readOnly, t, { limit: 3 });
  assert.deepEqual(r.rows.map((x) => x.id), ['1', '2', '3']);
  const d = await browser.browse(readOnly, t, { limit: 2, sort: [{ column: 'id', direction: 'desc' }] });
  assert.deepEqual(d.rows.map((x) => x.id), ['20000', '19999']);
});
