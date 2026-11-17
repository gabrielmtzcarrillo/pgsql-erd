import test from 'node:test';
import assert from 'node:assert/strict';
import { mssqlType, mssqlDefault, mssqlSpecs, parseTsql, tokenizeTsql } from '../src/renderer/lib/mssqlimport.js';
import { catalogFromRows, mssqlConfig } from '../src/main/database/mssql.cjs';
import { modelFromSpecs } from '../src/renderer/lib/spreadsheet.js';
import { generateSQL } from '../src/renderer/lib/sql.js';

test('mssql: types become PostgreSQL types', () => {
  const cases = [
    [{ type: 'int' }, 'integer'],
    [{ type: 'tinyint' }, 'smallint'],
    [{ type: 'bit' }, 'boolean'],
    [{ type: 'nvarchar', length: 50 }, 'character varying(50)'],
    [{ type: 'varchar', length: -1 }, 'text'],
    [{ type: 'nchar', length: 2 }, 'character(2)'],
    [{ type: 'varbinary', length: -1 }, 'bytea'],
    [{ type: 'decimal', precision: 10, scale: 2 }, 'numeric(10,2)'],
    [{ type: 'money' }, 'numeric(19,4)'],
    [{ type: 'float', precision: 53 }, 'double precision'],
    [{ type: 'float', precision: 24 }, 'real'],
    [{ type: 'datetime' }, 'timestamp'],
    [{ type: 'datetime2', scale: 7 }, 'timestamp'],
    [{ type: 'datetime2', scale: 0 }, 'timestamp(0)'],
    [{ type: 'time', scale: 3 }, 'time(3)'],
    [{ type: 'datetimeoffset', scale: 7 }, 'timestamp with time zone'],
    [{ type: 'uniqueidentifier' }, 'uuid'],
    [{ type: 'timestamp' }, 'bytea'], // rowversion, not a date
    [{ type: 'xml' }, 'xml'],
    [{ type: 'geography' }, 'geography'],
    [{ type: 'sql_variant' }, 'text'],
    [{ type: 'mystery' }, 'text'],
  ];
  for (const [col, pg] of cases) assert.equal(mssqlType(col), pg, JSON.stringify(col));
});

test('mssql: defaults are translated or dropped', () => {
  assert.equal(mssqlDefault('((0))', 'integer'), '0');
  assert.equal(mssqlDefault('((-1))', 'smallint'), '-1');
  assert.equal(mssqlDefault('((1))', 'boolean'), 'true');
  assert.equal(mssqlDefault('((0))', 'boolean'), 'false');
  assert.equal(mssqlDefault('(getdate())', 'timestamp'), 'CURRENT_TIMESTAMP');
  assert.equal(mssqlDefault('(sysutcdatetime())', 'timestamp'), 'CURRENT_TIMESTAMP');
  assert.equal(mssqlDefault('(getdate())', 'date'), 'CURRENT_DATE');
  assert.equal(mssqlDefault('CURRENT_TIMESTAMP', 'timestamp'), 'CURRENT_TIMESTAMP');
  assert.equal(mssqlDefault('(newid())', 'uuid'), 'gen_random_uuid()');
  assert.equal(mssqlDefault('(newsequentialid())', 'uuid'), 'gen_random_uuid()');
  assert.equal(mssqlDefault("(N'it''s')", 'character varying'), "'it''s'");
  assert.equal(mssqlDefault("('')", 'text'), "''");
  assert.equal(mssqlDefault('(suser_sname())', 'text'), 'CURRENT_USER');
  assert.equal(mssqlDefault('(NULL)', 'text'), '');
  assert.equal(mssqlDefault('0x00FF', 'bytea'), "'\\x00FF'");
  assert.equal(mssqlDefault('(CONVERT([bit],(0)))', 'boolean'), '');
  assert.equal(mssqlDefault('(datepart(year,getdate()))', 'integer'), '');
  assert.equal(mssqlDefault(null), '');
});

test('mssql: tokenizer reads brackets, Unicode strings and nested comments', () => {
  const { tokens } = tokenizeTsql("/* a /* nested */ still */ [My ]]Table] N'x''y' -- note\n 1.5");
  assert.deepEqual(tokens.map((t) => [t.t, t.v]), [['id', 'My ]Table'], ['str', "x'y"], ['num', '1.5']]);
});

const SSMS = `USE [Shop]
GO
/****** Object:  Table [dbo].[Product]    Script Date: 11/17/2026 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Product](
	[ProductID] [int] IDENTITY(1,1) NOT FOR REPLICATION NOT NULL,
	[Name] [nvarchar](50) COLLATE Latin1_General_CI_AS NOT NULL,
	[Price] [smallmoney] NOT NULL,
	[rowguid] [uniqueidentifier] ROWGUIDCOL NOT NULL,
	[Margin]  AS ([Price]*(0.1)),
 CONSTRAINT [PK_Product_ProductID] PRIMARY KEY CLUSTERED
(
	[ProductID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [AK_Product_Name] UNIQUE NONCLUSTERED
(
	[Name] ASC
)WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[Product] ADD  CONSTRAINT [DF_Product_rowguid]  DEFAULT (newid()) FOR [rowguid]
GO
ALTER TABLE [dbo].[Product]  WITH CHECK ADD  CONSTRAINT [CK_Product_Price] CHECK  (([Price]>=(0.00)))
GO
ALTER TABLE [dbo].[Product] CHECK CONSTRAINT [CK_Product_Price]
GO
`;

test('mssql: reads a script written by SQL Server Management Studio', () => {
  const { tables } = parseTsql(SSMS);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.deepEqual([t.schema, t.name, t.primaryKey, t.uniques], ['dbo', 'Product', ['ProductID'], [['Name']]]);
  const col = Object.fromEntries(t.columns.map((c) => [c.name, c]));
  assert.equal(col.ProductID.identity, true);
  assert.equal(col.ProductID.nullable, false);
  assert.deepEqual([col.Name.type, col.Name.length, col.Name.nullable], ['nvarchar', 50, false]);
  assert.equal(col.rowguid.default, '(newid())');
  assert.equal(col.Margin.computed, true);
  const [spec] = mssqlSpecs({ tables }, { schema: 'shop', snakeCase: true });
  assert.equal(spec.key, 'shop.product');
  const c = Object.fromEntries(spec.columns.map((x) => [x.name, x]));
  assert.equal(c.product_id.type, 'serial');
  assert.equal(c.rowguid.default, 'gen_random_uuid()');
  assert.equal(c.name.unique, true);
  assert.equal(c.margin.default, '');
});

test('mssql: reads hand-written scripts', () => {
  const { tables } = parseTsql(`
    create type dbo.Code from varchar(10) not null;
    create table Customer (Id int identity primary key, Code Code, Email varchar(200) unique, Kind char(1) default 'A' not null);
    create table dbo.Orders (
      Id bigint not null,
      CustomerId int not null foreign key references Customer(Id) on delete cascade on update no action,
      Amount decimal(9,2) default 0,
      Placed datetime default getdate(),
      constraint PK_Orders primary key nonclustered (Id),
      index IX_Orders_Placed (Placed),
    );
    alter table Orders add Note nvarchar(max) null, Status tinyint not null constraint DF_Status default 1;
    alter table Orders drop column Amount;
    create table #scratch (x int);
    exec sp_addextendedproperty N'MS_Description', N'Orders placed', N'SCHEMA', N'dbo', N'TABLE', N'Orders';
  `);
  assert.deepEqual(tables.map((t) => t.name), ['Customer', 'Orders']);
  const [customer, orders] = tables;
  assert.deepEqual(customer.primaryKey, ['Id']);
  assert.deepEqual(customer.uniques, [['Email']]);
  const code = customer.columns.find((c) => c.name === 'Code');
  assert.deepEqual([code.type, code.length, code.nullable], ['varchar', 10, false]);
  assert.equal(customer.columns.find((c) => c.name === 'Kind').default, "'A'");
  assert.deepEqual(orders.foreignKeys, [{ columns: ['CustomerId'], refSchema: 'dbo', refTable: 'Customer', refColumns: ['Id'] }]);
  assert.deepEqual(orders.columns.map((c) => c.name), ['Id', 'CustomerId', 'Placed', 'Note', 'Status']);
  assert.equal(orders.columns.find((c) => c.name === 'Status').default, '1');
  assert.equal(orders.description, 'Orders placed');

  const specs = mssqlSpecs({ tables }, { schema: 'public', snakeCase: false });
  const sql = generateSQL(modelFromSpecs(specs).model);
  assert.match(sql, /"Id" serial NOT NULL/);
  assert.match(sql, /"Placed" timestamp without time zone DEFAULT CURRENT_TIMESTAMP/);
  assert.match(sql, /"Status" smallint NOT NULL DEFAULT 1/);
  assert.match(sql, /REFERENCES public\."Customer" \("Id"\)/);
});

test('mssql: a later CREATE TABLE replaces an earlier one; unknown statements are skipped', () => {
  const { tables } = parseTsql(`
    IF OBJECT_ID('dbo.T') IS NOT NULL DROP TABLE dbo.T
    CREATE TABLE T (a int)
    GO
    INSERT INTO T (a) VALUES (1)
    CREATE TABLE T (b int NOT NULL, c varchar(5))
    CREATE PROCEDURE p AS SELECT 1
  `);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns.map((c) => c.name), ['b', 'c']);
});

test('mssql: catalog rows from the live database become a catalog', () => {
  const catalog = catalogFromRows({
    tables: [{ id: 1, schema_name: 'dbo', name: 'T', description: null }],
    columns: [
      { id: 1, name: 'Id', type_name: 'int', max_length: 4, precision: 10, scale: 0, is_nullable: false, is_identity: true, is_computed: false, default_definition: null, description: null },
      { id: 1, name: 'Name', type_name: 'nvarchar', max_length: 200, precision: 0, scale: 0, is_nullable: true, is_identity: false, is_computed: false, default_definition: "(N'x')", description: 'n' },
      { id: 1, name: 'Body', type_name: 'nvarchar', max_length: -1, precision: 0, scale: 0, is_nullable: true, is_identity: false, is_computed: false, default_definition: null, description: null },
    ],
    keys: [
      { id: 1, index_id: 1, is_primary_key: true, has_filter: false, column_name: 'Id' },
      { id: 1, index_id: 2, is_primary_key: false, has_filter: false, column_name: 'Name' },
      { id: 1, index_id: 3, is_primary_key: false, has_filter: true, column_name: 'Body' },
    ],
    foreignKeys: [],
  });
  const t = catalog.tables[0];
  assert.deepEqual(t.columns.map((c) => c.length), [null, 100, -1]);
  assert.deepEqual(t.primaryKey, ['Id']);
  assert.deepEqual(t.uniques, [['Name']]);
});

test('mssql: connection settings', () => {
  const named = mssqlConfig({ server: 'db1\\SQLEXPRESS', database: 'Shop', user: 'sa', password: 'x' });
  assert.deepEqual([named.server, named.options.instanceName, named.port], ['db1', 'SQLEXPRESS', undefined]);
  const plain = mssqlConfig({ server: 'db1', port: '14333', auth: 'ntlm', user: 'me', password: 'x', domain: 'CORP', trustServerCertificate: true });
  assert.equal(plain.port, 14333);
  assert.deepEqual(plain.authentication, { type: 'ntlm', options: { userName: 'me', password: 'x', domain: 'CORP' } });
  assert.equal(plain.options.trustServerCertificate, true);
  assert.equal(plain.options.encrypt, true);
});
