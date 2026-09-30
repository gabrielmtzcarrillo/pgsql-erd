// Script runner process. Started by src/main/scripting/script-runner.cjs
// with a minimal environment (and Node's permission model where available),
// it runs one transpiled script in a separate V8 context with only the
// script API as globals. It holds no credentials and opens no database
// connections: every db.* and ai.* call is a message to the main process,
// which checks permissions and runs it.

'use strict';

const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Nothing from the parent's environment is needed.
for (const k of Object.keys(process.env)) delete process.env[k];

const send = (msg) => process.send?.(msg);

let nextId = 1;
const pending = new Map();

function rpc(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type, id, ...payload });
  });
}

process.on('message', (msg) => {
  if (msg?.type === 'reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  } else if (msg?.type === 'run') {
    run(msg).catch((err) => {
      send({ type: 'failed', error: errorText(err) });
    });
  }
});

function errorText(err) {
  if (!err) return 'Unknown error';
  const stack = String(err.stack ?? '');
  // Keep the frames inside the script and drop the runner's.
  const frames = stack
    .split('\n')
    .slice(1)
    .filter((l) => l.includes('script.js'))
    .map((l) => l.replace(/\(?script\.js:(\d+):(\d+)\)?/, (_, line, col) => `(line ${line - 1}, column ${col})`))
    .slice(0, 5);
  return [err.message ?? String(err), ...frames].join('\n');
}

// Values printed by log(): strings as is, everything else as JSON.
function format(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
  } catch {
    return String(v);
  }
}

async function run({ code, schema, params, limits = {}, seedValue }) {
  const shared = await loadShared();
  const maxMessages = limits.maxMessages ?? 5000;
  const maxOutput = limits.maxOutputChars ?? 1_000_000;
  let messageCount = 0;
  let outputChars = 0;
  let current = null; // validation being run
  const validations = [];

  const emit = (level, entry) => {
    const e = typeof entry === 'string' ? { message: entry } : { ...entry };
    e.message = String(e.message ?? '');
    if (e.row !== undefined && typeof e.row === 'bigint') e.row = e.row.toString();
    if (current) {
      current[level === 'error' ? 'errors' : level === 'warning' ? 'warnings' : 'infos']++;
      e.validation = current.name;
    }
    if (++messageCount > maxMessages) return;
    send({ type: 'message', level, entry: sanitize(e) });
  };

  const report = {
    error: (e) => emit('error', e),
    warning: (e) => emit('warning', e),
    info: (e) => emit('info', e),
  };

  const log = (...values) => {
    const text = values.map(format).join(' ');
    if (outputChars > maxOutput) return;
    outputChars += text.length;
    send({ type: 'output', text: outputChars > maxOutput ? `${text.slice(0, 200)}\n… output truncated` : text });
  };

  const registered = [];
  const validate = (name, check) => {
    if (typeof check !== 'function') throw new Error('validate(name, check) needs a function.');
    registered.push({ name: String(name), check });
  };

  const faker = shared.createFaker(seedValue ?? 1);
  const db = makeDb(schema, shared);
  const seed = makeSeed(schema, shared, db, faker);
  const ai = {
    chat: (prompt, options = {}) => rpc('ai', { kind: 'chat', prompt: String(prompt), options: sanitize(options) }),
    structured: (options = {}) => {
      const o = { ...options };
      if (o.table) {
        const t = shared.findTable(schema, o.table);
        if (!t) return Promise.reject(new Error(`Unknown table: ${o.table}`));
        o.table = t.id;
      }
      return rpc('ai', { kind: 'structured', options: sanitize(o) });
    },
  };

  const context = vm.createContext(
    {
      db,
      report,
      validate,
      log,
      console: { log, info: log, warn: (...v) => report.warning(v.map(format).join(' ')), error: (...v) => report.error(v.map(format).join(' ')) },
      params: sanitize(params ?? {}),
      faker,
      seed,
      ai,
      setTimeout,
      clearTimeout,
    },
    { codeGeneration: { strings: false, wasm: false }, name: 'script' }
  );

  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'script.js' });
  const started = Date.now();
  let error = null;
  try {
    await script.runInContext(context, { timeout: limits.syncTimeoutMs ?? 30000 });
  } catch (err) {
    error = errorText(err);
  }

  // Declared validations run after the script body, one at a time.
  if (!error) {
    for (const v of registered) {
      current = { name: v.name, errors: 0, warnings: 0, infos: 0 };
      const t0 = Date.now();
      let failure = null;
      try {
        await v.check();
      } catch (err) {
        failure = errorText(err);
        report.error({ message: `Validation threw: ${failure}` });
      }
      validations.push({
        name: v.name,
        status: failure ? 'error' : current.errors ? 'failed' : 'passed',
        errors: current.errors,
        warnings: current.warnings,
        durationMs: Date.now() - t0,
        error: failure,
      });
      current = null;
    }
  }

  send({
    type: 'done',
    error,
    validations,
    messagesDropped: Math.max(0, messageCount - maxMessages),
    durationMs: Date.now() - started,
  });
}

// Plain data only crosses to the main process.
function sanitize(v, depth = 0) {
  if (depth > 20) return null;
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const s = sanitize(x, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

// ------------------------------------------------------------ db

function makeDb(schema, shared) {
  const dbCall = (op, args) => rpc('db', { op, args: sanitize(args) });

  function makeTable(id, state = { where: [], orderBy: [], limit: null, offset: null }) {
    const next = (patch) => makeTable(id, { ...state, ...patch });
    const base = { table: id, where: state.where.length ? state.where : undefined };
    return Object.freeze({
      name: id,
      where: (filter) => next({ where: [...state.where, filter ?? {}] }),
      orderBy: (column, direction = 'asc') => next({ orderBy: [...state.orderBy, { column, direction }] }),
      limit: (n) => next({ limit: n }),
      offset: (n) => next({ offset: n }),
      select: (...columns) =>
        dbCall('select', { ...base, columns: columns.flat(), orderBy: state.orderBy, limit: state.limit, offset: state.offset }),
      first: async () => (await dbCall('select', { ...base, orderBy: state.orderBy, limit: 1, offset: state.offset }))[0] ?? null,
      count: () => dbCall('count', base),
      insert: async (row) => {
        if (Array.isArray(row)) return dbCall('insert', { table: id, rows: row });
        return (await dbCall('insert', { table: id, rows: [row] }))[0];
      },
      insertMany: (rows) => dbCall('insert', { table: id, rows }),
      update: (values) => dbCall('update', { ...base, where: state.where.length ? state.where : undefined, values }),
      delete: () => dbCall('delete', { ...base }),
    });
  }

  const resolve = (name) => {
    const t = shared.findTable(schema, name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  };

  const schemaTables = (s) => {
    const entry = schema.schemas.find((x) => x.name === s);
    if (!entry) throw new Error(`Unknown schema: ${s}`);
    return Object.freeze(Object.fromEntries(entry.tables.map((t) => [t.name, makeTable(t.id)])));
  };

  const api = {
    table: (name) => makeTable(resolve(name).id),
    schema: schemaTables,
    query: (sql, params = []) => dbCall('query', { sql: String(sql), params }),
    transaction: async (fn) => {
      const sp = await dbCall('savepoint', { action: 'begin' });
      try {
        const result = await fn(db);
        await dbCall('savepoint', { action: 'release', name: sp.name });
        return result;
      } catch (err) {
        await dbCall('savepoint', { action: 'rollback', name: sp.name });
        throw err;
      }
    },
    describe: Object.freeze({
      tables: () => shared.allTables(schema).map((t) => t.id),
      table: (name) => structuredClone(resolve(name)),
      relationships: (name) => structuredClone(shared.relationshipsOf(schema, resolve(name).id)),
      insertOrder: (names) => shared.dependencyOrder(schema, names ?? null),
    }),
    preview: () => dbCall('preview', {}),
  };
  const db = { ...api };
  for (const s of schema.schemas) if (!(s.name in api)) db[s.name] = schemaTables(s.name);
  return Object.freeze(db);
}

// ------------------------------------------------------------ seed

function makeSeed(schema, shared, db, faker) {
  const enums = shared.enumValues(schema);
  const refCache = new Map(); // "table(cols)" -> rows
  const counters = new Map(); // table -> rows generated so far

  async function referenced(fk) {
    const key = `${fk.refTable}(${fk.refColumns.join(',')})`;
    if (!refCache.has(key)) {
      const rows = await db.table(fk.refTable).limit(5000).select(...fk.refColumns);
      refCache.set(key, rows);
    }
    return refCache.get(key);
  }

  async function row(name, overrides = {}) {
    const t = shared.findTable(schema, name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    // Unique values are numbered after the rows already in the table, so
    // repeated runs don't collide with committed data.
    if (!counters.has(t.id)) counters.set(t.id, shared.uniqueColumns(t).size ? await db.table(t.id).count() : 0);
    const index = counters.get(t.id);
    counters.set(t.id, index + 1);
    const unique = shared.uniqueColumns(t);
    const out = {};
    const fkCols = new Set();
    for (const fk of t.foreignKeys) {
      fk.columns.forEach((c) => fkCols.add(c));
      if (fk.columns.every((c) => c in overrides)) continue;
      const refs = fk.refTable === t.id ? [] : await referenced(fk);
      const nullable = fk.columns.every((c) => t.columns.find((x) => x.name === c)?.nullable);
      if (!refs.length) {
        if (nullable) {
          fk.columns.forEach((c) => (out[c] = null));
          continue;
        }
        throw new Error(`${t.id}.${fk.columns.join(', ')} must reference ${fk.refTable}, which has no rows. Fill it first (see db.describe.insertOrder()).`);
      }
      const ref = faker.helpers.arrayElement(refs);
      fk.columns.forEach((c, i) => (out[c] = ref[fk.refColumns[i]]));
    }
    for (const c of shared.columnsToFill(t)) {
      if (fkCols.has(c.name) || c.name in overrides) continue;
      out[c.name] = shared.valueForColumn(c, faker, { index, unique: unique.has(c.name), enums });
    }
    return { ...out, ...overrides };
  }

  return Object.freeze({
    row,
    fill: async (name, count, overrides = {}) => {
      const t = shared.findTable(schema, name);
      if (!t) throw new Error(`Unknown table: ${name}`);
      const rows = [];
      for (let i = 0; i < count; i++) rows.push(await row(t.id, typeof overrides === 'function' ? overrides(i) : overrides));
      const inserted = [];
      for (let i = 0; i < rows.length; i += 500) inserted.push(...(await db.table(t.id).insertMany(rows.slice(i, i + 500))));
      refCache.clear();
      return inserted;
    },
    check: async (name, r) => {
      const t = shared.findTable(schema, name);
      if (!t) throw new Error(`Unknown table: ${name}`);
      const problems = shared.checkRowAgainstTable(t, r, schema);
      for (const fk of t.foreignKeys) {
        const vals = fk.columns.map((c) => r[c]);
        if (vals.some((v) => v === null || v === undefined)) continue;
        const filter = Object.fromEntries(fk.refColumns.map((c, i) => [c, vals[i]]));
        if (!(await db.table(fk.refTable).where(filter).count())) problems.push(`${fk.columns.join(', ')}: no matching row in ${fk.refTable}`);
      }
      return problems;
    },
    jsonSchema: (name) => {
      const t = shared.findTable(schema, name);
      if (!t) throw new Error(`Unknown table: ${name}`);
      return shared.tableJsonSchema(t, schema);
    },
  });
}

// ------------------------------------------------------------ startup

let sharedModules = null;
async function loadShared() {
  if (sharedModules) return sharedModules;
  const dir = path.join(__dirname, '..', 'shared');
  const names = ['schema-model', 'fake', 'seed', 'json-schema'];
  const mods = await Promise.all(names.map((n) => import(pathToFileURL(path.join(dir, `${n}.js`)).href)));
  sharedModules = Object.assign({}, ...mods);
  return sharedModules;
}

loadShared().then(
  () => send({ type: 'ready', permissionModel: !!process.permission }),
  (err) => send({ type: 'failed', error: `Runner failed to start: ${err.message}` })
);
