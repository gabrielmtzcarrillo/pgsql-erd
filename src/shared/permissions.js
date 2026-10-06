// Script and assistant permissions, profiles and connection policies. The
// main process is the one that enforces them; the renderer only displays and
// edits them.

export const SCRIPT_PERMISSION_KEYS = [
  'readSchema', 'readData', 'executeSelect', 'insertData', 'updateData', 'deleteData', 'executeDDL', 'rawSql', 'useAI',
];

export const SCRIPT_PERMISSION_LABELS = {
  readSchema: 'Read schema',
  readData: 'Read rows',
  executeSelect: 'Run SELECT (db.query)',
  insertData: 'INSERT',
  updateData: 'UPDATE',
  deleteData: 'DELETE',
  executeDDL: 'DDL (CREATE / ALTER / DROP)',
  rawSql: 'Raw SQL writes (db.query)',
  useAI: 'Use AI (ai.chat / ai.structured)',
};

const none = Object.fromEntries(SCRIPT_PERMISSION_KEYS.map((k) => [k, false]));

// Scripts that read, review or generate data may call the AI (ai.chat /
// ai.structured); migrations may not unless overridden. Sending data to a
// remote provider still needs the user's consent when the script runs.
export const SCRIPT_PROFILES = {
  'read-only': { label: 'Read only', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, useAI: true } },
  validator: { label: 'Validator', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, useAI: true } },
  generator: { label: 'Data generator', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, insertData: true, useAI: true } },
  seeder: { label: 'Seeder', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, insertData: true, updateData: true, useAI: true } },
  migration: { label: 'Migration', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, insertData: true, updateData: true, deleteData: true, executeDDL: true, rawSql: true } },
  full: { label: 'Full access', permissions: Object.fromEntries(SCRIPT_PERMISSION_KEYS.map((k) => [k, true])) },
};

export const DEFAULT_SCRIPT_PERMISSIONS = SCRIPT_PROFILES['read-only'].permissions;

// Script permissions from a profile name plus explicit overrides. Unknown
// keys are dropped; missing ones fall back to the profile (or read-only).
export function resolveScriptPermissions(profile, overrides = {}) {
  const base = SCRIPT_PROFILES[profile]?.permissions ?? DEFAULT_SCRIPT_PERMISSIONS;
  const out = { ...base };
  for (const k of SCRIPT_PERMISSION_KEYS) if (typeof overrides?.[k] === 'boolean') out[k] = overrides[k];
  return out;
}

export const canWrite = (p) => !!(p.insertData || p.updateData || p.deleteData || p.executeDDL || p.rawSql);

// ------------------------------------------------------------ connections

export const ENVIRONMENTS = ['development', 'testing', 'staging', 'production'];

export function defaultPolicy(environment = 'development') {
  const prod = environment === 'production';
  return { allowWrites: !prod, allowDDL: !prod, requireDryRun: prod || environment === 'staging' };
}

export function normalizePolicy(environment, policy = {}) {
  const d = defaultPolicy(environment);
  return {
    allowWrites: typeof policy.allowWrites === 'boolean' ? policy.allowWrites : d.allowWrites,
    allowDDL: typeof policy.allowDDL === 'boolean' ? policy.allowDDL : d.allowDDL,
    requireDryRun: typeof policy.requireDryRun === 'boolean' ? policy.requireDryRun : d.requireDryRun,
  };
}

// What a script may actually do on a connection: its own permissions,
// narrowed by the connection's policy.
export function effectivePermissions(scriptPermissions, policy) {
  const p = { ...scriptPermissions };
  if (!policy.allowWrites) {
    p.insertData = p.updateData = p.deleteData = p.rawSql = false;
    p.executeDDL = false;
  }
  if (!policy.allowDDL) p.executeDDL = false;
  return p;
}

// ------------------------------------------------------------ assistant

export const AI_PERMISSION_KEYS = [
  'readSchema', 'readData', 'executeSelect', 'createScripts', 'modifyScripts', 'executeScripts', 'executeWrites', 'executeDDL',
];

export const AI_PERMISSION_LABELS = {
  readSchema: 'Read schema',
  readData: 'Read rows (samples)',
  executeSelect: 'Run SELECT queries',
  createScripts: 'Create scripts',
  modifyScripts: 'Modify scripts',
  executeScripts: 'Run validators / dry runs',
  executeWrites: 'Execute writes',
  executeDDL: 'Execute DDL',
};

export const DEFAULT_AI_PERMISSIONS = {
  readSchema: true,
  readData: false,
  executeSelect: false,
  createScripts: true,
  modifyScripts: true,
  executeScripts: false,
  executeWrites: false,
  executeDDL: false,
};

export function normalizeAiPermissions(p = {}) {
  const out = { ...DEFAULT_AI_PERMISSIONS };
  for (const k of AI_PERMISSION_KEYS) if (typeof p?.[k] === 'boolean') out[k] = p[k];
  // Writes and DDL are not exposed to the assistant yet, whatever is stored.
  out.executeWrites = false;
  out.executeDDL = false;
  return out;
}

// ------------------------------------------------------------ SQL checks

const strip = (sql) =>
  String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");

// Classify raw SQL by its statements' leading keywords. This is a guard for
// clear mistakes; the database enforces read-only transactions as well.
export function classifySql(sql) {
  const statements = strip(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const kinds = new Set();
  for (const s of statements) {
    const word = (s.match(/^\(*\s*([A-Za-z]+)/)?.[1] ?? '').toUpperCase();
    const writes = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(s);
    if (['SELECT', 'VALUES', 'TABLE', 'SHOW', 'WITH'].includes(word)) kinds.add(writes ? 'write' : 'read');
    // EXPLAIN only runs the statement with ANALYZE.
    else if (word === 'EXPLAIN') kinds.add(writes && /\bANALYZE\b/i.test(s) ? 'write' : 'read');
    else if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(word)) kinds.add('write');
    else if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'REINDEX', 'CLUSTER', 'VACUUM', 'ANALYZE', 'REFRESH', 'SECURITY', 'IMPORT'].includes(word)) kinds.add('ddl');
    else if (['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'START', 'SAVEPOINT', 'RELEASE', 'ABORT', 'PREPARE'].includes(word)) kinds.add('transaction');
    else kinds.add('other');
  }
  return { statements: statements.length, kinds: [...kinds] };
}

// Like strip(), but blanks comments and quoted text with spaces so every
// character keeps its offset.
const mask = (sql) =>
  String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (m) => ' '.repeat(m.length));

// The query tab runs everything in its own transaction. A script written as
// BEGIN … COMMIT (or … ROLLBACK, a dry run) is accepted: the outer BEGIN and
// COMMIT / ROLLBACK are blanked out (offsets of the rest stay the same, so
// error positions still point at the right character) and their meaning is
// returned. Savepoints inside are fine; any other transaction statement is not.
// → { sql, modes: 'ISOLATION LEVEL …' | null, end: 'commit' | 'rollback' | null }
export function unwrapTransaction(sql) {
  const text = String(sql);
  const masked = mask(text);
  const parts = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i < masked.length && masked[i] !== ';') continue;
    const body = masked.slice(start, i).trim();
    if (body) parts.push({ start, end: Math.min(i + 1, masked.length), body, words: body.toUpperCase().split(/\s+/) });
    start = i + 1;
  }
  const isBegin = (w) => w[0] === 'BEGIN' || (w[0] === 'START' && w[1] === 'TRANSACTION');
  const endOf = (w) => (['COMMIT', 'END'].includes(w[0]) ? 'commit' : ['ROLLBACK', 'ABORT'].includes(w[0]) && w[1] !== 'TO' ? 'rollback' : null);
  const isSavepoint = (w) => w[0] === 'SAVEPOINT' || w[0] === 'RELEASE' || (w[0] === 'ROLLBACK' && w[1] === 'TO');
  const isTx = (w) => ['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'START', 'ABORT'].includes(w[0]) || (w[0] === 'PREPARE' && w[1] === 'TRANSACTION');

  const first = parts[0];
  const last = parts[parts.length - 1];
  const wrapped = first && isBegin(first.words);
  if (wrapped && (parts.length < 2 || !endOf(last.words)))
    throw new Error('The script starts with BEGIN but does not end with COMMIT or ROLLBACK.');
  const inner = wrapped ? parts.slice(1, -1) : parts;
  if (inner.some((p) => isTx(p.words) && !isSavepoint(p.words)))
    throw new Error('The query tab runs the script in one transaction: wrap it in a single BEGIN … COMMIT (or ROLLBACK) and remove other BEGIN / COMMIT / ROLLBACK statements. Savepoints are allowed.');
  if (!wrapped) return { sql: text, modes: null, end: null };

  const blank = (s, p) => s.slice(0, p.start) + s.slice(p.start, p.end).replace(/[^\n]/g, ' ') + s.slice(p.end);
  const modes = first.body.replace(/^(BEGIN(\s+(WORK|TRANSACTION))?|START\s+TRANSACTION)\b/i, '').trim();
  return { sql: blank(blank(text, last), first), modes: modes || null, end: endOf(last.words) };
}
