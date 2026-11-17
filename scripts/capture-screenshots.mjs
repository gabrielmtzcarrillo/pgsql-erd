// Takes the README screenshots: starts the app with its own throw-away
// settings folder, drives it over the Chrome DevTools protocol and writes
// PNGs. See devlog/screenshots.md for how each screenshot is made and what
// servers the database shots need.
//
//   node scripts/capture-screenshots.mjs            # every shot, English and Spanish
//   node scripts/capture-screenshots.mjs ef-import  # one shot (or group: themes, shop)
//   node scripts/capture-screenshots.mjs --lang es  # one language
//
// Output goes to docs/screenshots/<name>.png and docs/screenshots/es/<name>.png.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const PORT = 9333;
const SIZE = { width: 1440, height: 880 };

const args = process.argv.slice(2);
const langArg = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');

// ---------------------------------------------------------------- shots

// Each shot gets the page's `cdp` helpers: eval(js), wait(ms), shot(file), send(method, params) and tmp (a scratch folder).

// A small shop database for the SQLite import shot.
const SHOP_SQLITE = `
CREATE TABLE Customer (Id INTEGER PRIMARY KEY AUTOINCREMENT, FullName VARCHAR(100) NOT NULL, Email TEXT UNIQUE, IsActive BOOLEAN NOT NULL DEFAULT 1, CreatedAt DATETIME DEFAULT (datetime('now')));
CREATE TABLE Category (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL UNIQUE, ParentId INTEGER REFERENCES Category(Id));
CREATE TABLE Product (Id INTEGER PRIMARY KEY, CategoryId INTEGER NOT NULL REFERENCES Category(Id), Sku VARCHAR(40) NOT NULL UNIQUE, Name TEXT NOT NULL, Price DECIMAL(10,2) NOT NULL DEFAULT 0, Photo BLOB);
CREATE TABLE "Order" (Id INTEGER PRIMARY KEY, CustomerId INTEGER NOT NULL REFERENCES Customer(Id), PlacedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, Status TEXT NOT NULL DEFAULT 'new', Total REAL);
CREATE TABLE OrderItem (OrderId INTEGER NOT NULL REFERENCES "Order"(Id), ProductId INTEGER NOT NULL REFERENCES Product(Id), Quantity INTEGER NOT NULL DEFAULT 1, UnitPrice DECIMAL(10,2) NOT NULL, PRIMARY KEY (OrderId, ProductId));
`;
const SHOTS = {
  // Drop the example DbContext on the window: the import dialog opens with the tables read from it.
  async 'ef-import'({ eval: run, wait, shot }) {
    const text = readFileSync(path.join(root, 'docs/examples/ShopContext.cs'), 'utf8');
    await run(`(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(text)}], 'ShopContext.cs', { type: 'text/plain' }));
      document.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await wait(800);
    await shot('ef-import.png');
    await run(`document.querySelector('#xl-import-dialog').close()`);
  },
  // Drop a SQLite database on the window. The app reads it by path, so the dropped File has to be a real one:
  // a file input filled in over the protocol provides it.
  async 'sqlite-import'({ eval: run, wait, shot, send, tmp }) {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(tmp, 'shop.db');
    rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    db.exec(SHOP_SQLITE);
    db.close();
    await run(`document.body.append(Object.assign(document.createElement('input'), { type: 'file', id: 'shot-file', hidden: true }))`);
    const { root: doc } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#shot-file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await run(`(() => {
      const input = document.querySelector('#shot-file');
      const dt = new DataTransfer();
      dt.items.add(input.files[0]);
      input.remove();
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await wait(800);
    await shot('sqlite-import.png');
    await run(`document.querySelector('#xl-import-dialog').close()`);
  },
  // Read a SQL Server database through File > Import from SQL Server Database. Needs a server, e.g. a container:
  //   docker run -d -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Pgerd_Test_2026!' -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
  //   PGERD_MSSQL_HOST=127.0.0.1 PGERD_MSSQL_PORT=14333 PGERD_MSSQL_PASSWORD='Pgerd_Test_2026!' node scripts/capture-screenshots.mjs mssql-import
  // The ShopDemo database is created on the first run.
  async 'mssql-import'({ eval: run, wait, shot }) {
    if (!process.env.PGERD_MSSQL_HOST) return console.log('mssql-import: skipped, set PGERD_MSSQL_HOST');
    const conn = {
      server: process.env.PGERD_MSSQL_HOST,
      port: process.env.PGERD_MSSQL_PORT || '1433',
      user: process.env.PGERD_MSSQL_USER || 'sa',
      password: process.env.PGERD_MSSQL_PASSWORD || '',
      trustServerCertificate: true,
    };
    await createShopMssql(conn);
    await run(`(() => {
      const b = Object.assign(document.createElement('button'), { hidden: true });
      b.dataset.cmd = 'import-mssql';
      document.body.append(b);
      b.click();
      b.remove();
      const f = document.querySelector('#mssql-connect-form').elements;
      Object.assign(f.namedItem('server'), { value: ${JSON.stringify(conn.server)} });
      f.namedItem('port').value = ${JSON.stringify(String(conn.port))};
      f.namedItem('database').value = 'ShopDemo';
      f.namedItem('user').value = ${JSON.stringify(conn.user)};
      f.namedItem('password').value = ${JSON.stringify(conn.password)};
      f.namedItem('trustServerCertificate').checked = true;
    })()`);
    await wait(300);
    await shot('mssql-connect.png');
    await run(`document.querySelector('#mssql-connect-ok').click()`);
    const done = async () => (await run(`!document.querySelector('#mssql-connect-dialog').open`)).result.value;
    for (let n = 0; n < 75 && !(await done()); n++) await wait(200);
    await wait(500);
    await shot('mssql-import.png');
    await run(`document.querySelector('#xl-import-dialog').close()`);
  },
};

// The copy shots need PostgreSQL (PGERD_TEST_HOST…, as tests/copy.integration.test.js) and MySQL (PGERD_MYSQL_HOST…);
// oracle-import needs Oracle (PGERD_ORACLE_HOST…). See that test for containers that work.
const env = process.env;
const pgTarget = { host: env.PGERD_TEST_HOST, port: env.PGERD_TEST_PORT || '5432', user: env.PGERD_TEST_USER || 'postgres', password: env.PGERD_TEST_PASSWORD || '', database: 'shop_copy' };
const mysqlSource = { host: env.PGERD_MYSQL_HOST, port: env.PGERD_MYSQL_PORT || '3306', user: env.PGERD_MYSQL_USER || 'root', password: env.PGERD_MYSQL_PASSWORD || '', database: 'shop_demo' };
const oracleSource = { host: env.PGERD_ORACLE_HOST, port: env.PGERD_ORACLE_PORT || '1521', service: env.PGERD_ORACLE_SERVICE || 'FREEPDB1', user: env.PGERD_ORACLE_USER || 'shop', password: env.PGERD_ORACLE_PASSWORD || '' };

const SHOP_MYSQL = [
  `CREATE TABLE Customer (Id int AUTO_INCREMENT PRIMARY KEY, FullName varchar(100) NOT NULL, Email varchar(200) UNIQUE,
     IsActive tinyint(1) NOT NULL DEFAULT 1, CreatedAt datetime NOT NULL DEFAULT CURRENT_TIMESTAMP) COMMENT 'People who buy'`,
  `CREATE TABLE Product (Id int AUTO_INCREMENT PRIMARY KEY, Sku varchar(40) NOT NULL UNIQUE, Name varchar(200) NOT NULL,
     Price decimal(10,2) NOT NULL DEFAULT 0, Kind enum('book','tool','toy') NOT NULL DEFAULT 'book', Photo blob)`,
  `CREATE TABLE \`Order\` (Id bigint unsigned AUTO_INCREMENT PRIMARY KEY, CustomerId int NOT NULL, PlacedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
     Status varchar(20) NOT NULL DEFAULT 'new', Notes json, FOREIGN KEY (CustomerId) REFERENCES Customer (Id))`,
  `CREATE TABLE OrderItem (OrderId bigint unsigned NOT NULL, ProductId int NOT NULL, Quantity smallint NOT NULL DEFAULT 1, UnitPrice decimal(10,2) NOT NULL,
     PRIMARY KEY (OrderId, ProductId), FOREIGN KEY (OrderId) REFERENCES \`Order\` (Id), FOREIGN KEY (ProductId) REFERENCES Product (Id))`,
  `INSERT INTO Customer (FullName, Email, IsActive) VALUES ('Ana López', 'ana@example.com', 1), ('Bo Chen', 'bo@example.com', 1), ('Zoë O''Brien', NULL, 0)`,
  `INSERT INTO Product (Sku, Name, Price, Kind) VALUES ('BK-1', 'Data modeling', 39.90, 'book'), ('TL-7', 'Torque wrench', 120.00, 'tool'), ('TY-3', 'Puzzle 1000', 15.50, 'toy')`,
  `INSERT INTO \`Order\` (CustomerId, Status, Notes) VALUES (1, 'paid', '{"gift": true}'), (2, 'new', NULL), (1, 'shipped', NULL)`,
  'INSERT INTO OrderItem VALUES (1, 1, 2, 39.90), (1, 3, 1, 15.50), (2, 2, 1, 120.00), (3, 1, 1, 39.90)',
];

async function createShopMysql() {
  const { mysqlConnection } = createRequire(import.meta.url)('../src/main/database/mysql.cjs');
  const c = await mysqlConnection({ ...mysqlSource, database: '' });
  try {
    await c.query(`DROP DATABASE IF EXISTS ${mysqlSource.database}`);
    await c.query(`CREATE DATABASE ${mysqlSource.database} CHARACTER SET utf8mb4`);
    await c.query(`USE ${mysqlSource.database}`);
    for (const sql of SHOP_MYSQL) await c.query(sql);
  } finally {
    await c.end();
  }
}

async function freshPgDatabase() {
  const db = createRequire(import.meta.url)('../src/main/db.cjs');
  const admin = { ...pgTarget, database: 'postgres' };
  await db.execute(admin, `DROP DATABASE IF EXISTS ${pgTarget.database} WITH (FORCE)`);
  await db.execute(admin, `CREATE DATABASE ${pgTarget.database}`);
}

// Click a hidden button for `cmd`, as the menu or ribbon would.
const command = (cmd) => `(() => {
  const b = Object.assign(document.createElement('button'), { hidden: true });
  b.dataset.cmd = ${JSON.stringify(cmd)};
  document.body.append(b);
  b.click();
  b.remove();
})()`;
// Fill named fields of a form: { name: value | boolean }.
const fill = (formSel, values) => `(() => {
  const f = document.querySelector(${JSON.stringify(formSel)}).elements;
  for (const [k, v] of Object.entries(${JSON.stringify(values)})) {
    const el = f.namedItem(k);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
})()`;
async function until(run, wait, expression, tries = 100) {
  for (let n = 0; n < tries; n++) {
    if ((await run(expression)).result.value) return true;
    await wait(200);
  }
  return false;
}

Object.assign(SHOTS, {
  // Import a MySQL database and copy its rows into PostgreSQL; also shows the Import Designer reading it.
  async 'mysql-copy'({ eval: run, wait, shot }) {
    if (!pgTarget.host || !mysqlSource.host) return console.log('mysql-copy: skipped, set PGERD_TEST_HOST and PGERD_MYSQL_HOST');
    await createShopMysql();
    await freshPgDatabase();
    await run(command('db-connect'));
    await wait(300);
    await run(fill('#db-connect-form', { ...pgTarget, sslmode: 'disable', profileName: 'shop_copy', environment: 'development', allowWrites: true, allowDDL: true, saveInstance: false }));
    await run(`document.querySelector('#db-connect-form button[value="ok"]').click()`);
    await until(run, wait, `!document.querySelector('#db-connect-dialog').open`);
    await wait(800);
    await run(command('import-mysql'));
    await wait(300);
    await run(fill('#mysql-connect-form', { ...mysqlSource, ssl: 'disable' }));
    await shot('mysql-connect.png');
    await run(`document.querySelector('#mysql-connect-form button[value="ok"]').click()`);
    await until(run, wait, `!document.querySelector('#mysql-connect-dialog').open`);
    await until(run, wait, `!document.querySelector('#xl-copy').disabled`);
    await run(`document.querySelector('#xl-copy').click()`);
    await wait(400);
    await shot('mysql-import.png');
    await run(`document.querySelector('#xl-import-ok').click()`);
    await until(run, wait, `!document.querySelector('#copy-close').disabled`);
    await wait(300);
    await shot('copy-rows.png');
    await run(`document.querySelector('#copy-close').click()`);
    // The same database as the sources of the Import Designer.
    await run(command('import-designer'));
    await wait(800);
    await run(`(() => { const s = document.querySelector('#imp-db-open'); s.value = 'mysql'; s.dispatchEvent(new Event('change')); })()`);
    await wait(300);
    await run(fill('#mysql-connect-form', { password: mysqlSource.password }));
    await run(`document.querySelector('#mysql-connect-form button[value="ok"]').click()`);
    await until(run, wait, `!document.querySelector('#mysql-connect-dialog').open`);
    await until(run, wait, `document.querySelectorAll('#imp-sheets .imp-sheet').length > 0`);
    await run(`[...document.querySelectorAll('#imp-sheets .imp-sheet')].find((b) => b.textContent === 'Order')?.click()`);
    await wait(300);
    await run(`document.querySelector('#imp-add-source').click()`);
    await wait(800);
    await shot('import-db-source.png');
  },
  async 'oracle-import'({ eval: run, wait, shot }) {
    if (!oracleSource.host) return console.log('oracle-import: skipped, set PGERD_ORACLE_HOST');
    await run(command('import-oracle'));
    await wait(300);
    await run(fill('#oracle-connect-form', oracleSource));
    await run(`document.querySelector('#oracle-connect-form button[value="ok"]').click()`);
    await until(run, wait, `!document.querySelector('#oracle-connect-dialog').open`);
    await wait(600);
    await shot('oracle-import.png');
    await run(`document.querySelector('#xl-import-dialog').close()`);
  },
});

// The ShopDemo database of the mssql-import shot.
const SHOP_MSSQL = `
CREATE SCHEMA Sales
GO
CREATE TABLE dbo.Customer (
  CustomerId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Customer PRIMARY KEY,
  FullName nvarchar(100) NOT NULL,
  Email nvarchar(320) NULL CONSTRAINT UQ_Customer_Email UNIQUE,
  IsActive bit NOT NULL CONSTRAINT DF_Customer_IsActive DEFAULT ((1)),
  CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_Customer_CreatedAt DEFAULT (sysdatetime())
)
GO
CREATE TABLE dbo.Product (
  ProductId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Product PRIMARY KEY,
  Sku varchar(40) NOT NULL CONSTRAINT UQ_Product_Sku UNIQUE,
  Name nvarchar(200) NOT NULL,
  Price money NOT NULL CONSTRAINT DF_Product_Price DEFAULT ((0)),
  Photo varbinary(max) NULL
)
GO
CREATE TABLE Sales.[Order] (
  OrderId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_Order PRIMARY KEY,
  CustomerId int NOT NULL CONSTRAINT FK_Order_Customer REFERENCES dbo.Customer (CustomerId),
  PlacedAt datetime NOT NULL CONSTRAINT DF_Order_PlacedAt DEFAULT (getdate()),
  Status nvarchar(20) NOT NULL CONSTRAINT DF_Order_Status DEFAULT (N'new'),
  Token uniqueidentifier NOT NULL CONSTRAINT DF_Order_Token DEFAULT (newid())
)
GO
CREATE TABLE Sales.OrderItem (
  OrderId bigint NOT NULL CONSTRAINT FK_OrderItem_Order REFERENCES Sales.[Order] (OrderId),
  ProductId int NOT NULL CONSTRAINT FK_OrderItem_Product REFERENCES dbo.Product (ProductId),
  Quantity smallint NOT NULL CONSTRAINT DF_OrderItem_Quantity DEFAULT ((1)),
  UnitPrice decimal(10, 2) NOT NULL,
  CONSTRAINT PK_OrderItem PRIMARY KEY (OrderId, ProductId)
)
GO
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'People who buy', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Customer'
`;

async function createShopMssql(conn) {
  const sql = createRequire(import.meta.url)('mssql');
  const { mssqlConfig } = createRequire(import.meta.url)('../src/main/database/mssql.cjs');
  const run = async (database, script) => {
    const pool = new sql.ConnectionPool(mssqlConfig({ ...conn, database }));
    await pool.connect();
    try {
      for (const batch of script.split(/^\s*GO\s*$/im)) if (batch.trim()) await pool.request().batch(batch);
    } finally {
      await pool.close();
    }
  };
  await run('master', "IF DB_ID('ShopDemo') IS NOT NULL BEGIN ALTER DATABASE ShopDemo SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ShopDemo END\nGO\nCREATE DATABASE ShopDemo");
  await run('ShopDemo', SHOP_MSSQL);
}

// ---------------------------------------------------------------- shots of the shop database

// Helpers every page gets as window.__s: find visible elements by text, the diagram's tables and rows, the
// explorer's tables, run a command as the ribbon does and drop a file on the window.
const PAGE_LIB = `window.__s = {
  visible: (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  center(el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; },
  all(sel, root = document) { return [...root.querySelectorAll(sel)].filter((e) => this.visible(e)); },
  text(sel, text, root = document) { return this.all(sel, root).find((e) => e.textContent.trim() === text); },
  table(name) { return this.text('.t-title', name)?.closest('g'); },
  header(name) { return this.table(name).querySelector('.t-header'); },
  row(name, col) { return [...this.table(name).querySelectorAll('.t-row')].find((r) => r.querySelector('text')?.textContent === col); },
  treeTable(key) { return this.all('.tree-row.table').find((r) => r.title.split(/\\s/).includes(key)); },
  cmd(name) { const b = Object.assign(document.createElement('button'), { hidden: true }); b.dataset.cmd = name; document.body.append(b); b.click(); b.remove(); },
  drop(name, text) { const dt = new DataTransfer(); dt.items.add(new File([text], name, { type: 'text/plain' })); document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); },
  page() { return this.all('.tab-page')[0]; },
};`;

// The shop database (PGERD_TEST_HOST…, database shopdb): the sample diagram's tables with a few differences for
// Compare, more tables for Import, rows, a pgvector column and an Apache AGE graph. The server needs the vector and
// age extensions; an image built FROM apache/age with pgvector added works.
const SHOPDB = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
CREATE SCHEMA shop;
CREATE TABLE public.customer (id bigint PRIMARY KEY, email varchar(120) NOT NULL UNIQUE, full_name text, created_at timestamptz NOT NULL DEFAULT now(), legacy_code text);
COMMENT ON TABLE public.customer IS 'Customers of the shop';
CREATE TABLE public.audit_log (id bigserial PRIMARY KEY, happened_at timestamptz NOT NULL DEFAULT now(), message text);
CREATE TABLE shop.product (id serial PRIMARY KEY, sku varchar(32) NOT NULL, name text NOT NULL, price numeric(10,2) NOT NULL, tags text[]);
CREATE TABLE shop.orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL REFERENCES public.customer(id) ON DELETE CASCADE, status varchar(20) NOT NULL, placed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE shop.order_item (order_id bigint NOT NULL REFERENCES shop.orders(id) ON DELETE CASCADE, product_id integer NOT NULL REFERENCES shop.product(id) ON DELETE RESTRICT, quantity integer NOT NULL DEFAULT 1, PRIMARY KEY (order_id, product_id));
CREATE TABLE shop.coupon (code varchar(20) PRIMARY KEY, percent_off integer NOT NULL);
CREATE TABLE shop.supplier (id serial PRIMARY KEY, name text NOT NULL, country varchar(2));
CREATE TABLE shop.warehouse (id serial PRIMARY KEY, city text NOT NULL);
CREATE TABLE shop.product_embedding (id bigserial PRIMARY KEY, product_id integer NOT NULL REFERENCES shop.product(id), model varchar(64) NOT NULL DEFAULT 'text-embedding-small', embedding vector(384) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.customer (id, email, full_name, created_at)
SELECT g, 'customer' || g || '@example.com',
       CASE WHEN g % 17 = 0 THEN NULL ELSE (ARRAY['Ana','Ben','Cruz','Dana','Eli','Fay','Gus','Hana'])[1 + g % 8] || ' ' || (ARRAY['López','Chen','Ortiz','Smith','Novak','Rossi'])[1 + g % 6] END,
       timestamp '2026-01-01' + g * interval '19 hours'
FROM generate_series(1, 240) g;
INSERT INTO shop.product (sku, name, price, tags)
SELECT 'SKU-' || lpad(g::text, 4, '0'), (ARRAY['Desk lamp','Notebook','Coffee mug','Backpack','Headphones','Water bottle','Keyboard','Monitor stand'])[1 + g % 8] || ' ' || g,
       round((5 + (g * 37) % 300)::numeric + 0.99, 2), ARRAY[(ARRAY['home','office','travel','audio'])[1 + g % 4]]
FROM generate_series(1, 2000) g;
INSERT INTO shop.orders (id, customer_id, status, placed_at)
SELECT g, 1 + (g * 7) % 240, (ARRAY['new','paid','shipped','delivered','cancelled'])[1 + g % 5], timestamp '2026-03-01' + g * interval '3 hours'
FROM generate_series(1, 1200) g;
INSERT INTO shop.order_item (order_id, product_id, quantity)
SELECT o, 1 + (o * k * 13) % 2000, 1 + (o + k) % 4 FROM generate_series(1, 1200) o, generate_series(1, 3) k ON CONFLICT DO NOTHING;
DELETE FROM shop.order_item WHERE order_id IN (37, 74, 111);
INSERT INTO shop.coupon VALUES ('WELCOME10', 10), ('SPRING25', 25);
INSERT INTO shop.supplier (name, country) VALUES ('Acme Supplies', 'US'), ('Globex', 'DE'), ('Initech', 'MX');
INSERT INTO shop.warehouse (city) VALUES ('Monterrey'), ('Madrid');
INSERT INTO shop.product_embedding (product_id, embedding)
SELECT p, (SELECT array_agg(sin(p * 0.37 + i * 0.11))::vector(384) FROM generate_series(1, 384) i) FROM generate_series(1, 2000) p;
ANALYZE;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
SELECT create_graph('social');
SELECT * FROM cypher('social', $$
  CREATE (ana:Person {name:'Ana', city:'Madrid'}), (ben:Person {name:'Ben', city:'Berlin'}), (cruz:Person {name:'Cruz', city:'Monterrey'}),
         (dana:Person {name:'Dana', city:'Lisbon'}), (eli:Person {name:'Eli', city:'Oslo'}), (fay:Person {name:'Fay', city:'Rome'}),
         (acme:Company {name:'Acme'}), (globex:Company {name:'Globex'}), (p1:Project {name:'pgsql-erd'}), (p2:Project {name:'graph-loader'}),
         (ana)-[:KNOWS {since:2019}]->(ben), (ana)-[:KNOWS {since:2021}]->(cruz), (ben)-[:KNOWS {since:2020}]->(dana),
         (cruz)-[:KNOWS {since:2018}]->(eli), (dana)-[:KNOWS {since:2022}]->(fay), (eli)-[:KNOWS {since:2023}]->(ana),
         (ana)-[:WORKS_AT {role:'Engineer'}]->(acme), (ben)-[:WORKS_AT {role:'Designer'}]->(acme), (cruz)-[:WORKS_AT {role:'Analyst'}]->(globex),
         (dana)-[:WORKS_AT {role:'Manager'}]->(globex), (eli)-[:WORKS_AT {role:'Engineer'}]->(globex), (fay)-[:WORKS_AT {role:'Founder'}]->(acme),
         (ana)-[:CONTRIBUTES {commits:120}]->(p1), (fay)-[:CONTRIBUTES {commits:45}]->(p1), (eli)-[:CONTRIBUTES {commits:80}]->(p2),
         (ben)-[:CONTRIBUTES {commits:12}]->(p2), (acme)-[:SPONSORS]->(p1), (globex)-[:SPONSORS]->(p2)
$$) AS (a agtype);
`;

// The project next to the diagram: samples/shop.pgerd and three scripts.
const DEMO_SCRIPTS = {
  'validators/orders-have-items.ts': `// @pgsql-erd {"type":"validator","profile":"validator"}
// Every order must have at least one item, and every item a positive quantity.
validate("Orders have items", async () => {
  const empty = await db.query<{ id: number }>(\`SELECT o.id FROM shop.orders o
    WHERE NOT EXISTS (SELECT 1 FROM shop.order_item i WHERE i.order_id = o.id) ORDER BY o.id\`);
  for (const o of empty) {
    report.error({ table: "shop.orders", row: o.id, column: "id", message: \`Order \${o.id} has no items.\` });
  }
});

validate("Quantities are positive", async () => {
  const bad = await db.shop.order_item.where({ quantity: { lte: 0 } }).count();
  if (bad) report.error(\`\${bad} order items with a quantity of zero or less\`);
});
`,
  'generators/test-customers.ts': `// @pgsql-erd {"type":"generator","profile":"generator"}
// Generates customers and their orders. Dry run first; nothing is saved until you commit.
faker.seed(42);
log(db.describe.insertOrder(["public.customer", "shop.orders"]));

const customers = await seed.fill("public.customer", 50);
await seed.fill("shop.orders", 120, (i) => ({ customer_id: customers[i % customers.length].id, status: "new" }));
log(\`Inserted \${customers.length} customers\`);
`,
  'exports/products.ts': `// @pgsql-erd {"type":"export","profile":"read-only"}
// Lists the products with their price, for the catalogue.
const products = await db.shop.product.orderBy("name").limit(20).select();
for (const p of products) log(p.sku, p.name, p.price);
`,
};

const QUERY_SQL = `SELECT c.full_name, count(*) AS orders, sum(i.quantity) AS items
FROM shop.orders o
JOIN public.customer c ON c.id = o.customer_id
JOIN shop.order_item i ON i.order_id = o.id
WHERE o.status = 'paid'
GROUP BY c.full_name
ORDER BY items DESC;
`;
const VECTOR_SQL = `-- Nearest neighbours of one product's embedding
SELECT p.name, e.embedding <=> q.embedding AS distance
FROM shop.product_embedding e
JOIN shop.product p ON p.id = e.product_id
CROSS JOIN (SELECT embedding FROM shop.product_embedding WHERE product_id = 42) q
ORDER BY e.embedding <=> q.embedding
LIMIT 10;
`;

const demoDir = env.PGERD_DEMO_DIR || path.join(tmpdir(), 'pgsql-erd-demo', 'shop');
const shopdb = { ...pgTarget, database: 'shopdb' };

async function createShopDb() {
  const db = createRequire(import.meta.url)('../src/main/db.cjs');
  const admin = { ...shopdb, database: 'postgres' };
  await db.execute(admin, 'DROP DATABASE IF EXISTS shopdb WITH (FORCE)');
  await db.execute(admin, 'CREATE DATABASE shopdb');
  await db.execute(shopdb, SHOPDB);
  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(demoDir, { recursive: true });
  writeFileSync(path.join(demoDir, 'shop.pgerd'), readFileSync(path.join(root, 'samples/shop.pgerd')));
  for (const [file, text] of Object.entries(DEMO_SCRIPTS)) {
    mkdirSync(path.dirname(path.join(demoDir, 'scripts', file)), { recursive: true });
    writeFileSync(path.join(demoDir, 'scripts', file), text);
  }
}

async function shopShots(lang) {
  if (!pgTarget.host) return console.log('shop: skipped, set PGERD_TEST_HOST (a server with the vector and age extensions)');
  await createShopDb();
  const p = await launch(lang, { file: path.join(demoDir, 'shop.pgerd') });
  const { val, wait, click, drag, key, shot } = p;
  const run = (js) => val(js);
  const waitFor = (expr, tries = 100) => until(p.eval, wait, expr, tries);
  const closeDialogs = () => run(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
  try {
    // Connect, with the explorer beside the diagram.
    await run(`__s.cmd('db-connect')`);
    await wait(300);
    await run(fill('#db-connect-form', { ...shopdb, sslmode: 'disable', profileName: 'shopdb', environment: 'development', allowWrites: true, allowDDL: true, saveInstance: false }));
    await run(`document.querySelector('#db-connect-form button[value="ok"]').click()`);
    await waitFor(`!document.querySelector('#db-connect-dialog').open`);
    await waitFor(`!!__s.treeTable('public.customer')`);
    await wait(500);
    await click(`__s.treeTable('public.customer').querySelector('.tree-twisty')`);
    await wait(300);
    await shot('diagram.png');
    const ribbonBottom = await run(`Math.ceil(document.querySelector('nav').getBoundingClientRect().bottom)`);
    await shot('ribbon.png', { x: 0, y: 0, width: 1440, height: ribbonBottom });

    // The explorer with two more tables open.
    const twisty = (t) => `__s.treeTable('${t}').querySelector('.tree-twisty')`;
    for (const t of ['shop.orders', 'shop.product_embedding']) {
      await click(twisty(t));
      await wait(300);
    }
    await shot('db-explorer.png');
    for (const t of ['shop.orders', 'shop.product_embedding', 'public.customer']) {
      await click(twisty(t));
      await wait(200);
    }

    // Import from Database, with two new tables ticked.
    await run(`__s.cmd('db-import')`);
    await waitFor(`__s.all('#db-import-dialog label').length > 3`);
    await run(`for (const name of ['supplier', 'warehouse']) __s.all('#db-import-dialog label').find((l) => l.textContent.includes(name))?.querySelector('input').click()`);
    await wait(300);
    await shot('db-import.png');
    await closeDialogs();

    // Compare with the database.
    await run(`__s.cmd('db-compare')`);
    await wait(2500);
    await shot('db-compare.png');
    await closeDialogs();

    // A table's sidebar with a column open.
    await click(`__s.header('customer')`);
    await wait(300);
    await click(`__s.row('customer', 'email')`);
    await wait(400);
    await shot('table-sidebar.png');
    await key('Escape', 'Escape', 27);
    await wait(300);

    // A relationship drawn from a column's handle.
    await drag(`__s.row('shop.orders', 'customer_id').querySelector('.t-col-handle')`, `__s.row('customer', 'id')`);
    await wait(500);
    await shot('relationship.png');
    await closeDialogs();
    await key('Escape', 'Escape', 27);

    // The SQL preview.
    await run(`__s.cmd('toggle-sql')`);
    await wait(600);
    await shot('sql-preview.png');
    await run(`__s.cmd('toggle-sql')`);
    await wait(300);

    // The scripts: a validator's dry run with an error picked, then a generator waiting for its commit.
    await run(`__s.cmd('script-tab-new')`);
    await wait(1500);
    await click(`__s.text('.wb-item .grow', 'orders-have-items')`);
    await wait(1500);
    await run(`__s.cmd('script-dry-run')`);
    await wait(4000);
    await click(`__s.all('.wb-msg.link')[0]`);
    await wait(800);
    await shot('scripts.png');
    await click(`__s.text('.wb-item .grow', 'test-customers')`);
    await wait(1500);
    await run(`__s.cmd('script-run')`);
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await wait(500);
    await shot('commit-review.png');
    await click(`__s.all('dialog[open] button').find((b) => /discard|descartar/i.test(b.textContent))`);
    await wait(800);
    await click(`__s.text('.wb-item .grow', 'products')`);
    await wait(1200);
    await run(`__s.cmd('script-dry-run')`);
    await wait(3000);

    // The scripts beside the tables they use.
    await click(`__s.all('nav .tab, nav button')[0]`);
    await wait(500);
    await run(`__s.cmd('toggle-erd-scripts')`);
    await wait(500);
    await run(`__s.cmd('fit')`);
    await wait(500);
    await shot('scripts-in-diagram.png');
    await run(`__s.cmd('toggle-erd-scripts')`);

    // A pgvector column in a diagram of its own.
    await run(`__s.cmd('new')`);
    await wait(800);
    for (const t of ['shop.product', 'shop.product_embedding']) {
      await click(`__s.treeTable('${t}')`, 2);
      await wait(500);
    }
    await run(`__s.cmd('auto-layout')`);
    await wait(400);
    await run(`__s.cmd('fit')`);
    await wait(400);
    await click(`__s.header('shop.product_embedding')`);
    await wait(300);
    await click(`__s.row('shop.product_embedding', 'embedding')`);
    await wait(500);
    await shot('pgvector-column.png');
    await key('Escape', 'Escape', 27);

    // The query analyzer, on an ordinary query and on a nearest-neighbour search.
    for (const [file, sql] of [['query-plan.png', QUERY_SQL], ['pgvector-query-plan.png', VECTOR_SQL]]) {
      await run(`__s.drop('${file.replace('.png', '.sql')}', ${JSON.stringify(sql)})`);
      await wait(2000);
      await click(`__s.all('.q-analyze')[0]`);
      await waitFor(`!__s.all('.q-plan')[0]?.hidden && __s.all('.q-plan')[0]?.textContent.length > 50`);
      await wait(500);
      await shot(file);
    }

    // The query builder with four tables joined.
    await run(`__s.cmd('builder-new')`);
    await wait(800);
    for (const t of ['public.customer', 'shop.orders', 'shop.order_item', 'shop.product']) {
      await click(`__s.treeTable('${t}')`, 2);
      await wait(500);
    }
    // Every other table lower down, so the joins have room.
    const card = (t) => `__s.all('#qb-area .qb-table').find((n) => n.querySelector('.qb-head').textContent.includes('${t}'))`;
    for (const t of ['orders', 'product']) {
      const at = await val(`__s.center(${card(t)}.querySelector('.qb-head'))`);
      await drag({ x: at.x - 60, y: at.y }, { x: at.x - 20, y: at.y + 190 });
      await wait(300);
    }
    await run(`for (const [t, cols] of Object.entries({ customer: ['email', 'full_name'], orders: ['status', 'placed_at'], order_item: ['quantity'], product: ['name', 'price'] }))
      for (const c of cols) {
        const box = __s.all('#qb-area .qb-table').find((n) => n.querySelector('.qb-head').textContent.includes(t))?.querySelector('label.qb-col[data-col="' + c + '"] input');
        if (box && !box.checked) box.click();
      }`);
    await wait(600);
    await shot('query-builder.png');

    // A data tab with a filter menu open.
    await click('document.querySelector("#data-tab-add")');
    await wait(600);
    await click(`__s.all('#data-pick-list .item').find((i) => i.textContent.trim() === 'shop.orders')`);
    await waitFor(`__s.all('.dt-filter').length > 0`);
    await wait(500);
    await click(`__s.all('.dt-filter')[2]`);
    await wait(800);
    // Untick two values, as you would before OK.
    await run(`for (const v of ['cancelled', 'new']) __s.all('label').find((l) => l.textContent.trim().startsWith(v) && l.querySelector('input'))?.querySelector('input').click()`);
    await wait(300);
    await shot('data-filter.png');
    await key('Escape', 'Escape', 27);

    // Apache AGE: the relationships of a graph, then the explorer.
    await run(`__s.cmd('graph-new')`);
    await wait(1200);
    await click(`__s.text('#graph-page *', 'social')`);
    await wait(1200);
    await shot('age-relationships.png');
    await click(`document.querySelector('[data-gtab="explore"]')`);
    await wait(500);
    await run(`(() => { const s = __s.all('#graph-page .gr-toolbar select')[0]; s.value = '50'; s.dispatchEvent(new Event('change')); })()`);
    await wait(6000);
    await click(`__s.all('#graph-page .gr-toolbar button[data-icon="fit"]')[0]`);
    await wait(1500);
    await click(`[...document.querySelectorAll('#graph-page .gr-canvas g')].find((g) => g.querySelector(':scope > text')?.textContent === 'Ana')?.querySelector('circle')`);
    await wait(600);
    await shot('age-explorer.png');
  } finally {
    await p.close();
  }
}

// The four themes, 2 × 2 at half size with their names, drawn in the page of the last window.
const THEMES = [['white', 'White', 'Blanco'], ['dark', 'Dark', 'Oscuro'], ['vs', 'Visual Studio', 'Visual Studio'], ['winme', 'Windows ME', 'Windows ME']];
async function themeShots(lang) {
  const pngs = [];
  let page;
  for (const [theme] of THEMES) {
    page = await launch(lang, { theme, file: path.join(root, 'samples/shop.pgerd') });
    await page.val(`__s.cmd('toggle-db-tree')`);
    await page.wait(300);
    await page.click(`__s.header('customer')`);
    await page.wait(300);
    await page.click(`__s.row('customer', 'id')`);
    await page.rest();
    await page.wait(500);
    pngs.push(await page.capture());
    if (pngs.length < THEMES.length) await page.close();
  }
  try {
    const names = THEMES.map((t) => (lang === 'es' ? t[2] : t[1]));
    const b64 = await page.val(`(async () => {
      const pngs = ${JSON.stringify(pngs)}, names = ${JSON.stringify(names)};
      const c = Object.assign(document.createElement('canvas'), { width: 1440, height: 880 });
      const g = c.getContext('2d');
      for (const [i, data] of pngs.entries()) {
        const img = new Image();
        img.src = 'data:image/png;base64,' + data;
        await img.decode();
        const x = (i % 2) * 720, y = Math.floor(i / 2) * 440;
        g.drawImage(img, x, y, 720, 440);
        g.font = 'bold 22px "Segoe UI", sans-serif';
        const w = g.measureText(names[i]).width + 28;
        g.fillStyle = '#111';
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.beginPath();
        g.roundRect(x + 14, y + 380, w, 36, 18);
        g.fill();
        g.stroke();
        g.fillStyle = '#fff';
        g.fillText(names[i], x + 28, y + 406);
      }
      g.fillStyle = '#888';
      g.fillRect(719, 0, 2, 880);
      g.fillRect(0, 439, 1440, 2);
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    page.write('themes.png', b64);
  } finally {
    await page.close();
  }
}

const OWN_APP_SHOTS = { themes: themeShots, shop: shopShots };

// ---------------------------------------------------------------- CDP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('The app did not open a window');
}

async function session(ws) {
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 1, mobile: false });
  return send;
}

// Start the app in `lang` and `theme` with its own settings folder, optionally opening `file`, and return the helpers a
// shot gets. close() quits it and removes the folder.
async function launch(lang, { theme = 'white', file = null } = {}) {
  const data = mkdtempSync(path.join(tmpdir(), 'pgsql-erd-shots-'));
  writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ locale: lang, theme }));
  const app = spawn(electron, [root, ...(file ? [file] : []), `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { stdio: 'ignore' });
  const close = async () => {
    app.kill();
    await sleep(500);
    try {
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // still locked by the exiting app; it is a temporary folder
    }
  };
  try {
    const ws = await connect();
    const send = await session(ws);
    await sleep(file ? 2500 : 1500);
    const outDir = path.join(root, 'docs/screenshots', lang === 'en' ? '' : lang);
    mkdirSync(outDir, { recursive: true });
    const run = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    const helpers = {
      lang,
      eval: run,
      // The value of a page expression.
      val: async (expression) => (await run(expression)).result.value,
      wait: sleep,
      send,
      tmp: data,
      // Real mouse input at page coordinates, or at the centre of a page expression that returns an element.
      async click(at, clicks = 1, modifiers = 0) {
        const { x, y } = typeof at === 'string' ? await helpers.val(`window.__s.center(${at})`) : at;
        await mouse('mouseMoved', x, y, { button: 'none' });
        for (let c = 1; c <= clicks; c++) {
          await mouse('mousePressed', x, y, { clickCount: c, modifiers });
          await mouse('mouseReleased', x, y, { clickCount: c, modifiers });
        }
      },
      async drag(from, to) {
        const a = typeof from === 'string' ? await helpers.val(`window.__s.center(${from})`) : from;
        const b = typeof to === 'string' ? await helpers.val(`window.__s.center(${to})`) : to;
        await mouse('mouseMoved', a.x, a.y, { button: 'none' });
        await mouse('mousePressed', a.x, a.y, { clickCount: 1 });
        for (let i = 1; i <= 12; i++) await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12, { buttons: 1 });
        await mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
      },
      async key(key, code = key, keyCode = 0, modifiers = 0) {
        for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
      },
      type: (text) => send('Input.insertText', { text }),
      // Park the pointer where it highlights nothing.
      rest: () => mouse('mouseMoved', 1439, 300, { button: 'none' }),
      // The page as a PNG (base64), optionally clipped to { x, y, width, height }.
      capture: async (clip) => (await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).data,
      write(file, b64) {
        writeFileSync(path.join(outDir, file), Buffer.from(b64, 'base64'));
        console.log(`wrote ${path.relative(root, path.join(outDir, file))}`);
      },
      shot: async (file, clip) => {
        await helpers.rest();
        helpers.write(file, await helpers.capture(clip));
      },
      close: async () => {
        ws.close();
        await close();
      },
    };
    await run(PAGE_LIB);
    return helpers;
  } catch (err) {
    await close();
    throw err;
  }
}

async function runAll(lang) {
  const plain = Object.entries(SHOTS).filter(([name]) => !wanted.length || wanted.includes(name));
  if (plain.length) {
    const page = await launch(lang);
    try {
      for (const [, fn] of plain) await fn(page);
    } finally {
      await page.close();
    }
  }
  for (const [name, fn] of Object.entries(OWN_APP_SHOTS)) {
    if (wanted.length && !wanted.includes(name)) continue;
    await fn(lang);
  }
}

for (const lang of langArg ? [langArg] : ['en', 'es']) await runAll(lang);
