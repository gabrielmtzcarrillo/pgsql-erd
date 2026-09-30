// The database side of a script run. The runner process never touches the
// database: it sends operations here (select, insert, raw query, …), and
// this session checks them against the script's permissions, builds the SQL
// with quoted identifiers and parameters, runs it inside the run's
// transaction and counts what changed.

const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like', 'ilike', 'isNull']);
const CMP = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

class PermissionError extends Error {}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

class ScriptSession {
  // client: a connected pg Client. schema: canonical schema model.
  // shared: modules from src/shared (findTable, classifySql).
  constructor({ client, schema, permissions, shared, limits = {} }) {
    this.client = client;
    this.schema = schema;
    this.permissions = permissions;
    this.shared = shared;
    this.limits = { maxRows: 50000, statementTimeoutMs: 60000, ...limits };
    this.counters = { inserts: 0, updates: 0, deletes: 0, rowsRead: 0, tables: {} };
    this.savepoints = 0;
    this.savedCounters = new Map();
    this.ranDDL = false;
    this.readOnly = !(permissions.insertData || permissions.updateData || permissions.deleteData || permissions.executeDDL || permissions.rawSql);
    this.state = 'idle';
  }

  async begin() {
    await this.client.query(this.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    await this.client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Number(this.limits.statementTimeoutMs) | 0)}`);
    this.state = 'open';
  }

  async commit() {
    if (this.state !== 'open') throw new Error('The transaction is no longer open.');
    await this.client.query('COMMIT');
    this.state = 'committed';
  }

  async rollback() {
    if (this.state !== 'open') return;
    this.state = 'rolled back';
    await this.client.query('ROLLBACK').catch(() => {});
  }

  summary() {
    const { inserts, updates, deletes, rowsRead, tables } = this.counters;
    return { inserts, updates, deletes, rowsRead, tables: structuredClone(tables) };
  }

  require(key, what) {
    if (!this.permissions[key]) throw new PermissionError(`Permission denied: ${what} needs the "${key}" permission.`);
  }

  table(name) {
    const t = this.shared.findTable(this.schema, name);
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  }

  count(table, kind, n) {
    const c = (this.counters.tables[table] ??= { insert: 0, update: 0, delete: 0 });
    c[kind] += n;
    this.counters[`${kind}s`] += n;
  }

  column(t, name) {
    const c = t.columns.find((c) => c.name === name);
    if (!c) throw new Error(`Unknown column ${name} in ${t.id}`);
    return c;
  }

  vectorKind(col) {
    return col && !col.isArray ? this.shared.vectorKind?.(col.baseType) ?? null : null;
  }

  // Values that node-postgres would convert wrongly.
  value(col, v) {
    if (typeof v === 'bigint') return v.toString();
    if (col && (col.baseType === 'json' || col.baseType === 'jsonb') && v !== null && v !== undefined) return JSON.stringify(v);
    // pgvector: number arrays -> '[1,2,3]' (node-postgres would send '{1,2,3}').
    const vec = this.vectorKind(col);
    if (vec && v !== null && v !== undefined) return this.shared.toVectorText(vec, v);
    return v;
  }

  // pgvector: vector / halfvec values come back as '[1,2,3]'; scripts get number arrays.
  decode(t, rows) {
    const cols = t.columns.filter((c) => {
      const k = this.vectorKind(c);
      return k === 'vector' || k === 'halfvec';
    });
    if (!cols.length) return rows;
    for (const r of rows) for (const c of cols) if (typeof r[c.name] === 'string') r[c.name] = this.shared.parseVectorText(r[c.name]);
    return rows;
  }

  // where: array of filter objects, combined with AND.
  where(t, filters, params) {
    const parts = [];
    for (const f of filters ?? []) {
      for (const [name, v] of Object.entries(f ?? {})) {
        const col = this.column(t, name);
        const c = quoteIdent(name);
        const p = (x) => {
          params.push(this.value(col, x));
          return `$${params.length}`;
        };
        // A vector column compares with one vector (an array of numbers); a list of them is IN.
        const vec = this.vectorKind(col);
        const isVectorValue = (x) => vec && (ArrayBuffer.isView(x) || (Array.isArray(x) && x.every((y) => typeof y === 'number')));
        // IN lists: vectors are encoded one by one, so the list itself isn't encoded again.
        const pList = (list) => {
          if (!vec) return p(list.map((x) => this.value(null, x)));
          params.push(list.map((x) => this.value(col, x)));
          return `$${params.length}`;
        };
        if (v === null) parts.push(`${c} IS NULL`);
        else if (Array.isArray(v) && !isVectorValue(v)) parts.push(v.length ? `${c} = ANY(${pList(v)})` : 'FALSE');
        else if (isPlainObject(v) && Object.keys(v).length && Object.keys(v).every((k) => OPS.has(k))) {
          for (const [op, x] of Object.entries(v)) {
            if (op === 'isNull') parts.push(`${c} IS ${x ? '' : 'NOT '}NULL`);
            else if (op === 'in' || op === 'notIn') {
              const list = Array.isArray(x) ? x : [x];
              if (!list.length) parts.push(op === 'in' ? 'FALSE' : 'TRUE');
              else parts.push(`${op === 'notIn' ? 'NOT ' : ''}(${c} = ANY(${pList(list)}))`);
            } else if ((op === 'eq' || op === 'ne') && x === null) parts.push(`${c} IS ${op === 'ne' ? 'NOT ' : ''}NULL`);
            else if (op === 'ne') parts.push(`${c} IS DISTINCT FROM ${p(x)}`);
            else parts.push(`${c} ${CMP[op]} ${p(x)}`);
          }
        } else parts.push(`${c} = ${p(v)}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  async query(sql, params = []) {
    return this.client.query(sql, params);
  }

  // ---------------------------------------------------------------- ops

  async handle(op, args = {}) {
    if (this.state !== 'open') throw new Error('The run has finished.');
    switch (op) {
      case 'select':
        return this.select(args);
      case 'count':
        return this.countRows(args);
      case 'insert':
        return this.insert(args);
      case 'update':
        return this.update(args);
      case 'delete':
        return this.remove(args);
      case 'query':
        return this.raw(args);
      case 'savepoint':
        return this.savepoint(args);
      case 'preview':
        return this.summary();
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  }

  async select({ table, where, columns, orderBy, limit, offset }) {
    this.require('readData', 'Reading rows');
    const t = this.table(table);
    const params = [];
    const cols = columns?.length ? columns.map((c) => quoteIdent(this.column(t, c).name)).join(', ') : '*';
    let sql = `SELECT ${cols} FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)}${this.where(t, where, params)}`;
    if (orderBy?.length)
      sql += ` ORDER BY ${orderBy.map((o) => `${quoteIdent(this.column(t, o.column).name)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
    const max = this.limits.maxRows;
    const wanted = limit === undefined || limit === null ? null : Math.max(0, Math.floor(Number(limit)));
    if (wanted !== null && wanted > max) throw new Error(`limit(${wanted}) is above the maximum of ${max} rows per query.`);
    sql += ` LIMIT ${wanted ?? max + 1}`;
    if (offset) sql += ` OFFSET ${Math.max(0, Math.floor(Number(offset)))}`;
    const res = await this.query(sql, params);
    if (wanted === null && res.rows.length > max)
      throw new Error(`${t.id} returned more than ${max} rows. Use .limit() and .offset() to read it in pages.`);
    this.counters.rowsRead += res.rows.length;
    return this.decode(t, res.rows);
  }

  async countRows({ table, where }) {
    this.require('readData', 'Counting rows');
    const t = this.table(table);
    const params = [];
    const res = await this.query(`SELECT count(*)::bigint AS n FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)}${this.where(t, where, params)}`, params);
    return Number(res.rows[0].n);
  }

  async insert({ table, rows }) {
    this.require('insertData', 'INSERT');
    const t = this.table(table);
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return [];
    for (const r of list) if (!isPlainObject(r)) throw new Error(`insert() into ${t.id} expects row objects.`);
    const names = [...new Set(list.flatMap((r) => Object.keys(r)))];
    const cols = names.map((n) => this.column(t, n));
    const out = [];
    const perStatement = Math.max(1, Math.floor(30000 / Math.max(1, cols.length)));
    for (let i = 0; i < list.length; i += perStatement) {
      const chunk = list.slice(i, i + perStatement);
      const params = [];
      const values = chunk.map(
        (r) =>
          `(${cols
            .map((c) => {
              if (!(c.name in r) || r[c.name] === undefined) return 'DEFAULT';
              params.push(this.value(c, r[c.name]));
              return `$${params.length}`;
            })
            .join(', ')})`
      );
      const target = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
      if (!cols.length) {
        for (const _ of chunk) out.push(...(await this.query(`INSERT INTO ${target} DEFAULT VALUES RETURNING *`)).rows);
        continue;
      }
      const res = await this.query(
        `INSERT INTO ${target} (${cols.map((c) => quoteIdent(c.name)).join(', ')}) VALUES ${values.join(', ')} RETURNING *`,
        params
      );
      out.push(...res.rows);
    }
    this.count(t.id, 'insert', out.length);
    return this.decode(t, out);
  }

  async update({ table, where, values }) {
    this.require('updateData', 'UPDATE');
    const t = this.table(table);
    if (!where) throw new Error('update() needs a where() filter; use where({}) to update every row.');
    const entries = Object.entries(values ?? {}).filter(([, v]) => v !== undefined);
    if (!entries.length) throw new Error('update() needs at least one value.');
    const params = [];
    const sets = entries.map(([k, v]) => {
      const c = this.column(t, k);
      params.push(this.value(c, v));
      return `${quoteIdent(c.name)} = $${params.length}`;
    });
    const res = await this.query(`UPDATE ${quoteIdent(t.schema)}.${quoteIdent(t.name)} SET ${sets.join(', ')}${this.where(t, where, params)}`, params);
    this.count(t.id, 'update', res.rowCount ?? 0);
    return res.rowCount ?? 0;
  }

  async remove({ table, where }) {
    this.require('deleteData', 'DELETE');
    const t = this.table(table);
    if (!where) throw new Error('delete() needs a where() filter; use where({}) to delete every row.');
    const params = [];
    const res = await this.query(`DELETE FROM ${quoteIdent(t.schema)}.${quoteIdent(t.name)}${this.where(t, where, params)}`, params);
    this.count(t.id, 'delete', res.rowCount ?? 0);
    return res.rowCount ?? 0;
  }

  async raw({ sql, params }) {
    const { kinds } = this.shared.classifySql(sql);
    if (!kinds.length) return [];
    if (kinds.includes('transaction'))
      throw new PermissionError('Scripts run in a transaction managed by the app; use db.transaction() instead of BEGIN/COMMIT/ROLLBACK.');
    if (kinds.includes('read')) {
      this.require('readData', 'db.query() reading rows');
      this.require('executeSelect', 'db.query() SELECT');
    }
    if (kinds.includes('write')) this.require('rawSql', 'db.query() INSERT/UPDATE/DELETE');
    if (kinds.includes('ddl')) this.require('executeDDL', 'DDL');
    if (kinds.includes('other')) this.require('rawSql', 'This statement');
    const res = await this.query(sql, params ?? []);
    if (kinds.includes('ddl')) this.ranDDL = true;
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) {
      const kind = { INSERT: 'insert', UPDATE: 'update', DELETE: 'delete', MERGE: 'update' }[r.command];
      if (kind) this.count('(sql)', kind, r.rowCount ?? 0);
    }
    const last = results[results.length - 1];
    const rows = last?.rows ?? [];
    if (rows.length > this.limits.maxRows) throw new Error(`The query returned more than ${this.limits.maxRows} rows.`);
    this.counters.rowsRead += rows.length;
    return rows;
  }

  async savepoint({ action, name }) {
    if (action === 'begin') {
      const sp = `sp_${++this.savepoints}`;
      await this.query(`SAVEPOINT ${sp}`);
      this.savedCounters.set(sp, structuredClone(this.counters));
      return { name: sp };
    }
    if (!this.savedCounters.has(name)) throw new Error('Unknown savepoint.');
    if (action === 'release') await this.query(`RELEASE SAVEPOINT ${name}`);
    else if (action === 'rollback') {
      await this.query(`ROLLBACK TO SAVEPOINT ${name}`);
      // Changes inside the savepoint are undone; rows read still count.
      const rowsRead = this.counters.rowsRead;
      this.counters = this.savedCounters.get(name);
      this.counters.rowsRead = rowsRead;
    } else throw new Error(`Unknown savepoint action: ${action}`);
    this.savedCounters.delete(name);
    return { name };
  }
}

module.exports = { ScriptSession, PermissionError, quoteIdent };
