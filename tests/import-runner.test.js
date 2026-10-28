// The import runner against a fake client: SQL, parameters, transactions,
// returned keys, lookups and failures. (No database needed.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { runImport } = createRequire(import.meta.url)('../src/main/database/import-runner.cjs');

// Answers queries by a function of (sql, params); remembers everything it was asked.
function fakeClient(answer = () => ({ rows: [] })) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      log.push({ sql, params });
      if ((params ?? []).includes('fail')) throw new Error('boom');
      return answer(sql, params);
    },
  };
}

const template = (over = {}) => ({
  execution: {
    operation: 'insert',
    transaction: 'atomic',
    tasks: [
      { id: 'parent', order: 1, sourceId: 's', target: { schema: 'public', table: 'customer' }, mappings: [{ source: { mode: 'column', column: 'A' }, targetColumn: 'email' }] },
      {
        id: 'child', order: 2, sourceId: 's', target: { schema: 'shop', table: 'order"s' },
        mappings: [
          { source: { mode: 'inserted', taskId: 'parent', column: 'id' }, targetColumn: 'customer_id' },
          { source: { mode: 'column', column: 'B' }, targetColumn: 'tags', processor: { type: 'split' } },
          { source: { mode: 'column', column: 'C' }, targetColumn: 'status_id', processor: { type: 'lookup', schema: 'shop', table: 'status', matchColumn: 'name', valueColumn: 'id', onMissing: 'error' } },
        ],
      },
    ],
    ...over,
  },
});
const rows = [
  { id: 'parent', rows: [{ row: 2, values: { email: 'a@x' } }, { row: 3, values: { email: 'b@x' } }] },
  { id: 'child', rows: [{ row: 2, values: { customer_id: null, tags: ['x', 'y'], status_id: 'new' } }, { row: 3, values: { customer_id: null, tags: null, status_id: 'new' } }] },
];

test('inserts in order, passing the returned key and the lookup result as parameters', () => {
  let id = 100;
  const client = fakeClient((sql) => {
    if (/^INSERT INTO "public"."customer"/.test(sql)) return { rows: [{ id: ++id }] };
    if (/FROM "shop"."status"/.test(sql)) return { rows: [{ v: 7 }] };
    return { rows: [] };
  });
  return runImport(client, template(), rows).then((res) => {
    assert.deepEqual(res.tasks.map((t) => [t.id, t.inserted]), [['parent', 2], ['child', 2]]);
    assert.equal(res.total, 4);
    const sql = client.log.map((l) => l.sql);
    assert.equal(sql[0], 'BEGIN');
    assert.match(sql[1], /SET LOCAL statement_timeout/);
    assert.equal(sql[2], 'INSERT INTO "public"."customer" ("email") VALUES ($1) RETURNING "id"');
    assert.equal(sql.at(-1), 'COMMIT');
    const child = client.log.filter((l) => l.sql.startsWith('INSERT INTO "shop"."order""s"'));
    assert.equal(child[0].sql, 'INSERT INTO "shop"."order""s" ("customer_id", "tags", "status_id") VALUES ($1, $2, $3)');
    assert.deepEqual(child[0].params, [101, ['x', 'y'], 7]);
    assert.deepEqual(child[1].params, [102, null, 7]);
    // The same lookup is made once.
    assert.equal(sql.filter((q) => /FROM "shop"."status"/.test(q)).length, 1);
    assert.deepEqual(client.log.find((l) => /FROM "shop"."status"/.test(l.sql)).params, ['new']);
  });
});

test('a failure rolls everything back and names the task and the worksheet row', async () => {
  const client = fakeClient();
  const bad = structuredClone(rows);
  bad[0].rows[1].values.email = 'fail';
  await assert.rejects(runImport(client, template(), bad), (err) => {
    assert.match(err.message, /Task parent \(public\.customer\), worksheet row 3: boom/);
    assert.deepEqual(err.committed, []);
    return true;
  });
  assert.equal(client.log.at(-1).sql, 'ROLLBACK');
  assert.ok(!client.log.some((l) => l.sql === 'COMMIT'));
});

test('per-task transactions commit each task and report what stayed committed', async () => {
  const client = fakeClient((sql) => (/^INSERT INTO "public"/.test(sql) ? { rows: [{ id: 1 }] } : { rows: [] }));
  const t = template();
  t.execution.transaction = 'perTask';
  t.execution.tasks[1].mappings.pop(); // no lookup
  const bad = structuredClone(rows);
  bad[1].rows[0].values.tags = 'fail';
  await assert.rejects(runImport(client, t, bad), (err) => {
    assert.deepEqual(err.committed, ['parent']);
    assert.match(err.message, /Tasks already committed: parent/);
    return true;
  });
  const words = client.log.map((l) => l.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s));
  assert.deepEqual(words, ['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);
});

test('lookups: a missing key is an error unless the template says null, and two matches always are', async () => {
  const none = fakeClient((sql) => (/FROM "shop"."status"/.test(sql) ? { rows: [] } : { rows: [{ id: 1 }] }));
  await assert.rejects(runImport(none, template(), rows), /has no row with name = new/);
  const t = template();
  t.execution.tasks[1].mappings[2].processor.onMissing = 'null';
  const ok = fakeClient((sql) => (/FROM "shop"."status"/.test(sql) ? { rows: [] } : { rows: [{ id: 1 }] }));
  await runImport(ok, t, rows);
  assert.equal(ok.log.find((l) => l.sql.startsWith('INSERT INTO "shop"')).params[2], null);
  const two = fakeClient((sql) => (/FROM "shop"."status"/.test(sql) ? { rows: [{ v: 1 }, { v: 2 }] } : { rows: [{ id: 1 }] }));
  await assert.rejects(runImport(two, template(), rows), /more than one row/);
});

test('an inserted key needs the parent to have inserted that worksheet row', async () => {
  const client = fakeClient((sql) => (/FROM "shop"."status"/.test(sql) ? { rows: [{ v: 1 }] } : { rows: [{ id: 1 }] }));
  const partial = structuredClone(rows);
  partial[0].rows.pop(); // the parent skipped row 3
  await assert.rejects(runImport(client, template(), partial), /did not insert worksheet row 3/);
  await assert.rejects(runImport(fakeClient(), template(), [rows[0]]), /no rows were prepared/);
});

test('columns the extractor reported as skipped are left out of the INSERT', async () => {
  const client = fakeClient();
  const tpl = { execution: { operation: 'insert', transaction: 'atomic', tasks: [{ id: 't', order: 1, sourceId: 's', target: { schema: 'public', table: 'p' }, mappings: [
    { source: { mode: 'header', name: 'Name' }, targetColumn: 'name' },
    { source: { mode: 'header', name: 'Phone' }, targetColumn: 'phone', optional: true },
  ] }] } };
  await runImport(client, tpl, [{ id: 't', skipped: ['phone'], rows: [{ row: 2, values: { name: 'Ana' } }] }]);
  const ins = client.log.find((l) => l.sql.startsWith('INSERT'));
  assert.equal(ins.sql, 'INSERT INTO "public"."p" ("name") VALUES ($1)');
  assert.deepEqual(ins.params, ['Ana']);
});
