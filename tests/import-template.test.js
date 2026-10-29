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
  inferHint, splitText, changeCase, cleanText, extractText, columnRefs, chainOf, mapText, convertText, blockSource, newSplit, newCase, newChoice, newLookup, newDesign, newSource, newTask, designToTemplate, templateToDesign, suggestOrder, designDiagnostics, hasErrors,
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
  assert.deepEqual(validateTemplate({ ...clone(TEMPLATE), specVersion: '1.1' }), []);
  assert.match(validateTemplate({ ...clone(TEMPLATE), specVersion: '1.11' })[0], /Unsupported specVersion/);
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

test('split blocks: a cell becomes an array', () => {
  assert.deepEqual(splitText('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitText('a; b', { delimiter: ';', trim: false }), ['a', ' b']);
  assert.deepEqual(splitText('a,,b', { dropEmpty: false }), ['a', '', 'b']);
  assert.deepEqual(splitText('a||b|c', { delimiter: '||' }), ['a', 'b|c']);
  const t = clone(TEMPLATE);
  t.specVersion = '1.1';
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags', processor: { type: 'split', delimiter: '|' } });
  assert.deepEqual(validateTemplate(t), []);
  const wb = [careers([]), students([['Ana', '1', '2', 'x | y|z'], ['Bo', '2', '3', ''], ['Cy', '3', '4', ' , ']])];
  const rows = extractRows(t, wb).tasks[1].rows.map((r) => r.values.tags);
  assert.deepEqual(rows, [['x', 'y', 'z'], null, [',']]);
  t.execution.tasks[1].mappings.at(-1).blank = 'emptyString';
  assert.deepEqual(extractRows(t, wb).tasks[1].rows.map((r) => r.values.tags)[1], []);
});

test('table dropdown parameters are chosen when the import runs', () => {
  const t = clone(TEMPLATE);
  t.specVersion = '1.1';
  t.parameters = [{ name: 'carrera', label: 'Carrera', default: '7', source: { type: 'table', schema: 'public', table: 'catCarreras', valueColumn: 'idCarrera', labelColumn: 'nombre' } }];
  t.execution.tasks[1].mappings.push({ source: { mode: 'parameter', name: 'carrera' }, targetColumn: 'carreraFija' });
  assert.deepEqual(validateTemplate(t), []);
  const wb = [careers([]), students([['Ana', '1', '2', ''], ['Bo', '2', '3', '']])];
  assert.deepEqual(extractRows(t, wb).tasks[1].rows.map((r) => r.values.carreraFija), ['7', '7']);
  assert.deepEqual(extractRows(t, wb, { parameters: { carrera: '9' } }).tasks[1].rows.map((r) => r.values.carreraFija), ['9', '9']);
  delete t.parameters[0].default;
  const missing = extractRows(t, wb);
  assert.equal(missing.errors[0].code, 'PARAMETER_MISSING');
  assert.deepEqual(extractRows(t, wb, { previewMissing: true }).tasks[1].rows[0].values.carreraFija, null);
  const undeclared = clone(t);
  undeclared.parameters = [];
  assert.match(validateTemplate(undeclared).join(), /undeclared parameter/);
  const only = clone(TEMPLATE);
  only.specVersion = '1.1';
  only.parameters = t.parameters;
  only.execution.tasks[0].mappings = [{ source: { mode: 'parameter', name: 'carrera' }, targetColumn: 'x' }];
  assert.match(validateTemplate(only).join(), /at least one column of the worksheet/);
});

test('blocks round trip through the template and bump the version only when used', () => {
  assert.equal(designToTemplate(templateToDesign(TEMPLATE)).specVersion, '1.0');
  const t = clone(TEMPLATE);
  t.specVersion = '1.1';
  t.parameters = [{ name: 'carrera', default: '7', source: { type: 'table', schema: 'public', table: 'catCarreras', valueColumn: 'idCarrera' } }];
  t.execution.tasks[1].mappings.push(
    { source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags', processor: { type: 'split', delimiter: ',', trim: true, dropEmpty: true } },
    { source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags2', processor: { type: 'split', delimiter: ',', trim: true, dropEmpty: true } },
    { source: { mode: 'parameter', name: 'carrera' }, targetColumn: 'carreraFija' },
  );
  t.editor.processors = [{ x: 300, y: 10 }, { x: 310, y: 20 }];
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => [p.kind, p.x, p.y]), [['split', 300, 10], ['choice', 310, 20]]);
  assert.equal(d.tasks[1].mappings[5].via, d.processors[1].id);
  assert.equal(d.tasks[1].mappings[3].via, d.tasks[1].mappings[4].via);
  const back = designToTemplate(d);
  assert.equal(back.specVersion, '1.1');
  assert.deepEqual(back.editor.processors, t.editor.processors);
  const { editor, ...exec } = back;
  const { editor: original, ...origExec } = t;
  assert.deepEqual(exec, origExec);
});

test('diagnostics for blocks', () => {
  const schema = shop();
  const d = newDesign();
  d.templateId = 'blocks';
  d.sources.push(newSource({ id: 's1', sheet: { mode: 'name', value: 'Hoja' }, columns: [{ letter: 'A', label: 'Name' }] }));
  const split = newSplit({ id: 'p1', input: { sourceId: 's1', letter: 'A', label: 'Name' } });
  const choice = newChoice({ id: 'p2', name: 'pick', table: 'ghost', valueColumn: 'id' });
  d.processors.push(split, choice, newSplit({ id: 'p3' }));
  const t = newTask('public', 'customer', { id: 't1', sourceId: 's1' });
  t.mappings.push({ id: 'm1', letter: '', label: '', via: 'p1', targetColumn: 'full_name', blank: 'null', trim: false }, { id: 'm2', letter: '', label: '', via: 'p2', targetColumn: 'email', blank: 'null', trim: false });
  d.tasks.push(t);
  const codes = designDiagnostics(d, schema, [{ name: 'Hoja', rows: [['Name'], ['a,b']] }]).map((x) => x.code);
  assert.ok(codes.includes('SPLIT_TARGET'));
  assert.ok(codes.includes('PARAM_TABLE'));
  assert.ok(codes.includes('SPLIT_NO_INPUT'));
  assert.ok(codes.includes('PARAM_NO_DEFAULT'));
  const arr = structuredClone(d);
  arr.tasks[0].schema = 'shop';
  arr.tasks[0].table = 'product';
  arr.tasks[0].mappings = [{ id: 'm1', letter: '', label: '', via: 'p1', targetColumn: 'tags', blank: 'null', trim: false }];
  assert.ok(!designDiagnostics(arr, schema, null).some((x) => x.code === 'SPLIT_TARGET' || x.code === 'COLUMN_MISSING'));
  assert.deepEqual(designToTemplate(d, { editor: false }).execution.tasks[0].mappings[0].processor, { type: 'split', delimiter: ',', trim: true, dropEmpty: true });
});

test('lookup blocks: a foreign key found from a value, version 1.2', () => {
  const t = clone(TEMPLATE);
  t.specVersion = '1.2';
  const lookup = { type: 'lookup', schema: 'public', table: 'catCarreras', matchColumn: 'nombre', valueColumn: 'idCarrera', onMissing: 'error' };
  t.execution.tasks[1].mappings[2] = { source: { mode: 'header', name: 'ID Carrera' }, targetColumn: 'idCarrera', trim: true, processor: lookup };
  assert.deepEqual(validateTemplate(t), []);
  assert.match(validateTemplate({ ...clone(t), specVersion: '1.11' })[0], /Unsupported/);
  const bad = clone(t);
  bad.execution.tasks[1].mappings[2].processor = { type: 'lookup', table: 'x' };
  assert.notEqual(validateTemplate(bad).length, 0);
  // The reader keeps the key; the runner resolves it.
  const wb = [careers([]), students([['Ana', '1', ' Derecho ', '']])];
  assert.equal(extractRows(t, wb).tasks[1].rows[0].values.idCarrera, 'Derecho');
  // Round trip: the design holds one block, the template the lookup again.
  const d = templateToDesign(t);
  assert.equal(d.processors[0].kind, 'lookup');
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.specVersion, '1.2');
  assert.deepEqual(back.execution.tasks[1].mappings[2], t.execution.tasks[1].mappings[2]);
  // Order: the looked-up table must be filled first.
  const d2 = templateToDesign(t);
  d2.tasks.reverse();
  const warn = designDiagnostics(d2, shop(), null).map((x) => x.code);
  assert.ok(warn.includes('LOOKUP_ORDER'));
  assert.ok(!designDiagnostics(d, shop(), null).some((x) => x.code === 'LOOKUP_ORDER'));
  // The value to look for must be a primary key of its table.
  const pk = structuredClone(d);
  Object.assign(pk.processors[0], { schema: 'public', table: 'customer', matchColumn: 'email', valueColumn: 'id' });
  assert.ok(designDiagnostics(pk, shop(), null).some((x) => x.code === 'LOOKUP_NOT_PK'));
  pk.processors[0].matchColumn = 'id';
  assert.ok(!designDiagnostics(pk, shop(), null).some((x) => x.code === 'LOOKUP_NOT_PK' || x.code === 'LOOKUP_TABLE'));
  const empty = newDesign();
  empty.processors.push(newLookup({ id: 'l1' }));
  assert.ok(designDiagnostics(empty, null, null).some((x) => x.code === 'LOOKUP_NO_INPUT'));
});

test('inserted keys: a column fed by what an earlier task returned, version 1.3', () => {
  const t = clone(TEMPLATE);
  t.specVersion = '1.3';
  // Both tasks read the Carreras sheet; the second takes the key the first inserted.
  t.execution.tasks[1].sourceId = 'srcCarreras';
  t.execution.tasks[1].mappings = [
    { source: { mode: 'column', column: 'D' }, targetColumn: 'nombre' },
    { source: { mode: 'inserted', taskId: 'insertCarreras', column: 'idCarrera' }, targetColumn: 'carreraId' },
  ];
  assert.deepEqual(validateTemplate(t), []);
  const wb = [careers([['1', 'Derecho']]), students([])];
  const run = extractRows(t, wb);
  assert.deepEqual(run.tasks[1].rows[0].values, { nombre: 'Derecho', carreraId: null });
  assert.deepEqual(run.tasks[1].inserted, { carreraId: 'insertCarreras.idCarrera' });
  const back = designToTemplate(templateToDesign(t), { editor: false });
  assert.equal(back.specVersion, '1.3');
  assert.deepEqual(back.execution.tasks[1].mappings[1], t.execution.tasks[1].mappings[1]);
  // Only earlier tasks, and the same source.
  const later = clone(t);
  later.execution.tasks[0].order = 2;
  later.execution.tasks[1].order = 1;
  assert.match(validateTemplate(later).join(), /runs after it/);
  const other = clone(t);
  other.execution.tasks[1].sourceId = 'srcAlumnos';
  other.execution.tasks[1].mappings[0] = { source: { mode: 'header', name: 'Nombre' }, targetColumn: 'nombre' };
  assert.match(validateTemplate(other).join(), /another source/);
  // A task may have no worksheet column at all: it inserts one row per row of the task whose key it uses.
  const only = clone(t);
  only.execution.tasks[1].mappings = [t.execution.tasks[1].mappings[1], { source: { mode: 'parameter', name: 'estado' }, targetColumn: 'estado' }];
  only.parameters = [{ name: 'estado', default: 'nuevo', source: { type: 'table', schema: 'public', table: 'estados', valueColumn: 'id' } }];
  assert.deepEqual(validateTemplate(only), []);
  const two = [careers([['1', 'Derecho'], [], ['3', 'Física']]), students([])];
  const rows = extractRows(only, two).tasks[1].rows;
  assert.deepEqual(rows.map((r) => [r.row, r.values.estado]), [[5, 'nuevo'], [7, 'nuevo']]);
  const none = clone(only);
  none.execution.tasks[1].mappings = [only.execution.tasks[1].mappings[1]];
  none.execution.tasks[1].mappings[0] = { source: { mode: 'parameter', name: 'estado' }, targetColumn: 'estado' };
  assert.match(validateTemplate(none).join(), /needs at least one column of the worksheet/);
});

test('inserted keys: diagnostics and insertion order', () => {
  const schema = shop();
  const d = newDesign();
  d.templateId = 'master';
  d.sources.push(newSource({ id: 's1', sheet: { mode: 'name', value: 'Hoja' }, columns: [{ letter: 'A', label: 'Email' }, { letter: 'B', label: 'Estado' }] }));
  const parent = newTask('public', 'customer', { id: 'parent', sourceId: 's1' });
  parent.mappings.push({ id: 'm1', letter: 'A', label: 'Email', targetColumn: 'email', blank: 'null', trim: false });
  const child = newTask('shop', 'orders', { id: 'child', sourceId: 's1' });
  child.mappings.push(
    { id: 'm2', letter: 'B', label: 'Estado', targetColumn: 'status', blank: 'null', trim: false },
    { id: 'm3', letter: '', label: '', inserted: { taskId: 'parent', column: 'id' }, targetColumn: 'customer_id', blank: 'null', trim: false },
  );
  d.tasks.push(child, parent);
  const codes = (x) => designDiagnostics(x, schema, null).map((y) => y.code);
  assert.ok(codes(d).includes('INSERTED_ORDER'));
  assert.deepEqual(suggestOrder(d, schema).order, ['parent', 'child']);
  d.tasks.reverse();
  assert.ok(!codes(d).includes('INSERTED_ORDER'));
  d.tasks[1].mappings[1].inserted.column = 'email';
  assert.ok(codes(d).includes('INSERTED_NOT_PK'));
  d.tasks[1].mappings[1].inserted.column = 'id';
  d.tasks[0].sourceId = null;
  assert.ok(codes(d).includes('INSERTED_SOURCE'));
});

test('node sizes are kept in the editor section only', () => {
  const t = clone(TEMPLATE);
  t.editor.nodes.srcCarreras = { x: 200, y: 100, w: 300, h: 180 };
  const d = templateToDesign(t);
  assert.deepEqual([d.sources[0].w, d.sources[0].h, d.tasks[0].w], [300, 180, undefined]);
  const back = designToTemplate(d);
  assert.deepEqual(back.editor.nodes.srcCarreras, { x: 200, y: 100, w: 300, h: 180 });
  assert.deepEqual(back.editor.nodes.insertCarreras, { x: back.editor.nodes.insertCarreras.x, y: back.editor.nodes.insertCarreras.y });
  assert.equal(JSON.stringify(designToTemplate(d, { editor: false })).includes('300'), false);
});

test('case blocks: upper or lower case for a string or for each element of a list, version 1.4', () => {
  assert.equal(changeCase('Ana Pérez', 'upper'), 'ANA PÉREZ');
  assert.deepEqual(changeCase(['A', 'b'], 'lower'), ['a', 'b']);
  const t = clone(TEMPLATE);
  t.specVersion = '1.4';
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags', processor: { type: 'case', mode: 'upper', split: { delimiter: '|' } } });
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'tag', processor: { type: 'case', mode: 'lower' } });
  assert.deepEqual(validateTemplate(t), []);
  const bad = clone(t);
  bad.execution.tasks[1].mappings[bad.execution.tasks[1].mappings.length - 1].processor.mode = 'title';
  assert.notEqual(validateTemplate(bad).length, 0);
  assert.equal(designToTemplate(templateToDesign(t), { editor: false }).specVersion, '1.4');
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => [p.kind, p.mode, p.list]), [['case', 'upper', true], ['case', 'lower', false]]);
  assert.deepEqual(designToTemplate(d, { editor: false }).execution.tasks[1].mappings.slice(-2), t.execution.tasks[1].mappings.slice(-2).map((m, i) => (i ? m : { ...m, processor: { type: 'case', mode: 'upper', split: { delimiter: '|', trim: true, dropEmpty: true } } })));
  assert.equal(newCase().mode, 'upper');
});

test('table dropdown filter, version 1.4', () => {
  const d = newDesign();
  d.processors.push(newChoice({ id: 'c1', name: 'campus', schema: 'public', table: 'campus', valueColumn: 'id', filterColumn: 'active', filterValue: 'true' }));
  d.processors.push(newChoice({ id: 'c2', name: 'x', table: 't', valueColumn: 'id', filterColumn: 'active', filterValue: '' }));
  const s = newSource({ id: 's1', sheet: { mode: 'name', value: 'Hoja1', headers: null } });
  const task = newTask('public', 'a', { id: 't1', sourceId: 's1' });
  task.mappings.push({ id: 'm1', letter: 'A', label: 'A', targetColumn: 'c', blank: 'null', trim: false });
  task.mappings.push({ id: 'm2', letter: '', label: '', via: 'c1', targetColumn: 'campus', blank: 'null', trim: false });
  d.sources.push(s);
  d.tasks.push(task);
  const t = designToTemplate(d, { editor: false });
  assert.deepEqual(t.parameters[0].source.filter, { column: 'active', value: 'true' });
  assert.equal(t.specVersion, '1.4');
  assert.deepEqual(validateTemplate(t), []);
  const back = templateToDesign(t).processors.find((p) => p.kind === 'choice');
  assert.deepEqual([back.filterColumn, back.filterValue], ['active', 'true']);
  assert.ok(designDiagnostics(d, null, null).some((x) => x.code === 'PARAM_FILTER'));
});

test('table dropdown filter that follows another dropdown', () => {
  const d = newDesign();
  d.processors.push(newChoice({ id: 'c1', name: 'campus', table: 'campus', valueColumn: 'id', value: '7' }));
  d.processors.push(newChoice({ id: 'c2', name: 'career', table: 'career', valueColumn: 'id', filterColumn: 'campusId', filterParam: 'campus' }));
  d.sources.push(newSource({ id: 's1', sheet: { mode: 'name', value: 'Hoja1', headers: null } }));
  const task = newTask('public', 'a', { id: 't1', sourceId: 's1' });
  task.mappings.push({ id: 'm1', letter: 'A', label: 'A', targetColumn: 'c', blank: 'null', trim: false });
  task.mappings.push({ id: 'm2', letter: '', label: '', via: 'c2', targetColumn: 'careerId', blank: 'null', trim: false });
  d.tasks.push(task);
  const t = designToTemplate(d, { editor: false });
  assert.deepEqual(t.parameters.map((p) => p.name).sort(), ['campus', 'career']);
  assert.deepEqual(t.parameters.find((p) => p.name === 'career').source.filter, { column: 'campusId', parameter: 'campus' });
  assert.deepEqual(validateTemplate(t), []);
  assert.equal(templateToDesign(t).processors.find((p) => p.name === 'career').filterParam, 'campus');
  assert.equal(designDiagnostics(d, null, null).some((x) => x.code === 'PARAM_FILTER'), false);
  const both = clone(t);
  both.parameters.find((p) => p.name === 'career').source.filter.value = 'x';
  assert.match(validateTemplate(both).join(), /exactly one/);
  const loop = clone(t);
  loop.parameters.find((p) => p.name === 'campus').source.filter = { column: 'x', parameter: 'career' };
  assert.match(validateTemplate(loop).join(), /leads back/);
  d.processors[0].filterColumn = 'x';
  d.processors[0].filterParam = 'career';
  assert.ok(designDiagnostics(d, null, null).some((x) => x.code === 'PARAM_FILTER'));
});

test('a split block can follow a case block', () => {
  const t = clone(TEMPLATE);
  t.specVersion = '1.4';
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags', processor: { type: 'split', delimiter: '|', case: 'upper' } });
  assert.deepEqual(validateTemplate(t), []);
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => p.kind), ['case', 'split']);
  assert.deepEqual(d.processors[1].input, { procId: d.processors[0].id });
  assert.equal(blockSource(d, d.processors[1]).label, 'Extra');
  assert.equal(designDiagnostics(d, null, null).some((x) => x.code.startsWith('SPLIT_')), false);
  const back = designToTemplate(d, { editor: false });
  assert.deepEqual(back.execution.tasks[1].mappings.at(-1).processor, { type: 'split', delimiter: '|', trim: true, dropEmpty: true, case: 'upper' });
  assert.equal(back.specVersion, '1.4');
  d.processors[0].list = true;
  assert.ok(designDiagnostics(d, null, null).some((x) => x.code === 'CHAIN_INPUT'));
});

test('replace and convert blocks, version 1.5', () => {
  const cfg = { pairs: [{ from: 'M', to: 'Male' }, { from: 'F', to: 'Female' }] };
  assert.deepEqual(mapText(' m ', cfg), { ok: true, value: 'Male' });
  assert.deepEqual(mapText('x', cfg), { ok: true, value: 'x' });
  assert.deepEqual(mapText('x', { ...cfg, otherwise: 'null' }), { ok: true, value: null });
  assert.equal(mapText('x', { ...cfg, otherwise: 'error' }).ok, false);
  assert.equal(mapText('m', { ...cfg, caseSensitive: true, otherwise: 'error' }).ok, false);
  assert.equal(convertText('31/12/2025', { to: 'date' }).value, '2025-12-31');
  assert.equal(convertText('12/31/25', { to: 'date', order: 'mdy' }).value, '2025-12-31');
  assert.equal(convertText('2025-03-04 5:07', { to: 'timestamp', order: 'ymd' }).value, '2025-03-04 05:07:00');
  assert.equal(convertText('31/02/2025', { to: 'date' }).ok, false);
  assert.equal(convertText('1.234,50', { to: 'number', decimal: ',' }).value, '1234.50');
  assert.equal(convertText('$1,234.50', { to: 'number' }).value, '1234.50');
  assert.equal(convertText('(5)', { to: 'number' }).value, '-5');
  assert.equal(convertText('abc', { to: 'number' }).ok, false);
  assert.equal(convertText('Sí', { to: 'boolean' }).value, 'true');
  assert.equal(convertText('maybe', { to: 'boolean' }).ok, false);

  const t = clone(TEMPLATE);
  t.specVersion = '1.5';
  const ms = t.execution.tasks[1].mappings;
  ms.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'sex', processor: { type: 'map', pairs: [{ from: 'x', to: 'Y' }], otherwise: 'error' } });
  ms.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'born', processor: { type: 'convert', to: 'date', order: 'dmy' } });
  assert.deepEqual(validateTemplate(t), []);
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => p.kind), ['map', 'convert']);
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.specVersion, '1.5');
  assert.deepEqual(back.execution.tasks[1].mappings.at(-2).processor, { type: 'map', pairs: [{ from: 'x', to: 'Y' }], caseSensitive: false, otherwise: 'error' });
  assert.deepEqual(back.execution.tasks[1].mappings.at(-1).processor, { type: 'convert', to: 'date', order: 'dmy' });
  const bad = clone(t);
  bad.execution.tasks[1].mappings.at(-1).processor.to = 'color';
  assert.notEqual(validateTemplate(bad).length, 0);
  d.processors[0].pairs = [{ from: '', to: '' }];
  assert.ok(designDiagnostics(d, null, null).some((x) => x.code === 'MAP_EMPTY'));
});

test('string blocks can be chained, version 1.6', () => {
  const t = clone(TEMPLATE);
  t.specVersion = '1.6';
  const chain = [
    { type: 'map', pairs: [{ from: 'x', to: 'a b' }], otherwise: 'keep' },
    { type: 'case', mode: 'upper' },
    { type: 'split', delimiter: ' ' },
  ];
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'tags', processors: chain });
  assert.deepEqual(validateTemplate(t), []);
  const wb = [careers([]), students([['Ana', '1', '2', 'x'], ['Bo', '2', '3', 'c d']])];
  assert.deepEqual(extractRows(t, wb).tasks[1].rows.map((r) => r.values.tags), [['A', 'B'], ['C', 'D']]);

  // The designer holds one block per step, each reading the one before.
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => p.kind), ['map', 'case', 'split']);
  assert.ok(d.processors[0].input.sourceId && d.processors[1].input.procId === d.processors[0].id && d.processors[2].input.procId === d.processors[1].id);
  assert.equal(blockSource(d, d.processors[2]).label, 'Extra');
  assert.deepEqual(chainOf(d, d.processors[2]).map((p) => p.kind), ['map', 'case', 'split']);
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.specVersion, '1.6');
  assert.deepEqual(back.execution.tasks[1].mappings.at(-1).processors.map((x) => x.type), ['map', 'case', 'split']);
  assert.equal(designDiagnostics(d, null, null).some((x) => x.code === 'CHAIN_INPUT'), false);

  // A step that makes an array or a key must be last, and both spellings are not allowed together.
  const bad = clone(t);
  bad.execution.tasks[1].mappings.at(-1).processors = [chain[2], chain[1]];
  assert.match(validateTemplate(bad).join(), /no other processor can follow/);
  const both = clone(t);
  both.execution.tasks[1].mappings.at(-1).processor = chain[1];
  assert.match(validateTemplate(both).join(), /both processor and processors/);
  // A failing step stops the chain for that cell.
  const strict = clone(t);
  strict.execution.tasks[1].mappings.at(-1).processors[0].otherwise = 'error';
  const run = extractRows(strict, wb);
  assert.equal(run.errors[0].code, 'MAP_NO_MATCH');
});

test('join, constant, clean, extract and default, version 1.7', () => {
  assert.equal(cleanText('  Ana   Pérez​ ', { removeAccents: true }), 'Ana Perez');
  assert.equal(extractText('ABCDE', { mode: 'substring', start: 2, length: 3 }).value, 'BCD');
  assert.equal(extractText('AB', { mode: 'substring', start: 5 }).value, null);
  assert.equal(extractText('Tel: 555-1234', { mode: 'regex', pattern: '(\\d+)-(\\d+)', group: 2 }).value, '1234');
  assert.equal(extractText('none', { mode: 'regex', pattern: '\\d+', otherwise: 'keep' }).value, 'none');
  assert.equal(extractText('none', { mode: 'regex', pattern: '\\d+', otherwise: 'error' }).ok, false);

  const t = clone(TEMPLATE);
  t.specVersion = '1.7';
  const ms = t.execution.tasks[1].mappings;
  const added = [
    { source: { mode: 'join', parts: [{ header: 'Nombre' }, { header: 'Matrícula' }], separator: ' - ', prefix: '[', suffix: ']' }, targetColumn: 'etiqueta', processor: { type: 'case', mode: 'upper' } },
    { source: { mode: 'constant', value: 'ALTA' }, targetColumn: 'estado' },
    { source: { mode: 'header', name: 'Extra' }, targetColumn: 'nota', processors: [{ type: 'default', value: 'sin nota' }, { type: 'clean', collapseSpaces: true, removeControl: true, removeAccents: false }] },
    { source: { mode: 'header', name: 'Extra' }, targetColumn: 'num', processor: { type: 'extract', mode: 'regex', pattern: '\\d+', group: 0, ignoreCase: false, otherwise: 'null' } },
  ];
  ms.push(...added);
  assert.deepEqual(validateTemplate(t), []);
  const wb = [careers([]), students([['Ana', 'A1', '1', ' hola   mundo 42'], ['Bo', '', '2', '']])];
  const rows = extractRows(t, wb).tasks[1].rows.map((r) => r.values);
  assert.equal(rows[0].etiqueta, '[ANA - A1]');
  assert.equal(rows[1].etiqueta, '[BO]');
  assert.equal(rows[0].estado, 'ALTA');
  assert.deepEqual([rows[0].nota, rows[1].nota], ['hola mundo 42', 'sin nota']);
  assert.deepEqual([rows[0].num, rows[1].num], ['42', null]);

  // The designer holds a join block with its inputs, a constant block and the chains.
  const d = templateToDesign(t);
  assert.deepEqual(d.processors.map((p) => p.kind), ['join', 'case', 'constant', 'default', 'clean', 'extract']);
  assert.equal(d.processors[0].inputs.length, 2);
  assert.equal(designDiagnostics(d, null, null).some((x) => x.level === 'error' && /BLOCK_NO_INPUT|JOIN|CHAIN|DEFAULT|EXTRACT/.test(x.code)), false);
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.specVersion, '1.7');
  assert.deepEqual(back.execution.tasks[1].mappings.slice(-4), added.map((m, i) => (i === 0 ? { ...m, source: { ...m.source } } : m)));
  assert.deepEqual(columnRefs(d, d.sources.find((x) => x.id === 'srcAlumnos')).map((c) => c.label).filter((l) => l === 'Nombre' || l === 'Matrícula').length, 4);

  const bad = clone(t);
  bad.execution.tasks[1].mappings.at(-1).processor.pattern = '(';
  assert.match(validateTemplate(bad).join(), /not a valid regular expression/);
  const late = clone(t);
  late.execution.tasks[1].mappings.at(-2).processors = [{ type: 'clean' }, { type: 'default', value: 'x' }];
  assert.match(validateTemplate(late).join(), /must be the first/);
  const fixed = clone(t);
  fixed.execution.tasks[1].mappings.at(-3).processor = { type: 'clean' };
  assert.match(validateTemplate(fixed).join(), /constant cannot have a processor/);
});

test('an optional header the workbook lacks is skipped; a required one still fails', () => {
  const t = clone(TEMPLATE);
  t.execution.tasks[1].mappings.push({ source: { mode: 'header', name: 'Extra' }, targetColumn: 'nota', optional: true });
  assert.deepEqual(validateTemplate(t), []);
  const withExtra = extractRows(t, [careers([]), students([['Ana', 'A1', '1', 'hi']])]);
  assert.deepEqual(withExtra.tasks[1].skipped, []);
  assert.equal(withExtra.tasks[1].rows[0].values.nota, 'hi');
  const lacking = { ...students([['Ana', 'A1', '1']]), rows: [['Nombre', 'Matrícula', 'ID Carrera'], ['Ana', 'A1', '1']] };
  const run = extractRows(t, [careers([]), lacking]);
  assert.equal(run.ok, true);
  assert.deepEqual(run.tasks[1].skipped, ['nota']);
  assert.equal('nota' in run.tasks[1].rows[0].values, false);
  t.execution.tasks[1].mappings.at(-1).optional = false;
  assert.equal(extractRows(t, [careers([]), lacking]).ok, false);
});

test('distinct values of a worksheet column and of a table column, version 1.8', () => {
  const base = (tasks) => ({
    format: 'excel-pg-insert-template',
    specVersion: '1.8',
    templateId: 'cats',
    name: 'Categorias',
    sources: [{
      id: 'src',
      sheet: { mode: 'name', value: 'Alumnos' },
      header: { mode: 'detect', scanRows: { from: 1, to: 5 }, match: { trim: true, caseSensitive: false } },
      data: { firstRow: { mode: 'afterHeader', offset: 1 }, endMode: 'lastNonEmptyMappedRow', skipEmptyRows: true },
    }],
    execution: { operation: 'insert', transaction: 'atomic', tasks },
  });
  const wb = [students([['Ana', 'A1', ' x ', ''], ['Bo', 'B1', 'X', ''], ['Cy', 'C1', 'y', ''], ['Di', 'D1', '', ''], ['Ed', 'E1', 'y', '']])];
  wb[0].rows[0][2] = 'Cat';
  const t = base([{
    id: 'cats', order: 1, sourceId: 'src', target: { schema: 'public', table: 'cat' },
    mappings: [
      { source: { mode: 'header', name: 'Cat' }, targetColumn: 'name', processors: [{ type: 'clean', collapseSpaces: true, removeControl: true, removeAccents: false }, { type: 'distinct', ignoreCase: true }, { type: 'case', mode: 'upper' }] },
      { source: { mode: 'constant', value: 'on' }, targetColumn: 'state' },
    ],
  }]);
  assert.deepEqual(validateTemplate(t), []);
  const run = extractRows(t, wb);
  assert.equal(run.ok, true);
  assert.deepEqual(run.tasks[0].rows.map((r) => r.values), [{ name: 'X', state: 'on' }, { name: 'Y', state: 'on' }]);
  assert.equal(run.tasks[0].total, 2);
  // Without ignoreCase the two spellings stay apart.
  t.execution.tasks[0].mappings[0].processors[1] = { type: 'distinct' };
  assert.equal(extractRows(t, wb).tasks[0].total, 3);

  // stopAtEmpty ends the reading at the first blank cell: Di's blank hides Ed's "y" (already seen) and anything after it.
  const wb2 = [students([['Ana', 'A1', 'x', ''], ['Bo', 'B1', 'y', ''], ['Cy', 'C1', '', ''], ['Di', 'D1', 'z', '']])];
  wb2[0].rows[0][2] = 'Cat';
  t.execution.tasks[0].mappings[0].processors[1] = { type: 'distinct' };
  assert.deepEqual(extractRows(t, wb2).tasks[0].rows.map((r) => r.values.name), ['X', 'Y', 'Z']);
  t.execution.tasks[0].mappings[0].processors[1] = { type: 'distinct', stopAtEmpty: true };
  assert.deepEqual(extractRows(t, wb2).tasks[0].rows.map((r) => r.values.name), ['X', 'Y']);

  // A table column: the runner hands in its values; the task has no worksheet.
  const tt = base([{
    id: 'fromTable', order: 1, target: { schema: 'public', table: 'copy' },
    mappings: [{ source: { mode: 'distinct', schema: 'public', table: 'cat', column: 'name' }, targetColumn: 'name', processor: { type: 'case', mode: 'lower' } }],
  }]);
  assert.deepEqual(validateTemplate(tt), []);
  assert.equal(extractRows(tt, wb).ok, false);
  const key = JSON.stringify(['public', 'cat', 'name']);
  const got = extractRows(tt, wb, { tableValues: { [key]: ['A', 'B', ' '] } });
  assert.deepEqual(got.tasks[0].rows.map((r) => r.values.name), ['a', 'b']);
  assert.equal(extractRows(tt, wb, { previewMissing: true }).tasks[0].total, 0);

  // The designer reads and writes both forms.
  for (const tpl of [t, tt]) {
    const d = templateToDesign(tpl);
    assert.equal(d.processors.some((p) => p.kind === 'distinct'), true);
    assert.deepEqual(designToTemplate(d, { editor: false }).execution, tpl.execution);
    assert.equal(designToTemplate(d, { editor: false }).specVersion, '1.8');
    assert.equal(designDiagnostics(d, null, null).some((x) => x.level === 'error'), false);
  }

  // Rules: one distinct column, no other worksheet columns, no inserted keys from it.
  const mix = clone(t);
  mix.execution.tasks[0].mappings.push({ source: { mode: 'header', name: 'Nombre' }, targetColumn: 'other' });
  assert.match(validateTemplate(mix).join(), /only hold fixed values/);
  const two = clone(t);
  two.execution.tasks[0].mappings.push({ source: { mode: 'header', name: 'Nombre' }, targetColumn: 'other', processor: { type: 'distinct' } });
  assert.match(validateTemplate(two).join(), /only one column/);
  const child = clone(t);
  child.execution.tasks.push({ id: 'kid', order: 2, sourceId: 'src', target: { schema: 'public', table: 'kid' }, mappings: [{ source: { mode: 'inserted', taskId: 'cats', column: 'id' }, targetColumn: 'cat_id' }, { source: { mode: 'header', name: 'Nombre' }, targetColumn: 'n' }] });
  assert.match(validateTemplate(child).join(), /distinct values/);
  const noSource = clone(t);
  delete noSource.execution.tasks[0].sourceId;
  assert.match(validateTemplate(noSource).join(), /needs a sourceId/);
  assert.match(validateTemplate({ ...t, specVersion: '1.11' }).join(), /Unsupported/);
});

test('a range of rows of one worksheet column gives an array, version 1.9', () => {
  const t = {
    format: 'excel-pg-insert-template',
    specVersion: '1.9',
    templateId: 'range',
    name: 'Rango',
    sources: [{
      id: 'src',
      sheet: { mode: 'name', value: 'Alumnos' },
      header: { mode: 'detect', scanRows: { from: 1, to: 5 }, match: { trim: true, caseSensitive: false } },
      data: { firstRow: { mode: 'afterHeader', offset: 1 }, endMode: 'lastNonEmptyMappedRow', skipEmptyRows: true },
    }],
    execution: {
      operation: 'insert',
      transaction: 'atomic',
      tasks: [{
        id: 'grades', order: 1, sourceId: 'src', target: { schema: 'public', table: 'grade' },
        mappings: [
          { source: { mode: 'header', name: 'Nombre' }, targetColumn: 'name' },
          { source: { mode: 'range', header: 'Matrícula', fromRow: 2, toRow: 3 }, targetColumn: 'cells', processor: { type: 'case', mode: 'upper' } },
          { source: { mode: 'range', header: 'Matrícula', fromRow: 3 }, targetColumn: 'rest' },
        ],
      }],
    },
  };
  assert.deepEqual(validateTemplate(t), []);
  const run = extractRows(t, [students([['Ana', 'a1', '1', 'x'], ['Bo', 'b2', '', ''], ['Cy', 'c3', '', '']])]);
  assert.equal(run.ok, true);
  // The same array goes to every row; no toRow reads to the last value of the column.
  assert.deepEqual(run.tasks[0].rows.map((r) => r.values.cells), [['A1', 'B2'], ['A1', 'B2'], ['A1', 'B2']]);
  assert.deepEqual(run.tasks[0].rows[0].values.rest, ['b2', 'c3']);
  // The designer shows a select block reading the column and writes the same range back.
  const d = templateToDesign(t);
  assert.equal(d.processors[0].kind, 'select');
  assert.deepEqual([d.processors[0].input.label, d.processors[0].fromRow, d.processors[0].toRow], ['Matrícula', 2, 3]);
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.specVersion, '1.9');
  assert.deepEqual(back.execution.tasks[0].mappings.slice(1), t.execution.tasks[0].mappings.slice(1));
  const bad = clone(t);
  bad.execution.tasks[0].mappings[1].processor = { type: 'clean' };
  assert.match(validateTemplate(bad).join(), /only a case processor/);
  delete bad.execution.tasks[0].mappings[1].processor;
  bad.execution.tasks[0].mappings[1].source.toRow = 1;
  assert.match(validateTemplate(bad).join(), /before row 2/);
});

test('lastRow ends the rows a source reads, version 1.10', () => {
  const t = {
    format: 'excel-pg-insert-template',
    specVersion: '1.10',
    templateId: 'last',
    name: 'Ultima',
    sources: [{
      id: 'src',
      sheet: { mode: 'name', value: 'Alumnos' },
      header: { mode: 'detect', scanRows: { from: 1, to: 5 }, match: { trim: true, caseSensitive: false } },
      data: { firstRow: { mode: 'afterHeader', offset: 1 }, endMode: 'lastNonEmptyMappedRow', lastRow: 3, skipEmptyRows: true },
    }],
    execution: {
      operation: 'insert',
      transaction: 'atomic',
      tasks: [{
        id: 'a', order: 1, sourceId: 'src', target: { schema: 'public', table: 'alumno' },
        mappings: [{ source: { mode: 'header', name: 'Nombre' }, targetColumn: 'name' }],
      }],
    },
  };
  assert.deepEqual(validateTemplate(t), []);
  const book = [students([['Ana', 'a1', '', ''], ['Bo', 'b2', '', ''], ['Cy', 'c3', '', ''], ['Di', 'd4', '', '']])];
  const cut = extractRows(t, book);
  assert.equal(cut.ok, true);
  assert.deepEqual(cut.tasks[0].rows.map((r) => r.values.name), ['Ana', 'Bo']); // the header is row 1: rows 2 and 3
  const all = clone(t);
  delete all.sources[0].data.lastRow;
  assert.equal(extractRows(all, book).tasks[0].rows.length, 4);
  const from = clone(t);
  from.sources[0].data.firstRow = { mode: 'row', row: 3 };
  assert.deepEqual(extractRows(from, book).tasks[0].rows.map((r) => r.values.name), ['Bo']); // rows 3 to 3
  const dd = templateToDesign(from);
  assert.equal(dd.sources[0].startRow, 3);
  assert.deepEqual(designToTemplate(dd, { editor: false }).sources[0].data.firstRow, { mode: 'row', row: 3 });
  const d = templateToDesign(t);
  assert.equal(d.sources[0].lastRow, 3);
  const back = designToTemplate(d, { editor: false });
  assert.equal(back.sources[0].data.lastRow, 3);
  assert.equal(back.specVersion, '1.10');
  const bad = clone(t);
  bad.sources[0].header = { mode: 'fixed', row: 1, startColumn: 'A' };
  bad.sources[0].data.lastRow = 1;
  assert.match(validateTemplate(bad).join(), /lastRow is before/);
});
