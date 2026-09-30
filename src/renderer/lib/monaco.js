// Script editor: Monaco (from node_modules/monaco-editor, AMD build) with
// TypeScript IntelliSense against the generated database typings. If Monaco
// can't be loaded, a plain textarea with the same interface is used.

const MONACO_BASE = new URL('../../../node_modules/monaco-editor/min/vs', import.meta.url).href;

let loading = null;

function loadMonaco() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${MONACO_BASE}/loader.js`;
    script.onerror = () => reject(new Error('Monaco editor not found'));
    script.onload = () => {
      const amdRequire = window.require;
      amdRequire.config({ paths: { vs: MONACO_BASE } });
      amdRequire(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    document.head.append(script);
  });
  return loading;
}

const typescriptApi = (monaco) => monaco.typescript ?? monaco.languages.typescript;

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let typesLib = null;
let modelSeq = 0;
let configured = false;

function configure(monaco) {
  if (configured) return;
  configured = true;
  const tsApi = typescriptApi(monaco);
  const defaults = tsApi.typescriptDefaults;
  defaults.setCompilerOptions({
    target: tsApi.ScriptTarget.ES2022 ?? 9,
    module: tsApi.ModuleKind.ESNext,
    // Each script is a module, so top-level await works.
    moduleDetection: 3,
    lib: ['es2022'],
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
  });
  defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  defaults.setEagerModelSync(true);
  darkQuery.addEventListener('change', () => monaco.editor.setTheme(darkQuery.matches ? 'vs-dark' : 'vs'));
}

// SQL completions: table and column names of the current schema.
let sqlSchema = null;
let sqlCompletions = false;
export function setSqlSchema(schema) {
  sqlSchema = schema;
}
function registerSqlCompletions(monaco) {
  if (sqlCompletions) return;
  sqlCompletions = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const q = (n) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);
      const out = [];
      for (const s of sqlSchema?.schemas ?? []) {
        for (const t of s.tables) {
          const name = s.name === 'public' ? q(t.name) : `${q(s.name)}.${q(t.name)}`;
          out.push({ label: name, kind: monaco.languages.CompletionItemKind.Class, insertText: name, detail: t.comment || `${t.columns.length} columns`, range });
          for (const c of t.columns)
            out.push({ label: q(c.name), kind: monaco.languages.CompletionItemKind.Field, insertText: q(c.name), detail: `${t.id} · ${c.databaseType}`, range });
        }
      }
      return { suggestions: out };
    },
  });
}

// options: { value, language, onChange(), onSave(), onRun(), onDryRun(),
//            bindings: [{ keys: ['CtrlCmd', 'Enter'], run }] }
export async function createEditor(container, options = {}) {
  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (err) {
    console.warn('Falling back to a plain editor:', err);
    return textareaEditor(container, options);
  }
  configure(monaco);
  const language = options.language ?? 'typescript';
  if (language === 'sql') registerSqlCompletions(monaco);
  const ext = language === 'sql' ? 'sql' : 'ts';
  const newModel = (text) => monaco.editor.createModel(text ?? '', language, monaco.Uri.parse(`file:///${language}/doc-${++modelSeq}.${ext}`));
  let model = newModel(options.value);
  const editor = monaco.editor.create(container, {
    model,
    theme: darkQuery.matches ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 4,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    renderLineHighlight: 'line',
  });
  editor.onDidChangeModelContent(() => options.onChange?.());
  const K = monaco.KeyMod;
  const C = monaco.KeyCode;
  if (options.onSave) editor.addCommand(K.CtrlCmd | C.KeyS, () => options.onSave());
  if (options.onRun) editor.addCommand(C.F5, () => options.onRun());
  if (options.onDryRun) editor.addCommand(C.F6, () => options.onDryRun());
  for (const b of options.bindings ?? []) {
    const code = b.keys.reduce((acc, k) => acc | (K[k] ?? C[k] ?? 0), 0);
    editor.addCommand(code, () => b.run());
  }

  return {
    isMonaco: true,
    getValue: () => model.getValue(),
    // The selected text, or the whole document when nothing is selected.
    getSelectedOrAll() {
      const sel = editor.getSelection();
      return sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue();
    },
    // Mark an error at a character offset (PostgreSQL's "position").
    markError(offset, message) {
      const pos = model.getPositionAt(Math.max(0, offset - 1));
      monaco.editor.setModelMarkers(model, 'pgsql-erd', [
        { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 1, message, severity: monaco.MarkerSeverity.Error },
      ]);
      editor.revealPositionInCenter(pos);
    },
    clearMarkers: () => monaco.editor.setModelMarkers(model, 'pgsql-erd', []),
    // A new document gets a fresh model (and undo history); an edit of the
    // current one keeps undo.
    setValue(text, { keepUndo = false } = {}) {
      if (keepUndo) {
        editor.pushUndoStop();
        editor.executeEdits('pgsql-erd', [{ range: model.getFullModelRange(), text }]);
        editor.pushUndoStop();
        return;
      }
      const old = model;
      model = newModel(text);
      editor.setModel(model);
      old.dispose();
    },
    insertText(text) {
      const sel = editor.getSelection();
      editor.executeEdits('pgsql-erd', [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
    },
    setTypes(dts) {
      typesLib?.dispose();
      typesLib = typescriptApi(monaco).typescriptDefaults.addExtraLib(dts, 'file:///types/database.d.ts');
    },
    // diagnostics from the main process (lint warnings such as unknown tables)
    setMarkers(diags) {
      const severity = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
      monaco.editor.setModelMarkers(
        model,
        'pgsql-erd',
        diags.map((d) => ({
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.endLine ?? d.line,
          endColumn: d.endColumn ?? d.column + 1,
          message: d.message,
          severity: severity[d.severity] ?? monaco.MarkerSeverity.Error,
        }))
      );
    },
    revealLine(line, column = 1) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    },
    // Markers from the TypeScript worker, for the problems line.
    onMarkers(cb) {
      monaco.editor.onDidChangeMarkers((uris) => {
        if (uris.some((u) => u.toString() === model.uri.toString())) cb(monaco.editor.getModelMarkers({ resource: model.uri }));
      });
    },
    setReadOnly: (ro) => editor.updateOptions({ readOnly: ro }),
    focus: () => editor.focus(),
    layout: () => editor.layout(),
  };
}

function textareaEditor(container, options) {
  const ta = document.createElement('textarea');
  ta.className = 'wb-textarea';
  ta.spellcheck = false;
  ta.value = options.value ?? '';
  container.append(ta);
  ta.addEventListener('input', () => options.onChange?.());
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const b = (options.bindings ?? []).find((x) => x.keys.includes('Enter') && x.keys.includes('Shift') === e.shiftKey);
      if (b) {
        e.preventDefault();
        b.run();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      options.onSave?.();
    } else if (e.key === 'F5') {
      e.preventDefault();
      options.onRun?.();
    } else if (e.key === 'F6') {
      e.preventDefault();
      options.onDryRun?.();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
    }
  });
  return {
    isMonaco: false,
    getValue: () => ta.value,
    getSelectedOrAll: () => (ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value),
    markError(offset) {
      ta.focus();
      ta.setSelectionRange(offset - 1, offset);
    },
    clearMarkers() {},
    setValue: (text) => (ta.value = text),
    insertText: (text) => {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      options.onChange?.();
    },
    setTypes() {},
    setMarkers() {},
    revealLine(line) {
      const lines = ta.value.split('\n');
      const pos = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
    },
    onMarkers() {},
    setReadOnly: (ro) => (ta.readOnly = ro),
    focus: () => ta.focus(),
    layout() {},
  };
}
