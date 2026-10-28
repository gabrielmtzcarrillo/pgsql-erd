# How import blocks are made

A *block* is a small node of the Import designer that sits between the worksheet and a table column and changes the
value on the way (split, case, replace, convert, join, clean, extract, default, lookup, distinct, ...). This page
explains the pieces a block is made of, so a new one can be added. The exported file format is described in
[import-template-spec.md](import-template-spec.md); this page is about the code.

## Two shapes of the same thing

| Where | Name | What it is |
| --- | --- | --- |
| Template (JSON) | **processor** (`{ "type": "clean", ... }`) or a **source mode** | The portable contract. Has no position, no id, no DOM. |
| Designer | **block** (`{ id, kind: 'clean', x, y, input, ... }`) | The editable node. Knows where it sits and what feeds it. |

`designToTemplate()` and `templateToDesign()` in `src/shared/import-template.js` convert between them. A block that
reads a column or another block becomes one entry of `processor` / `processors` on a mapping; blocks that *start* a
value (join, fixed value, table dropdown, distinct over a table) become the mapping's `source` instead.

Blocks form chains: an Excel column → block → block → table column. `chainOf(design, block)` returns the blocks from
the first to the given one; a block gets its input from `input: { sourceId, letter, label }` (an Excel column) or
`input: { procId }` (the text of the block before it).

## Steps to add a block

All of this is covered by `tests/import-template.test.js`; write the test first with a template that uses the block.

1. **Contract** (`src/shared/import-template.js`)
   - Add the processor to `IMPORT_TEMPLATE_SCHEMA` (the `processor` `anyOf`; `processors` reuses it) or, for a block
     that starts a value, a `source` `anyOf` entry.
   - Bump `SPEC_VERSION`, `SCHEMA_ID` and add a `*_VERSION` constant. A template is exported with the *lowest* version
     that covers what it uses (see the `specVersion:` line in `designToTemplate()`); older readers refuse newer
     minors, so never change the meaning of an existing field.
   - Give processors that produce plain text a place in `isTextProcessor()` so other processors can follow them.
   - Add semantic rules to `validateTemplate()` (anything the schema cannot say: ordering, combinations, references).
2. **Reading rows** (`applyProcessor()` / `extractRows()`)
   - A per-cell processor is a pure function `(text, config) -> { ok, value }`; add it to `applyProcessor()`. A failure
     returns `{ ok: false, code, what }` and is reported with its row.
   - A processor that changes *which rows exist* (like `distinct`) needs a hook in the row loop of `extractRows()`; keep
     it there, never in the runner.
   - A source that needs the database (like a distinct table column) must not be read in this module: it takes the
     values as an option (`tableValues`) that the caller supplies. The module stays free of DOM and database access.
3. **Designer state** (same file): add `newYourBlock()` with its defaults, include the kind in `isTextBlock()` and
   `hasInput()` as it applies, convert it in `processorOf()` and in the `build()` function of `templateToDesign()`
   (its `desc` is the key that merges identical blocks), and add its checks to `designDiagnostics()` using
   `{ processorId }` so the node is outlined.
4. **Designer UI** (`src/renderer/importdesigner.js`): a branch in `procNode()` that draws the node (ports are
   `.imp-port in` / `.imp-port out`; the `hasin` class makes the node a drop target for columns), a title in
   `blockTitle()`, an icon in `BLOCK_ICON`, a case in `addBlock()`, the explanation in `dockInspector()`, and the
   click handler of its toolbar button.
5. **Static page and assets**: the button in `src/renderer/index.html` (`#imp-add-<kind>`), the icon in
   `src/renderer/icons.js` (and its colour), the Spanish strings in `src/shared/locales/es.js` (the i18n test fails
   until every `tr()` string and the page text have an entry).
6. **Docs**: describe the block in `import-template-spec.md`, regenerate the schema
   (`node scripts/write-import-schema.mjs`) and run `npm test`.
7. **Runner** (`src/main/database/import-runner.cjs`): usually nothing. It receives rows that were already read; only
   change it when the value must be resolved inside the transaction (as `lookup` and `inserted` are).

## Example: the distinct block

- *Contract*: processor `{ "type": "distinct", "ignoreCase": false }` for a worksheet column, and source
  `{ "mode": "distinct", "schema", "table", "column" }` for a table column (spec 1.8).
- *Rows*: in the row loop of `extractRows()` the processors before `distinct` run, the result is looked up in a
  `Set`, repeated values skip the row, the processors after it run on the survivors. A table column comes in through
  `tableValues[distinctKey(source)]`.
- *Rules*: a task with a distinct column can only hold fixed values and dropdowns besides, and its rows cannot feed
  `inserted` keys (they have no worksheet row).
- *Designer*: `kind: 'distinct'` with `from: 'column'` (has an input, `hasInput()` is true) or `from: 'table'` (starts
  the chain, like a join). The renderer reads the table's values with the existing `data-distinct` call, caches them
  per tab and passes them to `extractRows()` for the preview, the diagnostics and the run.
