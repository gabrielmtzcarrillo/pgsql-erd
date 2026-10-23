// Runs an import template's INSERTs (see src/shared/import-template.js and
// docs/import-template-spec.md). The rows come already read from the
// workbook; this applies them to the database, task by task in the template's
// order, with every value sent as a parameter and every identifier quoted.
//
//   runImport(client, template, tasks) -> { tasks: [{ id, order, table, inserted }], total }
//
// `client` is a pg client; `tasks` is [{ id, rows: [{ row, values }] }] as read
// by extractRows(). Beyond plain INSERTs:
//  - `inserted` mappings take the key an earlier task's INSERT returned
//    (RETURNING) for the same worksheet row;
//  - `lookup` processors find the row whose primary key equals the cell text,
//    in the same transaction, so rows inserted by earlier tasks are visible.
// A failure rolls back the open transaction (everything with "atomic", only the
// failing task with "perTask") and throws an Error that names the task and the
// worksheet row; `error.committed` lists the tasks that stay committed.

const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
const tableName = (t) => `${t.schema}.${t.table}`;

async function runImport(client, template, tasks, { timeoutMs = 600000 } = {}) {
  const order = [...template.execution.tasks].sort((a, b) => a.order - b.order);
  const prepared = new Map(tasks.map((t) => [t.id, t]));
  const atomic = template.execution.transaction === 'atomic';

  // Columns later tasks take from an INSERT ... RETURNING.
  const needed = new Map();
  for (const task of order) {
    for (const m of task.mappings) {
      if (m.source.mode !== 'inserted') continue;
      if (!needed.has(m.source.taskId)) needed.set(m.source.taskId, new Set());
      needed.get(m.source.taskId).add(m.source.column);
    }
  }
  const returned = new Map(); // task id -> Map(worksheet row -> { column: value })
  const found = new Map(); // lookups already made

  const lookup = async (task, p, key) => {
    const cacheKey = JSON.stringify([p.schema, p.table, p.matchColumn, p.valueColumn, key]);
    if (found.has(cacheKey)) return found.get(cacheKey);
    const res = await client.query(
      `SELECT ${quote(p.valueColumn)} AS v FROM ${quote(p.schema)}.${quote(p.table)} WHERE ${quote(p.matchColumn)}::text = $1 LIMIT 2`,
      [key]
    );
    let value;
    if (res.rows.length > 1) throw new Error(`more than one row of ${p.schema}.${p.table} has ${p.matchColumn} = ${key}`);
    if (res.rows.length === 0) {
      if ((p.onMissing ?? 'error') !== 'null') throw new Error(`${p.schema}.${p.table} has no row with ${p.matchColumn} = ${key}`);
      value = null;
    } else value = res.rows[0].v;
    found.set(cacheKey, value);
    return value;
  };

  const valueOf = async (task, m, row) => {
    if (m.source.mode === 'inserted') {
      const got = returned.get(m.source.taskId)?.get(row.row);
      if (!got) throw new Error(`the task ${m.source.taskId} did not insert worksheet row ${row.row}, so its key is not available`);
      return got[m.source.column] ?? null;
    }
    const v = row.values[m.targetColumn];
    if (v === undefined) return null;
    const last = (m.processors ?? [m.processor]).at(-1);
    if (last?.type === 'lookup' && v !== null) return lookup(task, last, String(v));
    return v;
  };

  const begin = async () => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
  };
  const done = [];
  try {
    if (atomic) await begin();
    for (const task of order) {
      const data = prepared.get(task.id);
      if (!data) throw new Error(`Task ${task.id}: no rows were prepared for it.`);
      if (!atomic) await begin();
      const keep = needed.has(task.id) ? new Map() : null;
      if (keep) returned.set(task.id, keep);
      const columns = task.mappings.map((m) => m.targetColumn);
      const sql = `INSERT INTO ${quote(task.target.schema)}.${quote(task.target.table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`
        + (keep ? ` RETURNING ${[...needed.get(task.id)].map(quote).join(', ')}` : '');
      let inserted = 0;
      for (const row of data.rows) {
        try {
          const params = [];
          for (const m of task.mappings) params.push(await valueOf(task, m, row));
          const res = await client.query(sql, params);
          if (keep) keep.set(row.row, res.rows[0] ?? {});
          inserted++;
        } catch (err) {
          const e = new Error(`Task ${task.id} (${tableName(task.target)}), worksheet row ${row.row}: ${err.message}`);
          e.cause = err;
          throw e;
        }
      }
      if (!atomic) await client.query('COMMIT');
      done.push({ id: task.id, order: task.order, table: tableName(task.target), inserted });
    }
    if (atomic) await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.committed = atomic ? [] : done.map((t) => t.id);
    if (err.committed.length) err.message += ` Tasks already committed: ${err.committed.join(', ')}.`;
    throw err;
  }
  return { tasks: done, total: done.reduce((n, t) => n + t.inserted, 0) };
}

module.exports = { runImport };
