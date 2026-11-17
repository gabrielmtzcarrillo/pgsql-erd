// Runs against a real SQL Server. Skipped unless PGERD_MSSQL_HOST is set, e.g. with
//   docker run -d -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Pgerd_Test_2026!' -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
//   PGERD_MSSQL_HOST=127.0.0.1 PGERD_MSSQL_PORT=14333 PGERD_MSSQL_PASSWORD='Pgerd_Test_2026!' npm test
// A temporary database is created and dropped. The same script is also read
// by the T-SQL parser, and both catalogs must give the same tables.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mssqlSpecs, parseTsql } from '../src/renderer/lib/mssqlimport.js';

const require = createRequire(import.meta.url);
const enabled = !!process.env.PGERD_MSSQL_HOST;
const base = {
  server: process.env.PGERD_MSSQL_HOST,
  port: process.env.PGERD_MSSQL_PORT || 1433,
  user: process.env.PGERD_MSSQL_USER || 'sa',
  password: process.env.PGERD_MSSQL_PASSWORD || '',
  database: 'master',
  encrypt: true,
  trustServerCertificate: true,
};
const dbName = `pgsql_erd_test_${process.pid}`;

export const SCRIPT = `
CREATE SCHEMA Sales
GO
CREATE TYPE dbo.Email FROM nvarchar(320) NOT NULL
GO
CREATE TABLE [dbo].[Customers](
  [CustomerId] [int] IDENTITY(1,1) NOT NULL,
  [Name] [nvarchar](100) NULL,
  [Email] [dbo].[Email],
  [IsActive] [bit] NOT NULL CONSTRAINT [DF_Customers_IsActive] DEFAULT ((1)),
  [Notes] [nvarchar](max) NULL,
  [Balance] [money] NOT NULL DEFAULT 0,
  [Rv] [rowversion] NOT NULL,
  CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerId] ASC) WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
CREATE TABLE [Sales].[OrderHeader](
  [OrderId] [bigint] IDENTITY(1,1) NOT NULL PRIMARY KEY,
  [CustomerId] [int] NOT NULL,
  [Total] [decimal](18, 2) NOT NULL,
  [Created] [datetime2](3) NOT NULL,
  [Token] uniqueidentifier NOT NULL DEFAULT newid(),
  [Code] varchar(20) NULL
)
GO
ALTER TABLE [dbo].[Customers] ADD CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED ([Email] ASC)
GO
ALTER TABLE [Sales].[OrderHeader] ADD CONSTRAINT [DF_OrderHeader_Created] DEFAULT (sysdatetime()) FOR [Created]
GO
ALTER TABLE [Sales].[OrderHeader] WITH CHECK ADD CONSTRAINT [FK_OrderHeader_Customers] FOREIGN KEY([CustomerId])
REFERENCES [dbo].[Customers] ([CustomerId]) ON DELETE CASCADE
GO
CREATE UNIQUE NONCLUSTERED INDEX [IX_OrderHeader_Code] ON [Sales].[OrderHeader] ([Code] ASC)
GO
CREATE TABLE OrderLine (
  OrderId bigint NOT NULL REFERENCES Sales.OrderHeader (OrderId),
  LineNumber int NOT NULL,
  Sku varchar(20) NOT NULL,
  Qty smallint NOT NULL DEFAULT -1,
  Price numeric(10, 4) NULL,
  CONSTRAINT PK_OrderLine PRIMARY KEY (OrderId, LineNumber)
)
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'People who buy', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'Customers'
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Full name', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'Customers', @level2type=N'COLUMN', @level2name=N'Name'
GO
`;

let sql;
let pool;
let mssql;

async function run(conn, script) {
  const p = new sql.ConnectionPool(mssql.mssqlConfig(conn));
  await p.connect();
  try {
    for (const batch of script.split(/^\s*GO\s*$/im)) if (batch.trim()) await p.request().batch(batch);
  } finally {
    await p.close();
  }
}

before(async () => {
  if (!enabled) return;
  sql = require('mssql');
  mssql = require('../src/main/database/mssql.cjs');
  await run(base, `CREATE DATABASE [${dbName}]`);
  await run({ ...base, database: dbName }, SCRIPT);
});

after(async () => {
  if (!enabled) return;
  await run(base, `ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE\nGO\nDROP DATABASE [${dbName}]`);
});

// The parts of a spec that both readers must agree on.
const shape = (specs) =>
  specs
    .map((s) => ({
      key: s.key,
      description: s.description,
      columns: s.columns.map((c) => ({ name: c.name, type: c.type, length: c.length, precision: c.precision, notNull: c.notNull, pk: c.pk, unique: c.unique, default: c.default, description: c.description, ref: c.ref })),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

test('mssql: reads the catalog of a live database', { skip: !enabled }, async () => {
  const res = await mssql.readMssqlCatalog({ ...base, database: dbName });
  assert.equal(res.database, dbName);
  const specs = shape(mssqlSpecs(res.catalog, { schema: 'public', snakeCase: true }));
  assert.deepEqual(specs.map((s) => s.key), ['public.customers', 'public.order_line', 'sales.order_header']);
  const customers = specs[0];
  assert.equal(customers.description, 'People who buy');
  const col = Object.fromEntries(customers.columns.map((c) => [c.name, c]));
  assert.equal(col.customer_id.type, 'serial');
  assert.equal(col.customer_id.pk, true);
  assert.deepEqual([col.name.type, col.name.length, col.name.description], ['character varying', 100, 'Full name']);
  assert.deepEqual([col.email.type, col.email.length, col.email.notNull, col.email.unique], ['character varying', 320, true, true]);
  assert.deepEqual([col.is_active.type, col.is_active.default], ['boolean', 'true']);
  assert.equal(col.notes.type, 'text');
  assert.deepEqual([col.balance.type, col.balance.length, col.balance.precision, col.balance.default], ['numeric', 19, 4, '0']);
  assert.equal(col.rv.type, 'bytea');
  const order = Object.fromEntries(specs[2].columns.map((c) => [c.name, c]));
  assert.equal(order.order_id.type, 'bigserial');
  assert.deepEqual(order.customer_id.ref, { schema: 'public', table: 'customers', column: 'customer_id' });
  assert.equal(order.created.default, 'CURRENT_TIMESTAMP');
  assert.equal(order.token.default, 'gen_random_uuid()');
  assert.equal(order.code.unique, true);
  const line = Object.fromEntries(specs[1].columns.map((c) => [c.name, c]));
  assert.deepEqual([line.order_id.pk, line.line_number.pk], [true, true]);
  assert.deepEqual(line.order_id.ref, { schema: 'sales', table: 'order_header', column: 'order_id' });
  assert.equal(line.qty.default, '-1');
});

test('mssql: the T-SQL parser reads the creating script as the database does', { skip: !enabled }, async () => {
  const res = await mssql.readMssqlCatalog({ ...base, database: dbName });
  const opts = { schema: 'public', snakeCase: true };
  assert.deepEqual(shape(mssqlSpecs(parseTsql(SCRIPT), opts)), shape(mssqlSpecs(res.catalog, opts)));
});

test('mssql: a wrong password is reported', { skip: !enabled }, async () => {
  await assert.rejects(mssql.readMssqlCatalog({ ...base, password: 'wrong' }), /Login failed/);
});
