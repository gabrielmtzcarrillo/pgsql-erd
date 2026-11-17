# Implementation Plan — Excel → PostgreSQL Visual Import Designer

**Status:** Implementation specification (v1 draft)  
**Scope:** The visual designer and its portable JSON export contract. A separate server imports the JSON template, accepts any structurally compatible `.xlsx` workbook, and performs the INSERT operations.  
**Integration target:** Existing ERD editor; reuse database-schema discovery, node rendering, ports/connections, pan/zoom, and project persistence where possible.

## 1. Objective and boundaries

Build a three-panel editor that visually maps Excel worksheet columns onto PostgreSQL table columns, assigns an explicit insertion order to the table import tasks, previews/validates the design, and exports a **versioned, self-contained import template**.

The exported JSON must be runnable independently of the designer and independently of the workbook originally used to construct it. Workbook names, contents and (in dynamic-matching mode) column order may change, provided the replacement workbook satisfies the profile's declared structure.

**In scope for v1**
- `.xlsx` import and spreadsheet preview (read-only).
- Worksheet, header row, starting column, first data row and data boundary selection.
- Excel source nodes, PostgreSQL table nodes, and column mapping connections.
- Mapping multiple worksheets into multiple destination tables.
- Explicit sequential import task ordering; FK-aware ordering suggestion.
- Configuration validation and sample-based preview without writing to PostgreSQL.
- JSON export, JSON reimport, round-trip persistence, and a published schema.

**Out of scope for v1**
- Automatic FK resolution, parent-ID propagation, lookup joins or auto-generated values.
- Arbitrary SQL, scripts, formulas, transformations or table creation.
- UPDATE, UPSERT, DELETE, truncate, schema migration or automatic deduplication.
- Running the production import directly from the editor: server execution belongs to a separate runner.

A **destination node represents one INSERT task**, not necessarily one unique physical table. Two nodes may reference the same table if separate execution passes are needed.

## 2. User flow

1. Open **Import Designer** from the existing ERD application.
2. Select an Excel workbook; inspect the read-only spreadsheet preview in the right panel.
3. Choose the worksheet and specify its header row, starting column and data range. Alternatively, select dynamic header detection.
4. Add a source node to the center canvas (one per mapped worksheet/range).
5. Browse the PostgreSQL schema in the left panel and drag destination tables onto the canvas.
6. Connect Excel source column ports to PostgreSQL destination column ports; inspect warnings and per-column settings.
7. Configure each destination node's insertion order using a dedicated ordered-task panel.
8. Preview the mapping against sample rows and validate the template's structure.
9. Export a portable `.import.json` file; optionally export a `.zip` containing the profile and an example workbook **for testing only**.
10. A different system uploads the JSON to its server once. Later it submits any compatible Excel workbook for validation and execution using the registered profile.

## 3. Three-panel interface

### Left: PostgreSQL explorer
- Reuse the existing connection and metadata explorer.
- Browse and search schemas/tables; list columns with PostgreSQL type, nullable/default/identity/generated information, PK, FK and unique constraints.
- Drag/drop or click to add a **destination task node**; adding the same table more than once is allowed and must receive distinct task IDs.
- Optional FK dependency visualization, strictly read-only: no DDL changes.

### Center: mapping canvas
- Reuse ERD panning, zooming, selection, keyboard controls and connector rendering.
- Distinct node kinds: **Excel Source** and **PostgreSQL INSERT Destination**.
- Excel source node: worksheet selector, header range, physical Excel column letters and resolved labels, output ports.
- Destination node: `schema.table`, task number, column names/types, required/generated flags, input ports.
- Drag a source output port to a destination input port to create one mapping edge.
- Default: at most one source edge per target field per task; one source field can feed multiple targets/tasks.
- Edge selection reveals source reference mode, type compatibility, blank/null policy and preview examples.
- Connections describe value mappings only. Style them differently from foreign-key relationships if both can appear.
- Mapping list view and delete/undo/redo support; robust handling of node deletion.
- Dedicated **Execution Order** drawer: reorder by drag/drop or arrows. Number each target node. Canvas positioning never defines execution order.

### Right: Excel preview
- Read-only virtualized grid with Excel column letters, row numbers, tabs for worksheets and merged-cell indication.
- Selection gestures: mark header row, first header column, first data row and optional last column/row.
- Support example formats such as **headers at C4, data at C5**, with title rows above.
- Display detected header labels, duplicate/blank headers, field samples and inferred type hints.
- Enable a **fixed-location** or **detect-by-header** profile mode.
- For dynamic mode show which worksheet, header row and source columns would be selected, and explain failed/ambiguous matches.
- Keep workbook parsing off the renderer/UI thread; only materialize visible rows and a bounded preview/sample set.

## 4. Source selection and portability rules

**Fixed-location mode:** The JSON declares the worksheet, header row, starting column, data start and physical Excel columns. It is suitable for strongly standardized Excel templates; a different workbook must retain those positions and pass any configured header checks.

**Detect-by-header mode:** The JSON declares a bounded worksheet/header search, a required set of uniquely identifiable header labels, header matching policy, and the rule for locating the first data row. The runner resolves source columns by header name, allowing column reordering or shifted title rows within the scan limits.

Requirements common to both modes:
- **A 'valid Excel file' is not necessarily a 'compatible workbook'.** Compatibility is established by the chosen profile.
- Always identify source references unambiguously: sheet selector + header selector + column selector.
- If zero or multiple worksheets/header rows match, fail validation with actionable diagnostics. Never silently guess.
- If two header cells normalize to the same name, fail a header-based selector referencing that name. Physical-position selectors may still be used.
- The profile must specify blank-row behavior and a deterministic end-of-data rule. Avoid “stop at first blank row” as the unconditional default because mid-sheet blanks occur.
- Preview sample data must **not** be embedded in the exported executable profile.
- Define whether cells use raw typed values or displayed/formatted text for each mapping when necessary. This matters for leading-zero IDs, dates and locale-dependent number formats.
- Formula evaluation is out of scope; a runner must use cached formula results if available and report missing/unsupported results rather than execute formulas/macros or external links.

## 5. PostgreSQL mapping behavior

- Read destination metadata from the selected database connection; require explicit `schema`, `table` and destination column names.
- Visual hints for numeric/text/date/boolean target types and nullability; highlight required unmapped columns without defaults.
- For generated/identity columns, default to omitting them unless explicitly enabled and supported by the target PostgreSQL semantics.
- The v1 meaning of a mapping is **value assignment for raw INSERT**. The designer does not resolve referenced values, create relationships, generate IDs or transform arbitrary expressions.
- If the user maps text IDs such as `"00042"`, preserve their intended representation according to the explicit Excel value-read policy.
- Warn about potential FK constraint order failures, acknowledging that referenced rows may already exist in the destination DB.
- Never export database passwords, connection strings, local file paths, or connection-specific secret IDs.

## 6. Insertion order

- Every destination node/task has an immutable task ID and one integer `order` index (1-based, unique, contiguous on export).
- Reordering tasks updates badges and an ordered list; canvas coordinates are unaffected.
- Provide **Suggest Order** based on the FK graph of selected PostgreSQL tables using topological sorting.
- Treat each selected table as a dependency node for the suggestion; handle repeated-task destinations explicitly and do not pretend a table-level graph completely orders repeated inserts.
- Display warnings when a task appears before a referenced parent task. Do not always block export because parent records might already exist.
- Cycles must be surfaced explicitly with the involved tables/constraints. Do not silently select an arbitrary order.
- Define that all rows of task N are processed before task N+1; the future runner applies atomic transaction policy as declared by the template.

## 7. Portable JSON contract

Develop and version a **JSON Schema** before building the export UI. A server or CLI conforming to the contract must be able to validate and execute the exported file without the original desktop application.

### Required top-level concepts
- `format`, `specVersion`, `templateId`, `name`.
- `sources[]`: worksheet matching, header finding, column selectors, row boundaries and cell-reading policies.
- `execution`: operation (`insert`), transaction policy, ordered tasks and blank-row policy.
- `tasks[]`: unique task ID, 1-based execution order, source ID, target schema/table and individual source-to-target column mappings.
- `editor` (optional): node positions, zoom and collapsed panels. Runners **must ignore** this presentation-only field.

### Illustrative example (final keys to be frozen with the JSON Schema)

```json
{
  "format": "excel-pg-insert-template",
  "specVersion": "1.0",
  "templateId": "alumnos-v1",
  "name": "Alta de alumnos y carreras",
  "sources": [
    {
      "id": "srcCarreras",
      "sheet": { "mode": "name", "value": "Carreras" },
      "header": {
        "mode": "fixed",
        "row": 4,
        "startColumn": "C",
        "expected": ["ID Carrera", "Carrera"]
      },
      "data": {
        "firstRow": { "mode": "afterHeader", "offset": 1 },
        "endMode": "lastNonEmptyMappedRow",
        "skipEmptyRows": true
      }
    },
    {
      "id": "srcAlumnos",
      "sheet": {
        "mode": "requiredHeaders",
        "headers": ["Matrícula", "Nombre", "ID Carrera"]
      },
      "header": {
        "mode": "detect",
        "scanRows": { "from": 1, "to": 30 },
        "match": { "trim": true, "caseSensitive": false }
      },
      "data": {
        "firstRow": { "mode": "afterHeader", "offset": 1 },
        "endMode": "lastNonEmptyMappedRow",
        "skipEmptyRows": true
      }
    }
  ],
  "execution": {
    "operation": "insert",
    "transaction": "atomic",
    "tasks": [
      {
        "id": "insertCarreras",
        "order": 1,
        "sourceId": "srcCarreras",
        "target": { "schema": "public", "table": "catCarreras" },
        "mappings": [
          {
            "source": { "mode": "column", "column": "C" },
            "targetColumn": "idCarrera"
          },
          {
            "source": { "mode": "column", "column": "D" },
            "targetColumn": "nombre"
          }
        ]
      },
      {
        "id": "insertAlumnos",
        "order": 2,
        "sourceId": "srcAlumnos",
        "target": { "schema": "public", "table": "tbAlumnos" },
        "mappings": [
          {
            "source": { "mode": "header", "name": "Matrícula" },
            "targetColumn": "matricula"
          },
          {
            "source": { "mode": "header", "name": "Nombre" },
            "targetColumn": "nombre"
          },
          {
            "source": { "mode": "header", "name": "ID Carrera" },
            "targetColumn": "idCarrera"
          }
        ]
      }
    ]
  },
  "editor": {
    "nodes": {
      "srcCarreras": { "x": 200, "y": 100 },
      "srcAlumnos": { "x": 200, "y": 450 },
      "insertCarreras": { "x": 650, "y": 100 },
      "insertAlumnos": { "x": 650, "y": 450 }
    }
  }
}
```

**Contract details to settle before coding:** JSON Schema URI and semantic version policy; how a header row is uniquely identified; Excel date epoch and time-zone policy; blank vs empty-string vs null semantics; raw vs formatted values; how coercion failures are reported; exact semantics of `lastNonEmptyMappedRow`; maximum number of sheets/rows/columns and scanning limits. Make all defaults explicit in the schema or specification.

## 8. Suggested module boundaries

Names are illustrative; adapt them to the existing repository and architecture.

- `ImportDesignerView`: split panels, tabs, commands, file selection, session state.
- `WorkbookPreviewService`: reads Excel workbook metadata and bounded cell ranges; paging/virtualization.
- `SourceRangeEditor`: range selection, header normalization, dynamic/fixed matching.
- `ImportCanvasAdapter`: node/edge integration with existing ERD rendering system.
- `DatabaseMetadataAdapter`: exposes existing PostgreSQL schema introspection in a read-only model.
- `MappingState`: normalized source, target task, connection and ordering state.
- `MappingValidator`: validates source selectors, target columns, uniqueness, required fields, and order warnings.
- `InsertionOrderPlanner`: FK dependency graph + topological sort + cycle diagnostics.
- `ImportProfileSerializer`: import/export canonical JSON, schema validation, version handling and optional editor metadata.
- `ImportPreviewEngine`: runs the **shared contract** against sample rows without executing SQL.

Keep renderer state and persistence models separate. No direct database insertion logic belongs in the canvas or desktop UI. Prefer sharing DTOs/JSON Schema and test fixtures with the independent server runner.

## 9. Validation requirements

**Design-time (no DB writes)**
- Source sheet exists and header/reference selectors resolve uniquely on the example workbook.
- Selected source columns exist; duplicate header mappings are diagnosed.
- Every task has a valid source, destination, unique order and at least one mapping.
- Target table and fields exist; no conflicting duplicate mappings to the same target field.
- Required target fields either are mapped or have a database default/generated behavior.
- Flag type mismatch risks from sample values, but distinguish heuristic warnings from conclusive errors.
- Warn about FK dependencies and order conflicts, cycles, generated IDs and potentially dangerous retries.
- Export is blocked for malformed/incomplete profiles; warnings can be acknowledged.

**Contract validation**
- Export must conform to the published JSON Schema.
- Importing then exporting a profile must preserve its execution meaning.
- Layout metadata must not affect runner behavior.
- Unknown major spec versions must be rejected, not silently interpreted.

**Execution behavior (contract for separate server)**
- Server registers a profile once and accepts a later Excel file with arbitrary filename.
- Server independently revalidates profile, workbook structure, table access and row data.
- Each task performs plain PostgreSQL INSERTs in the declared sequence; no FK lookup or transformation magic.
- Server reports task ID, worksheet, source Excel row, destination and failure.
- Execution must use parameters/safe identifier quoting, least-privilege allowlists, transactions, workbook size limits and idempotency safeguards such as recorded import hashes.

## 10. Implementation milestones

### Milestone A — Contract and model
1. Define state and exported profile models; design 1-based order and immutable source/task IDs.
2. Draft JSON Schema v1 and conformance fixtures for fixed/dynamic headers.
3. Write serializers, validators and JSON round-trip tests.
**Deliverable:** A documented portable contract independent of any UI.

### Milestone B — Excel viewer and source authoring
1. Add right panel workbook loader and worksheet tabs.
2. Implement virtualized grid and header/data-range selection.
3. Implement fixed-position and dynamic-header source definitions with explicit ambiguity errors.
4. Add Excel source node creation/update/removal.
**Deliverable:** A worksheet source can be authored and persisted reliably.

### Milestone C — PostgreSQL destination mapping
1. Reuse DB explorer and target metadata.
2. Add PostgreSQL task nodes and ERD-style column connectors.
3. Implement mapping editing, deleting and undo/redo.
4. Add mapping validation and sample preview for mapped fields.
**Deliverable:** Single-table raw INSERT mapping with visible diagnostics.

### Milestone D — Multiple tasks and execution order
1. Allow multiple target nodes and multiple worksheet sources.
2. Add explicit task order drawer, numbered badges and manual reordering.
3. Add FK-based order suggestion, dependency warnings and cycle detection.
**Deliverable:** Ordered, multi-table mapping is fully modeled and validated.

### Milestone E — Export and interoperability
1. Export canonical `.import.json` and allow reimport for editing.
2. Add JSON Schema validation and round-trip consistency testing.
3. Produce shared golden test fixtures and a reference interpretation document for the server team.
4. Verify the server can register the profile and run a different compatible Excel workbook without editor state.
**Deliverable:** Portable template interoperable with an independent runner.

### Milestone F — UX hardening
1. Empty/loading/error states, keyboard navigation, large-file performance, long header handling.
2. Preview of resolved dynamic selectors; source drift warnings.
3. Tests for cancellation, bad workbooks, version mismatch and schema changes.
4. User guidance explaining raw INSERT behavior and duplicate-import risks.
**Deliverable:** Production-ready authoring experience.

## 11. Acceptance tests

1. **Shifted header:** Source header starts at C4 and records at C5; proper mapping and preview.
2. **Strict reuse:** Another workbook with the same fixed structure but new data is compatible.
3. **Flexible reuse:** Dynamic headers reorder columns and move within the declared scan window; the new workbook still resolves correctly.
4. **Invalid input:** Missing, duplicated or ambiguous headers prevent validation, with precise reasons.
5. **Two-table workflow:** The user maps `catCarreras` and `tbAlumnos`, places them in a manually chosen sequence, and exports that order.
6. **FK suggestion:** Recommends the parent table first; a cycle produces a diagnostic.
7. **Task uniqueness:** Two tasks may target the same table and preserve distinct IDs and execution positions.
8. **JSON round-trip:** Export, close the app, import JSON, and recover the source definitions, connections, order and canvas layout.
9. **Portable behavior:** A headless server loads the JSON and processes a distinct compatible workbook without referring to the designer, sample workbook, or local paths.
10. **Safety:** No credentials, SQL scripts or sample row content leak into the executable profile; neither the designer nor preview writes to the database.

## 12. Definition of done

The design feature is complete when a user can visually construct a multi-table raw INSERT template from an example Excel workbook, explicitly order the destination tasks, validate it, export/reopen it as JSON, and hand it to an independent server that applies the same profile to a structurally compatible but otherwise unrelated Excel workbook.

**Implementation principle:** The JSON contract is the product; the visual designer is one authoring interface for it. Preserve the distinction between Excel *file validity* and *template compatibility*.
