import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitStatements, tokenize, parseColumnType, parseDump, parseInsert, dumpInserts } from '../src/shared/mysql-dump.js';
import { mysqlType, mysqlDefault, mysqlSpecs } from '../src/renderer/lib/mysqlimport.js';
import { copyOrder, copyRequest } from '../src/renderer/copyui.js';
import { catalogFromRows, columnDefault, mysqlConfig } from '../src/main/database/mysql.cjs';
import { convertValue } from '../src/main/database/data-copy.cjs';

const DUMP = fs.readFileSync(new URL('./fixtures/shop.mysql.sql', import.meta.url), 'utf8');

test('mysql: statements are split on the delimiter, outside strings and comments', () => {
  const texts = [...splitStatements("SELECT 'a;b' -- x;\n; /* ; */ SELECT \"c;\" # ;\n;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nSELECT `x;`;")].map((s) => s.text);
  assert.deepEqual(texts, ["SELECT 'a;b'", 'SELECT "c;"', 'CREATE PROCEDURE p() BEGIN SELECT 1; END', 'SELECT `x;`']);
});

test('mysql: tokenizer reads escapes and literals', () => {
  const t = tokenize("'it\\'s' 'a''b' `we``ird` x'FF' b'101' 0x0A _utf8mb4'é' _binary 'z' -1.5e3");
  assert.deepEqual(t.map((x) => [x.t, x.v]), [
    ['str', "it's"], ['str', "a'b"], ['id', 'we`ird'], ['hex', 'FF'], ['bits', '101'], ['hex', '0A'], ['str', 'é'], ['str', 'z'], ['op', '-'], ['num', '1.5e3'],
  ]);
  assert.equal(t[7].binary, true);
});

test('mysql: column types', () => {
  const p = (s) => parseColumnType(s).col;
  assert.deepEqual(p('int(10) unsigned zerofill'), { type: 'int', length: 10, precision: null, scale: null, unsigned: true, values: null });
  assert.deepEqual(p("enum('a','it''s')").values, ['a', "it's"]);
  assert.deepEqual([p('decimal(12,2)').precision, p('decimal(12,2)').scale], [12, 2]);
  assert.equal(p('datetime(3)').scale, 3);
  assert.equal(p('double precision').type, 'double');
  assert.equal(p('national varchar(20)').type, 'varchar');
  assert.equal(p('bool').length, 1);
  const cases = [
    [{ type: 'tinyint', length: 1 }, 'boolean'], [{ type: 'tinyint', length: 4 }, 'smallint'], [{ type: 'tinyint' }, 'smallint'],
    [{ type: 'int' }, 'integer'], [{ type: 'int', unsigned: true }, 'bigint'], [{ type: 'bigint', unsigned: true }, 'numeric(20,0)'],
    [{ type: 'smallint', unsigned: true }, 'integer'], [{ type: 'mediumint' }, 'integer'],
    [{ type: 'decimal', precision: 10, scale: 2 }, 'numeric(10,2)'], [{ type: 'float' }, 'real'], [{ type: 'double' }, 'double precision'],
    [{ type: 'bit', length: 1 }, 'boolean'], [{ type: 'bit', length: 8 }, 'bit(8)'],
    [{ type: 'varchar', length: 30 }, 'character varying(30)'], [{ type: 'char', length: 2 }, 'character(2)'],
    [{ type: 'longtext' }, 'text'], [{ type: 'enum', values: ['a'] }, 'text'], [{ type: 'set' }, 'text'],
    [{ type: 'mediumblob' }, 'bytea'], [{ type: 'varbinary', length: 16 }, 'bytea'],
    [{ type: 'datetime' }, 'timestamp'], [{ type: 'datetime', scale: 3 }, 'timestamp(3)'], [{ type: 'timestamp' }, 'timestamp with time zone'],
    [{ type: 'time' }, 'time'], [{ type: 'year' }, 'smallint'], [{ type: 'json' }, 'jsonb'], [{ type: 'point' }, 'geometry'],
    [{ type: 'uuid' }, 'uuid'], [{ type: 'inet6' }, 'inet'],
  ];
  for (const [col, pg] of cases) assert.equal(mysqlType(col), pg, JSON.stringify(col));
});

test('mysql: defaults', () => {
  assert.equal(mysqlDefault(null), '');
  assert.equal(mysqlDefault({ literal: '1' }, 'boolean'), 'true');
  assert.equal(mysqlDefault({ literal: '0.00' }, 'numeric(12,2)'), '0.00');
  assert.equal(mysqlDefault({ literal: "it's" }, 'text'), "'it''s'");
  assert.equal(mysqlDefault({ literal: '' }, 'character varying'), "''");
  assert.equal(mysqlDefault({ literal: '0000-00-00 00:00:00' }, 'timestamp'), '');
  assert.equal(mysqlDefault({ literal: '{}' }, 'jsonb'), "'{}'::jsonb");
  assert.equal(mysqlDefault({ expr: 'CURRENT_TIMESTAMP(3)' }, 'timestamp(3)'), 'CURRENT_TIMESTAMP');
  assert.equal(mysqlDefault({ expr: 'current_timestamp()' }, 'date'), 'CURRENT_DATE');
  assert.equal(mysqlDefault({ expr: 'now()' }, 'timestamp with time zone'), 'CURRENT_TIMESTAMP');
  assert.equal(mysqlDefault({ expr: 'curdate()' }, 'date'), 'CURRENT_DATE');
  assert.equal(mysqlDefault({ expr: 'uuid()' }, 'character(36)'), 'gen_random_uuid()');
  assert.equal(mysqlDefault({ expr: "b'0'" }, 'boolean'), 'false');
  assert.equal(mysqlDefault({ expr: "b'101'" }, 'bit(3)'), "B'101'");
  assert.equal(mysqlDefault({ expr: '-1' }, 'integer'), '-1');
  assert.equal(mysqlDefault({ expr: "_utf8mb4'x'" }, 'text'), "'x'");
  assert.equal(mysqlDefault({ expr: '(rand())' }, 'double precision'), '');
});

test('mysql: reads a mysqldump file', () => {
  const { tables, databases } = parseDump(DUMP);
  assert.deepEqual(databases, []);
  assert.deepEqual(tables.map((t) => t.name), ['category', 'CustomerAccount', 'order_line']);
  const [category, customer, line] = tables;
  assert.equal(category.description, 'Product groups');
  assert.deepEqual(category.foreignKeys, [{ columns: ['parent_id'], refSchema: null, refTable: 'category', refColumns: ['id'] }]);
  // A prefix unique key does not make the column unique.
  assert.deepEqual(customer.uniques, [['Code']]);
  const col = Object.fromEntries(customer.columns.map((c) => [c.name, c]));
  assert.deepEqual(col.Status.values, ['new', 'vip', "it's"]);
  assert.equal(col.Status.description, 'Lifecycle state');
  assert.deepEqual(col.CreatedAt.default, { expr: 'CURRENT_TIMESTAMP(3)' });
  assert.equal(col.Upper.generated, true);
  assert.deepEqual(line.primaryKey, ['customer_id', 'line_no']);

  const specs = mysqlSpecs({ tables }, { schema: 'shop', snakeCase: true });
  assert.deepEqual(specs.map((s) => s.key), ['shop.category', 'shop.customer_account', 'shop.order_line']);
  const c = Object.fromEntries(specs[1].columns.map((x) => [x.name, x]));
  assert.equal(c.id.type, 'bigserial');
  assert.deepEqual([c.is_active.type, c.is_active.default], ['boolean', 'true']);
  assert.equal(c.created_at.default, 'CURRENT_TIMESTAMP');
  assert.equal(c.flags.default, 'false');
  assert.equal(c.upper.default, '');
  assert.equal(specs[0].columns[0].type, 'bigserial'); // int unsigned AUTO_INCREMENT
  assert.deepEqual(specs[2].columns.find((x) => x.name === 'customer_id').ref, { schema: 'shop', table: 'customer_account', column: 'id' });
  assert.deepEqual(specs[1].source.columns.at(-1), { name: 'Upper', type: 'varchar', spatial: false, generated: true });
});

test('mysql: rows of INSERT statements', () => {
  const inserts = [...dumpInserts(DUMP)];
  assert.deepEqual(inserts.map((i) => [i.table, i.rows.length]), [['category', 3], ['CustomerAccount', 2], ['order_line', 3]]);
  assert.deepEqual(inserts[0].rows[2], ['3', 'Tools; hardware', null]);
  const [first, second] = inserts[1].rows;
  assert.equal(first[1], 'O\'Brien "Pat"');
  assert.deepEqual([...first[8]], [0]); // _binary '\0'
  assert.deepEqual([...first[9]], [80, 78, 71, 0, 10]);
  assert.equal(second[1], 'Zoë – 名前');
  assert.deepEqual(inserts[2].columns, ['customer_id', 'line_no', 'category_id', 'qty', 'price', 'year']);
  assert.deepEqual(inserts[2].rows[1], ['1', '2', '3', '-1', '1e3', null]);
  assert.deepEqual(parseInsert('INSERT IGNORE INTO db.t VALUES (TRUE, b\'1\', now())'), { schema: 'db', table: 't', columns: null, rows: [['1', { bits: '1' }, null]] });
  assert.equal(parseInsert('UPDATE t SET a = 1'), null);
});

test('mysql: a dump of several databases keeps them as schemas', () => {
  const { tables, databases } = parseDump('USE `a`;\nCREATE TABLE t (id int PRIMARY KEY);\nUSE `b`;\nCREATE TABLE u (t_id int, FOREIGN KEY (t_id) REFERENCES a.t (id));');
  assert.deepEqual(databases, ['a', 'b']);
  assert.deepEqual(tables.map((t) => `${t.schema}.${t.name}`), ['a.t', 'b.u']);
  const specs = mysqlSpecs({ tables }, { schema: 'public' });
  assert.deepEqual(specs.map((s) => s.key), ['a.t', 'b.u']);
  assert.deepEqual(specs[1].columns[0].ref, { schema: 'a', table: 't', column: 'id' });
});

test('mysql: catalog rows from information_schema', () => {
  assert.deepEqual(columnDefault("'it''s'", '', true), { literal: "it's" });
  assert.equal(columnDefault('NULL', '', true), null);
  assert.deepEqual(columnDefault('current_timestamp()', '', true), { expr: 'current_timestamp()' });
  assert.deepEqual(columnDefault('new', '', false), { literal: 'new' });
  assert.deepEqual(columnDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', false), { expr: 'CURRENT_TIMESTAMP' });
  assert.deepEqual(columnDefault('(rand())', 'DEFAULT_GENERATED', false), { expr: '(rand())' });
  const catalog = catalogFromRows(
    {
      database: 'shop',
      mariadb: false,
      tables: [{ name: 'a', comment: 'A' }],
      columns: [
        { table_name: 'a', name: 'id', dflt: null, nullable: 'NO', column_type: 'int unsigned', extra: 'auto_increment', comment: '' },
        { table_name: 'a', name: 'code', dflt: null, nullable: 'YES', column_type: 'varchar(20)', extra: '', comment: 'c' },
        { table_name: 'a', name: 'up', dflt: null, nullable: 'YES', column_type: 'varchar(20)', extra: 'VIRTUAL GENERATED', comment: '' },
        { table_name: 'a', name: 'b_id', dflt: null, nullable: 'YES', column_type: 'int', extra: '', comment: '' },
      ],
      keys: [
        { table_name: 'a', index_name: 'PRIMARY', non_unique: 0, column_name: 'id', sub_part: null },
        { table_name: 'a', index_name: 'uq', non_unique: 0, column_name: 'code', sub_part: null },
        { table_name: 'a', index_name: 'uq_prefix', non_unique: 0, column_name: 'up', sub_part: 5 },
      ],
      foreignKeys: [{ table_name: 'a', name: 'fk', column_name: 'b_id', ref_schema: 'other', ref_table: 'b', ref_column: 'id' }],
    },
    (s) => parseColumnType(s)
  );
  const [t] = catalog.tables;
  assert.deepEqual([t.primaryKey, t.uniques], [['id'], [['code']]]);
  assert.equal(t.columns[0].autoIncrement, true);
  assert.equal(t.columns[2].generated, true);
  assert.deepEqual(t.foreignKeys, [{ columns: ['b_id'], refSchema: 'other', refTable: 'b', refColumns: ['id'] }]);
  assert.equal(mysqlConfig({ host: 'db', port: '3307' }).port, 3307);
  assert.deepEqual(mysqlConfig({ ssl: 'require' }).ssl, { rejectUnauthorized: false });
});

test('copy: values are converted for their PostgreSQL column', () => {
  assert.equal(convertValue(null, 'text'), null);
  assert.equal(convertValue('1', 'boolean'), true);
  assert.equal(convertValue(0, 'boolean'), false);
  assert.equal(convertValue(new Uint8Array([1]), 'boolean'), true);
  assert.equal(convertValue({ bits: '0' }, 'boolean'), false);
  assert.equal(convertValue({ bits: '101' }, 'bit(5)'), '00101');
  assert.equal(convertValue(new Uint8Array([5]), 'bit(3)'), '101');
  assert.ok(Buffer.isBuffer(convertValue(new Uint8Array([0, 1]), 'bytea')));
  assert.equal(convertValue(new Uint8Array([0x7b, 0x7d]), 'jsonb'), '{}');
  assert.equal(convertValue('not json', 'jsonb'), '"not json"');
  assert.equal(convertValue({ a: 1 }, 'json'), '{"a":1}');
  assert.equal(convertValue('0000-00-00', 'date'), null);
  assert.equal(convertValue('2026-01-02 03:04:05', 'timestamp with time zone'), '2026-01-02 03:04:05+00');
  assert.equal(convertValue('2026-01-02 03:04:05 +01:00', 'timestamp with time zone'), '2026-01-02 03:04:05 +01:00');
  assert.equal(convertValue('2026-01-02', 'timestamp with time zone'), '2026-01-02');
  assert.equal(convertValue(1767225600, 'date'), '2026-01-01');
  assert.equal(convertValue(12345678901234567890n, 'numeric'), '12345678901234567890');
  assert.equal(convertValue('a\u0000b', 'text'), 'ab');
  assert.equal(convertValue(new Uint8Array([104, 105]), 'text'), 'hi');
});

test('copy: tables come after the tables they reference', () => {
  const t = (name, refs = []) => ({ schema: 'public', name, columns: refs.map((r) => ({ name: `${r}_id`, ref: { schema: null, table: r } })) });
  const order = copyOrder([t('line', ['order', 'product']), t('order', ['customer']), t('customer'), t('product'), t('node', ['node'])]);
  assert.deepEqual(order.map((x) => x.name), ['customer', 'order', 'product', 'line', 'node']);
});

test('copy: the request creates tables without foreign keys and adds them afterwards', () => {
  const specs = mysqlSpecs(parseDump(DUMP), { schema: 'shop' });
  const req = copyRequest(specs, { kind: 'mysql-dump', filePath: 'x.sql' }, { truncate: true });
  assert.deepEqual(req.tables.map((x) => x.target.name), ['category', 'customer_account', 'order_line']);
  assert.doesNotMatch(req.createSql, /FOREIGN KEY|BEGIN;|END;/);
  assert.match(req.foreignKeySql, /FOREIGN KEY \(customer_id\)/);
  assert.equal(req.tables[1].columns.find((c) => c.name === 'flags').type, 'boolean');
  assert.equal(req.tables[1].columns.find((c) => c.name === 'full_name').type, 'character varying(100)');
  assert.equal(req.tables[1].columns.find((c) => c.name === 'balance').type, 'numeric(12,2)');
  assert.equal(req.tables[1].source.table, 'CustomerAccount');
});

test('mysql: a foreign key column takes the type of the column it references', () => {
  const { tables } = parseDump(`CREATE TABLE o (id bigint unsigned AUTO_INCREMENT PRIMARY KEY);
    CREATE TABLE i (o_id bigint unsigned NOT NULL, FOREIGN KEY (o_id) REFERENCES o (id));`);
  const [o, i] = mysqlSpecs({ tables }, { schema: 'public' });
  assert.equal(o.columns[0].type, 'bigserial');
  assert.equal(i.columns[0].type, 'bigint'); // not numeric(20,0), which PostgreSQL would not link to bigint
});
