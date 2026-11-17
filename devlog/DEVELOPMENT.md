# Development

**English** · [Español](DEVELOPMENT-es.md)

For people working on pgsql-erd itself: running and testing it, building installers, adding a language and where the
code lives. What the app does is in the [README](../README.md). Other notes in this folder:

- [screenshots.md](screenshots.md): how the README screenshots are taken, and
  [screenshots-archive/](screenshots-archive/) with the ones they replaced
- [pgerd-format.md](pgerd-format.md): the `.pgerd` file format and how the app reads and writes it
- [ai-assistant.md](ai-assistant.md): the AI assistant, which is disabled in this build
- [import-blocks.md](import-blocks.md): how the Import designer's blocks are made
- [excel_postgresql_import_designer_plan.md](excel_postgresql_import_designer_plan.md): the original plan of the Import
  designer

## Where things go

- **README.md / README-es.md** are for people who use the app: what it does and how, with screenshots. Keep both
  languages in step.
- **devlog/** is for people (and agents) who work on the code: building, testing, conventions, the project layout,
  file formats, design notes and plans, how the screenshots are taken, and the archive of old screenshots. New
  technical notes go here, not in the README.
- **docs/** holds what the app publishes: the README screenshots, the import template spec, its JSON Schema and the
  examples.

## Coding conventions

- **Modules:** the Electron main process and the script runner are CommonJS (`.cjs`); the page (`src/renderer/`)
  and `src/shared/` are ES modules, and the main process loads the shared ones asynchronously.
- **Process boundaries:** the page runs sandboxed with context isolation and no Node integration. File access,
  database calls and credentials go through the preload bridge (`src/main/preload.cjs`); passwords and keys never
  reach the page.
- **Interface text:** every string a person sees goes through `tr()` / `trn()` (`src/shared/i18n.js`) and needs a
  translation in each catalog of `src/shared/locales/`; `tests/i18n.test.js` fails until it has one.
- **Database work:** send values as query parameters, never spliced into SQL. Anything that writes checks the
  connection's policy (writes, schema changes, environment) and is recorded in the audit log.
- **Imports from other databases** read their catalog only and turn it into table specs in `src/renderer/lib/*import.js`;
  foreign key columns take the type of the column they reference (`fktypes.js`).
- **Tests:** `node:test` suites in `tests/`. Unit tests run with `npm test`; integration tests run against real
  servers when their `PGERD_*` variables are set and are skipped otherwise.
- **Icons:** `src/renderer/icons.js`; run `npm run menu-icons` after changing them.
- **Screenshots:** add or change a shot in `scripts/capture-screenshots.mjs` rather than taking it by hand, and
  move the images it replaces to `devlog/screenshots-archive/<year>-<month>/` (see [screenshots.md](screenshots.md)).

## Running and testing

```bash
npm install
npm start                          # empty diagram
npm start -- samples/shop.pgerd    # open a file
npm test                           # unit tests
# integration tests against a real server (creates and drops temporary databases):
PGERD_TEST_HOST=127.0.0.1 PGERD_TEST_PORT=5432 PGERD_TEST_USER=postgres PGERD_TEST_PASSWORD=… npm test
```

Icons live in `src/renderer/icons.js`. After changing them, run `npm run menu-icons` to re-render
the PNG icons of the native menus into `src/main/menu-icons/`.

To build installers (AppImage/deb, NSIS, dmg) with the `.pgerd` file association:

```bash
npm run dist
```

### Windows (.exe)

On Windows, with Node.js 20+ installed, run from the repository root:

```bat
scripts\build-windows.bat
```

It is a plain batch file, so it runs from Command Prompt or by double-clicking, without changing the
PowerShell execution policy.

This installs dependencies, runs the tests and writes to `dist\`:

| File | What it is |
| --- | --- |
| `pgsql-erd-Setup-<version>.exe` | Installer: choose the install folder, adds Start menu and desktop shortcuts, registers `.pgerd` files |
| `pgsql-erd-<version>-portable.exe` | Single executable that runs without installing |
| `win-unpacked\pgsql-erd.exe` | The unpacked app the other two are made from |

To build only one target, pass `installer`, `portable` or `dir` (default `all`), e.g.
`scripts\build-windows.bat portable`. Options: `--skip-tests`, `--skip-install`, `--clean` (delete
`dist\` first). The same builds are available as npm scripts:
`npm run dist:win` (installer + portable), `dist:win:installer`, `dist:win:portable` and `dist:win:dir`.

The app, installer and uninstaller use `build/icon.ico`. The executables are unsigned, so Windows SmartScreen warns the first time they run. Building them on
Linux or macOS also works but needs [Wine](https://www.winehq.org/) (with 32-bit support for the
installer).

## Project layout

```
src/main/main.cjs         Electron main process: windows, menus, file dialogs, file I/O
src/main/db.cjs           PostgreSQL connection, catalog introspection, migration execution (pg)
src/main/preload.cjs      contextBridge API exposed to the renderer (window.erdHost)
src/main/ipc/             IPC for connections, scripts, queries, data tabs, the assistant, the audit log
src/main/database/        per-window connections and policies, query tab runner, data browser queries,
                          Apache AGE graphs (age.cjs)
src/main/scripting/       type checking and transpiling (TypeScript), script runs, the script-side database API
src/main/ai/              providers (Ollama, OpenAI-compatible, OpenAI), keys, tools, structured output
src/main/projects/        scripts and settings in the project folder
src/runner/               the isolated script process
src/shared/               schema model, typings generator, permissions, context builder, JSON schema,
                          fake data, plan analyzer, pgvector and Apache AGE helpers (used by the main
                          process, the runner and the page)
src/shared/i18n.js        translations: tr(), trn(), locale selection
src/shared/locales/       translation catalogs (es.js)
src/renderer/index.html   UI shell
src/renderer/app.js       rendering, interaction, properties panel, commands
src/renderer/dbui.js      connect / import / compare dialogs
src/renderer/tabs.js      main tabs
src/renderer/workbench.js Scripts tab
src/renderer/query.js     Query tab
src/renderer/querybuilder.js Builder tab (visual query builder)
src/renderer/dbtree.js    database explorer
src/renderer/graph.js     Graph tab (Apache AGE)
src/renderer/databrowser.js data tabs and filters
src/renderer/assistant.js Assistant tab and AI provider settings (disabled, see ai-assistant.md)
src/renderer/xlui.js      Excel / CSV, Entity Framework / JSON, SQLite and SQL Server import dialog
src/renderer/importdesigner.js Import tabs (Excel -> PostgreSQL import designer)
src/renderer/lib/pgerd.js .pgerd parsing and serialization
src/renderer/lib/efimport.js Entity Framework Core (C#) and JSON readers for the import dialog
src/renderer/lib/sqliteimport.js SQLite catalog -> table specs for the import dialog
src/main/database/sqlite.cjs reads the schema of a SQLite file (node:sqlite, read-only)
src/renderer/lib/mssqlimport.js SQL Server catalog and T-SQL script parser -> table specs for the import dialog
src/main/database/mssql.cjs reads the schema of a SQL Server database (mssql / tedious, read-only)
src/renderer/lib/mysqlimport.js MySQL / MariaDB catalog -> table specs for the import dialog
src/shared/mysql-dump.js  MySQL dump reader: statements, CREATE TABLE, INSERT rows
src/main/database/mysql.cjs reads the schema of a MySQL / MariaDB database (mysql2, read-only)
src/renderer/lib/oracleimport.js Oracle catalog -> table specs for the import dialog
src/main/database/oracle.cjs reads the schema of an Oracle schema (node-oracledb Thin mode, read-only)
src/renderer/lib/fktypes.js foreign key columns take their referenced column's type
src/renderer/copyui.js    "Copy rows": the option of the import dialog and its progress
src/main/database/data-copy.cjs copies rows from MySQL, SQL Server, Oracle, SQLite or a dump into PostgreSQL
src/main/database/source-sheets.cjs database tables as worksheets for the Import Designer
src/renderer/lib/sql.js   PostgreSQL DDL generation
src/renderer/lib/layout.js table geometry, relationship routing, auto layout
src/renderer/lib/catalog.js catalog rows -> diagram model
src/renderer/lib/diff.js  database vs diagram comparison and migration SQL
src/renderer/lib/sync.js  import / update diagram tables from the database
src/renderer/lib/spreadsheet.js .xlsx / CSV reading and sheet -> table conversion
src/renderer/lib/highlight.js SQL syntax highlighting
src/renderer/lib/querybuilder.js query builder joins and SELECT generation
samples/shop.pgerd        example diagram
build/icon.svg            app icon source; icon.ico (Windows) and icon.png are rendered from it
scripts/build-windows.bat Windows build script
scripts/capture-screenshots.mjs retakes the README screenshots (see devlog/screenshots.md)
tests/                    node:test suites
```

The renderer runs sandboxed with context isolation and no Node integration. All file access goes
through the preload bridge.

A project folder looks like this; everything is plain text, and no passwords or API keys are stored in it:

```
project/
├── diagram.pgerd
├── pgsql-erd.json            project settings (assistant provider, model, permissions)
├── scripts/
│   ├── validators/*.ts
│   ├── generators/*.ts
│   └── migrations/*.ts
└── generated/database.d.ts   typings for other editors
```


## Adding a language

The English text is the key: code calls `tr('Save')` or `trn(n, '{n} table', '{n} tables')`
(`src/shared/i18n.js`), and the static page is translated from its text when it loads. To add a language:

1. Copy `src/shared/locales/es.js` to `src/shared/locales/<code>.js` and translate the values. Keep the
   `{placeholders}` and any leading or trailing spaces.
2. Import it in `src/shared/i18n.js` and add it to `CATALOGS` and `LOCALES` (the name shown in
   View → Language, in its own language).
3. Add it to `CATALOGS` in `tests/i18n.test.js` and run `npm test`. The test lists every string used in the
   code or the page that is missing from the catalog, entries that are no longer used, and translations whose
   placeholders don't match.

New interface text goes through `tr()` / `trn()` in the same way; the test fails until each catalog has it.
