# pgsql-erd

**English** · [Español](README-es.md)

A desktop ERD (entity–relationship diagram) tool and database workbench for PostgreSQL, built with
Node.js and Electron. It opens and saves **pgAdmin 4 `.pgerd` files**, so diagrams can move back and
forth between pgAdmin's ERD tool and this app, and adds schema-aware TypeScript scripts (validators,
test-data generators, migrations) with dry runs, a query analyzer, a data browser with Excel-style
filters, Apache AGE graphs, and imports from Excel, Entity Framework, SQLite, SQL Server, MySQL / MariaDB
and Oracle that can also copy the rows into PostgreSQL.

![Diagram](docs/screenshots/diagram.png)

## Screenshots

### Ribbon and tabs

Commands are grouped Office-style (File: Open, Save, Save As…; Database: Connect, Explorer, Import Excel,
Import designer) with two-tone colour icons; the native menus use the same icons. Below the ribbon are the
tabs: a window starts with one diagram, and the **+ Diagram**, **+ Scripts**, **+ Query**, **+ Builder**,
**+ Import**, **+ Graph** and **+ Data** buttons open as many more as you like (**+ Diagram** is also
<kbd>Ctrl</kbd>+<kbd>N</kbd>). Opening a `.pgerd` file shows it in a diagram tab of its own (or the
empty one you started with). **Save** and **Save As…** work on the tab in front: a diagram saves its
`.pgerd` (Save As can also write SQL, SVG or PNG), Query and Builder tabs save their SQL to a `.sql`
file, a Scripts tab saves its script to the project (Save As writes its code to a `.ts` file) and a
Graph tab saves its Cypher query to a `.cypher` file. The Diagram tab has its own toolbar: **Undo**, **Redo**, **Tables**, **Table**, **Relationship**, **Delete**,
**SQL Preview**, **Import from Database…** and **Compare**.

![Ribbon](docs/screenshots/ribbon.png)

### Table sidebar

Select a table to see and edit its properties, columns and relationships. Clicking a column in the diagram opens its editor.

![Table sidebar](docs/screenshots/table-sidebar.png)

### SQL preview

Live PostgreSQL DDL with syntax highlighting.

![SQL preview](docs/screenshots/sql-preview.png)

### Relationships

Add a foreign key, optionally creating the column. Drag from a column's handle (the foreign key) onto a column of another table (the referenced one) to open the dialog with both filled in.

![New relationship](docs/screenshots/relationship.png)

### Themes

White, Dark, Visual Studio and Windows ME in **View → Theme**, or follow the system.

![Themes](docs/screenshots/themes.png)

### Database explorer

The connected database's schemas, tables and columns; drag or double-click a table to add it to the diagram.

![Database explorer](docs/screenshots/db-explorer.png)

### Query builder

Add tables from the explorer and tick columns; related tables are joined automatically.

![Query builder](docs/screenshots/query-builder.png)

### Import from database

Pick tables to add, or refresh the ones already in the diagram.

![Import tables](docs/screenshots/db-import.png)

### Import from Entity Framework / JSON

Read the entity classes and `DbContext` of an EF Core model (or a JSON description) and add its tables to the diagram.

![Import from Entity Framework](docs/screenshots/ef-import.png)

### Import from SQLite

Read the tables of a SQLite database file and add them to the diagram as PostgreSQL tables.

![Import from SQLite](docs/screenshots/sqlite-import.png)

### Import from SQL Server

Read the tables of a Microsoft SQL Server database, or of a T-SQL script, and add them to the diagram as PostgreSQL tables.

![Connect to SQL Server](docs/screenshots/mssql-connect.png)

![Import from SQL Server](docs/screenshots/mssql-import.png)

### Import from MySQL / MariaDB and Oracle, and copy the rows

Read the tables of a MySQL or MariaDB database (or a `mysqldump` file) or of an Oracle schema, add them to the diagram,
and copy their rows into the connected PostgreSQL database in one transaction. The same copy works from SQL Server and
SQLite.

![Import from MySQL](docs/screenshots/mysql-import.png)

![Copy rows](docs/screenshots/copy-rows.png)

![Import from Oracle](docs/screenshots/oracle-import.png)

### Compare / sync

Differences with the database and the migration SQL.

![Compare with database](docs/screenshots/db-compare.png)

### Scripts

Typed TypeScript validators; clicking an error shows the row.

![Scripts](docs/screenshots/scripts.png)

### Commit review

A run's changes wait in an open transaction until you commit.

![Commit review](docs/screenshots/commit-review.png)

### Query analyzer

EXPLAIN ANALYZE as a tree, with time per node and index hints.

![Query plan](docs/screenshots/query-plan.png)

### Data tabs

Excel-style filters with value lists, blanks and conditions.

![Data filter](docs/screenshots/data-filter.png)

### Scripts in the diagram

Each script linked to the tables it uses, with its last run.

![Scripts in the diagram](docs/screenshots/scripts-in-diagram.png)

### pgvector columns

The dimensions and a ready-to-copy HNSW index for similarity search.

![pgvector column](docs/screenshots/pgvector-column.png)

### pgvector queries

Nearest-neighbour searches that scan every row get an HNSW index suggestion.

![pgvector query plan](docs/screenshots/pgvector-query-plan.png)

### Apache AGE relationships

Every edge of a graph, filterable, searchable and editable in place.

![AGE relationships](docs/screenshots/age-relationships.png)

### Graph explorer

A force-directed view; double-click a vertex to expand its neighbours.

![AGE graph explorer](docs/screenshots/age-explorer.png)

## Features

- Open `.pgerd` files from **File → Open**, by dragging them onto the window, from the command
  line (`npm start -- path/to/file.pgerd`), or by double-clicking them once the app is installed
  (the packaged app registers the `.pgerd` file type). The last 10 diagrams opened or saved are in
  **File → Open Recent** and on the start screen of an empty diagram.
- Draws tables with columns, types, primary keys (key icon) and foreign keys (link icon). Relationships use
  crow's-foot notation.
- A sidebar opens when you select a table. It shows:
  - the table's name, schema and column count
  - its properties (name, schema, comment, note, header colour, primary key)
  - its columns, with PK/FK icons and NOT NULL and default markers; click one to edit it
  - its relationships, in both directions

  Click a column in the diagram to jump to it. Drag the sidebar's edge to resize it, and press
  <kbd>Esc</kbd> or × to close it. **Tables** in the ribbon shows a filterable list of all tables.
- Editing:
  - add, rename and delete tables
  - edit columns: name, type, length/scale, NOT NULL, PK, default value, order
  - set schema, comment, note and header colour
  - add and remove relationships, optionally creating the FK column for you
- Drag a table by its title bar to move it, and by its bottom right corner to resize it
  (double-click the corner to fit it to its content again). <kbd>Ctrl</kbd>+click tables to select several, or hold <kbd>Shift</kbd>
  and drag a rectangle to select the tables it touches (<kbd>Ctrl</kbd>+<kbd>Shift</kbd> adds them to the
  selection); the selected tables are dragged, nudged with the arrow keys and deleted together, and
  the sidebar sets their schema and header colour at once with **Apply**.
  Drag the background to pan and scroll to zoom. The status bar holds the
  view controls, as in Word: a zoom slider (100% in the middle) with zoom out/in buttons and the
  zoom level, plus **Fit** and **Auto layout** to tidy up, and the grid controls.
- Copy tables with <kbd>Ctrl</kbd>+<kbd>C</kbd> or **Copy table** in their context menu, and paste them
  with <kbd>Ctrl</kbd>+<kbd>V</kbd> or **Paste table here** on the background, also into another diagram.
  Pasting one table asks for its name and schema (empty means `public`, and existing schemas are
  suggested) and won't paste over a table of the same name; pasting several asks for the schema
  and gives a `_copy` suffix to names already taken there. Foreign keys between the copied tables
  point at the new copies; foreign keys to tables that weren't copied are left out.
- A grid is drawn behind the diagram (grid button in the status bar, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>), with a
  heavier line every fifth cell. With **Snap** on (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>),
  dragged tables, arrow-key nudges, new tables and auto layout all land on grid lines; hold
  <kbd>Alt</kbd> while dragging to invert snapping for that move, and <kbd>Shift</kbd>+arrow nudges
  by 1px. The grid size is picked in the list next to the Snap button and saved in the file's `gridSize`.
- Undo/redo, and a prompt about unsaved changes when you close the window.
- Save back to `.pgerd`. Properties this app doesn't edit (tablespace, check constraints, and so
  on) are kept as they were.
- Import tables from **Excel (`.xlsx`/`.xlsm`) or CSV** with **File → Import from Excel / CSV**
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>), **Import Excel** in the ribbon's Database group, or by dropping the file on the window.
  Each sheet is read in one of two layouts:
  - **Column definitions:** a header row with *Column* and *Type* (plus any of *Table, Schema, Length, Scale,
    Nullable / Not null, PK, Unique, Default, References, Comment*), one row per column. A *Table* column splits
    the sheet into several tables (a blank cell continues the table above); *References* takes `table.column`,
    `schema.table.column` or `table(column)` and becomes a foreign key. Common type spellings (`varchar(50)`,
    `int`, `decimal(10,2)`, `datetime`, …) are mapped to PostgreSQL types. English and Spanish headers are recognised.
  - **Data:** the first row names the columns and the rows below are data. Types (integer, bigint, numeric,
    boolean, date, timestamp, time, uuid, jsonb, text) are inferred from the values, and an `id` column with
    unique values becomes the primary key.

  The dialog lets you pick and rename the tables, set the schema and preview the SQL. Names are converted to
  snake_case unless you turn that off. Tables already in the diagram are updated and keep their position.
  Old `.xls` files are not supported; save them as `.xlsx` first.
- Import tables from **Entity Framework Core classes or JSON** with **File → Import from Entity Framework / JSON…**, or by
  dropping `.cs` files on the window. Choose the entity classes and the `DbContext` together; they are read as text, nothing is compiled:
  - **Entities:** public properties (including inherited ones) become columns. `DbSet` names, `[Table]`, `[Column]`,
    `[Key]`, `[PrimaryKey]`, `[Required]`, `[MaxLength]`, `[StringLength]`, `[Precision]`, `[Index]`, `[Comment]`,
    `[DatabaseGenerated]` and `[NotMapped]` are honoured, and `int`/`long` keys become `serial`/`bigserial`.
  - **Fluent API:** `OnModelCreating` and `IEntityTypeConfiguration<T>` are read for `HasDefaultSchema`, `ToTable`, `HasKey`,
    `Property(...)` (`HasColumnName`, `HasMaxLength`, `IsRequired`, `HasColumnType`, `HasPrecision`, `HasDefaultValue`, `HasDefaultValueSql`),
    `HasIndex().IsUnique()`, `Ignore` and `HasOne`/`HasMany`/`WithOne`/`WithMany`/`HasForeignKey`/`HasPrincipalKey`.
  - **Relationships:** foreign keys come from the fluent API, `[ForeignKey]` or EF's naming conventions (a shadow column when
    there is no key property); two collections that point at each other get a join table. Classes derived from another
    entity share its table with a `discriminator` column. Owned types and value conversions are not followed.
  - **JSON:** `{ "schema": "app", "tables": [{ "name": "person", "columns": [{ "name": "id", "type": "serial", "pk": true }, { "name": "boss_id", "type": "int", "references": "person.id" }] }] }`.
    Columns take `type`, `length`, `precision`/`scale`, `nullable` or `notNull`, `pk`, `unique`, `default`, `description` and
    `references` (`table.column` or `schema.table.column`); a table may also list `primaryKey` and `foreignKeys`.
  - The same dialog as the Excel import lets you pick and rename the tables and preview the SQL. A sample is in
    [docs/examples/ShopContext.cs](docs/examples/ShopContext.cs).
- Import tables from a **SQLite database** with **File → Import from SQLite Database…**, or by dropping a `.db`, `.sqlite`,
  `.sqlite3`, `.db3`, `.s3db` or `.sl3` file on the window. The file is opened read-only and only its schema is read; no
  rows are copied:
  - Declared types become PostgreSQL types (`DATETIME` → `timestamp`, `BLOB` → `bytea`, `REAL` → `double precision`,
    `VARCHAR(100)`, `DECIMAL(10,2)` and so on). A type PostgreSQL does not have is replaced by the one for its SQLite
    affinity, and a column without a type becomes `text`. An `INTEGER PRIMARY KEY` becomes `serial`.
  - Primary keys, `NOT NULL`, single-column `UNIQUE` constraints and unique indexes, and foreign keys are kept.
  - Defaults are translated (`datetime('now')` → `CURRENT_TIMESTAMP`, `1` → `true` on a boolean column); a default that calls
    a function only SQLite has is dropped.
  - Views, virtual tables, `CHECK` constraints, multi-column unique constraints and non-unique indexes are not imported.
  - The same dialog as the Excel import lets you pick and rename the tables, set the schema and preview the SQL.
- Import tables from **Microsoft SQL Server** (2008 or later, Azure SQL Database included):
  - **File → Import from SQL Server Database…** asks for the server (`host`, `host\instance` or `host` and a port), the
    database and a SQL Server login or a Windows account (NTLM: user, password and domain), with encryption on by default
    and an option to trust a self-signed certificate. Only the catalog views are read; nothing is written and no rows
    are copied. The settings but the password are remembered for the next time.
  - **File → Import from SQL Server Script…** reads a `.sql` file instead, such as the one SQL Server Management Studio
    writes with *Script Table as → CREATE To* or *Generate Scripts* (UTF-8 or UTF-16). `CREATE TABLE` with inline and table
    constraints, `ALTER TABLE … ADD` (constraints, `DEFAULT … FOR`, columns), `ALTER TABLE … DROP COLUMN`,
    `CREATE UNIQUE INDEX`, alias types (`CREATE TYPE … FROM`) and `sp_addextendedproperty` descriptions are understood;
    other statements are skipped. The script is not run.
  - Types become their PostgreSQL equivalents: `nvarchar(50)` → `character varying(50)`, `nvarchar(max)` → `text`,
    `datetime` / `datetime2` → `timestamp`, `datetimeoffset` → `timestamp with time zone`, `bit` → `boolean`,
    `uniqueidentifier` → `uuid`, `money` → `numeric(19,4)`, `varbinary` / `image` / `rowversion` → `bytea`,
    `tinyint` → `smallint`; `sql_variant` and `hierarchyid` become `text`. An `IDENTITY` column of an integer type becomes
    `serial`, `bigserial` or `smallserial`.
  - Primary keys, `NOT NULL`, single-column unique constraints and unique indexes (not filtered ones), foreign keys and
    `MS_Description` comments are kept. Defaults are translated (`getdate()` / `sysdatetime()` → `CURRENT_TIMESTAMP`,
    `newid()` → `gen_random_uuid()`, `N'…'` → `'…'`, `((1))` → `true` on a `bit` column); one that calls another function
    is dropped.
  - Tables of the `dbo` schema go to the schema set in the dialog; other schemas keep their name (in snake_case when names
    are converted).
  - Views, computed column expressions (the column is kept), `CHECK` constraints, foreign key actions, multi-column unique
    constraints and non-unique indexes are not imported.
- Import tables from **MySQL** (5.7 or later) and **MariaDB** (10.2 or later):
  - **File → Import from MySQL / MariaDB Database…** asks for the host, port, database, user, password and SSL mode
    (off, required without a certificate check, or verified). Only `information_schema` is read.
  - **File → Import from MySQL / MariaDB Dump…** reads a `.sql` file written by `mysqldump`, `mariadb-dump` or
    `SHOW CREATE TABLE`: its `CREATE TABLE` statements give the tables, and its `INSERT` statements are the rows that
    **Copy rows** copies (below). A dump of several databases (`USE` before each) keeps each one as a schema. The dump is
    not run.
  - Types: `tinyint(1)` → `boolean`, `int unsigned` → `bigint`, `bigint unsigned` → `numeric(20,0)`, `datetime` →
    `timestamp`, `timestamp` → `timestamp with time zone` (MySQL stores it in UTC), `enum` / `set` → `text`, `blob` →
    `bytea`, `json` → `jsonb` (MariaDB's JSON, a `LONGTEXT` with a `json_valid` check, too), `year` → `smallint`,
    `bit(1)` → `boolean`, spatial types → `geometry` (needs PostGIS). An `AUTO_INCREMENT` integer becomes a serial type.
  - Primary keys, `NOT NULL`, single-column unique keys (not prefix or functional ones), foreign keys and comments are
    kept. Defaults are translated (`CURRENT_TIMESTAMP(3)`, `now()` → `CURRENT_TIMESTAMP`, `uuid()` →
    `gen_random_uuid()`, `'1'` → `true` on a boolean, `b'0'` → `false`).
- Import tables from **Oracle Database** (12.1 or later) with **File → Import from Oracle Database…**: host, port,
  service name, user, password and, optionally, the schema to read (the user's own by default). node-oracledb runs in
  Thin mode, so no Oracle Client is installed. Only the `ALL_*` dictionary views are read.
  - Types: `NUMBER(p)` → `smallint` / `integer` / `bigint` / `numeric(p,0)` by size, `NUMBER(p,s)` → `numeric(p,s)`,
    `NUMBER` → `numeric`, `VARCHAR2` / `NVARCHAR2` → `character varying` (in characters), `CLOB` → `text`, `BLOB` →
    `bytea`, `RAW(16)` → `uuid`, `DATE` → `timestamp(0)` (an Oracle `DATE` has a time), `TIMESTAMP WITH [LOCAL] TIME ZONE`
    → `timestamp with time zone`, `INTERVAL` → `interval`, `XMLTYPE` → `xml`, `JSON` → `jsonb`. An identity column
    becomes a serial type. Upper-case names become snake_case (`CUSTOMER_ID` → `customer_id`).
  - Primary keys, `NOT NULL`, single-column unique constraints and unique indexes, foreign keys (a key to another schema
    points to a schema of that name) and comments are kept; `SYSDATE` / `SYSTIMESTAMP` → `CURRENT_TIMESTAMP`, `SYS_GUID()`
    → `gen_random_uuid()`.
- In every import a foreign key column takes the type of the column it references, so the key can be created.
- **Copy rows**: after tables from MySQL / MariaDB, SQL Server, Oracle, SQLite or a MySQL dump are added to the diagram,
  **Copy the rows into the connected database** creates the missing tables in the connected PostgreSQL database and
  copies every row, optionally emptying the tables first. Everything runs in **one transaction**: the tables are created
  without foreign keys, the rows go in batches with every value sent as a parameter, then the foreign keys are added and
  each serial column's sequence is moved past the copied keys. If anything fails, or you press **Stop**, nothing is
  changed. It needs a connection whose policy allows writes and schema changes, and it is written to the audit log.
  Values arrive unchanged: numbers and decimals as text (no rounding), dates and times by their wall-clock value,
  MySQL's zero dates as `NULL`, binary data as `bytea`, JSON as `jsonb`. The copy is a snapshot, not a running
  replication.
- Live SQL preview (`CREATE TABLE`, primary keys, unique
  constraints, foreign keys, comments), SVG or PNG. **Save As…** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>)
  writes any of these: the file type picked in the dialog (`.pgerd`, `.sql`, `.svg` or `.png`) decides the format.
- An Office-style ribbon with labelled command groups and two-tone colour icons, which the
  native menus and dialogs share.
- Themes in **View → Theme**: White, Dark, Visual Studio (classic Blue) and Windows ME, or follow the system's
  light or dark setting (the default).
- Available in English and Spanish (see [Languages](#languages)).

## Database sync

The **Database** menu (the *Connect* button in the ribbon, and **Import from Database…** and **Compare** on the Diagram tab) works with a live
PostgreSQL 10+ server:

- **Connect:** host, port, database, user, password and SSL mode. Connections can be saved as named
  instances (with their environment and policy) and picked from a list; double-click one to connect.
  Tick **Remember the password** to store it encrypted with the operating system's credential store
  (DPAPI, Keychain, libsecret/kwallet); without a credential store it is kept in memory until the app quits.
  A saved password is only sent to the host, port and user it was saved for. **Reconnect to the last
  instance** reopens the last session when a window opens. Connecting to a different database asks first:
  it closes the diagram (discarding unsaved changes), the data tabs and the query builder, and clears the
  query results.
- **Import tables:** lists every table in the database by schema, with its column count and whether it's
  already in the diagram. Selected tables that are new are added to the diagram with their columns, primary
  keys, unique constraints and foreign keys. Tables already in the diagram are updated from the database;
  their position, colour and note are kept. Serial columns come back as `serial`/`bigserial`.
- **Explorer:** a panel left of the diagram with a tree of the connected database's schemas, tables and
  columns. Drag a table onto the diagram (or double-click it) to add it where it's dropped; its foreign
  keys to and from tables already in the diagram are drawn as relationships. Tables already in the
  diagram are ticked. Toggle the panel with **Explorer** in the Database group. The same panel sits
  beside the query builder in the **Builder** tab.
- **Compare / Sync:** compares the diagram with the database (per schema) and lists every difference:
  - new and dropped tables and columns
  - type, `NOT NULL`, default and identity changes
  - primary keys, unique constraints and foreign keys (including `ON DELETE`/`ON UPDATE` changes)
  - table comments

  Each change has a tick box, so you can leave some out. It then generates the migration SQL that makes the
  database match the diagram. You can copy or save it,
  or run it on the database in a single transaction; if any statement fails, nothing is applied.
  - Statements are ordered so they work: dependent foreign keys are dropped before a key they reference and
    re-created afterwards.
  - Destructive statements (`DROP COLUMN`, `DROP TABLE`) are only included when you tick the matching
    option. Otherwise they appear as comments at the end of the script.
  - A type change converts the values with a cast; **Drop and re-create columns whose type changed** drops the
    column and adds it again instead, for types a cast can't convert (its data is lost and it moves to the end of
    the table).
  - Renamed tables or columns can't be detected: they show up as a drop plus an add.

## pgvector

[pgvector](https://github.com/pgvector/pgvector) columns (`vector`, `halfvec`, `sparsevec`) are supported
throughout:

- **Diagram:** the types are in the column type list, and their length is the number of dimensions
  (`vector(1536)`). The column editor shows the HNSW index for cosine search, ready to copy. Vectors
  with more than 2,000 dimensions get a `halfvec` expression index, which works up to 4,000.
- **SQL export and migrations** add `CREATE EXTENSION IF NOT EXISTS vector;` when the diagram uses vector
  types. Compare / Sync only adds it when the database doesn't have the extension yet.
- **Scripts:** `vector` and `halfvec` values are read as `number[]` and can be written as `number[]`,
  `Float32Array` or pgvector text (`'[1,2,3]'`). `sparsevec` values are strings (`'{1:0.5,3:1}/5'`), and
  you can write them as dense arrays. `where({ embedding: [1, 2, 3] })` compares with one vector.
  `seed.row()` / `seed.fill()` generate random unit vectors, and `seed.check()` checks the dimensions.
- **Query analyzer:** a nearest-neighbour query (`ORDER BY embedding <=> $1 LIMIT n`) that sorts every
  row gets a suggestion for an HNSW index with the operator class for its operator (`<->`, `<=>`, `<#>`,
  `<+>`). It also points out an existing vector index built for a different operator.
- **Data tabs** show long vectors shortened as `[0.1,0.2,…] (1536 dims)`; hover over a cell to see the full value.

## Apache AGE graphs

The **Graph** tab (Database → Graphs, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>) manages
[Apache AGE](https://age.apache.org) property graphs in the connected database:

- **Sidebar:** the database's graphs with their vertex labels and relationship types, and how many
  vertices or relationships each one has. You can create and drop graphs and labels here. If the server has
  AGE available but the database doesn't use it yet, **Install AGE** runs `CREATE EXTENSION age`.
- **Relationships:** every relationship, shown as *from — TYPE → to*. You can filter by type, search
  properties and labels of the relationship and both vertices, and page through the list. **New
  relationship** picks the two vertices by search-as-you-type and sets the type (a new type is created
  automatically) and JSON properties. Each row can be edited in place or deleted.
- **Vertices:** vertices with their relationship counts. You can create, edit and delete them (deleting
  one also deletes its relationships). **Connect** starts a relationship from that vertex, and clicking the
  count lists that vertex's relationships.
- **Explorer:** a force-directed view. Load a sample of the graph or search for a vertex, then double-click
  a vertex to expand its neighbours and drag, pan and zoom as needed. Select a vertex or relationship to
  edit its properties. To connect two vertices, use **Connect…** and click the target, or Shift+click it.
- **Cypher:** runs Cypher queries on the selected graph. Result columns come from the `RETURN` clause, or
  you can list them for `RETURN *`. Vertices, edges and paths are shown readably and can be opened in the
  explorer.

Changes are committed immediately, need a connection whose policy allows writes (graphs and labels also
need schema changes), and are recorded in the audit log. Deletes and drops ask for confirmation. Cypher
queries that change the graph (`CREATE`, `MERGE`, `SET`, `DELETE`, `REMOVE`) only run when you tick
**Allow changes**; other queries run in a read-only transaction. Graph element ids are 64-bit, so they are
kept as strings and never rounded. AGE's own schemas (`ag_catalog` and one per graph) are left out of
**Import from Database…** and **Compare**.

The session runs `LOAD 'age'`, falling back to `$libdir/plugins/age` for non-superusers, unless AGE is
already in `shared_preload_libraries`.

## Workbench tabs

### Scripts

Scripts are TypeScript files kept next to the diagram, in `scripts/<type>/` (validators, generators,
seeders, migrations, queries, maintenance, imports, exports), so they can live in version control. The
first line holds their metadata (`// @pgsql-erd {"type":"validator"}`).

- **Monaco editor with IntelliSense for your database.** Typings are generated from the connected
  database (or from the diagram when offline): each table gets a row and an insert interface, and
  `db.public.tbUsuarios.insert({ nombre: 123 })` is reported as *Type 'number' is not assignable to type
  'string'*. Unknown table names in `db.table("…")` are flagged too. The typings are also written to
  `generated/database.d.ts` for other editors. Typings refresh on **Database → Refresh Schema**.
- **Script API** (globals, no imports):
  - `db.public.orders.where({ status: ["new", "paid"], total: { gt: 10 } }).orderBy("id").limit(50).select()`,
    `.first()`, `.count()`, `.insert(row)`, `.insertMany(rows)`, `.update(values)`, `.delete()`
  - `db.query(sql, params)`, `db.transaction(async (tx) => …)` (a savepoint),
    `db.describe.table() / relationships() / insertOrder()`, `db.preview()`
  - `validate(name, async () => { report.error({ table, row, column, message }) })`, `report.warning/info`, `log()`
  - `faker` (seeded fake data), `seed.row(table)`, `seed.fill(table, n)` (plausible values, valid foreign keys,
    unique values that don't collide with existing rows), `seed.check(table, row)`
- **Dry run** (F6) runs the script in a transaction that is always rolled back and reports inserts, updates,
  deletes and rows read per table. **Run** (F5) keeps the transaction open when the script changed data and
  asks you to commit or discard (rolled back automatically after 10 minutes).
- **Permissions** per script, from profiles (Read only, Validator, Data generator, Seeder, Migration, Full
  access) plus overrides: read rows, raw SELECT, INSERT, UPDATE, DELETE, DDL, raw SQL writes. Scripts
  without write permissions run in a `READ ONLY` transaction, so PostgreSQL enforces it as well.
- **Validators** list each `validate()` with pass/fail; clicking an error shows the offending row, the
  validation in the editor, and links to the table in the diagram and in a data tab.

### Scripts in the diagram

**Show scripts** (bottom left of the diagram, or **View → Show Scripts in Diagram**) draws the project's saved
scripts as entities next to the tables they use. A script is linked to the tables named in its source or listed in
its metadata, with a dashed line labelled by what it does: *validates*, *generates*, *seeds*, *migrates*,
*imports into*, *exports from*, *queries*. Each box shows the script's type and its last run on this machine: PASS or
FAIL with the number of validations, rows changed, rows checked.

- Drag boxes to arrange them; their positions are saved in `pgsql-erd.json`, not in the `.pgerd` file, so the
  diagram stays compatible with pgAdmin. Exported SVG and PNG images include the scripts while they are shown.
- Click a box for its details and linked tables, with **Open script** and **Run validator** / **Dry run**;
  double-click opens it in the Scripts tab.
- A table's sidebar lists the scripts that use it, with their last result.
- Scripts are hidden by default, to keep large diagrams readable.

### Query

A SQL editor with table and column completion. **Run** (Ctrl+Enter) runs the selection or everything in a
read-only transaction; statements that change data or the schema need **Allow changes**, a confirmation,
and a connection that allows writes, and are committed together. **Explain** shows the estimated plan and
**Explain analyze** (Ctrl+Shift+Enter) the actual one (always rolled back), as a tree with rows, self time
and a bar per node. Hints point out sequential scans that discard most rows, bad row estimates, sorts and
hashes that spill to disk and foreign keys without an index, with the `CREATE INDEX` / `ANALYZE` statement
to insert.

The database explorer sits beside the editor (**Explorer**): drag a table into the SQL, or double-click it,
to insert its name. **+ Query** next to **+ Data** opens more query tabs, each with its own SQL, results
and plan; opened or dropped `.sql` files get a tab of their own. Query tabs and their SQL are remembered
between sessions, and closing one with unsaved SQL asks first.

### Builder

A visual query builder (Database → Query Builder, Ctrl+Alt+U). Drag tables from the database explorer onto
the canvas (or double-click them) and tick the columns to return; the header checkbox picks every column.
Tables with a foreign key between them are joined automatically on its columns:

- a table added twice gets its own alias, and the next foreign key: a second `addresses` table next to
  `orders` joins on the shipping address when the first one took the billing address
- a table that references itself (`employees.manager_id`) can be added twice for a self join
- drag a column onto a column of another table to join them by hand

Each join has a small menu on its line, by its SQL name: matching rows only (`INNER JOIN`), every row of one
table (`LEFT` / `RIGHT JOIN`) or of both (`FULL JOIN`). Aliases can be renamed in the table headers; **Distinct** and
**Limit** complete the statement. The SQL shows below the canvas as you go: **Open in Query** puts it in
the Query tab and **Run** also runs it there; **Save…** writes the SQL to a file. Each Builder tab has its
own query, and they are remembered between sessions.

### Import designer

Maps the worksheets of an Excel workbook onto PostgreSQL tables and exports a reusable, portable **import
template** (Database → Excel Import Designer, Ctrl+Alt+M, or **Import** in the tab bar). Three panels:
the database explorer, a mapping canvas and a read-only preview of an example workbook.

- Open an example `.xlsx` on the right (or a folder of JSON files, or **Open database…**: the tables of a MySQL /
  MariaDB, SQL Server, Oracle or SQLite database or of a MySQL dump, one worksheet per table with the column names in
  its first row) and **Add as source**: one source block per worksheet. The rows of a database are read when it is
  opened, up to 100,000 per table, and **Run** imports them through the blocks like the rows of a workbook; the template
  keeps no connection. Pick how it is
  found: by name, position or its headers; at a **fixed position** (e.g. headers at `C4`, data from `C5`, with
  title rows above) or by **finding the header names** in a range of rows, so reordered columns and moved
  headers still work. Click a cell of the preview to move the header or the first data row.
- Drag tables from the explorer: each is an INSERT task (the same table can be added more than once). Drag
  from an Excel column's dot to a table column to map it; **Map by name** connects the matching names.
- **Insertion order** lists the tasks: reorder them by dragging or with the arrows, or **Suggest order** to put
  referenced tables first (cycles are reported, never broken silently). Task 1 inserts all its rows, then task 2.
- **Processor blocks** (toolbar) sit between the worksheet and a table column. **Split block** cuts a cell at a
  separator (a comma by default) into an array for a `text[]`-style column. **Table dropdown** gives a column a
  value picked from the rows of a table, with a search box, when the import runs; the default chosen in the
  designer is saved in the template. **Lookup block** finds a foreign key from a value of the worksheet: it
  looks the text up in a table (match column, return column) when the import runs, after the earlier tasks, so
  it finds the ids that were just generated. On the table nodes, **primary key columns have a dot on their right**: drag it to a column of a later task
  that reads the same worksheet to use the key the INSERT returns (`inserted.<primary key>`, `RETURNING` in
  PostgreSQL), so child rows get the id generated for their parent row. The parent task is moved before the child
  if needed. Arrows on the connections show the direction of the data.
- **Problems** checks the design against the example workbook and the database; **Preview** shows the rows each
  task would insert; nothing is written to the database by either.
- **Run** (toolbar) applies the design to the connected database with the rows of the open workbook, task by
  task in the insertion order. It needs a connection whose policy allows writes, shows how many rows each task
  will insert and asks first; the result tab shows the rows inserted per task or the failing task and worksheet
  row. With "all tasks together" a failure rolls everything back, and with "one per task" the earlier tasks stay
  committed. Every run is recorded in the audit log.
- **Save** / **Save As…** in the ribbon write a versioned `.import.json` with no sample data, credentials or
  paths (after checking the design). **Open** brings one back with its mappings, order and layout. Undo/redo (Ctrl+Z / Ctrl+Y), zoom
  (Ctrl + wheel) and Delete work on the canvas. Nodes behave like diagram tables: move them by the title bar and
  resize them from the grip in the bottom right corner (double-click it to fit the content). Click a connection to
  select it, then press Del or its × button to remove it.

The template is the product: a server or CLI can run it against any structurally compatible workbook using the
same code (`src/shared/import-template.js`). It describes plain INSERTs only: values are copied as text, with no
lookups, generated keys or transformations. See [docs/import-template-spec.md](docs/import-template-spec.md) and
[docs/import-template.schema.json](docs/import-template.schema.json).

### Data tabs

**Data** in the tab bar (or **Browse data** in a table's sidebar, or **Database → Browse Table Data…**)
opens a table in its own tab: a grid with paging (100/500/1000 rows), sticky headers, **Copy**
(tab-separated, pastes into a spreadsheet) and **Markdown** (the page as a Markdown table). Each column header has an Excel-style filter menu:

- sort ascending / descending (by the column's type: numbers and dates sort as such)
- a checklist of the column's distinct values with their counts, **(Blanks)**, **(Select all)** and a search box;
  as in Excel, the list reflects the other columns' filters
- text filters (contains, begins with, equals, is empty, …) or number / date filters (greater than, between, …)

Active filters show as chips above the grid.

**Edit rows** makes the grid editable, like *Edit rows* in SQL Server Management Studio: click a cell to
change it (Enter / Tab move on, Shift+Enter adds a line, Escape cancels, **Ctrl+0** sets NULL), click the
last row (`*`) to add a row (columns left as *(default)* get their DEFAULT) and **×** to delete one.
Changed cells, new rows and deleted rows are highlighted until **Save**, which applies them all in one
transaction (or none, if a row was changed by someone else meanwhile) and records them in the audit log.
Rows are found by their primary key, so tables without one only accept new rows; identity (`GENERATED
ALWAYS`) and generated columns are read-only. Editing is only offered when the connection's policy allows
writes, and outside development the save is confirmed first.

## Safety model

- The page (renderer) never runs scripts or sees credentials: the database password is sent once when
  connecting and stays in the main process. Saved passwords are encrypted with the
  operating system's credential store and never sent back to the page.
- Scripts run in a separate process (Electron's Node) with an empty environment, a memory limit, a
  timeout and Node's permission model: no file writes, no reads outside the app, no child processes. The
  process holds no database connection; every `db.*` call goes to the main process, which checks the
  script's permissions and the connection's policy.
- Connections have an environment (development, testing, staging, production) and a policy: production
  is read-only by default, shown in red, and blocks DDL including migrations from the compare dialog.
- Writes are reviewed before they are committed; `BEGIN`/`COMMIT` inside scripts are refused.
- An audit log (**Database → Open Audit Log**, and the Activity tab) records connections, schema refreshes
  and migrations, script runs and commits, query-tab writes and settings changes.

## Languages

The app is available in **English** and **Spanish** (Español). It follows the operating system's language,
falling back to English. To pick one yourself, use **View → Language**; menus switch immediately and
open windows switch when the app restarts (it offers to restart). The choice is saved in `settings.json` in
the app's user data folder. Numbers and dates follow the chosen language.

Translations cover the whole interface: menus, dialogs, the diagram sidebar, every tab, compare / migration
summaries and query-plan hints. Messages that come from PostgreSQL itself, and the names of plan nodes
(`Seq Scan`, `Hash Join`), stay as the server reports them.

## Getting started

```bash
npm install
npm start                          # empty diagram
npm start -- samples/shop.pgerd    # open a file
```

## Development

Technical notes for people working on the code are in [devlog/](devlog/): building and testing, coding
conventions, the project layout, the [.pgerd file format](devlog/pgerd-format.md), how the screenshots are
taken, and the design notes of features such as the disabled AI assistant. Start with
[devlog/DEVELOPMENT.md](devlog/DEVELOPMENT.md).

## License

[MIT](LICENSE)
