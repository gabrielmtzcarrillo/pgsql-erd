// Takes the README screenshots that need no database: starts the app with its
// own throw-away settings folder, drives it over the Chrome DevTools protocol
// and writes PNGs. See docs/screenshots.md for how each screenshot is made.
//
//   node scripts/capture-screenshots.mjs            # every shot, English and Spanish
//   node scripts/capture-screenshots.mjs ef-import  # one shot
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

async function run(lang) {
  const data = mkdtempSync(path.join(tmpdir(), 'pgsql-erd-shots-'));
  writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ locale: lang, theme: 'white' }));
  const app = spawn(electron, [root, `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { stdio: 'ignore' });
  try {
    const ws = await connect();
    const send = await session(ws);
    await sleep(1500);
    const outDir = path.join(root, 'docs/screenshots', lang === 'en' ? '' : lang);
    mkdirSync(outDir, { recursive: true });
    const helpers = {
      eval: (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      wait: sleep,
      send,
      tmp: data,
      shot: async (file) => {
        const { data: b64 } = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(outDir, file), Buffer.from(b64, 'base64'));
        console.log(`wrote ${path.relative(root, path.join(outDir, file))}`);
      },
    };
    for (const [name, fn] of Object.entries(SHOTS)) {
      if (wanted.length && !wanted.includes(name)) continue;
      await fn(helpers);
    }
    ws.close();
  } finally {
    app.kill();
    await sleep(500);
    rmSync(data, { recursive: true, force: true });
  }
}

for (const lang of langArg ? [langArg] : ['en', 'es']) await run(lang);
