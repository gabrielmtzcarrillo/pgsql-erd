import test from 'node:test';
import assert from 'node:assert/strict';
import { oracleType, oracleDefault, oracleSpecs } from '../src/renderer/lib/oracleimport.js';
import { catalogFromRows, oracleConfig } from '../src/main/database/oracle.cjs';
import { convertValue } from '../src/main/database/data-copy.cjs';

test('oracle: types become PostgreSQL types', () => {
  const cases = [
    [{ type: 'NUMBER', precision: 4, scale: 0 }, 'smallint'],
    [{ type: 'NUMBER', precision: 9, scale: 0 }, 'integer'],
    [{ type: 'NUMBER', precision: 10, scale: 0 }, 'bigint'],
    [{ type: 'NUMBER', precision: 20, scale: 0 }, 'numeric(20,0)'],
    [{ type: 'NUMBER', precision: 10, scale: 2 }, 'numeric(10,2)'],
    [{ type: 'NUMBER', precision: 5, scale: -2 }, 'numeric(7,0)'],
    [{ type: 'NUMBER', precision: null, scale: 0 }, 'numeric(38,0)'], // INTEGER
    [{ type: 'NUMBER', precision: null, scale: null }, 'numeric'],
    [{ type: 'FLOAT', precision: 126 }, 'double precision'],
    [{ type: 'BINARY_FLOAT' }, 'real'],
    [{ type: 'VARCHAR2', length: 50 }, 'character varying(50)'],
    [{ type: 'NVARCHAR2', length: 10 }, 'character varying(10)'],
    [{ type: 'CHAR', length: 1 }, 'character(1)'],
    [{ type: 'CLOB' }, 'text'],
    [{ type: 'BLOB' }, 'bytea'],
    [{ type: 'RAW', length: 16 }, 'uuid'],
    [{ type: 'RAW', length: 2000 }, 'bytea'],
    [{ type: 'DATE' }, 'timestamp(0)'],
    [{ type: 'TIMESTAMP(6)', scale: 6 }, 'timestamp'],
    [{ type: 'TIMESTAMP(3)', scale: 3 }, 'timestamp(3)'],
    [{ type: 'TIMESTAMP(6) WITH TIME ZONE', scale: 6 }, 'timestamp with time zone'],
    [{ type: 'TIMESTAMP(6) WITH LOCAL TIME ZONE', scale: 6 }, 'timestamp with time zone'],
    [{ type: 'INTERVAL DAY(2) TO SECOND(6)' }, 'interval'],
    [{ type: 'XMLTYPE' }, 'xml'],
    [{ type: 'JSON' }, 'jsonb'],
    [{ type: 'BOOLEAN' }, 'boolean'],
    [{ type: 'ROWID' }, 'text'],
  ];
  for (const [col, pg] of cases) assert.equal(oracleType(col), pg, JSON.stringify(col));
});

test('oracle: defaults', () => {
  assert.equal(oracleDefault('SYSDATE ', 'timestamp(0)'), 'CURRENT_TIMESTAMP');
  assert.equal(oracleDefault('systimestamp', 'timestamp with time zone'), 'CURRENT_TIMESTAMP');
  assert.equal(oracleDefault('SYS_GUID()', 'uuid'), 'gen_random_uuid()');
  assert.equal(oracleDefault('USER', 'character varying'), 'CURRENT_USER');
  assert.equal(oracleDefault("'N'", 'character(1)'), "'N'");
  assert.equal(oracleDefault("'it''s'", 'text'), "'it''s'");
  assert.equal(oracleDefault('0', 'integer'), '0');
  assert.equal(oracleDefault('(1)', 'smallint'), '1');
  assert.equal(oracleDefault('NULL', 'text'), '');
  assert.equal(oracleDefault('"APP"."SEQ_X"."NEXTVAL"', 'bigint'), '');
  assert.equal(oracleDefault("TO_DATE('2000-01-01','YYYY-MM-DD')", 'timestamp(0)'), '');
});

test('oracle: dictionary rows become a catalog and specs', () => {
  const catalog = catalogFromRows({
    owner: 'SHOP',
    tables: [{ name: 'CUSTOMER', description: 'People' }, { name: 'ORDERS', description: null }],
    columns: [
      { table_name: 'CUSTOMER', name: 'CUSTOMER_ID', data_type: 'NUMBER', data_length: 22, char_length: 0, data_precision: 10, data_scale: 0, nullable: 'N', data_default: '"SHOP"."ISEQ$$_1".nextval', identity_column: 'YES', virtual_column: 'NO', description: null },
      { table_name: 'CUSTOMER', name: 'EMAIL', data_type: 'VARCHAR2', data_length: 800, char_length: 200, data_precision: null, data_scale: null, nullable: 'Y', data_default: null, identity_column: 'NO', virtual_column: 'NO', description: 'Mail' },
      { table_name: 'CUSTOMER', name: 'CREATED', data_type: 'DATE', data_length: 7, char_length: 0, data_precision: null, data_scale: null, nullable: 'N', data_default: 'SYSDATE\n', identity_column: 'NO', virtual_column: 'NO', description: null },
      { table_name: 'CUSTOMER', name: 'TOKEN', data_type: 'RAW', data_length: 16, char_length: 0, data_precision: null, data_scale: null, nullable: 'N', data_default: 'SYS_GUID()', identity_column: 'NO', virtual_column: 'NO', description: null },
      { table_name: 'ORDERS', name: 'ORDER_ID', data_type: 'NUMBER', data_length: 22, char_length: 0, data_precision: 18, data_scale: 0, nullable: 'N', data_default: null, identity_column: 'NO', virtual_column: 'NO', description: null },
      { table_name: 'ORDERS', name: 'CUSTOMER_ID', data_type: 'NUMBER', data_length: 22, char_length: 0, data_precision: 10, data_scale: 0, nullable: 'N', data_default: null, identity_column: 'NO', virtual_column: 'NO', description: null },
      { table_name: 'ORDERS', name: 'REP_ID', data_type: 'NUMBER', data_length: 22, char_length: 0, data_precision: 10, data_scale: 0, nullable: 'Y', data_default: null, identity_column: 'NO', virtual_column: 'NO', description: null },
    ],
    constraints: [
      { table_name: 'CUSTOMER', constraint_name: 'PK_CUSTOMER', constraint_type: 'P', column_name: 'CUSTOMER_ID', position: 1 },
      { table_name: 'CUSTOMER', constraint_name: 'UQ_EMAIL', constraint_type: 'U', column_name: 'EMAIL', position: 1 },
      { table_name: 'ORDERS', constraint_name: 'PK_ORDERS', constraint_type: 'P', column_name: 'ORDER_ID', position: 1 },
      { table_name: 'ORDERS', constraint_name: 'FK_CUST', constraint_type: 'R', column_name: 'CUSTOMER_ID', position: 1, ref_owner: 'SHOP', ref_table: 'CUSTOMER', ref_column: 'CUSTOMER_ID' },
      { table_name: 'ORDERS', constraint_name: 'FK_REP', constraint_type: 'R', column_name: 'REP_ID', position: 1, ref_owner: 'HR', ref_table: 'EMPLOYEES', ref_column: 'EMPLOYEE_ID' },
    ],
    uniqueIndexes: [
      { table_name: 'CUSTOMER', index_name: 'PK_CUSTOMER', column_name: 'CUSTOMER_ID', column_position: 1 },
      { table_name: 'CUSTOMER', index_name: 'UX_TOKEN', column_name: 'TOKEN', column_position: 1 },
    ],
  });
  catalog.owner = 'SHOP';
  const [customer, orders] = catalog.tables;
  assert.deepEqual(customer.uniques, [['EMAIL'], ['TOKEN']]);
  assert.equal(customer.columns[1].length, 200); // characters, not bytes
  assert.equal(orders.foreignKeys[1].refSchema, 'HR');

  const specs = oracleSpecs(catalog, { schema: 'shop', snakeCase: true });
  assert.deepEqual(specs.map((s) => s.key), ['shop.customer', 'shop.orders']);
  const c = Object.fromEntries(specs[0].columns.map((x) => [x.name, x]));
  assert.deepEqual([c.customer_id.type, c.customer_id.default], ['bigserial', '']);
  assert.deepEqual([c.email.type, c.email.length, c.email.unique, c.email.description], ['character varying', 200, true, 'Mail']);
  assert.deepEqual([c.created.default, c.token.type, c.token.default, c.token.unique], ['CURRENT_TIMESTAMP', 'uuid', 'gen_random_uuid()', true]);
  const o = Object.fromEntries(specs[1].columns.map((x) => [x.name, x]));
  assert.deepEqual(o.customer_id.ref, { schema: 'shop', table: 'customer', column: 'customer_id' });
  assert.deepEqual(o.rep_id.ref, { schema: 'hr', table: 'employees', column: 'employee_id' });
  assert.deepEqual(specs[0].source, { kind: 'oracle', schema: 'SHOP', table: 'CUSTOMER', columns: catalog.tables[0].columns.map((x) => ({ name: x.name, type: x.type })) });
});

test('oracle: connection settings and RAW(16) values', () => {
  assert.equal(oracleConfig({ host: 'db', service: 'FREEPDB1', user: 'shop' }).connectString, 'db:1521/FREEPDB1');
  assert.equal(oracleConfig({ host: 'db', port: '1522' }).connectString, 'db:1522');
  assert.equal(convertValue(Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 'uuid'), '00112233-4455-6677-8899-aabbccddeeff');
});
