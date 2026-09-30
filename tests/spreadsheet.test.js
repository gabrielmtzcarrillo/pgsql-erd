import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { parsePgerd, emptyModel } from '../src/renderer/lib/pgerd.js';
import { generateSQL } from '../src/renderer/lib/sql.js';
import {
  readSpreadsheet, readXlsx, parseCsv, snakeCase, normalizeType, inferType, parseReference,
  sheetTables, modelFromSpecs, importSpecs, dateFormatKind, serialToString,
} from '../src/renderer/lib/spreadsheet.js';

// Minimal zip writer (deflate) for building .xlsx fixtures.
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(comp.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook() {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <workbook ${NS}><sheets>
        <sheet name="Customers" sheetId="1" r:id="rId1"/>
        <sheet name="Schema" sheetId="2" r:id="rId2"/>
        <sheet name="Old" sheetId="3" state="hidden" r:id="rId3"/>
      </sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
        <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
        <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>`,
    'xl/sharedStrings.xml': `<sst ${NS}>
      <si><t>ID</t></si><si><t>Full Name</t></si><si><t>Signed Up</t></si><si><t>Active</t></si>
      <si><r><t>Ada </t></r><r><t>Lovelace</t></r></si><si><t xml:space="preserve">Tom &amp; Jerry</t></si>
      <si><t>Table</t></si><si><t>Column</t></si><si><t>Data Type</t></si><si><t>PK</t></si><si><t>Nullable</t></si><si><t>References</t></si>
      <si><t>orders</t></si><si><t>id</t></si><si><t>bigserial</t></si><si><t>yes</t></si><si><t>no</t></si>
      <si><t>customer_id</t></si><si><t>BIGINT</t></si><si><t>customers.id</t></si>
      <si><t>total</t></si><si><t>decimal(10, 2)</t></si>
      <si><t>order_lines</t></si><si><t>order_id</t></si><si><t>int</t></si><si><t>orders(id)</t></si>
      <si><t>Comment</t></si><si><t>Order total</t></si>
    </sst>`,
    'xl/styles.xml': `<styleSheet ${NS}>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
      <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="22"/></cellXfs>
    </styleSheet>`,
    // Data layout, with a gap at column B in row 3 and a date column.
    'xl/worksheets/sheet1.xml': `<worksheet ${NS}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" s="1"><v>45292</v></c><c r="D2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3"><v>2</v></c><c r="C3" s="1"><v>45293</v></c><c r="D3" t="b"><v>0</v></c></row>
      <row r="5"><c r="A5"><v>3</v></c><c r="B5" t="inlineStr"><is><t>Tom &amp; Jerry</t></is></c><c r="C5" s="1"><v>45294</v></c><c r="D5" t="b"><v>1</v></c></row>
    </sheetData></worksheet>`,
    // Definition layout; the table name is only on the first row of each table.
    'xl/worksheets/sheet2.xml': `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
      <x:row r="2"><x:c r="A2" t="s"><x:v>6</x:v></x:c><x:c r="B2" t="s"><x:v>7</x:v></x:c><x:c r="C2" t="s"><x:v>8</x:v></x:c><x:c r="D2" t="s"><x:v>9</x:v></x:c><x:c r="E2" t="s"><x:v>10</x:v></x:c><x:c r="F2" t="s"><x:v>11</x:v></x:c><x:c r="G2" t="s"><x:v>26</x:v></x:c></x:row>
      <x:row r="3"><x:c r="A3" t="s"><x:v>12</x:v></x:c><x:c r="B3" t="s"><x:v>13</x:v></x:c><x:c r="C3" t="s"><x:v>14</x:v></x:c><x:c r="D3" t="s"><x:v>15</x:v></x:c><x:c r="E3" t="s"><x:v>16</x:v></x:c></x:row>
      <x:row r="4"><x:c r="B4" t="s"><x:v>17</x:v></x:c><x:c r="C4" t="s"><x:v>18</x:v></x:c><x:c r="E4" t="s"><x:v>16</x:v></x:c><x:c r="F4" t="s"><x:v>19</x:v></x:c></x:row>
      <x:row r="5"><x:c r="B5" t="s"><x:v>20</x:v></x:c><x:c r="C5" t="s"><x:v>21</x:v></x:c><x:c r="E5" t="s"><x:v>15</x:v></x:c><x:c r="G5" t="s"><x:v>27</x:v></x:c></x:row>
      <x:row r="6"><x:c r="A6" t="s"><x:v>22</x:v></x:c><x:c r="B6" t="s"><x:v>23</x:v></x:c><x:c r="C6" t="s"><x:v>24</x:v></x:c><x:c r="D6" t="s"><x:v>15</x:v></x:c><x:c r="F6" t="s"><x:v>25</x:v></x:c></x:row>
    </x:sheetData></x:worksheet>`,
    'xl/worksheets/sheet3.xml': `<worksheet ${NS}><sheetData><row r="1"><c r="A1" s="2"><v>45292.5</v></c></row></sheetData></worksheet>`,
  });
}

test('reads cells, shared strings, dates and booleans from .xlsx', async () => {
  const sheets = await readXlsx(workbook());
  assert.deepEqual(sheets.map((s) => [s.name, s.hidden]), [['Customers', false], ['Schema', false], ['Old', true]]);
  const [cust, schema, old] = sheets;
  assert.deepEqual(cust.rows[0], ['ID', 'Full Name', 'Signed Up', 'Active']);
  assert.deepEqual(cust.rows[1], ['1', 'Ada Lovelace', '2024-01-01', 'true']);
  assert.deepEqual(cust.rows[2], ['2', '', '2024-01-02', 'false']);
  assert.deepEqual(cust.rows[3], []);
  assert.deepEqual(cust.rows[4], ['3', 'Tom & Jerry', '2024-01-03', 'true']);
  assert.deepEqual(schema.rows[0], []);
  assert.equal(schema.rows[1][2], 'Data Type');
  assert.deepEqual(old.rows[0], ['2024-01-01 12:00:00']);
});

test('readSpreadsheet detects CSV and rejects .xls', async () => {
  const sheets = await readSpreadsheet('C:\\data\\My Products.csv', new TextEncoder().encode('a;b\n1;2\n'));
  assert.deepEqual(sheets, [{ name: 'My Products', hidden: false, rows: [['a', 'b'], ['1', '2']] }]);
  await assert.rejects(readSpreadsheet('x.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), /\.xlsx/);
});

test('parseCsv handles quotes, newlines in quotes and delimiters', () => {
  assert.deepEqual(parseCsv('\uFEFFname,note\r\n"Smith, J","said ""hi""\nthere"\r\nx,\n'), [
    ['name', 'note'],
    ['Smith, J', 'said "hi"\nthere'],
    ['x', ''],
  ]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('date formats and serials', () => {
  assert.equal(dateFormatKind(14), 'date');
  assert.equal(dateFormatKind(22), 'datetime');
  assert.equal(dateFormatKind(21), 'time');
  assert.equal(dateFormatKind(2), null);
  assert.equal(dateFormatKind(164, 'dd/mm/yyyy'), 'date');
  assert.equal(dateFormatKind(165, '[$-409]h:mm AM/PM'), 'time');
  assert.equal(dateFormatKind(166, '#,##0.00 "days"'), null);
  assert.equal(dateFormatKind(167, '[Red]0.00'), null);
  assert.equal(serialToString(45292, 'date'), '2024-01-01');
  assert.equal(serialToString(45292.75, 'date'), '2024-01-01 18:00:00');
  assert.equal(serialToString(43830, 'date', true), '2024-01-01');
});

test('names and types', () => {
  assert.equal(snakeCase('Customer ID'), 'customer_id');
  assert.equal(snakeCase('OrderDate'), 'order_date');
  assert.equal(snakeCase('HTTPStatus Code'), 'http_status_code');
  assert.equal(snakeCase('Año (€)'), 'ano');
  assert.equal(snakeCase('2nd line'), '_2nd_line');
  assert.deepEqual(normalizeType('VARCHAR( 100 )'), { type: 'character varying', length: 100, precision: null });
  assert.deepEqual(normalizeType('decimal(10, 2)'), { type: 'numeric', length: 10, precision: 2 });
  assert.deepEqual(normalizeType('int(11) unsigned'), { type: 'integer', length: null, precision: null });
  assert.deepEqual(normalizeType('varchar(20)[]'), { type: 'character varying[]', length: 20, precision: null });
  assert.deepEqual(normalizeType('datetime'), { type: 'timestamp without time zone', length: null, precision: null });
  assert.deepEqual(normalizeType(''), { type: 'text', length: null, precision: null });
  assert.equal(inferType(['1', '2', '']).type, 'integer');
  assert.equal(inferType(['1', '3000000000']).type, 'bigint');
  assert.equal(inferType(['1', '2.5']).type, 'numeric');
  assert.equal(inferType(['007', '8']).type, 'text');
  assert.equal(inferType(['TRUE', 'no']).type, 'boolean');
  assert.equal(inferType(['2024-01-01', '2024-01-02 10:00']).type, 'timestamp without time zone');
  assert.equal(inferType(['2024-01-02T10:00:00Z']).type, 'timestamp with time zone');
  assert.equal(inferType(['2024-01-01']).type, 'date');
  assert.equal(inferType(['10:30']).type, 'time without time zone');
  assert.equal(inferType(['6f1c2b3a-0d4e-4f5a-9b6c-7d8e9f0a1b2c']).type, 'uuid');
  assert.equal(inferType(['{"a":1}', '[]']).type, 'jsonb');
  assert.equal(inferType([]).type, 'text');
  assert.deepEqual(parseReference('public.customers.id'), { schema: 'public', table: 'customers', column: 'id' });
  assert.deepEqual(parseReference('orders(id)'), { schema: null, table: 'orders', column: 'id' });
  assert.deepEqual(parseReference('customers'), { schema: null, table: 'customers', column: null });
  assert.equal(parseReference('yes'), null);
  assert.equal(parseReference(''), null);
});

test('data layout: header row plus inferred types', async () => {
  const [cust] = await readXlsx(workbook());
  const { layout, tables } = sheetTables(cust, { schema: 'crm', notNull: true });
  assert.equal(layout, 'data');
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.name, 'customers');
  assert.equal(t.schema, 'crm');
  assert.equal(t.rows, 3);
  assert.deepEqual(
    t.columns.map((c) => [c.name, c.type, c.pk, c.notNull, c.description]),
    [
      ['id', 'integer', true, true, 'ID'],
      ['full_name', 'text', false, false, 'Full Name'],
      ['signed_up', 'date', false, true, 'Signed Up'],
      ['active', 'boolean', false, true, 'Active'],
    ]
  );
  const raw = sheetTables(cust, { snakeCase: false }).tables[0];
  assert.deepEqual(raw.columns.map((c) => c.name), ['ID', 'Full Name', 'Signed Up', 'Active']);
  assert.equal(raw.columns[0].pk, true);
  assert.equal(raw.columns[2].notNull, false);
});

test('data layout: blank and duplicate headers', () => {
  const { tables } = sheetTables({ name: 'T', rows: [['a', '', 'a'], ['1', '2', '3']] });
  assert.deepEqual(tables[0].columns.map((c) => c.name), ['a', 'column_2', 'a_2']);
  assert.deepEqual(sheetTables({ name: 'E', rows: [[], ['']] }), { layout: 'empty', tables: [] });
});

test('definition layout: one row per column, several tables, keys and references', async () => {
  const [, schema] = await readXlsx(workbook());
  const { layout, tables } = sheetTables(schema);
  assert.equal(layout, 'definition');
  assert.deepEqual(tables.map((t) => t.key), ['public.orders', 'public.order_lines']);
  const [orders, lines] = tables;
  assert.deepEqual(
    orders.columns.map((c) => [c.name, c.type, c.length, c.precision, c.pk, c.notNull, c.ref, c.description]),
    [
      ['id', 'bigserial', null, null, true, true, null, ''],
      ['customer_id', 'bigint', null, null, false, true, { schema: null, table: 'customers', column: 'id' }, ''],
      ['total', 'numeric', 10, 2, false, false, null, 'Order total'],
    ]
  );
  assert.deepEqual(lines.columns.map((c) => [c.name, c.type, c.pk, c.ref]), [
    ['order_id', 'integer', true, { schema: null, table: 'orders', column: 'id' }],
  ]);
});

test('a data sheet with Name and Type columns is not read as definitions', () => {
  const sheet = { name: 'Products', rows: [['Name', 'Type', 'Price'], ['Chair', 'Furniture', '10.5'], ['Desk', 'Furniture', '99']] };
  const { layout, tables } = sheetTables(sheet);
  assert.equal(layout, 'data');
  assert.deepEqual(tables[0].columns.map((c) => [c.name, c.type]), [['name', 'text'], ['type', 'text'], ['price', 'numeric']]);
});

test('definition layout: separate referenced table/column and key column values', () => {
  const sheet = {
    name: 'Invoices',
    rows: [
      ['Field', 'Type', 'Size', 'Scale', 'Key', 'Required', 'Default', 'Ref Table', 'Ref Column', 'Description'],
      ['Invoice No', 'varchar', '20', '', 'PK', '', '', '', '', 'Invoice number'],
      ['Amount', 'number', '12', '2', '', 'yes', '0', '', '', ''],
      ['Code', 'text', '', '', 'UK', 'x', '', '', '', ''],
      ['Customer', 'int', '', '', 'FK', '', '', 'sales.customers', 'id', ''],
    ],
  };
  const t = sheetTables(sheet).tables[0];
  assert.equal(t.key, 'public.invoices');
  assert.deepEqual(
    t.columns.map((c) => [c.name, c.type, c.length, c.precision, c.pk, c.unique, c.notNull, c.default, c.ref]),
    [
      ['invoice_no', 'character varying', 20, null, true, false, true, '', null],
      ['amount', 'numeric', 12, 2, false, false, true, '0', null],
      ['code', 'text', null, null, false, true, true, '', null],
      ['customer', 'integer', null, null, false, false, false, '', { schema: 'sales', table: 'customers', column: 'id' }],
    ]
  );
});

test('modelFromSpecs builds tables, keys and links; generates valid SQL', async () => {
  const sheets = await readXlsx(workbook());
  const specs = [...sheetTables(sheets[0], { schema: 'public' }).tables, ...sheetTables(sheets[1]).tables];
  specs[0].name = 'customers';
  const { model, external } = modelFromSpecs(specs);
  assert.equal(external.length, 0);
  assert.equal(model.links.length, 2);
  const sql = generateSQL(model);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.orders\n\(\n\s+id bigserial NOT NULL,/);
  assert.match(sql, /total numeric\(10,2\)/);
  assert.match(sql, /PRIMARY KEY \(id\)/);
  assert.match(sql, /FOREIGN KEY \(customer_id\)\s+REFERENCES public\.customers \(id\)/);
  assert.match(sql, /FOREIGN KEY \(order_id\)\s+REFERENCES public\.orders \(id\)/);
});

test('importSpecs adds new tables, updates existing ones and links to diagram tables', () => {
  const erd = parsePgerd(readFileSync(new URL('../samples/shop.pgerd', import.meta.url), 'utf8'));
  const names = erd.tables.map((t) => `${t.schema}.${t.name}`);
  const existing = erd.tables[0];
  const pk = existing.columns.find((c) => c.pk);
  const before = { id: existing.id, x: existing.x, y: existing.y };
  const specs = [
    ...sheetTables({ name: existing.name, rows: [['id', 'label'], ['1', 'a']] }, { schema: existing.schema }).tables,
    ...sheetTables({
      name: 'audit_log',
      rows: [['column', 'type', 'references'], ['id', 'bigint', ''], ['ref_id', 'bigint', `${existing.name}.${pk.name}`]],
    }, { schema: existing.schema }).tables,
  ];
  const result = importSpecs(erd, specs);
  assert.equal(result.updated.length, 1);
  assert.equal(result.added.length, 1);
  assert.deepEqual({ id: existing.id, x: existing.x, y: existing.y }, before);
  assert.deepEqual(existing.columns.map((c) => c.name), ['id', 'label']);
  assert.equal(erd.tables.length, names.length + 1);
  const audit = erd.tables.find((t) => t.name === 'audit_log');
  const link = erd.links.find((l) => l.localTable === audit.id);
  assert.equal(link.refTable, existing.id);
  assert.equal(link.refCol, existing.columns.find((c) => c.name === 'id').attnum);

  const empty = emptyModel();
  importSpecs(empty, specs);
  assert.equal(empty.tables.length, 2);
  assert.equal(empty.links.length, 1); // resolved among the imported tables
});
