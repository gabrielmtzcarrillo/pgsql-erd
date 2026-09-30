// Schema model, typings, permissions, script files, JSON schema checks,
// context building and the isolated script runner (no database needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parsePgerd } from '../src/renderer/lib/pgerd.js';
import {
  schemaFromErd, findTable, dependencyOrder, relationshipsOf, summarizeSchemaChanges, parseDatabaseType,
} from '../src/shared/schema-model.js';
import { generateDatabaseDts, tsType, pascalCase } from '../src/shared/typegen.js';
import {
  classifySql, resolveScriptPermissions, effectivePermissions, normalizePolicy, normalizeAiPermissions,
} from '../src/shared/permissions.js';
import { parseScriptFile, serializeScriptFile, scriptPath, template, tablesMentioned } from '../src/shared/scripts.js';
import { validateJson, parseModelJson, tableJsonSchema, checkRowAgainstTable } from '../src/shared/json-schema.js';
import { buildContext, tablesInText, codeBlocks } from '../src/shared/context-builder.js';
import { createFaker } from '../src/shared/fake.js';
import { valueForColumn, columnsToFill } from '../src/shared/seed.js';

const require = createRequire(import.meta.url);
const ts = require('../src/main/scripting/ts-service.cjs');
const { runInWorker } = require('../src/main/scripting/script-runner.cjs');

const shop = () => schemaFromErd(parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8')));

test('schema model from the diagram', () => {
  const s = shop();
  assert.equal(s.source, 'diagram');
  assert.deepEqual(s.schemas.map((x) => x.name), ['public', 'shop']);
  const item = findTable(s, 'order_item');
  assert.equal(item.id, 'shop.order_item');
  assert.deepEqual(item.foreignKeys.map((f) => f.refTable).sort(), ['shop.orders', 'shop.product']);
  assert.equal(findTable(s, 'CUSTOMER').id, 'public.customer');
  assert.equal(findTable(s, 'nope'), null);
  assert.deepEqual(dependencyOrder(s), ['public.customer', 'shop.product', 'shop.orders', 'shop.order_item']);
  assert.deepEqual(dependencyOrder(s, ['shop.order_item', 'shop.orders']), ['shop.orders', 'shop.order_item']);
  assert.deepEqual(relationshipsOf(s, 'shop.orders').map((r) => r.direction).sort(), ['referenced-by', 'references']);
});

test('parses database types', () => {
  assert.deepEqual(parseDatabaseType('character varying(20)[]'), { baseType: 'character varying', isArray: true });
  assert.deepEqual(parseDatabaseType('timestamp(3) with time zone'), { baseType: 'timestamp with time zone', isArray: false });
});

test('summarizes schema changes', () => {
  const a = shop();
  const b = structuredClone(a);
  const cust = findTable(b, 'customer');
  cust.columns.push({ ...cust.columns[0], name: 'active', databaseType: 'boolean', nullable: false });
  cust.columns[1].databaseType = 'character varying(300)';
  b.schemas[1].tables = b.schemas[1].tables.filter((t) => t.name !== 'product');
  const changes = summarizeSchemaChanges(a, b);
  assert.ok(changes.includes('+ public.customer.active boolean NOT NULL'));
  assert.ok(changes.some((c) => c.startsWith('~ public.customer.') && c.includes('→ character varying(300)')));
  assert.ok(changes.includes('- shop.product'));
});

test('TypeScript types for columns', () => {
  const col = (databaseType, extra = {}) => ({ databaseType, ...parseDatabaseType(databaseType), nullable: false, ...extra });
  assert.equal(tsType(col('integer')), 'number');
  assert.equal(tsType(col('bigint')), 'string');
  assert.equal(tsType(col('bigint'), new Map(), 'insert'), 'string | number | bigint');
  assert.equal(tsType(col('timestamp with time zone')), 'Date');
  assert.equal(tsType(col('jsonb')), 'Json');
  assert.equal(tsType(col('text[]')), 'string[]');
  assert.equal(tsType(col('mood'), new Map([['mood', '"ok" | "sad"']])), '"ok" | "sad"');
  assert.equal(pascalCase('tb_usuarios'), 'TbUsuarios');
  assert.equal(pascalCase('2024 data'), 'T2024Data');
});

test('generated typings type-check scripts', () => {
  const dts = generateDatabaseDts(shop());
  assert.match(dts, /interface ShopOrders \{/);
  assert.match(dts, /"shop\.orders": \{ row: ShopOrders; insert: ShopOrdersInsert \};/);
  const ok = ts.check(
    `const orders = await db.shop.orders.where({ customer_id: 1, status: ["new", "paid"] }).orderBy("placed_at", "desc").limit(10).select();
     for (const o of orders) log(o.id, o.status.toUpperCase());
     const c = await db.table("public.customer").first();
     validate("x", async () => { report.error({ table: "shop.orders", row: 1, message: "m" }); });
     faker.seed(1); log(faker.person.fullName());
     const r = await seed.row("shop.orders", { status: "new" });`,
    dts
  );
  assert.deepEqual(ok, []);
  const bad = ts.check('await db.shop.product.insert({ sku: "a", name: 123, price: 1 });\nawait db.shop.orders.select("nope");', dts);
  assert.equal(bad.length, 2);
  assert.match(bad[0].message, /Type 'number' is not assignable to type 'string'/);
  assert.equal(bad[1].line, 2);
});

test('transpiles scripts and rejects imports', () => {
  assert.match(ts.transpile('const x: number = await Promise.resolve(1);\nlog(x);'), /const x = await Promise\.resolve\(1\);/);
  assert.throws(() => ts.transpile('import fs from "fs";'), /import or export/);
  assert.throws(() => ts.transpile('export const x = 1;'), /import or export/);
  assert.match(ts.check('import fs from "fs";\nlog(1)', generateDatabaseDts(shop()))[0].message, /cannot use import/);
});

test('classifies SQL', () => {
  assert.deepEqual(classifySql('SELECT 1').kinds, ['read']);
  assert.deepEqual(classifySql("select 'delete' as x -- update\n").kinds, ['read']);
  assert.deepEqual(classifySql('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d').kinds, ['write']);
  assert.deepEqual(classifySql('EXPLAIN DELETE FROM t').kinds, ['read']);
  assert.deepEqual(classifySql('EXPLAIN ANALYZE DELETE FROM t').kinds, ['write']);
  assert.deepEqual(classifySql('select updated_at from t').kinds, ['read']);
  assert.deepEqual(classifySql('ALTER TABLE t ADD c int; UPDATE t SET c = 1').kinds.sort(), ['ddl', 'write']);
  assert.deepEqual(classifySql('COMMIT').kinds, ['transaction']);
  assert.equal(classifySql("DO $$ BEGIN PERFORM 1; END $$").kinds[0], 'other');
});

test('permissions: profiles, overrides and connection policy', () => {
  const p = resolveScriptPermissions('validator', { insertData: true, bogus: true });
  assert.equal(p.insertData, true);
  assert.equal(p.bogus, undefined);
  assert.equal(resolveScriptPermissions('unknown').insertData, false);
  const prod = normalizePolicy('production');
  assert.deepEqual(prod, { allowWrites: false, allowDDL: false, requireDryRun: true });
  const eff = effectivePermissions(resolveScriptPermissions('full'), prod);
  assert.equal(eff.insertData || eff.executeDDL || eff.rawSql, false);
  assert.equal(eff.readData, true);
  assert.equal(effectivePermissions(resolveScriptPermissions('full'), normalizePolicy('development', { allowDDL: false })).executeDDL, false);
  const ai = normalizeAiPermissions({ executeWrites: true, readData: true });
  assert.equal(ai.executeWrites, false);
  assert.equal(ai.readData, true);
  assert.equal(normalizeAiPermissions().executeSelect, false);
});

test('script files keep metadata in a header line', () => {
  const text = serializeScriptFile({ type: 'validator', profile: 'validator', overrides: { useAI: true }, description: 'Checks', source: 'log(1)' });
  assert.equal(text, '// @pgsql-erd {"type":"validator","permissions":{"useAI":true},"description":"Checks"}\nlog(1)\n');
  const meta = parseScriptFile(text);
  assert.equal(meta.type, 'validator');
  assert.equal(meta.permissions.useAI, true);
  assert.equal(meta.source, 'log(1)\n');
  const plain = parseScriptFile('log(2)', 'generator');
  assert.equal(plain.type, 'generator');
  assert.equal(plain.permissions.insertData, true);
  assert.equal(scriptPath('validator', 'Empleados sin área!'), 'scripts/validators/empleados-sin-area.ts');
  assert.deepEqual(tablesMentioned('db.shop.orders.select()', findTable(shop(), 'orders') ? shop().schemas.flatMap((s) => s.tables) : []), ['shop.orders']);
});

test('script templates type-check', () => {
  const s = shop();
  const dts = generateDatabaseDts(s);
  for (const type of ['query', 'validator', 'generator', 'seeder', 'migration', 'export', 'import', 'maintenance']) {
    const errors = ts.check(template(type, { table: 'shop.orders' }), dts).filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], type);
  }
});

test('JSON schema validation', () => {
  const schema = { type: 'object', properties: { a: { type: 'integer', minimum: 1 }, b: { type: ['string', 'null'], format: 'email' }, c: { enum: ['x', 'y'] } }, required: ['a'], additionalProperties: false };
  assert.deepEqual(validateJson({ a: 2, b: null, c: 'x' }, schema), []);
  assert.deepEqual(validateJson({ a: 0, b: 'nope', c: 'z', d: 1 }, schema), [
    '$.a: must be >= 1',
    '$.b: must be a valid email',
    '$.c: must be one of "x", "y"',
    '$.d: is not allowed',
  ]);
  assert.deepEqual(validateJson({}, schema), ['$.a: is required']);
  assert.deepEqual(parseModelJson('Here you go:\n```json\n{"a": 1}\n```').value, { a: 1 });
  assert.deepEqual(parseModelJson('Result: [1, 2] done').value, [1, 2]);
  assert.equal(parseModelJson('nothing').ok, false);
});

test('table JSON schema and row checks', () => {
  const s = shop();
  const product = findTable(s, 'shop.product');
  const js = tableJsonSchema(product, s);
  assert.deepEqual(js.required.sort(), ['name', 'price', 'sku']);
  assert.equal(js.properties.sku.maxLength, 32);
  const orders = findTable(s, 'shop.orders');
  assert.ok(!('customer_id' in tableJsonSchema(orders, s).properties));
  assert.deepEqual(checkRowAgainstTable(product, { sku: 'x'.repeat(40), name: null, price: '9.99', extra: 1 }), [
    'extra: no such column in shop.product',
    'sku: must have at most 32 characters',
    "name: can't be null",
  ]);
});

test('context builder includes selected and related tables only', () => {
  const s = shop();
  assert.deepEqual(tablesInText(s, 'Validate order_item rows'), ['shop.order_item']);
  const ctx = buildContext(s, ['shop.orders'], { relatedTables: false });
  assert.deepEqual(ctx.tables, ['shop.orders']);
  assert.match(ctx.text, /TABLE shop\.orders/);
  assert.match(ctx.text, /RELATIONSHIPS[\s\S]*shop\.order_item\(order_id\) -> shop\.orders\(id\)/);
  assert.equal(buildContext(s, ['shop.orders']).tables.length, 3);
  assert.match(buildContext(s, []).text, /Tables in the database \(4\)/);
  assert.equal(buildContext(s, [], { entireSchema: true }).tables.length, 4);
  const withScript = buildContext(s, [], {}, { script: { name: 'x', type: 'query', source: 'log(1)' } });
  assert.match(withScript.text, /CURRENT SCRIPT[\s\S]*log\(1\)/);
  assert.deepEqual(codeBlocks('a\n```ts\nlog(1)\n```\nb\n```sql\nselect 1\n```'), [
    { lang: 'ts', code: 'log(1)\n' },
    { lang: 'sql', code: 'select 1\n' },
  ]);
});

test('fake data is deterministic and fits columns', () => {
  const a = createFaker(5);
  const b = createFaker(5);
  assert.equal(a.person.fullName(), b.person.fullName());
  assert.match(a.string.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const n = a.number.int({ min: 3, max: 5 });
  assert.ok(n >= 3 && n <= 5);
  const f = createFaker(1);
  const col = (name, databaseType, extra = {}) => ({ name, databaseType, ...parseDatabaseType(databaseType), nullable: false, ...extra });
  assert.match(valueForColumn(col('correo', 'character varying(120)'), f, { index: 3, unique: true }), /\.4@example\.com$/);
  assert.equal(valueForColumn(col('code', 'character(3)'), f).length, 3);
  assert.ok(valueForColumn(col('title', 'character varying(5)'), f).length <= 5);
  assert.equal(typeof valueForColumn(col('active', 'boolean'), f), 'boolean');
  assert.equal(valueForColumn(col('n', 'integer'), f, { index: 9, unique: true }), 10);
  const s = shop();
  // placed_at defaults to now(); status has a plain default and is filled for variety.
  assert.deepEqual(columnsToFill(findTable(s, 'shop.orders')).map((c) => c.name), ['id', 'customer_id', 'status']);
});

// ------------------------------------------------------------ runner

const emptySchema = { source: 'database', schemas: [], enums: [] };
function runScript(code, handlers = {}, limits = {}) {
  const output = [];
  const messages = [];
  return runInWorker({
    code: ts.transpile(code),
    schema: emptySchema,
    limits,
    handlers: { db: async () => [], output: (t) => output.push(t), message: (level, e) => messages.push({ level, ...e }), ...handlers },
  }).then((r) => ({ ...r, output, messages }));
}

test('runner: output, reports and errors', async () => {
  const r = await runScript('log("a", { b: 1 }); report.warning("w"); console.error("e"); throw new Error("stop");');
  assert.deepEqual(r.output, ['a {\n  "b": 1\n}']);
  assert.deepEqual(r.messages.map((m) => [m.level, m.message]), [['warning', 'w'], ['error', 'e']]);
  assert.match(r.error, /^stop/);
});

test('runner: no Node APIs, no eval, empty environment, sandboxed process', async () => {
  const r = await runScript(`
    log(typeof require, typeof process, typeof fetch);
    try { eval("1"); } catch (e) { log("eval:", (e as Error).message); }
    const p = (db.constructor as any).constructor("return process")();
    log(JSON.stringify(p.env));
    try { p.getBuiltinModule("fs").writeFileSync("/tmp/pgsql-erd-escape", "x"); log("wrote"); } catch (e) { log("write:", (e as any).code); }
    try { p.getBuiltinModule("child_process").execSync("true"); log("spawned"); } catch (e) { log("spawn:", (e as any).code); }
  `);
  assert.equal(r.error, null);
  assert.equal(r.output[0], 'undefined undefined undefined');
  assert.match(r.output[1], /eval: Code generation from strings disallowed/);
  assert.equal(r.output[2], '{}');
  assert.equal(r.output[3], 'write: ERR_ACCESS_DENIED');
  assert.equal(r.output[4], 'spawn: ERR_ACCESS_DENIED');
});

test('runner: timeouts and memory limits stop the process', async () => {
  const slow = await runScript('while (true) {}', {}, { timeoutMs: 1000 });
  assert.match(slow.error, /Script execution timed out|longer than/);
  const hog = await runScript('const a: string[] = []; while (true) a.push("x".repeat(1e6) + Math.random());', {}, { memoryMb: 64, timeoutMs: 30000 });
  assert.match(hog.error, /out of memory|exited unexpectedly/);
});

test('runner: stop via abort signal', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const r = await runInWorker({ code: 'await new Promise(() => {});', schema: emptySchema, signal: ctrl.signal, handlers: { db: async () => [] } });
  assert.match(r.error, /stopped/);
});

test('runner: db calls are relayed and errors surface in the script', async () => {
  const calls = [];
  const r = await runScript(
    `
    try { await db.table("public.x").select(); } catch (e) { log((e as Error).message); }
    const n = await db.query("select 1", [1]);
    log(n);
    await db.transaction(async () => {});
    try { await ai.chat("hi"); } catch (e) { log((e as Error).message); }
  `,
    {
      db: async (op, args) => {
        calls.push([op, args]);
        if (op === 'savepoint') return { name: 'sp_1' };
        return [{ one: 1 }];
      },
    }
  );
  assert.equal(r.error, null);
  assert.equal(r.output[0], 'Unknown table: public.x');
  assert.equal(r.output[2], 'AI is not available for this run.');
  assert.deepEqual(calls.map((c) => c[0]), ['query', 'savepoint', 'savepoint']);
  assert.deepEqual(calls[2][1], { action: 'release', name: 'sp_1' });
});

test('plan analyzer: self time, hints and missing foreign key indexes', async () => {
  const { flattenPlan, analyzePlan, describeNode } = await import('../src/shared/plan-analyzer.js');
  const plan = {
    'Planning Time': 0.5,
    'Execution Time': 20,
    Plan: {
      'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Total Cost': 900, 'Plan Rows': 50, 'Actual Rows': 5000, 'Actual Loops': 1, 'Actual Total Time': 20,
      'Hash Cond': '(o.customer_id = c.id)',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'shop', Alias: 'o', 'Parent Relationship': 'Outer', 'Total Cost': 800, 'Plan Rows': 5000, 'Actual Rows': 5000, 'Actual Loops': 1, 'Actual Total Time': 15, Filter: "(status = 'new')", 'Rows Removed by Filter': 95000 },
        { 'Node Type': 'Hash', 'Parent Relationship': 'Inner', 'Total Cost': 10, 'Plan Rows': 100, 'Actual Rows': 100, 'Actual Loops': 1, 'Actual Total Time': 1, 'Hash Batches': 4,
          Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'customer', Schema: 'public', Alias: 'c', 'Parent Relationship': 'Outer', 'Total Cost': 5, 'Plan Rows': 100, 'Actual Rows': 100, 'Actual Loops': 1, 'Actual Total Time': 0.8 }] },
      ],
    },
  };
  const flat = flattenPlan(plan);
  assert.equal(flat.nodes.length, 4);
  assert.equal(flat.nodes[0].selfTime, 4);
  assert.equal(Math.round(flat.nodes[1].percent), 75);
  assert.equal(describeNode(flat.nodes[1]), 'Seq Scan on shop.orders o');
  const hints = analyzePlan(flat, shop());
  const seq = hints.find((x) => x.node === 1 && x.severity === 'warning');
  assert.match(seq.message, /discards 95,000 rows/);
  assert.equal(seq.sql, 'CREATE INDEX ON "shop"."orders" ("status");');
  assert.ok(hints.some((x) => /estimated 50 rows, got 5,000/.test(x.message)));
  assert.ok(hints.some((x) => /Hash used 4 batches/.test(x.message)));
  assert.ok(hints.some((x) => x.sql === 'CREATE INDEX ON "shop"."orders" ("customer_id");'));
});

test('plan analyzer: column names with regex characters', async () => {
  const { flattenPlan, analyzePlan } = await import('../src/shared/plan-analyzer.js');
  const col = (name) => ({ name, databaseType: 'integer', baseType: 'integer', isArray: false, nullable: true });
  const schema = {
    source: 'database',
    enums: [],
    schemas: [{ name: 'public', tables: [{ id: 'public.t', schema: 'public', name: 't', comment: '', columns: [col('id'), col('total(usd'), col('a.b'), col('axb')], primaryKey: { name: 'p', columns: ['id'] }, uniques: [], foreignKeys: [], indexes: [], checks: [] }] }],
  };
  const scan = (filter) => ({ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', Schema: 'public', 'Total Cost': 1, 'Plan Rows': 10, 'Actual Rows': 10, 'Actual Loops': 1, 'Actual Total Time': 5, Filter: filter, 'Rows Removed by Filter': 50000 } });
  const hint = (filter) => analyzePlan(flattenPlan(scan(filter)), schema).find((x) => x.severity === 'warning');
  assert.equal(hint('("total(usd" > 5)').sql, 'CREATE INDEX ON "public"."t" ("total(usd");');
  // "a.b" must not match the column "axb".
  assert.equal(hint('(axb = 1)').sql, 'CREATE INDEX ON "public"."t" ("axb");');
});
