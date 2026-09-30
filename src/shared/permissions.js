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

export const SCRIPT_PROFILES = {
  'read-only': { label: 'Read only', permissions: { ...none, readSchema: true, readData: true, executeSelect: true } },
  validator: { label: 'Validator', permissions: { ...none, readSchema: true, readData: true, executeSelect: true } },
  generator: { label: 'Data generator', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, insertData: true, useAI: true } },
  seeder: { label: 'Seeder', permissions: { ...none, readSchema: true, readData: true, executeSelect: true, insertData: true, updateData: true } },
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
