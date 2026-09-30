// TypeScript for scripts: type-checks a script against the generated
// database.d.ts and transpiles it to JavaScript for the runner. Uses the
// TypeScript compiler API with an in-memory language service host, so the
// standard library files are parsed once and reused.

const path = require('node:path');
const fs = require('node:fs');

let ts = null;
const load = () => (ts ??= require('typescript'));

const SCRIPT = '/script.ts';
const TYPES = '/database.d.ts';

function compilerOptions() {
  const t = load();
  return {
    target: t.ScriptTarget.ES2022,
    module: t.ModuleKind.ESNext,
    // Every script is its own module, so top-level await is allowed and
    // scripts don't see each other's declarations.
    moduleDetection: t.ModuleDetectionKind.Force,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noEmit: true,
    types: [],
    skipLibCheck: true,
    noImplicitAny: false,
  };
}

// Script-relevant subset of the environment: no DOM, no Node.
let service = null;
const files = new Map(); // name -> { text, version }

function setFile(name, text) {
  const cur = files.get(name);
  if (cur?.text === text) return;
  files.set(name, { text, version: (cur?.version ?? 0) + 1 });
}

function getService() {
  const t = load();
  if (service) return service;
  const libDir = path.dirname(require.resolve('typescript/lib/lib.d.ts'));
  const host = {
    getScriptFileNames: () => [SCRIPT, TYPES],
    getScriptVersion: (f) => String(files.get(f)?.version ?? 0),
    getScriptSnapshot: (f) => {
      if (files.has(f)) return t.ScriptSnapshot.fromString(files.get(f).text);
      const p = f.startsWith(libDir) ? f : path.join(libDir, path.basename(f));
      return fs.existsSync(p) ? t.ScriptSnapshot.fromString(fs.readFileSync(p, 'utf8')) : undefined;
    },
    getCurrentDirectory: () => '/',
    getCompilationSettings: compilerOptions,
    getDefaultLibFileName: (o) => path.join(libDir, t.getDefaultLibFileName(o)),
    fileExists: (f) => files.has(f) || fs.existsSync(f),
    readFile: (f) => files.get(f)?.text ?? (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
    readDirectory: () => [],
    directoryExists: () => true,
    getDirectories: () => [],
  };
  service = t.createLanguageService(host, t.createDocumentRegistry());
  return service;
}

const SEVERITY = ['warning', 'error', 'info', 'info'];

// Diagnostics as { line, column, endLine, endColumn, message, code, severity }
// (1-based lines and columns, like Monaco markers).
function check(source, dts) {
  const t = load();
  setFile(SCRIPT, source);
  setFile(TYPES, dts);
  const svc = getService();
  const diags = [...svc.getSyntacticDiagnostics(SCRIPT), ...svc.getSemanticDiagnostics(SCRIPT)];
  const sf = svc.getProgram().getSourceFile(SCRIPT);
  const moduleErrors = moduleStatements(source).map((r) => ({
    ...r,
    message: 'Scripts cannot use import or export: the script API (db, validate, report, faker, seed, ai, log) is available as globals.',
    code: 'pgsql-erd',
    severity: 'error',
  }));
  return moduleErrors.concat(diags.map((d) => {
    const start = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    const end = sf.getLineAndCharacterOfPosition((d.start ?? 0) + (d.length ?? 0));
    return {
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      message: t.flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
      severity: SEVERITY[d.category] ?? 'error',
    };
  }));
}

// Scripts run as plain code with the script API as globals, so imports
// and exports have nothing to bind to. Returns the offending statements.
function moduleStatements(source) {
  const t = load();
  const sf = t.createSourceFile(SCRIPT, source, t.ScriptTarget.ES2022, true);
  const K = t.SyntaxKind;
  return sf.statements.filter(
    (st) =>
      [K.ImportDeclaration, K.ImportEqualsDeclaration, K.ExportDeclaration, K.ExportAssignment].includes(st.kind) ||
      (t.canHaveModifiers(st) && t.getModifiers(st)?.some((m) => m.kind === K.ExportKeyword))
  ).map((st) => {
    const pos = sf.getLineAndCharacterOfPosition(st.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(st.getEnd());
    return { line: pos.line + 1, column: pos.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
  });
}

// JavaScript for the runner. The empty export that module detection adds
// is dropped.
function transpile(source) {
  const t = load();
  if (moduleStatements(source).length) throw new Error('Scripts cannot use import or export statements.');
  const out = t.transpileModule(source, {
    compilerOptions: { target: t.ScriptTarget.ES2022, module: t.ModuleKind.ESNext, moduleDetection: t.ModuleDetectionKind.Force },
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).map((d) => t.flattenDiagnosticMessageText(d.messageText, '\n'));
  if (errors.length) throw new Error(errors.join('\n'));
  return out.outputText.replace(/^\s*export\s*\{\s*\};?\s*$/gm, '');
}

module.exports = { check, transpile };
