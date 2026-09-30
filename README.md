# pgsql-erd

A desktop ERD (entity–relationship diagram) tool for PostgreSQL, built with Node.js and Electron.
It opens and saves **pgAdmin 4 `.pgerd` files**, so diagrams can move back and forth between
pgAdmin's ERD tool and this app.

## Features

- Open `.pgerd` files from **File → Open**, by dragging them onto the window, from the command
  line (`npm start -- path/to/file.pgerd`), or by double-clicking them once the app is installed
  (the packaged app registers the `.pgerd` file type).
- Draws tables with columns, types, primary keys (PK) and foreign keys (FK). Relationships use
  crow's-foot notation.
- Editing:
  - add, rename and delete tables
  - edit columns: name, type, length/scale, NOT NULL, PK, default value, order
  - set schema, comment, note and header colour
  - add and remove relationships, optionally creating the FK column for you
- Drag tables to move them (snaps to the grid; hold <kbd>Alt</kbd> for free placement). Drag the
  background to pan, scroll to zoom, and use **Fit** or **Auto layout** to tidy up.
- Undo/redo, and a prompt about unsaved changes when you close the window.
- Save back to `.pgerd`. Properties this app doesn't edit (tablespace, check constraints, and so
  on) are kept as they were.
- Live SQL preview, and export to PostgreSQL DDL (`CREATE TABLE`, primary keys, unique
  constraints, foreign keys, comments), SVG or PNG.
- Follows the system's light or dark theme.

## Getting started

```bash
npm install
npm start                          # empty diagram
npm start -- samples/shop.pgerd    # open a file
npm test                           # parser / SQL / layout tests
```

To build installers (AppImage/deb, NSIS, dmg) with the `.pgerd` file association:

```bash
npm run dist
```

## Project layout

```
src/main/main.cjs         Electron main process: windows, menus, file dialogs, file I/O
src/main/preload.cjs      contextBridge API exposed to the renderer (window.erdHost)
src/renderer/index.html   UI shell
src/renderer/app.js       rendering, interaction, properties panel, commands
src/renderer/lib/pgerd.js .pgerd parsing and serialization
src/renderer/lib/sql.js   PostgreSQL DDL generation
src/renderer/lib/layout.js table geometry, relationship routing, auto layout
samples/shop.pgerd        example diagram
tests/                    node:test suites
```

The renderer runs sandboxed with context isolation and no Node integration. All file access goes
through the preload bridge.

## The .pgerd format

A `.pgerd` file is pgAdmin's serialized react-diagrams model:

```json
{
  "version": 80900,
  "data": {
    "offsetX": 0, "offsetY": 0, "zoom": 100, "gridSize": 15,
    "layers": [
      { "type": "diagram-links", "models": { "<link id>": { "data": {
          "local_table_uuid": "…", "local_column_attnum": 1,
          "referenced_table_uuid": "…", "referenced_column_attnum": 0 } } } },
      { "type": "diagram-nodes", "models": { "<table id>": {
          "type": "table", "x": 40, "y": 40,
          "otherInfo": { "note": "", "data": {
            "name": "orders", "schema": "public",
            "columns": [{ "name": "id", "cltype": "bigint", "attnum": 0, "is_primary_key": true }],
            "primary_key": [{ "columns": [{ "column": "id" }] }],
            "foreign_key": [{ "name": "…", "columns": [{ "local_column": "customer_id",
              "references": "<table id>", "referenced": "id" }] }] } } } } }
    ]
  }
}
```

The app reads relationships from each table's `foreign_key` list and from the links layer. When
saving, it rebuilds both, together with the ports pgAdmin uses to attach links to columns.
