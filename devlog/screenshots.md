# How the README screenshots are taken

For people and agents who need to retake or add a screenshot. The PNGs live in `docs/screenshots/` (English) and
`docs/screenshots/es/` (Spanish, same file names); `README.md` and `README-es.md` embed them. Every one of them is made
by `scripts/capture-screenshots.mjs`; the ones they replaced are kept in [screenshots-archive/](screenshots-archive/),
in a folder named after the month they were taken.

## Conventions

- **Size:** 1440 × 880 px, PNG, device scale factor 1. The ribbon shot is the ribbon and the tab strip only.
- **Both languages:** every screenshot exists twice. Language and theme come from `settings.json` in the app's user
  data folder: `{ "locale": "en" | "es", "theme": "white" }` (see the top of `src/main/main.cjs`). The script starts
  the app with `--user-data-dir=<a temporary folder>`, so the real settings are untouched.
- **Theme:** `white`, except the themes shot.
- **Mouse pointer and caret:** not captured. Shots go through the DevTools protocol, and the pointer is parked at the
  right edge before each one so nothing shows a hover state.

## Running it

```bash
node scripts/capture-screenshots.mjs              # every shot, both languages
node scripts/capture-screenshots.mjs shop         # one shot or group
node scripts/capture-screenshots.mjs --lang es    # one language
```

Shots whose server is not configured are skipped with a message. The environment variables:

| Variables | For | Notes |
| --- | --- | --- |
| `PGERD_TEST_HOST`, `_PORT`, `_USER`, `_PASSWORD` | `shop`, `mysql-copy` | PostgreSQL. For `shop` it needs the `vector` and `age` extensions (an image built from `apache/age` with pgvector added works). The shots **drop and recreate** the `shopdb` and `shop_copy` databases |
| `PGERD_DEMO_DIR` | `shop` | Folder for the demo project (the sample diagram and three scripts); it is emptied first. Its path shows in the status bar, so pick a short one such as `D:\demo\shop`. Default: `<temp>/pgsql-erd-demo/shop` |
| `PGERD_MSSQL_HOST`, `_PORT`, `_USER`, `_PASSWORD` | `mssql-import` | SQL Server, e.g. `mcr.microsoft.com/mssql/server:2022-latest` |
| `PGERD_MYSQL_HOST`, `_PORT`, `_USER`, `_PASSWORD` | `mysql-copy` | MySQL, containers as in `tests/copy.integration.test.js` |
| `PGERD_ORACLE_HOST`, `_PORT`, `_SERVICE`, `_USER`, `_PASSWORD` | `oracle-import` | An Oracle schema with tables, such as the one `tests/copy.integration.test.js` leaves |

The November 2026 shots used a throw-away PostgreSQL 15 container with AGE 1.6 and pgvector 0.8 on port 55432:

```bash
docker run -d --name pgerd-shots -e POSTGRES_PASSWORD=pgerd_shots -p 55432:5432 <image with age and vector>
PGERD_TEST_HOST=127.0.0.1 PGERD_TEST_PORT=55432 PGERD_TEST_PASSWORD=pgerd_shots PGERD_DEMO_DIR='D:\demo\shop' \
  node scripts/capture-screenshots.mjs themes shop
```

## How the script works

It starts Electron with `--remote-debugging-port=9333`, connects to the window over the Chrome DevTools protocol
(Node's built-in `fetch` and `WebSocket`, no dependencies), sets the viewport to 1440 × 880, runs the steps of a shot
and calls `Page.captureScreenshot`. There are three kinds of entries:

- `SHOTS`: run one after another in one window that starts empty (`ef-import`, `sqlite-import`, `mssql-import`,
  `mysql-copy`, `oracle-import`).
- `OWN_APP_SHOTS`: start their own windows. `shop` opens the demo project's diagram and takes every shot of the shop
  database in one session; `themes` starts the app once per theme.

A shot gets these helpers:

| Helper | What it does |
| --- | --- |
| `eval(js)`, `val(js)` | Run JavaScript in the page; `val` returns the value |
| `click(at, clicks)`, `drag(from, to)`, `key(...)`, `type(text)` | Real mouse and keyboard input. `at` is `{ x, y }` or a page expression that returns an element, whose centre is used |
| `shot(file, clip?)`, `capture(clip?)`, `write(file, base64)` | Take a screenshot to a file, or as base64 to compose |
| `wait(ms)`, `send(method, params)`, `tmp` | Sleep, a raw DevTools protocol call, a scratch folder |

The page gets `window.__s` (`PAGE_LIB` in the script): `__s.cmd(name)` runs a ribbon command (a hidden button with
`data-cmd`, as the ribbon does), `__s.table(name)` / `__s.header(name)` / `__s.row(table, column)` find the diagram's
SVG elements, `__s.treeTable('schema.table')` a table of the explorer, `__s.drop(name, text)` drops a file on the
window and `__s.text(selector, text)` / `__s.all(selector)` find visible elements.

Things learned while building it:

- Electron needs `--user-data-dir` to a fresh folder, otherwise it joins the running app through the single-instance
  lock.
- The first screenshot needs about 1.5 s after the window appears (2.5 s when it opens a diagram).
- The language and the theme are read at start-up, so each needs its own app start.
- Native file dialogs cannot be automated: feed files in by dispatching a `drop` event with a `DataTransfer` that holds
  `File` objects (`.pgerd`, spreadsheets, `.sql`, `.cs`, `.json`). A dropped `.sql` file opens a Query tab. A SQLite
  database is read by its path, which a `File` made in the page does not have: fill a file input with
  `DOM.setFileInputFiles` and drop that file.
- A native message box (`host.confirm`, e.g. *The script has type errors. Run anyway?* or *Save changes?*) blocks the
  main process, and with it the DevTools endpoint: the script hangs. Make sure the demo scripts type-check and nothing
  is left unsaved before switching scripts.
- Tables added from the explorer by double-click land on top of each other: run `auto-layout` before `fit`.
- The Graph explorer needs a few seconds for the force layout to settle before **Fit**.
- Close the dialog a shot opened so the next shot starts clean, and look at the PNGs afterwards.

## The shots

| File | What it shows | Shot |
| --- | --- | --- |
| `diagram.png` | The sample diagram, connected to `shopdb`, with the explorer open and `customer` expanded | `shop` |
| `ribbon.png` | The ribbon and the tab strip (a crop of the same window) | `shop` |
| `db-explorer.png` | The explorer with `customer`, `orders` and `product_embedding` open | `shop` |
| `db-import.png` | Import from Database with `supplier` and `warehouse` ticked | `shop` |
| `db-compare.png` | Compare: the database's `customer`, `orders` and `order_item` differ from the diagram on purpose | `shop` |
| `table-sidebar.png` | `customer` selected, its `email` column open in the sidebar | `shop` |
| `relationship.png` | New relationship, after dragging from `orders.customer_id`'s handle onto `customer.id` | `shop` |
| `sql-preview.png` | The SQL preview panel | `shop` |
| `scripts.png` | The `orders-have-items` validator after a dry run, its first error clicked | `shop` |
| `commit-review.png` | The `test-customers` generator after **Run**, waiting for its commit (then discarded) | `shop` |
| `scripts-in-diagram.png` | The three scripts beside the tables they use, with their last runs | `shop` |
| `pgvector-column.png` | A new diagram with `shop.product` and `shop.product_embedding`, the `embedding` column open | `shop` |
| `query-plan.png` | Explain analyze of a join over orders, customers and items | `shop` |
| `pgvector-query-plan.png` | Explain analyze of a nearest-neighbour search, with the HNSW suggestion | `shop` |
| `query-builder.png` | Builder with four tables joined and seven columns ticked | `shop` |
| `data-filter.png` | Data tab on `shop.orders`, the `status` filter menu open with two values unticked | `shop` |
| `age-relationships.png`, `age-explorer.png` | The `social` graph: its relationships, then the explorer with `Ana` selected | `shop` |
| `themes.png` | White, Dark, Visual Studio and Windows ME, 2 × 2 at half size with their names, drawn on a canvas in the page | `themes` |
| `ef-import.png` | Import dialog on `docs/examples/ShopContext.cs` | `ef-import` |
| `sqlite-import.png` | Import dialog on a SQLite database made with `node:sqlite` (Node 22.5 or later) | `sqlite-import` |
| `mssql-connect.png`, `mssql-import.png` | The SQL Server connection dialog, then the import dialog on `ShopDemo` | `mssql-import` |
| `mysql-connect.png`, `mysql-import.png`, `copy-rows.png`, `import-db-source.png` | The MySQL connection dialog; the import dialog with **Copy rows** checked; the finished copy into PostgreSQL; the Import Designer with that database open | `mysql-copy` |
| `oracle-import.png` | Import dialog on an Oracle schema (run after `mysql-copy`, so its tables show as updates) | `oracle-import` |

The `shop` database is created by the script (`SHOPDB`): the sample diagram's tables, with `customer.email` shorter,
`customer.full_name` nullable, an extra `legacy_code` column, no default on `orders.status` and no `unit_price` in
`order_item`, so Compare has something to list; `audit_log`, `coupon`, `supplier` and `warehouse` that the diagram does
not have; 240 customers, 2,000 products, 1,200 orders (three of them without items, for the validator); 2,000 random
384-dimension embeddings; and an AGE graph `social` of six people, two companies and two projects.

The Assistant shot is not retaken: the feature is disabled (see [ai-assistant.md](ai-assistant.md)). The last one is
in `screenshots-archive/2026-10/assistant.png`.
