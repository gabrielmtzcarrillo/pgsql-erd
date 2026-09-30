import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgtype, cypherLiteral, cypherReturnColumns, isCypherWrite, cypherSQL, dollarQuote, graphElements,
  vertexCaption, formatAgValue, isGraphName, isLabelName, isGraphId,
} from '../src/shared/age.js';

test('parses agtype vertices, edges and paths', () => {
  const v = parseAgtype('{"id": 844424930131969, "label": "Person", "properties": {"name": "Ann"}}::vertex');
  assert.deepEqual(v, { kind: 'vertex', id: '844424930131969', label: 'Person', properties: { name: 'Ann' } });
  const e = parseAgtype('{"id": 1125899906842625, "label": "KNOWS", "end_id": 844424930131970, "start_id": 844424930131969, "properties": {"since": 2020}}::edge');
  assert.deepEqual(e, { kind: 'edge', id: '1125899906842625', label: 'KNOWS', start: '844424930131969', end: '844424930131970', properties: { since: 2020 } });
  const p = parseAgtype('[{"id": 1, "label": "A", "properties": {}}::vertex, {"id": 2, "label": "R", "end_id": 3, "start_id": 1, "properties": {}}::edge, {"id": 3, "label": "A", "properties": {}}::vertex]::path');
  assert.equal(p.kind, 'path');
  assert.deepEqual(p.items.map((x) => x.kind), ['vertex', 'edge', 'vertex']);
  // Lists of vertices (collect()) stay lists.
  assert.deepEqual(parseAgtype('[{"id": 1, "label": "A", "properties": {}}::vertex]').map((x) => x.id), ['1']);
});

test('keeps large integers and numerics exact', () => {
  // Ids of labels created late are above Number.MAX_SAFE_INTEGER.
  assert.deepEqual(parseAgtype('{"id": 18014398509481985, "label": "L", "properties": {"n": 12345678901234567890, "f": 1.5}}::vertex'), {
    kind: 'vertex', id: '18014398509481985', label: 'L', properties: { n: '12345678901234567890', f: 1.5 },
  });
  assert.equal(parseAgtype('3.14159265358979323846::numeric'), '3.14159265358979323846');
  assert.equal(parseAgtype('42'), 42);
  assert.equal(parseAgtype('"Ann"'), 'Ann');
  assert.equal(parseAgtype('NaN'), null);
  assert.equal(parseAgtype(null), null);
  // Annotations and numbers inside strings are left alone.
  assert.deepEqual(parseAgtype('{"s": "x::vertex 99999999999999999999"}'), { s: 'x::vertex 99999999999999999999' });
});

test('writes Cypher literals safely', () => {
  assert.equal(cypherLiteral({ name: "O'Hara", note: 'a\\b\n', n: 2, ok: true, none: null, tags: ['x', 1] }),
    "{`name`: 'O\\'Hara', `note`: 'a\\\\b\\n', `n`: 2, `ok`: true, `none`: null, `tags`: ['x', 1]}");
  assert.equal(cypherLiteral({ 'we ird': { a: 1 } }), '{`we ird`: {`a`: 1}}');
  assert.throws(() => cypherLiteral({ 'a`b': 1 }), /Invalid name/);
  assert.throws(() => cypherLiteral(Infinity), /finite/);
});

test('derives result columns from RETURN', () => {
  assert.deepEqual(cypherReturnColumns('MATCH (a)-[r]->(b) RETURN a, r, b'), ['a', 'r', 'b']);
  assert.deepEqual(cypherReturnColumns('MATCH (p) RETURN p.name AS person, count(*), p.age ORDER BY person LIMIT 5'), ['person', 'c2', 'p_age']);
  assert.deepEqual(cypherReturnColumns('MATCH (p) RETURN DISTINCT {a: 1, b: [1, 2]} AS m, p'), ['m', 'p']);
  assert.deepEqual(cypherReturnColumns("MATCH (p) WHERE p.name = 'RETURN x, y' RETURN p"), ['p']);
  assert.deepEqual(cypherReturnColumns('MATCH (a) WITH a RETURN a.x, a.x'), ['a_x', 'a_x_2']);
  assert.deepEqual(cypherReturnColumns("CREATE (n:Person {name: 'x'})"), ['result']);
  assert.throws(() => cypherReturnColumns('MATCH (n) RETURN *'), /explicit columns/);
});

test('classifies Cypher writes', () => {
  assert.equal(isCypherWrite('MATCH (n) RETURN n'), false);
  assert.equal(isCypherWrite("MATCH (n) WHERE n.note = 'please DELETE me' RETURN n"), false);
  assert.equal(isCypherWrite('MATCH (n) DETACH DELETE n'), true);
  assert.equal(isCypherWrite('merge (n:A {x: 1})'), true);
  assert.equal(isCypherWrite('MATCH (n) SET n.x = 1'), true);
});

test('builds cypher() SQL', () => {
  assert.equal(cypherSQL('social', 'MATCH (n) RETURN n;'),
    "SELECT * FROM ag_catalog.cypher('social', $cypher$ MATCH (n) RETURN n $cypher$) AS (\"n\" ag_catalog.agtype)");
  assert.match(cypherSQL('social', 'MATCH (n) WHERE id(n) = $id RETURN n', { params: '$1', columns: ['n'] }), /\$cypher\$, \$1\) AS/);
  assert.equal(dollarQuote('x $cypher$ y'), '$cypher1$x $cypher$ y$cypher1$');
  assert.throws(() => cypherSQL("x'); DROP TABLE t; --", 'RETURN 1'), /Invalid graph name/);
  assert.throws(() => cypherSQL('social', '  '), /Type a Cypher query/);
});

test('validates names and ids', () => {
  assert.equal(isGraphName('social'), true);
  assert.equal(isGraphName('ab'), false);
  assert.equal(isGraphName('my-graph'), false);
  assert.equal(isLabelName('Person'), true);
  assert.equal(isLabelName('_ag_label_vertex'), false);
  assert.equal(isLabelName('has space'), false);
  assert.equal(isGraphId('844424930131969'), true);
  assert.equal(isGraphId('1 OR 1=1'), false);
});

test('collects graph elements and formats values', () => {
  const a = { kind: 'vertex', id: '1', label: 'Person', properties: { name: 'Ann' } };
  const b = { kind: 'vertex', id: '2', label: 'Person', properties: { role: 'x' } };
  const r = { kind: 'edge', id: '9', label: 'KNOWS', start: '1', end: '2', properties: {} };
  const found = graphElements([[{ kind: 'path', items: [a, r, b] }, 5], [[a], { nested: b }]]);
  assert.deepEqual(found.vertices.map((v) => v.id), ['1', '2']);
  assert.deepEqual(found.edges.map((e) => e.id), ['9']);
  assert.equal(vertexCaption(a), 'Ann');
  assert.equal(vertexCaption(b), 'x');
  assert.equal(vertexCaption({ id: '844424930131969', label: 'Thing', properties: {} }), 'Thing 131969');
  assert.equal(formatAgValue(a), '(Person Ann)');
  assert.equal(formatAgValue(r), '[:KNOWS 1→2]');
  assert.equal(formatAgValue({ x: 1 }), '{"x":1}');
  assert.equal(formatAgValue(null), null);
});
