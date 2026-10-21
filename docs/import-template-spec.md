# Excel → PostgreSQL INSERT template, specification 1.0

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
- `specVersion` is `"<major>.<minor>"`. A reader of 1.x **must reject any other major version** and must not
  guess. Minor versions only add optional fields; a 1.0 reader ignores unknown fields.
- `editor` is presentation only (node positions). Runners **must ignore** it; it never changes behaviour.

## Document

| Field | Meaning |
|---|---|
| `templateId` | Identifier: a letter, then letters, digits, `-`, `_` (≤ 64). |
| `name`, `description` | Free text. |
| `limits` | Optional ceilings: `maxRows` (default 100000 data rows per task), `maxScanRows` (200), `maxColumns` (512). Exceeding one fails the run. |
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
