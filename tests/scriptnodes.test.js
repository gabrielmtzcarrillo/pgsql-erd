// Scripts shown as diagram entities: links, labels, placement and routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkedTables, scriptLines, scriptSize, placeScripts, connect, route, RELATION, SCRIPT_W,
} from '../src/renderer/lib/scriptnodes.js';

const tables = [
  { key: 'public.tbEmpleados', schema: 'public', name: 'tbEmpleados' },
  { key: 'public.catAreasDeptos', schema: 'public', name: 'catAreasDeptos' },
  { key: 'shop.orders', schema: 'shop', name: 'orders' },
];

test('links scripts to the tables they name or list', () => {
  const s = { type: 'validator', tables: [], source: 'const e = await db.public.tbEmpleados.select();\nconst d = await db.table("public.catAreasDeptos").count();' };
  assert.deepEqual(linkedTables(s, tables).sort(), ['public.catAreasDeptos', 'public.tbEmpleados']);
  assert.deepEqual(linkedTables({ tables: ['orders'], source: '' }, tables), ['shop.orders']);
  assert.deepEqual(linkedTables({ tables: ['shop.orders'], source: 'log(1)' }, tables), ['shop.orders']);
  // Partial words don't count.
  assert.deepEqual(linkedTables({ source: 'const tbEmpleadosCount = 1; // preorders' }, tables), []);
  assert.equal(RELATION.validator, 'validates');
  assert.equal(RELATION.generator, 'generates');
});

test('box lines show the type and the last run', () => {
  assert.deepEqual(scriptLines({ type: 'validator' }, null).map((l) => l.text), ['Validator · TypeScript', 'Not run yet']);
  const pass = scriptLines({ type: 'validator' }, { status: 'ok', validations: 2, passed: 2, errors: 0, rowsRead: 1483 });
  assert.deepEqual(pass.map((l) => l.text), ['Validator · TypeScript', 'Last run: PASS (2/2)', '1,483 rows checked']);
  assert.match(pass[1].cls, /pass/);
  const fail = scriptLines({ type: 'validator' }, { status: 'ok', validations: 2, passed: 1, errors: 3, rowsRead: 10 });
  assert.deepEqual(fail.slice(1, 3).map((l) => l.text), ['Last run: FAIL (1/2)', '3 errors']);
  const gen = scriptLines({ type: 'generator' }, { status: 'ok', mode: 'dry-run', validations: 0, passed: 0, inserts: 100, updates: 0, deletes: 0, rowsRead: 0 });
  assert.deepEqual(gen.slice(1).map((l) => l.text), ['Last run: OK (dry run)', '+100 ~0 −0 rows']);
  assert.equal(scriptLines({ type: 'query' }, { status: 'error' })[1].text, 'Last run: ERROR');
  assert.deepEqual(scriptSize(pass), { width: SCRIPT_W, height: 30 + 3 * 20 + 8 });
  assert.equal(scriptSize(pass, 250).width, 294);
  assert.equal(scriptSize(pass, 900).width, 360);
  assert.equal(scriptSize(pass, 0, 250).width, 270);
  assert.equal(gen.at(-1)?.text.includes('checked'), false);
});

test('new boxes go right of their tables without overlapping', () => {
  const boxes = new Map([
    ['a', { x: 0, y: 0, width: 200, height: 100 }],
    ['b', { x: 300, y: 0, width: 200, height: 100 }],
  ]);
  const size = { width: SCRIPT_W, height: 80 };
  const kept = new Map([['old.ts', { x: 5, y: 500 }]]);
  const out = placeScripts(
    [
      { path: 'old.ts', links: ['a'], size },
      { path: 'v1.ts', links: ['a'], size },
      { path: 'v2.ts', links: ['a'], size },
    ],
    boxes,
    kept
  );
  assert.deepEqual(out.get('old.ts'), { x: 5, y: 500 });
  const v1 = out.get('v1.ts');
  const v2 = out.get('v2.ts');
  assert.equal(v1.x, 280);
  // v1 would overlap table b, v2 would overlap v1: both move down.
  const all = [...boxes.values(), { ...v1, ...size }, { ...v2, ...size }];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const [p, q] = [all[i], all[j]];
      assert.ok(!(p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height), `boxes ${i} and ${j} overlap`);
    }
});

test('links leave from the facing sides', () => {
  const a = { x: 0, y: 0, width: 100, height: 50 };
  const right = connect(a, { x: 300, y: 0, width: 100, height: 50 });
  assert.match(right.path, /^M100,25 C/);
  assert.deepEqual(right.end, { x: 300, y: 25 });
  assert.deepEqual(right.mid, { x: 200, y: 25 });
  const below = connect(a, { x: 20, y: 200, width: 100, height: 50 });
  assert.match(below.path, /^M50,50 C/);
  assert.deepEqual(below.end, { x: 70, y: 200 });
});

test('links avoid passing through other tables', () => {
  const script = { x: 700, y: 200, width: 200, height: 80 };
  const target = { x: 0, y: 0, width: 200, height: 100 };
  const between = { x: 350, y: 0, width: 200, height: 300 };
  assert.ok(connect(script, target).points.some((p) => p.x > 350 && p.x < 550 && p.y < 300));
  const r = route(script, { ...target, y: 400 }, [between]);
  assert.equal(r.hits, 0);
});
