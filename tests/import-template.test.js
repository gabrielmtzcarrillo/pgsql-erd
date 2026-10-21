// The Excel -> PostgreSQL INSERT template: contract validation, source
// resolution (fixed and detected headers), row extraction from different
// workbooks, round trips, insertion order and design diagnostics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePgerd } from '../src/renderer/lib/pgerd.js';
import { schemaFromErd } from '../src/shared/schema-model.js';
import {
  IMPORT_TEMPLATE_SCHEMA, colLetter, colIndex, normHeader, validateTemplate, resolveSource, extractRows, checkValue,
  inferHint, newDesign, newSource, newTask, designToTemplate, templateToDesign, suggestOrder, designDiagnostics, hasErrors,
} from '../src/shared/import-template.js';
import { EXAMPLE_TEMPLATE as TEMPLATE } from './import-template.fixtures.js';

const shop = () => schemaFromErd(parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8')));

// Title rows above, headers at C4, data from C5.
const careers = (rows) => ({
  name: 'Carreras',
  rows: [['Catálogo'], [], [], ['', '', 'ID Carrera', 'Carrera'], ...rows.map((r) => ['', '', ...r])],
});
const students = (rows, title = 0) => ({
  name: 'Alumnos',
  rows: [...Array.from({ length: title }, () => ['Reporte']), ['Nombre', 'Matrícula', 'ID Carrera', 'Extra'], ...rows],
});

const clone = (x) => structuredClone(x);

test('column letters and header normalisation', () => {
  assert.deepEqual([0, 25, 26, 701, 702].map(colLetter), ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.deepEqual(['A', 'z', 'AA', 'AAA', '', '1', 'ABCD'].map(colIndex), [0, 25, 26, 702, -1, -1, -1]);
  assert.equal(normHeader('  ID   Carrera '), 'id carrera');
  assert.equal(normHeader(' ID ', { trim: false, caseSensitive: true }), ' ID ');
  assert.notEqual(normHeader('Matricula'), normHeader('Matrícula'));
});

test('the example template conforms to the schema and the published files are current', () => {
  assert.deepEqual(validateTemplate(TEMPLATE), []);
  const example = JSON.parse(readFileSync(new URL('../docs/examples/alumnos.import.json', import.meta.url), 'utf8'));
  assert.deepEqual(example, TEMPLATE);
  const published = JSON.parse(readFileSync(new URL('../docs/import-template.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(published, JSON.parse(JSON.stringify(IMPORT_TEMPLATE_SCHEMA)));
});

test('unknown major versions, bad structure and inconsistent tasks are refused', () => {
  const v2 = clone(TEMPLATE);
  v2.specVersion = '2.0';
  assert.match(validateTemplate(v2)[0], /Unsupported specVersion/);
  assert.deepEqual(validateTemplate({ ...clone(TEMPLATE), specVersion: '1.7' }), []);
  assert.match(validateTemplate({ ...clone(TEMPLATE), format: 'x' })[0], /format/);
  const gap = clone(TEMPLATE);
  gap.execution.tasks[1].order = 3;
  assert.match(validateTemplate(gap).join(), /contiguous/);
  const dup = clone(TEMPLATE);
  dup.execution.tasks[1].mappings[1].targetColumn = 'matricula';
  assert.match(validateTemplate(dup).join(), /mapped more than once/);
  const column = clone(TEMPLATE);
  column.execution.tasks[1].mappings[0].source = { mode: 'column', column: 'B' };
  assert.match(validateTemplate(column).join(), /detects its header/);
  const unknown = clone(TEMPLATE);
  unknown.execution.tasks[0].sourceId = 'nope';
  assert.match(validateTemplate(unknown).join(), /unknown source/);
});

test('shifted header: C4 headers, C5 data', () => {
  const wb = [careers([['1', 'Derecho'], ['2', 'Medicina'], [], ['3', 'Física']])];
  const res = resolveSource(TEMPLATE, TEMPLATE.sources[0], wb);
  assert.equal(res.ok, true);
  assert.equal(res.headerRow, 4);
  assert.equal(res.firstDataRow, 5);
  assert.deepEqual(res.columns.map((c) => [c.letter, c.label]), [['C', 'ID Carrera'], ['D', 'Carrera']]);
  const run = extractRows(TEMPLATE, [...wb, students([])]);
  const t = run.tasks[0];
  assert.equal(t.sheetName, 'Carreras');
  assert.deepEqual(t.rows.map((r) => [r.row, r.values]), [
    [5, { idCarrera: '1', nombre: 'Derecho' }], [6, { idCarrera: '2', nombre: 'Medicina' }], [8, { idCarrera: '3', nombre: 'Física' }],
  ]);
});

test('strict reuse: another workbook with the same structure and new data', () => {
  const a = extractRows(TEMPLATE, [careers([['1', 'A']]), students([])]);
  const b = extractRows(TEMPLATE, [careers([['9', 'Z'], ['8', 'Y']]), students([])]);
  assert.equal(a.tasks[0].total, 1);
  assert.equal(b.tasks[0].total, 2);
  const moved = extractRows(TEMPLATE, [{ name: 'Carreras', rows: [[], ['', '', 'ID Carrera', 'Carrera'], ['', '', '1', 'x']] }, students([])]);
  assert.equal(moved.ok, false);
  assert.match(moved.errors[0].message, /expected the header "ID Carrera"/);
});

test('flexible reuse: reordered columns and a shifted header row', () => {
  const rows = [['Ana', '0042', '1', ''], ['Luis', '0043', '2', '']];
  const base = extractRows(TEMPLATE, [careers([]), students(rows)]).tasks[1];
  assert.deepEqual(base.rows[0].values, { matricula: '0042', nombre: 'Ana', idCarrera: '1' });
  const shifted = extractRows(TEMPLATE, [careers([]), students(rows, 5)]).tasks[1];
  assert.equal(shifted.rows[0].row, 7);
  assert.deepEqual(shifted.rows.map((r) => r.values), base.rows.map((r) => r.values));
  const reordered = { name: 'Datos', rows: [['id carrera ', 'Matrícula', 'Nombre'], ['1', '0042', 'Ana']] };
  const res = extractRows(TEMPLATE, [careers([]), reordered]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.tasks[1].rows[0].values, { matricula: '0042', nombre: 'Ana', idCarrera: '1' });
});

test('missing, duplicated and ambiguous headers fail with reasons', () => {
  const missing = extractRows(TEMPLATE, [careers([]), { name: 'A', rows: [['Nombre', 'ID Carrera']] }]);
  assert.match(missing.errors[0].message, /No worksheet has a header row/);
  const dupHeader = extractRows(TEMPLATE, [careers([]), { name: 'A', rows: [['Nombre', 'Matrícula', 'ID Carrera', 'nombre'], ['a', 'b', 'c', 'd']] }]);
  assert.equal(dupHeader.errors[0].code, 'DUPLICATE_HEADER');
  assert.match(dupHeader.errors[0].message, /columns A, D/);
  const twoSheets = extractRows(TEMPLATE, [careers([]), students([]), { name: 'Copia', rows: [['Nombre', 'Matrícula', 'ID Carrera']] }]);
  assert.equal(twoSheets.errors[0].code, 'SHEET_AMBIGUOUS');
  const twoRows = extractRows(TEMPLATE, [careers([]), { name: 'A', rows: [['Nombre', 'Matrícula', 'ID Carrera'], ['x'], ['Nombre', 'Matrícula', 'ID Carrera']] }]);
  assert.equal(twoRows.errors[0].code, 'HEADER_AMBIGUOUS');
  const outside = clone(TEMPLATE);
  outside.sources[1].sheet = { mode: 'name', value: 'Alumnos' };
  outside.sources[1].header.scanRows = { from: 1, to: 2 };
  const far = extractRows(outside, [careers([]), students([], 4)]);
  assert.equal(far.errors[0].code, 'HEADER_NOT_FOUND');
  const noSheet = extractRows(TEMPLATE, [students([])]);
  assert.equal(noSheet.errors[0].code, 'SHEET_NOT_FOUND');
});

test('blank policies, trimming and empty rows', () => {
  const t = clone(TEMPLATE);
  t.execution.tasks[1].mappings[0].trim = true;
  t.execution.tasks[1].mappings[1].blank = 'emptyString';
  t.execution.tasks[1].mappings[2].blank = 'error';
  // Columns: Nombre, Matrícula, ID Carrera, Extra.
  const wb = [careers([]), students([[' Ana ', ' 7 ', '', ''], ['', '', '', ''], ['', ' 8', '3', ''], ['', ' ', '', 'x']])];
  const res = extractRows(t, wb);
  assert.equal(extractRows(t, [careers([]), students([['Zed', '1', '2', '']])]).ok, true);
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors.map((e) => [e.code, e.row, e.column]), [['BLANK_NOT_ALLOWED', 2, 'idCarrera']]);
  assert.deepEqual(res.tasks[1].rows.map((r) => r.values), [
    { matricula: '7', nombre: ' Ana ', idCarrera: null },
    { matricula: '8', nombre: '', idCarrera: '3' },
  ]);
  const keep = clone(TEMPLATE);
  keep.sources[1].data.skipEmptyRows = false;
  assert.equal(extractRows(keep, [careers([]), students([['a', 'b', 'c', ''], [], ['d', 'e', 'f', '']])]).tasks[1].total, 3);
});

test('limits cap the listed rows but not the total', () => {
  const rows = Array.from({ length: 50 }, (_, i) => [String(i), `n${i}`]);
  const run = extractRows(TEMPLATE, [careers(rows), students([])], { limit: 5 });
  assert.equal(run.tasks[0].rows.length, 5);
  assert.equal(run.tasks[0].total, 50);
  const small = { ...clone(TEMPLATE), limits: { maxRows: 10 } };
  assert.equal(extractRows(small, [careers(rows), students([])]).errors[0].code, 'ROW_LIMIT');
});

test('design <-> template round trip keeps the execution meaning and the layout', () => {
  const design = templateToDesign(TEMPLATE);
  const back = designToTemplate(design);
  const { editor, ...exec } = back;
  const { editor: original, ...origExec } = TEMPLATE;
  assert.deepEqual(exec, origExec);
  assert.deepEqual(editor.nodes.srcCarreras, { x: 200, y: 100 });
  assert.deepEqual(editor.nodes.insertAlumnos, { x: 650, y: 450 });
  assert.equal(designToTemplate(design, { editor: false }).editor, undefined);
  // The layout does not change what a runner reads.
  const wb = [careers([['1', 'a']]), students([['Ana', '1', '2', '']])];
  assert.deepEqual(extractRows(back, wb), extractRows(exec, wb));
});

test('a design derives the header checks from its mappings and holds no sample data', () => {
  const d = newDesign();
  d.templateId = 'one';
  const s = newSource({ id: 's1', sheet: { mode: 'name', value: 'Hoja' }, columns: [{ letter: 'C', label: 'ID' }, { letter: 'D', label: 'Name' }, { letter: 'E', label: 'Other' }] });
  s.header.row = 4;
  s.header.startColumn = 'C';
  d.sources.push(s);
  const t = newTask('public', 'customer', { id: 't1', sourceId: 's1' });
  t.mappings.push({ id: 'm', letter: 'D', label: 'Name', targetColumn: 'name', blank: 'null', trim: false });
  d.tasks.push(t);
  const tpl = designToTemplate(d, { editor: false });
  assert.deepEqual(tpl.sources[0].header.expected, ['ID', 'Name']);
  assert.deepEqual(validateTemplate(tpl), []);
  assert.doesNotMatch(JSON.stringify(tpl), /Other/);
  s.header.mode = 'detect';
  s.sheet = { mode: 'requiredHeaders', headers: null };
  const tpl2 = designToTemplate(d, { editor: false });
  assert.deepEqual(tpl2.sources[0].sheet.headers, ['Name']);
  assert.deepEqual(tpl2.execution.tasks[0].mappings[0].source, { mode: 'header', name: 'Name' });
  assert.deepEqual(validateTemplate(tpl2), []);
});

test('suggested order: parents first, repeated tasks stay in order, cycles are reported', () => {
  const schema = shop();
  const mk = (...tables) => {
    const d = newDesign();
    d.tasks = tables.map((t, i) => newTask(...t.split('.'), { id: `t${i}` }));
    return d;
  };
  const d = mk('shop.order_item', 'shop.orders', 'public.customer', 'shop.orders');
  const plan = suggestOrder(d, schema);
  assert.deepEqual(plan.order, ['t2', 't1', 't3', 't0']);
  assert.deepEqual(plan.cycles, []);
  const diag = designDiagnostics(d, schema, null);
  assert.ok(diag.some((x) => x.code === 'FK_ORDER' && x.taskId === 't0'));

  const cyc = structuredClone(schema);
  const [a, b] = cyc.schemas.flatMap((x) => x.tables);
  a.foreignKeys.push({ name: 'a_b', columns: [], refTable: b.id, refColumns: [] });
  b.foreignKeys.push({ name: 'b_a', columns: [], refTable: a.id, refColumns: [] });
  const plan2 = suggestOrder(mk(a.id, b.id), cyc);
  assert.equal(plan2.order, null);
  assert.deepEqual(plan2.cycles, [[a.id, b.id].sort()]);
});

test('two tasks may target the same table with distinct ids and positions', () => {
  const t = clone(TEMPLATE);
  const again = clone(t.execution.tasks[0]);
  again.id = 'insertCarreras2';
  again.order = 3;
  t.execution.tasks.push(again);
  assert.deepEqual(validateTemplate(t), []);
  const d = templateToDesign(t);
  assert.deepEqual(d.tasks.map((x) => x.id), ['insertCarreras', 'insertAlumnos', 'insertCarreras2']);
  assert.deepEqual(designToTemplate(d, { editor: false }).execution.tasks.map((x) => x.order), [1, 2, 3]);
});

test('value checks against column types', () => {
  const col = (databaseType) => ({ databaseType, baseType: databaseType.replace(/\(.*\)/, '') });
  assert.equal(checkValue(col('integer'), '42'), null);
  assert.match(checkValue(col('integer'), '4.5'), /whole number/);
  assert.match(checkValue(col('smallint'), '40000'), /out of range/);
  assert.equal(checkValue(col('numeric(10,2)'), '-1.5e3'), null);
  assert.match(checkValue(col('boolean'), 'maybe'), /boolean/);
  assert.equal(checkValue(col('date'), '2024-02-29'), null);
  assert.match(checkValue(col('timestamp without time zone'), '12/31/2024'), /date/);
  assert.match(checkValue(col('character varying(5)'), 'abcdefg'), /longer than 5/);
  assert.equal(checkValue(col('text'), 'anything'), null);
});

test('type hints from sample values', () => {
  assert.deepEqual([['1', ' 22'], ['1.5', '2'], ['2024-01-02', '2024-01-03 10:00'], ['true', 'False'], ['a', '1'], ['', ' '], ['00042', '7']].map(inferHint), ['integer', 'number', 'date', 'boolean', 'text', '', 'integer']);
});

test('design diagnostics against the database and the example workbook', () => {
  const schema = shop();
  const d = newDesign();
  d.templateId = 'shop';
  d.sources.push(newSource({ id: 's1', sheet: { mode: 'name', value: 'Clientes' }, columns: [{ letter: 'A', label: 'Name' }] }));
  const t = newTask('public', 'customer', { id: 't1', sourceId: 's1' });
  t.mappings.push({ id: 'm1', letter: 'A', label: 'Name', targetColumn: 'nope', blank: 'null', trim: false });
  d.tasks.push(t);
  const wb = [{ name: 'Clientes', rows: [['Name'], ['Ana']] }];
  const codes = (x) => x.map((y) => y.code);
  const diag = designDiagnostics(d, schema, wb);
  assert.ok(codes(diag).includes('COLUMN_MISSING'));
  assert.ok(codes(diag).includes('REQUIRED_UNMAPPED'));
  assert.equal(hasErrors(diag), true);
  assert.ok(codes(designDiagnostics(d, null, null)).includes('NO_WORKBOOK'));
  assert.ok(codes(designDiagnostics(d, null, null)).includes('NO_DATABASE'));
  const missingTable = structuredClone(d);
  missingTable.tasks[0].table = 'ghost';
  assert.ok(codes(designDiagnostics(missingTable, schema, wb)).includes('TABLE_MISSING'));
  const wrongSheet = structuredClone(d);
  wrongSheet.sources[0].sheet.value = 'Otra';
  assert.ok(codes(designDiagnostics(wrongSheet, schema, wb)).includes('SHEET_NOT_FOUND'));
  assert.ok(codes(designDiagnostics(newDesign(), null, null)).includes('NO_TASKS'));
});
