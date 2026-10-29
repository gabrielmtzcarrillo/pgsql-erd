# Excel → PostgreSQL INSERT template, specification 1.8

The Import Designer exports a **template**: a JSON document that tells a runner which worksheets of an Excel
workbook to read and which `INSERT`s to perform, in which order. The designer is only one way to author it;
this document is the contract a server or CLI implements. The JSON Schema is
[import-template.schema.json](import-template.schema.json) and a complete example is
[examples/alumnos.import.json](examples/alumnos.import.json).

A reference implementation of everything that does not touch a database (validation, finding worksheets,
header rows and columns, reading rows) is `src/shared/import-template.js`: `validateTemplate()`,
`resolveSource()` and `extractRows()`. It has no DOM and no dependencies besides the workbook reader
`src/renderer/lib/spreadsheet.js`, so a Node runner can use it as is. The tests in
`tests/import-template.test.js` double as conformance cases.

**A valid Excel file is not necessarily a compatible workbook.** Compatibility is defined by the template's
sources: a different file, with a different name and different data, is compatible when every source finds
exactly one worksheet, one header row and its mapped columns.

## Versioning

- `format` must be `"excel-pg-insert-template"`.
- `specVersion` is `"<major>.<minor>"`. A reader **must reject a version above the one it implements** (another
  major, or a newer minor) and must not guess: new fields can change what a template does, so ignoring them is
  unsafe. This document is 1.8. A template is written with the lowest version that covers what it uses, so older
  readers still run it. 1.1 adds *processor blocks* (`processor` on mappings, `parameters`, the `parameter`
  source); 1.2 adds the `lookup` processor; 1.3 adds `inserted` keys; 1.4 adds the `case` processor and the optional `filter` of a table dropdown; 1.5 adds the `map` and `convert` processors; 1.6 adds `processors` (chains); 1.7 adds the `join` and `constant` sources and the `clean`, `extract` and `default` processors; 1.8 adds the `distinct` processor and source. 1.9 adds the `range` source.
- `editor` is presentation only (node positions). Runners **must ignore** it; it never changes behaviour.

## Document

| Field | Meaning |
|---|---|
| `templateId` | Identifier: a letter, then letters, digits, `-`, `_` (≤ 64). |
| `name`, `description` | Free text. |
| `limits` | Optional ceilings: `maxRows` (default 100000 data rows per task), `maxScanRows` (200), `maxColumns` (512). Exceeding one fails the run. |
| `parameters[]` | Table dropdowns whose value is picked when the import runs (1.1, below). |
| `sources[]` | Where rows come from (below). |
| `execution.operation` | `"insert"`. Nothing else exists in 1.0: no update, upsert, delete or truncate. |
| `execution.transaction` | `"atomic"`: one transaction for all tasks, any failure undoes everything. `"perTask"`: one transaction per task; tasks before a failure stay committed. |
| `execution.tasks[]` | The INSERT tasks. |

### Sources

A source is one worksheet and one header row. Address a value as **sheet selector + header selector + column
selector**; if any step matches zero or several candidates the run fails with the reason. Nothing is guessed.

`sheet`:

- `{ "mode": "name", "value": "Alumnos" }`: exact name; if none, a case-insensitive match that must be unique.
- `{ "mode": "index", "value": 2 }`: 1-based position among all worksheets (hidden ones count).
- `{ "mode": "requiredHeaders", "headers": [...] }`: the one worksheet that has a header row containing all these
  headers (using the header match rules below and, for a fixed header, only that row). Zero or several → error.

`header`, both with `match: { trim, caseSensitive }` (defaults `true`, `false`):

- `{ "mode": "fixed", "row": 4, "startColumn": "C", "expected": ["ID Carrera", "Carrera"] }`: the header cells
  are the cells of `row` from `startColumn` rightwards. If `expected` is present, the cells from `startColumn` must
  equal it in order (a difference is an error naming the cell). This is the strict mode for standardised files.
- `{ "mode": "detect", "scanRows": { "from": 1, "to": 30 } }`: the header row is the row inside `scanRows`
  that contains every **required header**: the sheet's `headers` (when `requiredHeaders`) plus every header name a
  mapping of the source uses. Exactly one row must qualify. A span over `maxScanRows` is invalid. Columns are
  then resolved by header name, so reordering and shifted title rows are tolerated.

Header comparison: Unicode NFC, runs of whitespace collapsed to one space, trimmed (unless `trim` is false),
case-folded (unless `caseSensitive`). Accents always matter (`Matricula` ≠ `Matrícula`). If two header cells
normalise to the same text, a mapping that selects by that name **fails**; selecting by column letter still works.

`data`:

- `firstRow: { "mode": "afterHeader", "offset": 1 }`: the first data row is `header row + offset`.
- `endMode: "lastNonEmptyMappedRow"`: for each **task**, the data ends at the last row, from the first data row
  on, where at least one of the task's mapped cells is non-blank. Blank rows before that are not a terminator.
- `skipEmptyRows` (default `true`): rows in that range where **every** mapped cell is blank are not inserted. When
  `false` they are inserted as rows of blanks (subject to the blank policy).

### Tasks

Each task is `{ id, order, sourceId, target: { schema, table }, mappings[] }`.

- `id` is unique and immutable. `order` is an integer, **unique and contiguous from 1**. Two tasks may name the
  same table (distinct ids, distinct orders); a task is one INSERT pass, not a table.
- Tasks run in `order`. **All rows of task N are inserted before task N+1.** Within a task, rows follow worksheet
  row order.
- A task reads one source, and `mappings[]` assigns values to columns: one mapping per `targetColumn` (a column
  fed twice is invalid). A source column may feed several targets or tasks.
- `source` is `{ "mode": "column", "column": "C" }` (a letter; valid for `fixed` sources, not left of
  `startColumn`) or `{ "mode": "header", "name": "Matrícula" }` (valid for both; required for `detect`).
- Optional per mapping: `trim` (default `false`) trims the cell text; `blank` is what a blank cell becomes:
  `"null"` (default), `"emptyString"` or `"error"` (the run fails, naming sheet, row and column); `read` is
  `"text"`, the only value in 1.0.
- `optional` (default `false`, `header` sources only): when the worksheet has no header with that name, the column is left
  out of the INSERT (so the table default applies) instead of failing the run. `extractRows()` lists those columns in the
  task's `skipped`, and the runner drops them from the INSERT.
- A task needs at least one mapping that reads the worksheet or takes an inserted key (1.3); one with only
  `parameter` sources has no rows.

### Processor blocks (1.1, lookup 1.2)

**Split.** `processor: { "type": "split", "delimiter": ",", "trim": true, "dropEmpty": true }` on a `column` or
`header` mapping turns the cell text into an **array of strings**: it is cut at every occurrence of
`delimiter` (literal text of 1 to 8 characters, default `,`; no quoting or escaping, no regular expressions),
each element is trimmed (`trim`, default `true`) and empty elements are dropped (`dropEmpty`, default `true`).
The cell's own `trim` is applied first. A blank cell follows the mapping's `blank` policy: `null`, an error, or,
for `emptyString`, the empty array `[]`. The runner sends the array as one parameter for an array column such as
`text[]` or `integer[]`; PostgreSQL converts each element from text.

**Map (1.5): replace values.** `processor: { "type": "map", "pairs": [{ "from": "M", "to": "Male" }], "caseSensitive": false,
"otherwise": "keep" }` replaces the text by the `to` of the first pair whose `from` equals it (both trimmed; case is
ignored unless `caseSensitive`). `otherwise` says what happens to a text in no pair: `"keep"` it (default), insert
`"null"`, or fail with `"error"` (code `MAP_NO_MATCH`, naming sheet, row and column).

**Convert (1.5).** `processor: { "type": "convert", "to": "date", "order": "dmy" }` reads the text and gives the form
PostgreSQL expects. `date` and `timestamp` accept `D/M/Y`, `M/D/Y` or `Y/M/D` (`order` `dmy` default, `mdy`, `ymd`;
separators `/`, `.` or `-`; a two-digit year is 1970-2069) with an optional `HH:MM[:SS]`, and give `YYYY-MM-DD` or
`YYYY-MM-DD HH:MM:SS`; impossible dates fail. `number` removes spaces, currency symbols and thousands separators
(`decimal` is `"."` by default or `","`; `(5)` is `-5`). `boolean` reads true/yes/y/1/on/sí as `true` and
false/no/n/0/off as `false`. Anything else fails with `CONVERT_FAILED`.

**Join (1.7): several columns as one text.** `source: { "mode": "join", "parts": [{ "column": "B" }, { "column": "C" }],
"separator": " ", "skipBlank": true, "prefix": "", "suffix": "" }` writes the cells of the parts, in order, with
`separator` between them (default one space). Parts are column letters with a fixed header and `{ "header": "Name" }`
with a detected one (the same rule as `column` and `header`). With `skipBlank` (default true) blank cells and their
separator are left out; if every cell is blank the value is blank and follows the mapping's `blank` policy, otherwise
`prefix` and `suffix` surround the text. The mapping's `trim` applies to each cell. Processors may follow.

**Constant (1.7).** `source: { "mode": "constant", "value": "ALTA" }` inserts the same text in every row. It reads
nothing from the worksheet, so a task needs another mapping that does, and it cannot have a processor.

**Clean (1.7).** `processor: { "type": "clean", "collapseSpaces": true, "removeControl": true, "removeAccents": false }`:
`removeControl` (default true) deletes control and zero-width characters and turns a non-breaking space into a space;
`collapseSpaces` (default true) turns runs of white space into one space and trims the ends; `removeAccents`
(default false) removes the accents of letters.

**Extract (1.7).** `processor: { "type": "extract", "mode": "substring", "start": 1, "length": 3 }` keeps `length`
characters from character `start` (counting from 1; no `length` keeps the rest). `{ "type": "extract", "mode":
"regex", "pattern": "(\d+)-(\d+)", "group": 2, "ignoreCase": false }` keeps capture group `group` (0, the default,
is the whole match) of the first match of a JavaScript regular expression (at most 500 characters). When there is
nothing to extract, `otherwise` is `"null"` (default), `"keep"` the text or `"error"` (`EXTRACT_NO_MATCH`). An invalid
pattern makes the template invalid.

**Default (1.7).** `processor: { "type": "default", "value": "unknown" }`, as the first processor, replaces a blank cell
by `value` before the `blank` policy is looked at; other cells are untouched.

**Distinct values (1.8).** Two forms give a task one row for each *different* value instead of one row for each
worksheet row; blank values are left out.

- `processor: { "type": "distinct", "ignoreCase": false }` on a worksheet column (a `column`, `header` or `join`
  source): the first row with each text is kept. Processors before it (`clean`, `case`, ...) work on every cell, so
  the comparison is made on their result; processors after it work on each different value. Only one per column.
  `"stopAtEmpty": true` ends the reading at the first blank cell of the column (the rows after it are ignored)
  instead of skipping the blanks.
- `source: { "mode": "distinct", "schema": "public", "table": "category", "column": "name" }`: the different values of a
  column of a table, in the database. Processors may follow. The runner reads them (`SELECT DISTINCT`), so
  `extractRows()` takes them as `tableValues`, keyed by `distinctKey(source)`; `distinctTables(template)` lists what to
  read. Such a task has no worksheet: its `sourceId` may be omitted.

A task with a distinct column can hold, besides it, only `constant` and `parameter` mappings: its rows no longer
correspond to worksheet rows, so it cannot read other worksheet columns, and a later task cannot use its `inserted`
keys. To link the rows afterwards use a `lookup` on the same value.

**Chains (1.6): `processors`.** A mapping may carry `processors`, an array of two or more processors applied in order,
each to the text the one before gave, instead of a single `processor` (never both). Every processor but the last must
give text: `case` without `split`, `map` or `convert`. The last may be any processor, including `split` (an array) and
`lookup`. If a step turns the value into NULL (a `map` with `otherwise` `"null"`) or fails, the rest of the chain is
skipped for that cell. The designer draws a chain as blocks wired one after the other; a text block's output can feed
any block that reads an Excel column. A case block followed by a split is still written in the 1.4 form below.

**Split after a case (1.4).** A split processor may carry `"case": "upper"` or `"lower"`: the text is converted first, then cut. The designer draws it as a case block feeding the split block.

**Case (1.4).** `processor: { "type": "case", "mode": "upper" }` (`"upper"` or `"lower"`) writes the cell text in
upper or lower case (locale independent). With `"split": { "delimiter": "|", "trim": true, "dropEmpty": true }`
(same meaning as the split processor) the text is cut first and every element converted, so the result is an array;
without it the result is a string. A blank cell follows the `blank` policy (`emptyString` gives `[]` with `split`).

**Table dropdown filter (1.4).** A `parameters[].source` may carry `"filter": { "column": "active", "value": "true" }`, or `"filter": { "column": "campusId", "parameter": "campus" }` to follow the value picked in another dropdown (exactly one of `value` and `parameter`; the followed dropdown must be declared and the chain must not loop):
only the rows whose `column`, compared as text, equals `value` are offered. It is optional; a runner that lists the
rows of the dropdown must apply it.

**Lookup (1.2): a foreign key from a value.** `processor: { "type": "lookup", "schema": "public", "table":
"catCarreras", "matchColumn": "nombre", "valueColumn": "idCarrera", "onMissing": "error" }` replaces the cell
text with the `valueColumn` of the row of that table whose `matchColumn` equals the text (compared as text, after
the mapping's own `trim`). `matchColumn` must be a column of the table's primary key: the cell holds a key, and
the lookup checks it exists (with `valueColumn` equal to `matchColumn` it is a pure existence check). The runner
revalidates this against the database. It is done by the runner **when the task runs**, in the same transaction and after
the earlier tasks, so the rows they inserted, with the ids the database generated for them, can be found; the
designer warns when a task that fills the looked-up table comes later. No match: `onMissing` `"error"` (default;
the run fails, naming sheet, row and value) or `"null"`; more than one match is always an error. A blank cell
follows the mapping's `blank` policy and is not looked up. `extractRows()` leaves the cell text in place for
the runner to resolve. The runner needs read access to the looked-up table.

**Inserted key (1.3): `inserted.<primary key>`.** A mapping with `source: { "mode": "inserted", "taskId":
"insertCarreras", "column": "idCarrera" }` takes the value of `column` that the INSERT of an **earlier** task
returned for the same worksheet row. The runner performs that INSERT with `RETURNING "column"` and gives the
returned value to this task's row, which makes the usual master/detail load (parent row, then child rows that
need the generated id) possible from one worksheet. Rules: the referenced task must have a lower `order` and read
the **same source** (rows are paired by worksheet row; a row the earlier task skipped, because all its mapped
cells were blank, has no key and fails the run for that row); `column` is a column the earlier task's table
returns, normally its primary key; the mapping has no `processor`, `trim` or `blank`; and a task needs at least
one mapping that reads the worksheet **or** an inserted key. A task with no worksheet column of its own inserts one
row for each row of the task whose key it uses (so a detail row per parent row, with the key and fixed values). `extractRows()` leaves such columns
null and lists them in the task's `inserted` (`{ "targetColumn": "taskId.column" }`).

**Table dropdown.** A mapping with `source: { "mode": "parameter", "name": "carrera" }` gets the same value in
every row, chosen by whoever runs the import (not read from the worksheet). `parameters[]` declares it:

```json
{ "name": "carrera", "label": "Carrera", "default": "7",
  "source": { "type": "table", "schema": "public", "table": "catCarreras", "valueColumn": "idCarrera", "labelColumn": "nombre" } }
```

A runner shows a dropdown of the rows of that table, listing `labelColumn` (or `valueColumn` without one) with
a **search box**, and uses the `valueColumn` of the picked row as text. `default` is the value selected at
first, which the runner may override; with neither a default nor a choice the run fails. Names are unique, and a
mapping cannot name an undeclared parameter nor combine a parameter with a processor. The runner reads the
dropdown's rows through the same least-privilege access it uses for inserts (the table must be allowed).

## Reading cells

- A cell is **blank** when it is missing, empty or only whitespace. Blank → NULL / empty string / error per the
  mapping. A non-blank cell yields its text (not trimmed unless `trim`).
- Values are read **as text**, and PostgreSQL converts the text to the column type, so text IDs such as `00042`
  keep their zeros. Numbers keep the written form of the cell value; dates and times come out ISO 8601 with no time
  zone (`2024-02-29`, `2024-02-29 13:05:00`, `13:05:00`), computed from the workbook's 1900 or 1904 epoch.
  Booleans are `true` / `false`.
- **Formulas are never evaluated.** A runner uses the cached result stored in the file and reports a missing
  result rather than computing anything. Macros and external links are never executed or followed.
- Error cells (`#N/A`, …) read as blank.

The designer's **Run** button is a reference runner for the connected database: `src/main/database/import-runner.cjs`
(`runImport()`), which receives the rows read by `extractRows()`. It sends values as parameters, quotes identifiers,
applies `execution.transaction`, resolves `lookup` and `inserted` as described above, and reports the task and the
worksheet row of a failure. It requires a connection whose policy allows writes and records the run in the audit
log. It does not implement the allow-lists, upload limits or import hashes below, which a server runner needs.

## Runner obligations

A conforming runner:

1. Validates the template (structure, version, semantic rules in `validateTemplate()`) when it registers it and
   again when it runs it; a template that fails is never run.
2. Resolves every source against the uploaded workbook and reports each failure with its reason before inserting
   anything.
3. Revalidates the target tables and columns against the database, enforces least-privilege access (an allow-list
   of schemas / tables), quotes identifiers safely and sends values as **parameters**, never as SQL text.
4. Applies `execution.transaction`, the limits, an upload size limit, and an idempotency safeguard such as recording
   a hash of each imported workbook: the same file imported twice inserts its rows twice otherwise.
5. Reports, for every failure, the task id, worksheet, Excel row, target and reason.

Out of scope for 1.0: foreign-key resolution, ID propagation between tasks, lookups, generated values,
transformations, scripts, UPDATE / UPSERT / DELETE, table creation. The designer warns about insertion order
against foreign keys but cannot know which parent rows already exist in a database.

**Range of columns (1.9).** `source: { "mode": "range", "from": { "header": "Jan" }, "to": { "header": "Dec" } }` gives the
cells of every worksheet column from `from` to `to` (both included, in either order) as an array of texts, for an
array column such as `text[]`. Use `{ "column": "C" }` ends with a fixed header and `{ "header": ... }` ends with a
detected one. A row whose cells are all blank gives the `blank` policy's value (`null`, or an empty array with
`emptyString`). Only a `case` processor without `split` may follow. The designer writes it from a *Select* block.
